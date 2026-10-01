/*
 * BanG Dream! Our Notes event deck calculator: the calculation core.
 *
 * Deck power follows ournotes-deck (github.com/empty-sekai/ournotes-deck), which ports the game client's own
 * arithmetic: per-slot terms floored to whole points in binary32, summed over the five slots. Event points and items
 * follow the client formulas there as well:
 *   points = (10000 + pointBonus) * boostRate * value(rank) / 10000
 *   items  = count(rank) * (10000 + itemBonus) * boostRate / 10000
 * The live score is estimated as power * (no-skill score per unit of power of the chart, from nnnotes'
 * music-data.json) * a calibration factor for skills and play accuracy.
 *
 * Runs in the browser (window.Engine) and in Node (module.exports) for tests.
 */
(function (root) {
  "use strict";

  const BP = 10000;
  // MasterEventEffect._eventBonusType (client enum; confirmed against in-game results).
  const EVENT_POINT = 0;
  const EVENT_ITEM = 1;
  const PARAMETER_ALL = 2;
  const RESOURCE_MEMBER = 2;
  const RESOURCE_SNAP = 3;
  const MUSIC_TYPE_ALL = 99;
  const LEADER_SLOT = 2;
  const RANK_NAMES = { 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS" };

  const f32 = Math.fround;
  // FloorToInt((float)x / 10000f)
  const floorDiv = (x) => Math.floor(f32(f32(x) / BP));

  // ---------------------------------------------------------------------------------------------------------------
  // Master data

  const TABLES = [
    "MasterEvent", "MasterEventEffect", "MasterMemberCard", "MasterMemberCardLevel", "MasterMemberCardAwake",
    "MasterMemberCardLevelLimit", "MasterMemberCardRank", "MasterSupportCard", "MasterSupportCardLevel",
    "MasterSupportCardRank", "MasterCharacter", "MasterBand", "MasterTag", "MasterCharacterRank",
    "MasterCharacterTotalRank", "MasterLeaderSkillEffect", "MasterSkillTarget", "MasterSkillCondition",
    "MasterSkillConditionSet", "MasterSkillCumulativeCondition", "MasterVipRankBonus", "MasterParameter",
    "MasterLiveMusic", "MasterLiveMusicScore", "MasterLiveScoreRank", "MasterLiveEventPoint", "MasterLiveEventReward",
    "MasterChallengeLiveEventPoint", "MasterChallengeLiveEventReward", "MasterChallengeMusic", "MasterLiveChallengePoint",
    "MasterLiveMusicBoostBonus", "MasterChallengeMusicBoostBonus", "MasterLiveSkill", "MasterText",
  ];

  function rows(table) {
    return Array.isArray(table) ? table : table && Array.isArray(table._allData) ? table._allData : [];
  }

  function byId(list) {
    const m = new Map();
    for (const r of list) m.set(r._id, r);
    return m;
  }

  /** Indexes the raw tables ({TableName: json}). `lang` is a MasterText column, e.g. "_traditionalChinese". */
  function buildMaster(raw, lang) {
    const t = {};
    for (const name of TABLES) t[name] = rows(raw[name]);
    const text = new Map();
    for (const r of t.MasterText) text.set(r._id, r[lang] || r._traditionalChinese || r._japanese || r._english || "");
    const params = new Map(t.MasterParameter.map((r) => [r._id, r._value]));
    const m = {
      t,
      text: (id) => (id && text.get(id)) || "",
      memberCards: byId(t.MasterMemberCard),
      snaps: byId(t.MasterSupportCard),
      characters: byId(t.MasterCharacter),
      bands: byId(t.MasterBand),
      tags: byId(t.MasterTag),
      skillTargets: byId(t.MasterSkillTarget),
      skillConditions: byId(t.MasterSkillCondition),
      cumulative: byId(t.MasterSkillCumulativeCondition),
      liveSkills: byId(t.MasterLiveSkill),
      musics: byId(t.MasterLiveMusic),
      musicScores: byId(t.MasterLiveMusicScore),
      events: byId(t.MasterEvent),
      param: (k) => Number(params.get(k)),
      memberLevel: new Map(),
      supportLevel: new Map(),
      memberAwake: new Map(),
      memberRank: new Map(),
      supportRank: new Map(),
      levelLimit: new Map(),
      conditionSets: new Map(),
      leaderEffects: new Map(),
    };
    for (const r of t.MasterMemberCardLevel) m.memberLevel.set(r._group + ":" + r._level, r);
    for (const r of t.MasterSupportCardLevel) m.supportLevel.set(r._group + ":" + r._level, r);
    for (const r of t.MasterMemberCardAwake) m.memberAwake.set(r._group + ":" + r._awakeCount, r);
    for (const r of t.MasterMemberCardRank) m.memberRank.set(r._group + ":" + r._rank, r);
    for (const r of t.MasterSupportCardRank) m.supportRank.set(r._group + ":" + r._rank, r);
    for (const r of t.MasterMemberCardLevelLimit) m.levelLimit.set(r._rarity + ":" + r._awakeCount, r._limitLevel);
    for (const r of t.MasterSkillConditionSet) {
      if (!m.conditionSets.has(r._group)) m.conditionSets.set(r._group, []);
      m.conditionSets.get(r._group).push(r);
    }
    for (const r of t.MasterLeaderSkillEffect) {
      const k = r._leaderSkillID + ":" + r._level;
      if (!m.leaderEffects.has(k)) m.leaderEffects.set(k, []);
      m.leaderEffects.get(k).push(r);
    }
    m.characterRankBonus = t.MasterCharacterRank.map((r) => [r._rank, r._bonus]).sort((a, b) => a[0] - b[0]);
    m.characterTotalRankBonus = t.MasterCharacterTotalRank.map((r) => [r._totalRank, r._bonus]).sort((a, b) => a[0] - b[0]);
    m.musicTypeBase = m.param("music_type_base_bonus_rate");
    m.musicTagBase = m.param("music_tag_base_bonus_rate");
    m.typeLinkBase = m.param("type_link_base_bonus_rate");
    return m;
  }

  function lastLe(pairs, key) {
    let v = 0;
    for (const [k, b] of pairs) if (k <= key) v = b;
    return v;
  }

  /** Max level of a member card at an awake count, and the highest awake count. */
  function memberLimits(m, card) {
    let maxAwake = 1;
    for (const r of m.t.MasterMemberCardAwake) if (r._group === card._memberCardAwakeGroup) maxAwake = Math.max(maxAwake, r._awakeCount);
    return { maxAwake, limit: (awake) => m.levelLimit.get(card._rarity + ":" + awake) || 1 };
  }

  function snapLimit(m, snap, rank) {
    const r = m.supportRank.get(snap._supportCardRankGroup + ":" + rank);
    return r ? r._limitLevel : 1;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cards

  /** A member card the player owns, resolved: stats in whole points plus what the bonuses read. */
  function memberView(m, owned, player) {
    const c = m.memberCards.get(owned.id);
    if (!c) return null;
    const ch = m.characters.get(c._characterID);
    const lv = m.memberLevel.get(c._memberCardLevelGroup + ":" + owned.level);
    const aw = m.memberAwake.get(c._memberCardAwakeGroup + ":" + (owned.awake || 1));
    const rk = m.memberRank.get(c._memberCardRankGroup + ":" + (owned.rank || 1));
    if (!lv || !rk) return null;
    const max = [c._performancePowerMax, c._technicPowerMax, c._visualPowerMax];
    const lr = [lv._performanceRate, lv._technicRate, lv._visualRate];
    const ar = aw ? [aw._performanceRate, aw._technicRate, aw._visualRate] : [0, 0, 0];
    const rr = [rk._performanceRate, rk._technicRate, rk._visualRate];
    const power = [0, 1, 2].map(
      (i) =>
        Math.floor(f32(f32(lr[i] * max[i]) / BP)) +
        Math.floor(f32(f32(ar[i] / BP) * f32(max[i]))) +
        Math.floor(f32(f32(rr[i] * max[i]) / BP)),
    );
    const characterRanks = (player && player.characterRanks) || {};
    const live = m.liveSkills.get(c._liveSkillID);
    return {
      kind: "member",
      liveSkillCategories: live ? live._skillCategories || [] : [],
      id: c._id,
      assetId: c._assetID,
      characterId: c._characterID,
      bandId: ch ? ch._bandID : 0,
      cardType: c._cardType,
      rarity: c._rarity,
      tags: c._bestMusicTagIDs || [],
      level: owned.level,
      awake: owned.awake || 1,
      rank: owned.rank || 1,
      rankGroup: c._memberCardRankGroup,
      leaderSkillId: c._leaderSkillID,
      leaderSkillLevel: rk._leaderSkillLevel,
      musicTypeRate: rk._musicTypeBonusRate,
      musicTagRate: rk._musicTagBonusRate,
      power, // whole points [performance, technique, visual]
      characterRank: Number(characterRanks[c._characterID]) || 1,
    };
  }

  /** A snap the player owns: its power bonus percentage (BP) and what the bonuses read. */
  function snapView(m, owned) {
    const s = m.snaps.get(owned.id);
    if (!s) return null;
    const lv = m.supportLevel.get(s._supportCardLevelGroup + ":" + owned.level);
    const rk = m.supportRank.get(s._supportCardRankGroup + ":" + (owned.rank || 1));
    if (!lv) return null;
    const max = [s._performancePowerMax, s._technicPowerMax, s._visualPowerMax];
    const lr = [lv._performanceRate, lv._technicRate, lv._visualRate];
    const bands = [];
    for (const cid of s._characterIDs || []) {
      const ch = m.characters.get(cid);
      if (ch && !bands.includes(ch._bandID)) bands.push(ch._bandID);
    }
    return {
      kind: "snap",
      id: s._id,
      assetId: s._assetID,
      characterIds: s._characterIDs || [],
      bandIds: bands,
      cardType: s._cardType,
      rarity: s._rarity,
      level: owned.level,
      rank: owned.rank || 1,
      pct: [0, 1, 2].map((i) => floorDiv((lr[i] * max[i]) | 0)), // BP
      typeLinkRate: rk ? rk._cardTypeLinkBonusRate : null,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Event bonuses

  function eventEffects(m, eventId) {
    return m.t.MasterEventEffect.filter((e) => e._eventId === eventId);
  }

  function effectValue(e, rank) {
    return e["_rank" + Math.min(Math.max(rank, 1), 5) + "EffectValue"] || 0;
  }

  function memberTarget(e, v) {
    if (e._resourceTypeConstraint !== RESOURCE_MEMBER) return false;
    if (e._characterId > 0 && e._characterId !== v.characterId) return false;
    if (e._bandId > 0 && e._bandId !== v.bandId) return false;
    if (e._cardType !== 0 && e._cardType !== v.cardType) return false;
    if (e._tagId > 0 && !v.tags.includes(e._tagId)) return false;
    return e._memberCardId < 1 || e._memberCardId === v.id;
  }

  function snapTarget(e, v) {
    if (e._resourceTypeConstraint !== RESOURCE_SNAP) return false;
    if (e._characterId > 0 && !v.characterIds.includes(e._characterId)) return false;
    if (e._bandId > 0 && !v.bandIds.includes(e._bandId)) return false;
    if (e._cardType !== 0 && e._cardType !== v.cardType) return false;
    if (e._tagId >= 1) return false;
    return e._supportCardId < 1 || e._supportCardId === v.id;
  }

  /** {point, item, param} in 1/10000 for one card. */
  function cardEventBonus(effects, v) {
    const out = { point: 0, item: 0, param: 0 };
    if (!v) return out;
    for (const e of effects) {
      const hit = v.kind === "member" ? memberTarget(e, v) : snapTarget(e, v);
      if (!hit) continue;
      const val = effectValue(e, v.rank);
      if (e._eventBonusType === EVENT_POINT) out.point += val;
      else if (e._eventBonusType === EVENT_ITEM) out.item += val;
      else if (e._eventBonusType === PARAMETER_ALL) out.param += val;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Leader skill (ournotes-deck bonus.rs)

  function targetsOf(m, ids) {
    if (!ids || ids.length === 0) return null;
    return ids.map((i) => m.skillTargets.get(i)).filter(Boolean);
  }

  function isTargetMember(v, t) {
    if (t._bandID > 0 && t._bandID === v.bandId) return true;
    if (t._cardType !== 0 && t._cardType === v.cardType) return true;
    if (t._characterID > 0 && t._characterID === v.characterId) return true;
    if (t._tagID > 0 && v.tags.includes(t._tagID)) return true;
    const cats = t._liveSkillCategories || [];
    if (cats.length && v.liveSkillCategories.some((c) => cats.includes(c))) return true;
    return false; // Gekisou skill targets are not modelled
  }

  const matchesAny = (v, ts) => !!ts && ts.some((t) => isTargetMember(v, t));

  function formationCondition(ctype, members, ts, music) {
    if (!ts) return true;
    if (ctype === 3000) return members.some((v) => matchesAny(v, ts));
    if (ctype === 3001) return members.every((v) => matchesAny(v, ts));
    if (ctype === 4012) return !!music && ts.some((t) => t._liveMusicType !== 0 && t._liveMusicType === music.musicType);
    return true;
  }

  function checkCondition(m, group, members, music) {
    if (group <= 0) return true;
    for (const cs of m.conditionSets.get(group) || []) {
      for (const cid of cs._conditionIds) {
        const c = m.skillConditions.get(cid);
        if (!c || c._conditionType === 0) continue;
        if (!formationCondition(c._conditionType, members, targetsOf(m, c._conditionTargetIDs), music)) return false;
      }
    }
    return true;
  }

  function cumulativeCount(m, cid, members, leader) {
    if (cid < 1) return 1;
    const row = m.cumulative.get(cid);
    if (!row) return 1;
    const ts = targetsOf(m, row._conditionTargetIDs);
    const L = members[leader];
    let n;
    switch (row._skillCumulativeConditionType) {
      case 3000: n = members.filter((v) => matchesAny(v, ts)).length; break;
      case 3001: n = members.filter((v, i) => i !== leader && matchesAny(v, ts)).length; break;
      case 3002: n = members.filter((v) => v.bandId === L.bandId).length; break;
      case 3003: n = members.filter((v) => v.bandId !== L.bandId).length; break;
      case 3004: n = new Set(members.map((v) => v.bandId)).size; break;
      case 3005: n = new Set(members.map((v) => v.cardType)).size; break;
      default: return 1;
    }
    const cap = row._maxCumulativeCount;
    return cap < 1 ? n : Math.min(n, cap);
  }

  function accumulate(type, value, acc) {
    if (type === 1000 || type === 1500) { acc[0] += value; acc[1] += value; acc[2] += value; }
    else if (type === 1001 || type === 1501) acc[1] += value;
    else if (type === 1002 || type === 1502) acc[2] += value;
    else if (type === 1003 || type === 1503) acc[0] += value;
  }

  /** Leader skill percentages (BP) of the five slots, `members[leader]` leading. */
  function leaderBonuses(m, members, leader, music) {
    const L = members[leader];
    const out = members.map(() => [0, 0, 0]);
    for (const e of m.leaderEffects.get(L.leaderSkillId + ":" + L.leaderSkillLevel) || []) {
      if (!checkCondition(m, e._skillConditionGroup, members, music)) continue;
      let value = e._effectValue;
      if ((e._skillEffectType & ~3) === 1500) value *= cumulativeCount(m, e._skillCumulativeConditionID, members, leader);
      const ts = targetsOf(m, e._skillTargetIDs);
      members.forEach((v, i) => {
        if (!ts || matchesAny(v, ts)) accumulate(e._skillEffectType, value, out[i]);
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Deck power (ournotes-deck calc.rs slot_power). Every term is floored to whole points, so the deck power splits
  // exactly into a snap-independent part F(member, leader, music) and a snap part G(member, snap).

  // to_floor(b.mul(pct)) in whole points, b in whole points and pct in BP: floor((float)trunc(pct * b * 1e4 / 1e4) / 1e4f).
  const pctOf = (b, pct) => floorDiv(Math.trunc(pct * b));

  /** b: the member's stats before percentage bonuses (whole points), per stat. */
  function memberBase(m, v, ctx) {
    const eb = ctx.memberBonus.get(v) || { param: 0 };
    const cr = lastLe(m.characterRankBonus, v.characterRank);
    const ctr = lastLe(m.characterTotalRankBonus, ctx.totalRank);
    return v.power.map((p) => p + pctOf(p, eb.param) + cr + ctr + (ctx.flatBonus || 0));
  }

  /** Snap-independent slot power (whole points summed over the three stats). */
  function slotF(m, v, leaderPct, music, ctx) {
    const b = memberBase(m, v, ctx);
    let total = 0;
    for (let i = 0; i < 3; i++) {
      let x = b[i];
      x += pctOf(b[i], ctx.bandItemPct[i]);
      if (music) {
        if (v.cardType === MUSIC_TYPE_ALL || music.musicType === MUSIC_TYPE_ALL || v.cardType === music.musicType)
          x += pctOf(b[i], m.musicTypeBase + v.musicTypeRate + (music.typeBonusRate || 0));
        if (v.tags.some((tg) => music.tags.includes(tg)))
          x += pctOf(b[i], m.musicTagBase + v.musicTagRate + (music.tagBonusRate || 0));
      }
      x += pctOf(b[i], leaderPct[i]);
      x += pctOf(b[i], ctx.vipPct);
      total += x;
    }
    return total;
  }

  /** Snap part of a slot: snap percentage (with its event parameter bonus) and the type link. */
  function slotG(m, v, s, ctx) {
    if (!s) return 0;
    const b = memberBase(m, v, ctx);
    const sb = ctx.snapBonus.get(s) || { param: 0 };
    let total = 0;
    const link = v.cardType === s.cardType && s.typeLinkRate !== null ? m.typeLinkBase + s.typeLinkRate : 0;
    for (let i = 0; i < 3; i++) {
      total += pctOf(b[i], s.pct[i] + sb.param);
      if (link) total += pctOf(b[i], link);
    }
    return total;
  }

  /** Exact deck power of members (slot order, index 2 leads) and snaps (same order, null allowed). */
  function deckPower(m, members, snaps, music, ctx) {
    const lead = leaderBonuses(m, members, LEADER_SLOT, music);
    let p = 0;
    members.forEach((v, i) => {
      p += slotF(m, v, lead[i], music, ctx) + slotG(m, v, snaps[i], ctx);
    });
    return p;
  }

  /** Player-level context shared by every deck. */
  function makeContext(m, player, eventId, memberViews, snapViews) {
    const effects = eventId ? eventEffects(m, eventId) : [];
    const ranks = (player && player.characterRanks) || {};
    let totalRank = 0;
    for (const k of Object.keys(ranks)) totalRank += Number(ranks[k]) || 0;
    let vip = 0;
    for (const r of m.t.MasterVipRankBonus) if (r._vipBonusType === 7 && r._vipRank === (player.vipRank || 1)) vip = r._value;
    const bp = Number(player.bandItemPct) || 0; // simplified band item bonus: one percentage (BP) for every member
    const ctx = {
      effects,
      totalRank,
      vipPct: vip,
      bandItemPct: [bp, bp, bp],
      flatBonus: Number(player.flatBonus) || 0,
      memberBonus: new Map(),
      snapBonus: new Map(),
    };
    // The parameter bonus (type 2) is not in the in-game formation power nor in a solo live's score (checked against
    // screenshots), so it is off unless asked for.
    const withParam = !!player.eventParameters;
    const bonus = (v) => {
      const b = cardEventBonus(effects, v);
      if (!withParam) b.param = 0;
      return b;
    };
    for (const v of memberViews) ctx.memberBonus.set(v, bonus(v));
    for (const s of snapViews) ctx.snapBonus.set(s, bonus(s));
    return ctx;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Scores, ranks, event points

  function musicView(m, musicId) {
    const mu = m.musics.get(musicId);
    if (!mu) return null;
    return { id: mu._id, musicType: mu._musicType, tags: mu._bestMusicTagIDs || [], typeBonusRate: 0, tagBonusRate: 0 };
  }

  const DIFFS = [["_easyID", "easy"], ["_normalID", "normal"], ["_hardID", "hard"], ["_expertID", "expert"]];

  /** Score-rank thresholds (rank -> required score) of a song. */
  function rankThresholds(m, musicId) {
    const mu = m.musics.get(musicId);
    const out = [];
    for (const r of m.t.MasterLiveScoreRank) if (r._group === mu._liveScoreRankGroup) out.push([r._liveScoreRank, r._requiredScore]);
    return out.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Playable charts: {scoreId, musicId, difficulty, level, perPower, thresholds, lengthSec}. perPower is the no-skill score per
   * unit of power (music-data.json offSeeds, Gekisou off, every note Perfect); charts without it are skipped.
   */
  function charts(m, perPowerByScore, opts) {
    const now = opts.now || new Date();
    const out = [];
    const allowed = opts.musicIds ? new Set(opts.musicIds) : null;
    for (const mu of m.t.MasterLiveMusic) {
      if (allowed && !allowed.has(mu._id)) continue;
      if (!allowed && mu._startAt && parseTime(mu._startAt) > now) continue;
      const th = rankThresholds(m, mu._id);
      if (th.length === 0) continue;
      for (const [key, diff] of DIFFS) {
        const sid = mu[key];
        const sc = m.musicScores.get(sid);
        if (!sc) continue;
        if (opts.maxLevel && sc._musicScoreLevel > opts.maxLevel) continue;
        if (opts.difficulties && !opts.difficulties.includes(diff)) continue;
        const per = perPowerByScore.get(sid);
        if (!per) continue;
        const lengthSec = (opts.lengthByScore && opts.lengthByScore.get(sid)) || null;
        out.push({ scoreId: sid, musicId: mu._id, difficulty: diff, level: sc._musicScoreLevel, perPower: per, thresholds: th, lengthSec });
      }
    }
    return out;
  }

  function parseTime(s) {
    // "2026/09/30 15:00:00" or "2026-01-01 0:00:00", server local time; treated as local.
    const x = String(s).replace(/-/g, "/");
    const d = new Date(x);
    return isNaN(d) ? new Date(0) : d;
  }

  function scoreRankOf(thresholds, score) {
    let rank = 0;
    for (const [r, req] of thresholds) if (req <= score) rank = r;
    return rank;
  }

  /**
   * Event payoff tables: rank -> points value and item count, for normal or challenge lives, and for normal lives the
   * challenge points (CP) earned per unit of boost rate (no card bonus applies to them).
   */
  function payoff(m, event, mode) {
    const pointRows = mode === "challenge" ? m.t.MasterChallengeLiveEventPoint : m.t.MasterLiveEventPoint;
    const itemRows = mode === "challenge" ? m.t.MasterChallengeLiveEventReward : m.t.MasterLiveEventReward;
    const pg = mode === "challenge" ? event._challengeLiveEventPointGroup : event._liveEventPointGroup;
    const ig = mode === "challenge" ? event._challengeLiveEventRewardGroup : event._liveEventRewardGroup;
    const points = new Map();
    for (const r of pointRows) if (r._group === pg && !points.has(r._scoreRank)) points.set(r._scoreRank, r._value);
    const items = new Map();
    for (const r of itemRows)
      if (r._eventGroup === ig && r._resourceId === event._eventItemId && !items.has(r._scoreRank)) items.set(r._scoreRank, r._resourceCount);
    const cp = new Map();
    if (mode !== "challenge") for (const r of m.t.MasterLiveChallengePoint) if (!cp.has(r._scoreRank)) cp.set(r._scoreRank, r._value);
    return { points, items, cp };
  }

  /** Boost rate: normal lives by live boosts used, challenge lives by challenge points used. */
  function boostRate(m, mode, count) {
    if (mode === "challenge") {
      if (count < 201) return 1;
      const r = m.t.MasterChallengeMusicBoostBonus.find((x) => x._consumedChallengePointCount === count);
      return r ? r._eventPointRate : 1;
    }
    if (count < 1) return 1;
    const r = m.t.MasterLiveMusicBoostBonus.find((x) => x._consumedLiveBoostCount === count);
    return r ? r._eventPointRate : 1;
  }

  const eventPoints = (bonus, rate, value) => Math.trunc(((bonus + BP) * rate * value) / BP);
  const eventItems = (count, bonus, rate) => Math.trunc((count * (bonus + BP) * rate) / BP);

  // ---------------------------------------------------------------------------------------------------------------
  // Search
  //
  // Deck power = F(members, leader, song) + G(members, snaps), both sums of per-slot whole points. For every member set
  // (distinct characters) the best leader gives F exactly; the snap assignment is a small DP over filled-slot masks.
  // Sets are ranked by an upper bound of the objective and evaluated exactly until the bound falls below the k-th
  // best deck found.
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * DP over snaps assigning each to at most one of the five slots. Keeps, per filled-slot mask and per
   * (point bonus, item bonus) pair, the largest snap power. Returns every final state.
   */
  function snapStates(G, snapPoint, snapItem, nSnaps) {
    let states = [new Map([["0:0", { pt: 0, it: 0, power: 0, pick: null }]])];
    for (let mask = 1; mask < 32; mask++) states.push(new Map());
    for (let j = 0; j < nSnaps; j++) {
      const next = states.map((b) => new Map(b));
      for (let mask = 0; mask < 32; mask++) {
        for (const st of states[mask].values()) {
          for (let i = 0; i < 5; i++) {
            if (mask & (1 << i)) continue;
            const nm = mask | (1 << i);
            const pt = st.pt + snapPoint[j];
            const it = st.it + snapItem[j];
            const power = st.power + G[i][j];
            const key = pt + ":" + it;
            const cur = next[nm].get(key);
            if (!cur || cur.power < power) next[nm].set(key, { pt, it, power, pick: { i, j, prev: st.pick } });
          }
        }
      }
      states = next;
    }
    const out = [];
    for (const b of states) for (const st of b.values()) out.push(st);
    return out;
  }

  function pickToSnaps(pick) {
    const snaps = [null, null, null, null, null];
    for (let p = pick; p; p = p.prev) snaps[p.i] = p.j;
    return snaps;
  }

  function* combinations(n, k, start = 0, prefix = []) {
    if (prefix.length === k) {
      yield prefix;
      return;
    }
    for (let i = start; i <= n - (k - prefix.length); i++) yield* combinations(n, k, i + 1, prefix.concat([i]));
  }

  /** Whether a leader skill's percentages depend on the member alone (no conditions, no cumulative counts). */
  function simpleLeader(m, v) {
    return (m.leaderEffects.get(v.leaderSkillId + ":" + v.leaderSkillLevel) || []).every(
      (e) => e._skillConditionGroup <= 0 && (e._skillEffectType & ~3) !== 1500,
    );
  }

  /** Leader percentage (BP per stat) `leader` gives `v` when simple. */
  function simpleLeaderPct(m, leader, v) {
    const acc = [0, 0, 0];
    for (const e of m.leaderEffects.get(leader.leaderSkillId + ":" + leader.leaderSkillLevel) || []) {
      const ts = targetsOf(m, e._skillTargetIDs);
      if (!ts || matchesAny(v, ts)) accumulate(e._skillEffectType, e._effectValue, acc);
    }
    return acc;
  }

  /**
   * Finds the best decks for one event mode.
   * input: {master, event, mode: "normal"|"challenge", members: [owned], snaps: [owned], player, perPowerByScore,
   *         maxLevel, difficulties, calibration (score multiplier), powerCalibration (in-game / model power),
   *         boosts, objective: "points"|"items", topK, musicIds, fixed: {memberIds, excludeMemberIds},
   *         cpValue: event points one challenge point is worth (normal lives; 0 ignores the CP they earn),
   *         compareSongs: also return `songs`, the best deck of every song, lengthByScore: scoreId -> seconds}
   */
  function search(input) {
    const t0 = Date.now();
    const m = input.master;
    const event = input.event;
    const mode = input.mode || "normal";
    const player = input.player || {};
    const topK = input.topK || 5;
    const calib = input.calibration || 1;
    const pcal = input.powerCalibration || 1;
    const exclude = new Set((input.excludeMemberIds || []).map(Number));
    const members = input.members.filter((o) => !exclude.has(Number(o.id))).map((o) => memberView(m, o, player)).filter(Boolean);
    const snaps = input.snaps.map((o) => snapView(m, o)).filter(Boolean);
    const ctx = makeContext(m, player, event._id, members, snaps);
    const pay = payoff(m, event, mode);
    const rate = boostRate(m, mode, input.boosts || 0);
    const W = input.objective === "items" ? { point: 1, item: 1e6 } : { point: 1e6, item: 1 };
    const cpValue = mode === "challenge" ? 0 : input.cpValue || 0;
    const cpOf = (rank) => (pay.cp.get(rank) || 0) * rate;
    const scoreOf = (points, items, rank) => (points + cpOf(rank) * cpValue) * W.point + items * W.item;

    const musicIds = mode === "challenge"
      ? m.t.MasterChallengeMusic.filter((r) => r._eventId === event._id).map((r) => r._liveMusicId)
      : input.musicIds || null;
    const chartList = charts(m, input.perPowerByScore, {
      maxLevel: input.maxLevel,
      difficulties: input.difficulties,
      musicIds,
      now: input.now,
      lengthByScore: input.lengthByScore,
    });
    if (chartList.length === 0) return { error: "no-charts", results: [] };

    // Charts grouped by the song features that change deck power.
    const groups = new Map();
    for (const c of chartList) {
      const mv = musicView(m, c.musicId);
      if (mode === "challenge") {
        const row = m.t.MasterChallengeMusic.find((r) => r._eventId === event._id && r._liveMusicId === c.musicId);
        if (row && row._musicType) mv.musicType = row._musicType;
      }
      const key = mv.musicType + "|" + mv.tags.join(",");
      if (!groups.has(key)) groups.set(key, { music: mv, charts: [] });
      groups.get(key).charts.push(c);
    }

    // Candidate member cards: per character, those not dominated in (point bonus, item bonus, raw power).
    const baseSum = new Map(members.map((v) => [v, memberBase(m, v, ctx).reduce((a, b) => a + b, 0)]));
    const byChar = new Map();
    for (const v of members) {
      if (!byChar.has(v.characterId)) byChar.set(v.characterId, []);
      byChar.get(v.characterId).push(v);
    }
    const candidates = [];
    for (const list of byChar.values()) {
      const kept = list.filter((a) => {
        const ea = ctx.memberBonus.get(a);
        return !list.some((b) => {
          if (b === a) return false;
          const eb = ctx.memberBonus.get(b);
          const ge = eb.point >= ea.point && eb.item >= ea.item && baseSum.get(b) >= baseSum.get(a);
          const gt = eb.point > ea.point || eb.item > ea.item || baseSum.get(b) > baseSum.get(a);
          return ge && (gt || b.id < a.id) && a.leaderSkillId === b.leaderSkillId ? true : ge && gt && !isUsefulLeader(a);
        });
      });
      candidates.push(kept.slice(0, 4));
    }
    function isUsefulLeader(v) {
      return (m.leaderEffects.get(v.leaderSkillId + ":" + v.leaderSkillLevel) || []).some((e) => e._effectValue > 0);
    }
    if (candidates.length < 5) return { error: "not-enough-characters", results: [] };
    const allCand = candidates.flat();

    // Snap parts (independent of the song).
    const snapPoint = snaps.map((s) => ctx.snapBonus.get(s).point);
    const snapItem = snaps.map((s) => ctx.snapBonus.get(s).item);
    const topSum = (arr, k) => [...arr].sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + Math.max(0, b), 0);
    const maxSnapPoint = topSum(snapPoint, 5);
    const maxSnapItem = topSum(snapItem, 5);
    const Gm = new Map();
    const bestG = new Map();
    for (const v of allCand) {
      const row = snaps.map((s) => slotG(m, v, s, ctx));
      Gm.set(v, row);
      bestG.set(v, row.length ? Math.max(0, ...row) : 0);
    }
    // Leader terms for simple leaders: leaderTerm.get(L).get(v) = whole points L's skill adds to v's slot.
    const leaders = allCand.filter((v) => simpleLeader(m, v));
    const leaderTerm = new Map();
    for (const L of leaders) {
      const row = new Map();
      for (const v of allCand) {
        const pct = simpleLeaderPct(m, L, v);
        const b = memberBase(m, v, ctx);
        row.set(v, pctOf(b[0], pct[0]) + pctOf(b[1], pct[1]) + pctOf(b[2], pct[2]));
      }
      leaderTerm.set(L, row);
    }

    // Member sets (song independent): characters choose 5, one candidate card each.
    const sets = [];
    for (const cs of combinations(candidates.length, 5)) {
      const lists = cs.map((c) => candidates[c]);
      const idx = [0, 0, 0, 0, 0];
      for (;;) {
        const vs = lists.map((l, i) => l[idx[i]]);
        let pt = 0, it = 0, g = 0;
        for (const v of vs) {
          const eb = ctx.memberBonus.get(v);
          pt += eb.point;
          it += eb.item;
          g += bestG.get(v);
        }
        sets.push({ vs, pt, it, g });
        let k = 4;
        while (k >= 0 && ++idx[k] >= lists[k].length) idx[k--] = 0;
        if (k < 0) break;
      }
    }

    // Per rank, the chart needing the least power among `list`; rankFor(power) is the best rank that power reaches.
    function rankTable(list) {
      const need = new Map();
      for (const c of list) {
        for (const [r, req] of c.thresholds) {
          const p = Math.ceil(req / (c.perPower * calib) / pcal);
          const cur = need.get(r);
          if (!cur || p < cur.power || (p === cur.power && c.level < cur.chart.level)) need.set(r, { power: p, chart: c });
        }
      }
      const rankList = [...need.keys()].sort((a, b) => b - a);
      const rankFor = (power) => {
        for (const r of rankList) if (need.get(r).power <= power) return r;
        return rankList[rankList.length - 1];
      };
      return { need, rankList, rankFor };
    }
    const upperBound = (s, bf, rt) => {
      const r = rt.rankFor(bf.f + s.g);
      return scoreOf(
        eventPoints(s.pt + maxSnapPoint, rate, pay.points.get(r) || 0),
        eventItems(pay.items.get(r) || 0, s.it + maxSnapItem, rate),
        r,
      );
    };
    // The exact best deck of a member set: leader from bestF, snaps from the slot-mask DP.
    function evaluate(s, bf, rt, music) {
      evaluated++;
      const order = s.vs.slice();
      [order[bf.leader], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[bf.leader]];
      const G = order.map((v) => Gm.get(v));
      let best = null;
      for (const st of snapStates(G, snapPoint, snapItem, snaps.length)) {
        const power = bf.f + st.power;
        const rank = rt.rankFor(power);
        const pb = s.pt + st.pt;
        const ib = s.it + st.it;
        const points = eventPoints(pb, rate, pay.points.get(rank) || 0);
        const items = eventItems(pay.items.get(rank) || 0, ib, rate);
        const sc = scoreOf(points, items, rank);
        if (!best || sc > best.sc || (sc === best.sc && power > best.power)) best = { sc, power, rank, pb, ib, points, items, st };
      }
      const snapObjs = pickToSnaps(best.st.pick).map((j) => (j === null ? null : snaps[j]));
      const deck = {
        members: order,
        snaps: snapObjs,
        power: best.power,
        displayPower: Math.floor(best.power * pcal),
        rank: best.rank,
        rankName: RANK_NAMES[best.rank] || String(best.rank),
        chart: rt.need.get(best.rank).chart,
        needPower: rt.need.get(best.rank).power,
        needDisplayPower: Math.ceil(rt.need.get(best.rank).power * pcal),
        pointBonus: best.pb,
        itemBonus: best.ib,
        points: best.points,
        items: best.items,
        cp: cpOf(best.rank),
        cpPoints: cpOf(best.rank) * cpValue,
        score: best.sc,
        music,
      };
      const nextRank = rt.rankList.slice().reverse().find((r) => r > best.rank);
      if (nextRank) {
        deck.nextRank = nextRank;
        deck.nextRankName = RANK_NAMES[nextRank];
        deck.nextNeedDisplayPower = Math.ceil(rt.need.get(nextRank).power * pcal);
      }
      deck.estScore = Math.floor(best.power * pcal * deck.chart.perPower * calib);
      return deck;
    }

    const found = [];
    const songs = [];
    let evaluated = 0;
    for (const group of groups.values()) {
      const music = group.music;
      const rt = rankTable(group.charts);
      const fNo = new Map(allCand.map((v) => [v, slotF(m, v, [0, 0, 0], music, ctx)]));

      // Best leader F of each set: simple leaders from precomputed terms, others exactly.
      const bestF = (vs) => {
        let base = 0;
        for (const v of vs) base += fNo.get(v);
        let best = { f: base, leader: 0 };
        for (let L = 0; L < 5; L++) {
          const lv = vs[L];
          let f;
          const row = leaderTerm.get(lv);
          if (row) {
            f = base;
            for (const v of vs) f += row.get(v);
          } else {
            const order = vs.slice();
            [order[L], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[L]];
            const lead = leaderBonuses(m, order, LEADER_SLOT, music);
            f = 0;
            order.forEach((v, i) => (f += slotF(m, v, lead[i], music, ctx)));
          }
          if (f > best.f || (L === 0 && best.leader === 0 && f >= best.f)) best = { f, leader: L };
        }
        return best;
      };

      const bfs = sets.map((s) => bestF(s.vs));
      const scored = sets.map((s, i) => ({ s, bf: bfs[i], ub: upperBound(s, bfs[i], rt) }));
      scored.sort((a, b) => b.ub - a.ub);

      const groupFound = [];
      let kth = -Infinity;
      for (const { s, bf, ub } of scored) {
        if (groupFound.length >= topK && ub < kth) break;
        groupFound.push(evaluate(s, bf, rt, music));
        groupFound.sort((a, b) => b.score - a.score || b.power - a.power);
        if (groupFound.length > topK) groupFound.length = topK;
        if (groupFound.length >= topK) kth = groupFound[topK - 1].score;
      }
      found.push(...groupFound);

      // Song comparison: the best deck of every song of the group, from the same leader terms. The set with the
      // highest bound gives a floor; only sets whose bound reaches it can beat it.
      if (input.compareSongs) {
        const bySong = new Map();
        for (const c of group.charts) {
          if (!bySong.has(c.musicId)) bySong.set(c.musicId, []);
          bySong.get(c.musicId).push(c);
        }
        for (const list of bySong.values()) {
          const srt = rankTable(list);
          const ubs = new Float64Array(sets.length);
          let top = 0;
          for (let i = 0; i < sets.length; i++) {
            ubs[i] = upperBound(sets[i], bfs[i], srt);
            if (ubs[i] > ubs[top]) top = i;
          }
          let best = evaluate(sets[top], bfs[top], srt, music);
          const rest = [];
          for (let i = 0; i < sets.length; i++) if (i !== top && ubs[i] >= best.score) rest.push(i);
          rest.sort((a, b) => ubs[b] - ubs[a]);
          for (const i of rest) {
            if (ubs[i] < best.score) break;
            const d = evaluate(sets[i], bfs[i], srt, music);
            if (d.score > best.score || (d.score === best.score && d.power > best.power)) best = d;
          }
          songs.push(best);
        }
      }
    }
    found.sort((a, b) => b.score - a.score || b.power - a.power);
    const seen = new Set();
    const results = [];
    for (const d of found) {
      const key = d.members.map((v) => v.id).sort().join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(d);
      if (results.length >= topK) break;
    }
    songs.sort((a, b) => b.score - a.score || b.power - a.power);
    return { results, songs, rate, payoff: pay, ctx, stats: { sets: sets.length, evaluated, groups: groups.size, ms: Date.now() - t0 } };
  }

  /**
   * Plan for the most event points from live boosts: every normal live also earns CP, and challenge lives turn
   * CP into points at a fixed rate per CP (200/400/800/1600 CP give ×1/×2/×4/×8). The challenge deck is chosen
   * first; its points per CP then values the CP of each normal deck.
   */
  function planEvent(input) {
    const challenge = search({ ...input, mode: "challenge", boosts: 200, objective: "points" });
    const best = challenge.results[0];
    const cpValue = best ? best.points / 200 : 0;
    const normal = search({ ...input, mode: "normal", objective: "points", cpValue });
    return { challenge, normal, cpValue };
  }

  /** Per-card event bonuses for display. */
  function describeEventBonus(m, eventId, v) {
    return cardEventBonus(eventEffects(m, eventId), v);
  }

  /** The event being held at `now` (else the latest started one). */
  function currentEvent(m, now) {
    const t = now || new Date();
    const list = m.t.MasterEvent.slice().sort((a, b) => parseTime(a._startAt) - parseTime(b._startAt));
    let pick = null;
    for (const e of list) if (parseTime(e._startAt) <= t) pick = e;
    const holding = list.find((e) => parseTime(e._startAt) <= t && t <= parseTime(e._endAt));
    return holding || pick || list[list.length - 1] || null;
  }

  /** perPower map from nnnotes music-data.json. */
  function perPowerFromMusicData(md) {
    const out = new Map();
    const P = md && md.deck && md.deck.model && md.deck.model.power;
    if (!P) return out;
    for (const s of md.songs || []) {
      for (const c of s.charts || []) {
        const off = c.deck && c.deck.offSeeds && c.deck.offSeeds[0];
        if (off && off.score) out.set(c.scoreId, off.score / P);
      }
    }
    return out;
  }

  /** Song length in seconds of every chart (scoreId -> seconds), from music-data.json. */
  function chartLengthsFromMusicData(md) {
    const out = new Map();
    for (const s of (md && md.songs) || []) for (const c of s.charts || []) if (c.musicLengthMs) out.set(c.scoreId, c.musicLengthMs / 1000);
    return out;
  }

  const api = {
    TABLES, RANK_NAMES, buildMaster, memberView, snapView, memberLimits, snapLimit, makeContext, deckPower,
    leaderBonuses, cardEventBonus, eventEffects, describeEventBonus, payoff, boostRate, eventPoints, eventItems,
    charts, rankThresholds, scoreRankOf, search, planEvent, currentEvent, perPowerFromMusicData, chartLengthsFromMusicData, musicView,
    parseTime,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== "undefined" ? self : this);
