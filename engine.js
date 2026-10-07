/*
 * BanG Dream! Our Notes event deck calculator: the calculation core.
 *
 * Deck power follows ournotes-deck (github.com/empty-sekai/ournotes-deck), which ports the game client's own
 * arithmetic: per-slot terms floored to whole points in binary32, summed over the five slots. Event points and items
 * follow the client formulas there as well:
 *   points = (10000 + pointBonus) * boostRate * value(rank) / 10000
 *   items  = count(rank) * (10000 + itemBonus) * boostRate / 10000
 * The live score is estimated as power * (no-skill score per unit of power of the chart, from nnnotes'
 * music-data.json, plus the members' expected live skill gain) * a play accuracy factor.
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
    "MasterLiveMusicBoostBonus", "MasterChallengeMusicBoostBonus", "MasterLiveSkill", "MasterLiveSkillEffect", "MasterText",
    "MasterBandItem", "MasterBandItemSkillEffect", "MasterLiveComboScoreBonus", "MasterGekisouSkill",
    "MasterGekisouSkillEffect", "MasterGekisouSupportSkill", "MasterGekisouSupportSkillEffect", "MasterLiveJudgementTiming",
    "MasterSupportSkillEffect",
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
      gekisouSkills: byId(t.MasterGekisouSkill),
      gekisouSupportSkills: byId(t.MasterGekisouSupportSkill),
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
      liveSkillEffects: new Map(),
      liveSkillMaxLevel: new Map(),
      gekisouSkillEffects: new Map(),
      gekisouSkillMaxLevel: new Map(),
      gekisouSupportSkillEffects: new Map(),
      gekisouSupportSkillMaxLevel: new Map(),
      supportSkillEffects: new Map(),
      bandItemEffects: new Map(),
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
    for (const r of t.MasterLiveSkillEffect) {
      const k = r._liveSkillID + ":" + r._level;
      if (!m.liveSkillEffects.has(k)) m.liveSkillEffects.set(k, []);
      m.liveSkillEffects.get(k).push(r);
      m.liveSkillMaxLevel.set(r._liveSkillID, Math.max(m.liveSkillMaxLevel.get(r._liveSkillID) || 1, r._level));
    }
    for (const r of t.MasterGekisouSkillEffect) {
      const k = r._gekisouSkillID + ":" + r._level;
      if (!m.gekisouSkillEffects.has(k)) m.gekisouSkillEffects.set(k, []);
      m.gekisouSkillEffects.get(k).push(r);
      m.gekisouSkillMaxLevel.set(r._gekisouSkillID, Math.max(m.gekisouSkillMaxLevel.get(r._gekisouSkillID) || 1, r._level));
    }
    for (const r of t.MasterGekisouSupportSkillEffect) {
      const k = r._gekisouSupportSkillID + ":" + r._level;
      if (!m.gekisouSupportSkillEffects.has(k)) m.gekisouSupportSkillEffects.set(k, []);
      m.gekisouSupportSkillEffects.get(k).push(r);
      const id = r._gekisouSupportSkillID;
      m.gekisouSupportSkillMaxLevel.set(id, Math.max(m.gekisouSupportSkillMaxLevel.get(id) || 1, r._level));
    }
    for (const r of t.MasterSupportSkillEffect) {
      const k = r._supportSkillID + ":" + r._level;
      if (!m.supportSkillEffects.has(k)) m.supportSkillEffects.set(k, []);
      m.supportSkillEffects.get(k).push(r);
    }
    // Judgement types that can be judged Just (inside a Just-count range of a live with Gekisou).
    m.justTypes = new Set(t.MasterLiveJudgementTiming.filter((r) => r._noteSimulateJudgement === 6).map((r) => r._noteJudgementType));
    for (const r of t.MasterBandItemSkillEffect) {
      const k = r._bandItemId + ":" + r._level;
      if (!m.bandItemEffects.has(k)) m.bandItemEffects.set(k, []);
      m.bandItemEffects.get(k).push(r);
    }
    // Combo bonus (type 0): [required combo, running binary32 sum of the factors], as ournotes-deck ComboTable.
    let comboAcc = 0;
    m.comboBonus = t.MasterLiveComboScoreBonus.filter((r) => r._comboBonusType === 0)
      .sort((a, b) => a._requiredComboCount - b._requiredComboCount)
      .map((r) => [r._requiredComboCount, (comboAcc = f32(comboAcc + r._bonusFactor))]);
    m.breakFactors = new Map();
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

  /**
   * Band item (強化樂團) percentages (BP) of a member, per stat, from `player.bandItems` ({itemId: level}, 0 = not
   * opened). As ournotes-deck bonus.rs BandItemMaps: each target of an effect row counts separately under its band,
   * character and card type, so a target naming both a band and a character of the member counts twice.
   */
  function bandItemBonus(m, items, characterId, bandId, cardType) {
    const acc = [0, 0, 0];
    for (const [item, level] of Object.entries(items || {})) {
      for (const r of m.bandItemEffects.get(item + ":" + Number(level)) || []) {
        for (const tid of r._skillTargetIDs || []) {
          const t = m.skillTargets.get(tid);
          if (!t) continue;
          let n = 0;
          if (t._bandID > 0 && t._bandID === bandId) n++;
          if (t._characterID > 0 && t._characterID === characterId) n++;
          if (t._cardType !== 0 && t._cardType === cardType) n++;
          for (let k = 0; k < n; k++) accumulate(r._skillEffectType, r._effectValue, acc);
        }
      }
    }
    return acc;
  }

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
    const skillMax = m.liveSkillMaxLevel.get(c._liveSkillID) || 1;
    const gekisouMax = m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1;
    const gekisou = m.gekisouSkills.get(c._gekisouSkillID);
    const gekisouLevel = Math.min(gekisouMax, Math.max(1, Math.floor(Number(owned.gekisouSkillLevel) || 1)));
    return {
      kind: "member",
      liveSkillCategories: live ? live._skillCategories || [] : [],
      gekisouSkillCategories: gekisou ? gekisou._skillCategories || [] : [],
      gekisouMissionType: gekisou ? gekisou._gekisouMissionType || 0 : 0,
      liveSkillId: c._liveSkillID,
      liveSkillLevel: Math.min(skillMax, Math.max(1, Math.floor(Number(owned.skillLevel) || 1))),
      gekisouSkillId: c._gekisouSkillID || 0,
      gekisouSkillLevel: gekisouLevel,
      luckGauge: luckGaugeOf(m, c._gekisouSkillID, gekisouLevel),
      comboCount: comboCountOf(m, c._gekisouSkillID, gekisouLevel),
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
      bandItemPct: bandItemBonus(m, player && player.bandItems, c._characterID, ch ? ch._bandID : 0, c._cardType),
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
    // Snap skills at the levels the snap's rank gives (ournotes-deck cards.rs), as [skillId, level].
    const supportSkills = [];
    if (rk && s._supportSkillId01) supportSkills.push([s._supportSkillId01, rk._supportSkill01Level]);
    if (rk && s._supportSkillId02) supportSkills.push([s._supportSkillId02, rk._supportSkill02Level]);
    // Gekisou support skills (multiplayer lives only; they act when the paired member has a Gekisou skill).
    const gekisouSupportSkills = [];
    if (rk && s._gekisouSupportSkillId01) gekisouSupportSkills.push([s._gekisouSupportSkillId01, rk._gekisouSupportSkill01Level]);
    if (rk && s._gekisouSupportSkillId02) gekisouSupportSkills.push([s._gekisouSupportSkillId02, rk._gekisouSupportSkill02Level]);
    return {
      kind: "snap",
      id: s._id,
      supportSkills,
      gekisouSupportSkills,
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
    const gcats = t._gekisouSkillCategories || [];
    if (gcats.length && v.gekisouSkillCategories.some((c) => gcats.includes(c))) return true;
    // e.g. Cute·Float's leader skill: +18% Vis to cards whose Gekisou skill is a Just mission (power.test.js, 402409).
    return t._gekisouMissionType > 0 && t._gekisouMissionType === v.gekisouMissionType;
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
      x += pctOf(b[i], v.bandItemPct[i]);
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
  function makeContext(m, player, eventId, memberViews, snapViews, mode) {
    const effects = eventId ? eventEffects(m, eventId) : [];
    const ranks = (player && player.characterRanks) || {};
    let totalRank = 0;
    for (const k of Object.keys(ranks)) totalRank += Number(ranks[k]) || 0;
    let vip = 0;
    for (const r of m.t.MasterVipRankBonus) if (r._vipBonusType === 7 && r._vipRank === (player.vipRank || 1)) vip = r._value;
    const ctx = {
      effects,
      totalRank,
      vipPct: vip,
      flatBonus: Number(player.flatBonus) || 0,
      memberBonus: new Map(),
      snapBonus: new Map(),
    };
    // The parameter bonus (type 2) is not in a normal live's formation power nor its solo score (results/IMG_0038,
    // IMG_0040), but a challenge live applies it to both (results/IMG_0041: 244053 shown = model with it). Normal lives
    // count it only when asked for.
    const withParam = mode === "challenge" || !!player.eventParameters;
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

  /** Multiplayer (激奏) rank thresholds of a song: rank -> _battleLiveRequiredScore, the base for 5 players. */
  function battleThresholds(m, musicId) {
    const mu = m.musics.get(musicId);
    const out = [];
    for (const r of m.t.MasterLiveScoreRank) if (r._group === mu._liveScoreRankGroup) out.push([r._liveScoreRank, r._battleLiveRequiredScore]);
    return out.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Room total score a multiplayer rank needs with `players` connected players: trunc(sqrt(5 / n) * base * n)
   * (ournotes-deck event.rs battle_required_score). The room's rank, not the player's own, sets the event payoff.
   */
  function battleRequiredScore(base, players) {
    if (players < 1) return Infinity;
    return Math.trunc(Math.sqrt(5 / players) * base * players);
  }

  /**
   * Playable charts: {scoreId, musicId, difficulty, level, perPower, thresholds, battle, lengthSec}. perPower is the no-skill score per
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
      const battle = battleThresholds(m, mu._id);
      for (const [key, diff] of DIFFS) {
        const sid = mu[key];
        const sc = m.musicScores.get(sid);
        if (!sc) continue;
        if (opts.maxLevel && sc._musicScoreLevel > opts.maxLevel) continue;
        if (opts.difficulties && !opts.difficulties.includes(diff)) continue;
        const per = perPowerByScore.get(sid);
        if (!per) continue;
        const lengthSec = (opts.lengthByScore && opts.lengthByScore.get(sid)) || null;
        out.push({ scoreId: sid, musicId: mu._id, difficulty: diff, level: sc._musicScoreLevel, perPower: per, thresholds: th, battle, lengthSec });
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
   * DP over snaps assigning each to at most one of the five slots. Keeps, per filled-slot mask, the states that no
   * other matches or beats in point bonus, item bonus, pair rate and snap power. Returns the final states kept the
   * same way. A snap that five others match or beat in bonuses, and in power and pair rate on every slot, is skipped:
   * one of those five is always free to take its place. `X` (or null): X[slot][snap] = the snap's pair rate with that
   * slot's member (the score objective: its snap skills' and Gekisou support skills' score per unit of power on the
   * chart; points on a random song: supportMeans); a state's `x` sums them.
   */
  function snapStates(G, snapPoint, snapItem, nSnaps, X) {
    const atLeast = (k, j) => {
      if (snapPoint[k] < snapPoint[j] || snapItem[k] < snapItem[j]) return false;
      for (let i = 0; i < 5; i++) if (G[i][k] < G[i][j] || (X && X[i][k] < X[i][j])) return false;
      return true;
    };
    const useful = [];
    for (let j = 0; j < nSnaps; j++) {
      let n = 0;
      for (let k = 0; k < nSnaps && n < 5; k++) {
        if (k !== j && atLeast(k, j) && (k < j || !atLeast(j, k))) n++;
      }
      if (n < 5) useful.push(j);
    }
    // Pareto front in (pt, it, x, power): what the callers rank states by is monotone in all four, and a dominated
    // partial state stays dominated whatever snaps are added to it. Ties keep the earlier state.
    const front = (list) => {
      list.sort((a, b) => b.power - a.power || b.pt - a.pt || b.it - a.it || b.x - a.x);
      const kept = [];
      for (const st of list) if (!kept.some((k) => k.pt >= st.pt && k.it >= st.it && k.x >= st.x)) kept.push(st);
      return kept;
    };
    let states = [[{ pt: 0, it: 0, x: 0, power: 0, pick: null }]];
    for (let mask = 1; mask < 32; mask++) states.push([]);
    for (const j of useful) {
      const next = states.map((b) => b.slice());
      for (let mask = 0; mask < 32; mask++) {
        for (const st of states[mask]) {
          for (let i = 0; i < 5; i++) {
            if (mask & (1 << i)) continue;
            next[mask | (1 << i)].push({
              pt: st.pt + snapPoint[j], it: st.it + snapItem[j], x: X ? st.x + X[i][j] : 0, power: st.power + G[i][j], pick: { i, j, prev: st.pick },
            });
          }
        }
      }
      states = next.map((b, mask) => (b.length > states[mask].length ? front(b) : b));
    }
    return front([].concat(...states));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live skills

  /**
   * Live skill weights from nnnotes music-data.json `deck`: {kinds, byScore: scoreId -> Float64Array per kind}. One
   * effect of kind q at factor f at performance position k adds P * f * weights[q][k] (offSeeds: Gekisou off, every
   * note Perfect). The client shuffles the performance order uniformly at the start of every live, so a member's
   * expected gain uses the mean over the five positions; positions the chart never fires weigh 0.
   */
  function skillWeightsFromMusicData(md) {
    const kinds = (md && md.deck && md.deck.kinds) || [];
    const byScore = new Map();
    for (const s of (md && md.songs) || []) {
      for (const c of s.charts || []) {
        const off = c.deck && c.deck.offSeeds && c.deck.offSeeds[0];
        if (!off || !off.weights) continue;
        const w = new Float64Array(kinds.length);
        off.weights.forEach((row, q) => {
          if (row) w[q] = row.reduce((a, b) => a + (b || 0), 0) / 5;
        });
        byScore.set(c.scoreId, w);
      }
    }
    return { kinds, byScore };
  }

  /** The factor the game's applier makes of an effect value (music-data.json `deck` documentation). */
  function skillFactor(type, value) {
    if (type === 2000) return Math.floor(f32(f32(value / 10000) * 1e5)) / 1e5;
    if (type === 2005) return Math.floor(f32(f32(value / -10000) * 1e5)) / 1e5;
    return f32(value / 10000);
  }

  /** The music-data kind of a MasterLiveSkillEffect row, or null (cumulative conditions and unknown shapes). */
  function skillKindOf(kinds, e) {
    if (e._skillCumulativeConditionID) return null;
    const ids = e._skillTargetIDs || [];
    return (
      kinds.find(
        (k) =>
          k.effectType === e._skillEffectType &&
          k.activationTimeSecond === e._activationTimeSecond &&
          (k.skillTargetIds || []).length === ids.length &&
          (k.skillTargetIds || []).every((x, i) => x === ids[i]) &&
          k.skillConditionGroup === e._skillConditionGroup &&
          k.skillReleaseConditionGroup === e._skillReleaseConditionGroup &&
          k.effectLimitCount === e._effectLimitCount &&
          k.effectExecuteLimitCount === e._effectExecuteLimitCount &&
          k.effectExecuteLimitResetConditionGroup === e._effectExecuteLimitResetConditionGroup,
      ) || null
    );
  }

  /** Score-up terms [kind id, factor] of a member's live skill at its level; rows of no kind add nothing. */
  function liveSkillTerms(m, v, kinds) {
    const out = [];
    for (const e of m.liveSkillEffects.get(v.liveSkillId + ":" + v.liveSkillLevel) || []) {
      const k = skillKindOf(kinds, e);
      if (k) out.push([k.id, skillFactor(e._skillEffectType, e._effectValue)]);
    }
    return out;
  }

  /** Expected live skill score per unit of power of `members` on chart `scoreId` (0 without weights). */
  function liveSkillRate(m, members, scoreId, skillWeights) {
    const w = skillWeights && skillWeights.byScore.get(scoreId);
    if (!w) return 0;
    let r = 0;
    for (const v of members) for (const [q, f] of liveSkillTerms(m, v, skillWeights.kinds)) r += f * w[q];
    return r;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Snap skills
  //
  // A snap's skills act for the member it is paired with: 15000 extends that member's running live skills (by 0.25–5
  // s, often double when the member is in the snap's band), 2000–2005 add score. What a pairing adds at a performance
  // position does not depend on the other slots (as for live skills, see Simulate.orderScores), so the replay measures
  // each kind of pairing once per chart (Simulate.snapSkillRates) and the search adds the pairs' rates.

  // Effect types that can change the score of an all-Perfect play. Heal (3001), guard (3003) and Great to Perfect
  // (12006) cannot.
  const SNAP_SCORE_EFFECTS = new Set([2000, 2001, 2002, 2003, 2004, 2005, 15000]);
  // Condition types that do not read the paired member: its own live skill starting (4010, 5020), never in a solo
  // live (8000) and the life (2000–2004). 5000 reads the paired member and is evaluated here.
  const PAIR_FREE_CONDITIONS = new Set([4010, 5020, 8000, 2000, 2001, 2002, 2003, 2004]);

  /**
   * What decides the score a snap `s` adds paired with member `v` (views): the member's live skill and level, the
   * snap's skills, and per effect row whether its member conditions (5000) hold. Another member condition makes the
   * key name the member card. null when the snap's skills cannot change the score.
   */
  function snapSkillKey(m, v, s) {
    const rows = [];
    for (const [id, level] of s.supportSkills || []) {
      for (const e of m.supportSkillEffects.get(id + ":" + level) || []) if (SNAP_SCORE_EFFECTS.has(e._skillEffectType)) rows.push(e);
    }
    if (!rows.length || (rows.every((e) => e._skillEffectType === 15000) && !v.liveSkillId)) return null;
    let perCard = false;
    // Whether the conditions of `groups` hold for v; other member conditions make the key per card.
    const holds = (groups) => {
      let hit = true;
      for (const g of groups) {
        for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (!c || c._conditionType === 0 || PAIR_FREE_CONDITIONS.has(c._conditionType)) continue;
            if (c._conditionType === 5000) {
              if (matchesAny(v, targetsOf(m, c._conditionTargetIDs)) !== c._isPositive) hit = false;
            } else perCard = true;
          }
        }
      }
      return hit;
    };
    const mask = rows.map((e) => (holds([e._skillConditionGroup, e._skillTriggerConditionGroup, e._skillReleaseConditionGroup]) ? "1" : "0")).join("");
    // A live skill condition reading its member would also tell members of one live skill apart.
    for (const e of m.liveSkillEffects.get(v.liveSkillId + ":" + v.liveSkillLevel) || []) {
      for (const g of [e._skillConditionGroup, e._skillReleaseConditionGroup]) {
        for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c && c._conditionType !== 0 && !PAIR_FREE_CONDITIONS.has(c._conditionType)) perCard = true;
          }
        }
      }
    }
    const skills = s.supportSkills.map((x) => x.join(":")).join(",");
    return `${perCard ? "c" + v.id + ":" + v.liveSkillLevel : v.liveSkillId + ":" + v.liveSkillLevel}|${skills}|${mask}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Play accuracy

  /**
   * Score share kept when the combo breaks (Miss or Bad) at judged note i of n, for every i. A note scores in
   * proportion to 1 + min(combo bonus, 1) at the combo before it (ournotes-deck score.rs), so with equal note weights
   * a break at i keeps F(i) + F(n - i - 1) of F(n), F(k) the summed factors of an unbroken run of k notes. Skills and
   * note types weigh notes unequally; on 夢現妄想世界 EXPERT this is within 1.3% of the simulation.
   */
  function comboBreakFactors(m, n) {
    if (m.breakFactors.has(n)) return m.breakFactors.get(n);
    const F = new Float64Array(n + 1);
    let k = 0;
    for (let c = 0; c < n; c++) {
      while (k < m.comboBonus.length && m.comboBonus[k][0] <= c) k++;
      F[c + 1] = F[c] + 1 + Math.min(k ? m.comboBonus[k - 1][1] : 0, 1);
    }
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = (F[i] + F[n - i - 1]) / F[n];
    m.breakFactors.set(n, g);
    return g;
  }

  /**
   * Score shares a play on chart `scoreId` keeps, as weighted outcomes [share, weight]: accuracy {perfectRate (0..1),
   * breaks (combo breaks per live)}. Each non-Perfect note is taken as a Great (80%). Breaks fall at uniform judged
   * notes: enumerated for one break, sampled (fixed seed) for more; a fraction of a break mixes the two neighbouring
   * counts.
   */
  function playShares(m, scoreId, accuracy) {
    const great = accuracy ? 1 - 0.2 * Math.min(1, Math.max(0, 1 - (accuracy.perfectRate ?? 1))) : 1;
    const b = accuracy ? Math.max(0, accuracy.breaks || 0) : 0;
    const sc = m.musicScores.get(scoreId);
    const n = sc ? sc._fullComboCount : 0;
    if (!b || n < 2) return [[great, 1]];
    const g = comboBreakFactors(m, n);
    const k = Math.floor(b);
    const frac = b - k;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const of = (breaks, weight) => {
      if (!weight) return [];
      if (breaks === 0) return [[great, weight]];
      if (breaks === 1) return Array.from(g, (x) => [great * x, weight / n]);
      const N = 2000;
      return Array.from({ length: N }, () => {
        let x = great;
        for (let j = 0; j < breaks; j++) x *= g[Math.floor(rnd() * n)];
        return [x, weight / N];
      });
    };
    return of(k, 1 - frac).concat(of(k + 1, frac));
  }

  /** Expected score share of a play on chart `scoreId` (the mean of playShares). */
  function accuracyFactor(m, scoreId, accuracy) {
    return playShares(m, scoreId, accuracy).reduce((a, [x, w]) => a + x * w, 0);
  }

  /** K equal-weight quantiles (ascending) of playShares, for rank chances in the search. */
  function shareQuantiles(m, scoreId, accuracy, K = 64) {
    const out = playShares(m, scoreId, accuracy).sort((a, b) => a[0] - b[0]);
    const q = new Float64Array(K);
    let acc = 0;
    let i = 0;
    for (let k = 0; k < K; k++) {
      const target = (k + 0.5) / K;
      while (i < out.length - 1 && acc + out[i][1] < target) acc += out[i++][1];
      q[k] = out[i][0];
    }
    return q;
  }

  /** The share of quantiles `q` (ascending) at least `t`. */
  function survive(q, t) {
    let a = 0;
    let b = q.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (q[mid] < t) a = mid + 1;
      else b = mid;
    }
    return (q.length - a) / q.length;
  }

  function pickToSnaps(pick) {
    const snaps = [null, null, null, null, null];
    for (let p = pick; p; p = p.prev) snaps[p.i] = p.j;
    return snaps;
  }

  /** Binary heap; `before(x, y)` puts x nearer the top. */
  class Heap {
    constructor(before) {
      this.a = [];
      this.before = before;
    }
    get size() {
      return this.a.length;
    }
    top() {
      return this.a[0];
    }
    push(x) {
      const a = this.a;
      let i = a.length;
      a.push(x);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.before(x, a[p])) break;
        a[i] = a[p];
        i = p;
      }
      a[i] = x;
    }
    pop() {
      const a = this.a;
      const out = a[0];
      const last = a.pop();
      if (a.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= a.length) break;
          if (c + 1 < a.length && this.before(a[c + 1], a[c])) c++;
          if (!this.before(a[c], last)) break;
          a[i] = a[c];
          i = c;
        }
        a[i] = last;
      }
      return out;
    }
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

  /** The seconds snap `s` extends member `v`'s live skill by (15000 rows whose member conditions `v` meets). */
  function snapExtension(m, v, s) {
    let ext = 0;
    for (const [id, level] of (s && s.supportSkills) || []) {
      for (const e of m.supportSkillEffects.get(id + ":" + level) || []) {
        if (e._skillEffectType !== 15000) continue;
        let hit = true;
        for (const cs of e._skillConditionGroup > 0 ? m.conditionSets.get(e._skillConditionGroup) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c && c._conditionType === 5000 && matchesAny(v, targetsOf(m, c._conditionTargetIDs)) !== c._isPositive) hit = false;
          }
        }
        if (hit) ext += e._effectValue / 1000;
      }
    }
    return ext;
  }

  /**
   * A rough snap skill score per unit of power of a deck (member and snap views, slot by slot) on chart `scoreId`:
   * each snap's live skill extension (15000) over the live skill's own 5 s, times the member's live skill rate. On the
   * charts checked it is 8% below the replay's rates (spread ±15%). It picks which songs the score objective measures,
   * and it is what snap skills add in the points search, which has no measured rates.
   */
  function roughSnapRate(m, members, snaps, scoreId, skillWeights) {
    let r = 0;
    members.forEach((v, i) => {
      const ext = snapExtension(m, v, snaps[i]);
      if (ext) r += (liveSkillRate(m, [v], scoreId, skillWeights) * ext) / 5;
    });
    return r;
  }

  /**
   * The live a search plays (input as for search): the multiplayer room (normal lives only); with Gekisou, its rates
   * at the assumed rank and Just rate (battleRates); the live skill weights; `skillRateOf(v, scoreId)`, a member's live
   * (and Gekisou) skill score per unit of power; and the playable charts (a challenge live's songs, else musicIds).
   */
  function liveSetup(input) {
    const m = input.master;
    const mode = input.mode || "normal";
    const event = input.event;
    const multi = mode === "normal" && input.multi && input.multi.players >= 1 ? input.multi : null;
    // A multiplayer live scores with Gekisou (battleRates): the chart rates, live skill weights and Gekisou skills at
    // the rank assumed in every range (at most the room size) and the Just rate.
    const battle = multi && input.battle && input.battle.power ? input.battle : null;
    const bt = battle ? battleRates(battle, Math.min(multi.gekisouRank || 1, Math.max(1, multi.players)), multi.justRate) : null;
    const sw = bt
      ? { kinds: battle.kinds, byScore: bt.weights }
      : input.skillWeights && input.skillWeights.kinds.length ? input.skillWeights : null;
    const terms = new Map();
    const skillRateOf = (v, scoreId) => {
      if (!terms.has(v)) terms.set(v, sw ? liveSkillTerms(m, v, sw.kinds) : []);
      const w = sw && sw.byScore.get(scoreId);
      let r = 0;
      if (w) for (const [q, f] of terms.get(v)) r += f * w[q];
      if (bt) r += gekisouSkillRate(m, battle, bt, v, scoreId, input.gekisouLevels);
      return r;
    };
    const musicIds = mode === "challenge"
      ? m.t.MasterChallengeMusic.filter((r) => r._eventId === event._id && (!input.musicIds || input.musicIds.includes(r._liveMusicId)))
        .map((r) => r._liveMusicId)
      : input.musicIds || null;
    const chartList = charts(m, bt ? bt.perPower : input.perPowerByScore, {
      maxLevel: input.maxLevel,
      difficulties: input.difficulties,
      musicIds,
      now: input.now,
      lengthByScore: input.lengthByScore,
    });
    return { multi, battle, bt, sw, skillRateOf, chartList };
  }

  /**
   * What a score-objective search plays, for Simulate.snapSkillRates to measure first: per song, the charts whose
   * score per unit of power with the roster's five best skills is within `margin` of the song's best chart (a lower
   * difficulty seldom scores more), and one owned member and snap of every kind of pairing (snapSkillKey).
   * Returns {scoreIds, pairs: [{key, memberKey (the key's member part), member, snap}]} (member and snap as owned).
   */
  function scoreScope(input, margin = 0.05) {
    const m = input.master;
    const { skillRateOf, chartList } = liveSetup(input);
    const members = input.members.map((o) => [o, memberView(m, o, input.player || {})]).filter((x) => x[1]);
    const snaps = input.snaps.map((o) => [o, snapView(m, o)]).filter((x) => x[1]);
    const top = (c) => {
      const r = members.map(([, v]) => skillRateOf(v, c.scoreId)).sort((a, b) => b - a);
      return c.perPower + r.slice(0, 5).reduce((a, b) => a + b, 0);
    };
    const bySong = new Map();
    for (const c of chartList) {
      if (!bySong.has(c.musicId)) bySong.set(c.musicId, []);
      bySong.get(c.musicId).push([c, top(c)]);
    }
    const scoreIds = [];
    for (const list of bySong.values()) {
      const best = Math.max(...list.map((x) => x[1]));
      for (const [c, r] of list) if (r >= (1 - margin) * best) scoreIds.push(c.scoreId);
    }
    const pairs = new Map();
    for (const [mo, v] of members) {
      for (const [so, s] of snaps) {
        const key = snapSkillKey(m, v, s);
        if (key && !pairs.has(key)) pairs.set(key, { key, memberKey: key.slice(0, key.indexOf("|")), member: mo, snap: so });
      }
    }
    return { scoreIds, pairs: [...pairs.values()] };
  }

  /**
   * What Simulate.comboBoosts measures before a multiplayer search (input as for search): the owned members' COMBO
   * count-up skills (comboCountOf keys), and per song with a COMBO range among the allowed charts its hardest one
   * (another difficulty of the song takes its shares), with the support skill and idle Gekisou skill to measure them
   * with. null when there is nothing to measure.
   */
  function comboScope(input) {
    const m = input.master;
    const { bt, battle, chartList } = liveSetup(input);
    if (!bt || !battle.supportShapes || !battle.supportShapes.size) return null;
    const keys = new Set();
    for (const o of input.members) {
      const v = memberView(m, o, input.player || {});
      if (v && v.comboCount) keys.add(v.comboCount);
    }
    const support = [...m.gekisouSupportSkills.keys()].find((id) => gekisouSupportKind(m, id) === "combo");
    // A Gekisou skill that adds no score: a JUST count-up (mission points only).
    const idle = m.t.MasterGekisouSkill.find((g) => {
      const rows = m.gekisouSkillEffects.get(g._id + ":1") || [];
      return rows.length > 0 && rows.every((e) => e._skillEffectType === 13000);
    });
    if (!keys.size || !support || !idle) return null;
    const bySong = new Map();
    for (const c of chartList) {
      const b = battle.byScore.get(c.scoreId);
      if (!b || !(b.missions || []).includes(1)) continue;
      const cur = bySong.get(c.musicId);
      if (!cur || c.level > cur.level) bySong.set(c.musicId, c);
    }
    if (!bySong.size) return null;
    return {
      keys: [...keys].sort(),
      scoreIds: [...bySong.values()].map((c) => c.scoreId),
      byMusic: new Map([...bySong].map(([id, c]) => [id, c.scoreId])),
      support,
      idle: idle._id,
    };
  }

  /**
   * Finds the best decks for one event mode, or with objective "score" the decks of the highest expected score: no
   * event points, items or CP (boosts, cpValue and perMinute are ignored); a challenge live keeps the event's parameter
   * bonus and plays its challenge songs; a normal live needs no `event` (null); a multiplayer live scores with Gekisou
   * (a random song: the mean over the songs, randomScoreSearch). The score is the expected one over performance orders.
   * input: {master, event, mode: "normal"|"challenge", members: [owned], snaps: [owned], player, perPowerByScore,
   *         skillWeights (skillWeightsFromMusicData: adds the members' expected live skill score),
   *         snapSkill ({byScore: scoreId -> Map(snapSkillKey -> score per unit of power)}, Simulate.snapSkillRates: the
   *         score objective adds the snap skills and plays only the charts measured; otherwise snap skills are left to
   *         the simulation), maxLevel, difficulties, accuracy ({perfectRate, breaks}: see playShares; null plays all Perfect; with
   *         combo breaks the score varies, and decks are ranked by their expected payoff over the ranks they may reach),
   *         boosts, objective: "points"|"items"|"score", topK, musicIds, fixed: {memberIds, excludeMemberIds},
   *         cpValue: event points one challenge point is worth (normal lives; 0 ignores the CP they earn),
   *         compareSongs: also return `songs`, the best deck of every song, lengthByScore: scoreId -> seconds,
   *         multi: {players, othersScore, gekisouRank, justRate, pickSong} for a multiplayer (激奏) normal live: the rank is the
   *         room's, reached when the player's score plus othersScore (the other players' total) meets the battle
   *         threshold; with `battle` (battleFromMusicData) the player's score is the Gekisou score at gekisouRank in
   *         every range (default 1, at most players) and justRate (default 1), members' Gekisou skills included
   *         (gekisouLevels: level factors, see gekisouSkillRate; comboBoost: {byScore, byMusic} -> Simulate.comboBoosts
   *         entries, the COMBO count-up shares, see comboCountBoost); the song is drawn at random (public rooms: decks by
   *         the mean over the songs, musicIds narrowing them, see randomSongSearch and randomScoreSearch) unless pickSong
   *         (a private room choosing its song),
   *         perMinute: {overhead} to choose the chart and rank paying the most per minute (song length + overhead
   *         seconds) instead of per live; a deck's `score` is then per minute and `minutes` is one live's duration}
   */
  function search(input) {
    const t0 = Date.now();
    const m = input.master;
    const event = input.event;
    const mode = input.mode || "normal";
    const scoreMode = input.objective === "score";
    const player = input.player || {};
    const topK = input.topK || 5;
    const accuracy = input.accuracy || null;
    // The expected score is linear in the play share, so the score mode needs only its mean.
    const stochastic = !scoreMode && !!(accuracy && accuracy.breaks > 0);
    const sharesOf = new Map(); // scoreId -> {mean, max, q}
    const shares = (c) => {
      let v = sharesOf.get(c.scoreId);
      if (!v) {
        const out = playShares(m, c.scoreId, accuracy);
        v = {
          mean: out.reduce((a, [x, w]) => a + x * w, 0),
          max: Math.max(...out.map(([x]) => x)),
          q: stochastic ? shareQuantiles(m, c.scoreId, accuracy) : null,
        };
        sharesOf.set(c.scoreId, v);
      }
      return v;
    };
    const exclude = new Set((input.excludeMemberIds || []).map(Number));
    const members = input.members.filter((o) => !exclude.has(Number(o.id))).map((o) => memberView(m, o, player)).filter(Boolean);
    const snaps = input.snaps.map((o) => snapView(m, o)).filter(Boolean);
    const ctx = makeContext(m, player, event ? event._id : null, members, snaps, mode);
    // The score objective keeps the event's parameter bonus (a challenge live's power and score) and drops the rest.
    if (scoreMode) for (const b of [...ctx.memberBonus.values(), ...ctx.snapBonus.values()]) b.point = b.item = 0;
    const pay = scoreMode ? { points: new Map(), items: new Map(), cp: new Map() } : payoff(m, event, mode);
    const rate = scoreMode ? 1 : boostRate(m, mode, input.boosts || 0);
    const W = input.objective === "items" ? { point: 1, item: 1e6 } : { point: 1e6, item: 1 };
    const cpValue = mode === "challenge" ? 0 : input.cpValue || 0;
    const cpOf = (rank) => (pay.cp.get(rank) || 0) * rate;
    const { multi, battle, bt, sw, skillRateOf: liveRateOf, chartList: playable } = liveSetup(input);
    // Own score each rank needs on a chart: solo thresholds, or in a room what the others' scores leave (E counts as D).
    const ownThresholds = (c) =>
      multi
        ? c.battle.map(([r, base]) => [Math.max(r, 2), Math.max(0, battleRequiredScore(base, multi.players) - (multi.othersScore || 0))])
        : c.thresholds;
    const scoreOf = (points, items, rank) => (points + cpOf(rank) * cpValue) * W.point + items * W.item;
    // A public room draws its song at random: no song to choose, per minute or otherwise. Decks are ranked by the mean
    // over the songs (randomSongSearch; the score objective: randomScoreSearch), musicIds narrowing them (the songs of
    // one Gekisou range type, for a deck saved for them).
    const randomSong = !!(multi && !multi.pickSong);
    const perMinute = input.perMinute && !randomSong && !scoreMode ? { overhead: Math.max(0, input.perMinute.overhead || 0) } : null;
    const minutesOf = (c) => ((c.lengthSec || 0) + (perMinute ? perMinute.overhead : 0)) / 60;
    // Snap skill rates (score objective; Simulate.snapSkillRates): {byScore: scoreId -> Map(snapSkillKey -> score per
    // unit of power)}. Only the measured charts are played.
    const snapSkill = scoreMode && input.snapSkill ? input.snapSkill : null;
    // Snaps' Gekisou support skills (a live with Gekisou): music-data's measured gain of each pairing on each chart
    // (gekisouSupportTerms). Points have no measured snap skill rates: their snap skills are roughSnapRate's estimate
    // (`roughSnaps`, off with input.roughSnapSkills false). With any of them, a snap adds score depending on its member
    // and the chart (`pairX`; `pairPts` in points).
    const gkSup = !!(bt && battle.supportShapes && battle.supportShapes.size);
    const roughSnaps = !scoreMode && !!sw && input.roughSnapSkills !== false;
    const pairPts = !scoreMode && (gkSup || roughSnaps);
    const pairX = !!snapSkill || gkSup || roughSnaps;
    // The score objective plays one chart per group with pair rates; without measured snap skill rates, the charts
    // scoreScope would measure (a random song: one chart per song).
    const scope = scoreMode && gkSup && !snapSkill ? new Set(scoreScope(input, randomSong ? 0 : undefined).scoreIds) : null;
    const chartList = snapSkill ? playable.filter((c) => snapSkill.byScore.has(c.scoreId)) : scope ? playable.filter((c) => scope.has(c.scoreId)) : playable;
    if (chartList.length === 0) return { error: "no-charts", results: [] };

    // Charts grouped by the song features that change deck power; with pair rates in the score objective, which
    // depend on the chart, one chart per group.
    const groups = new Map();
    for (const c of chartList) {
      const mv = musicView(m, c.musicId);
      if (mode === "challenge") {
        const row = m.t.MasterChallengeMusic.find((r) => r._eventId === event._id && r._liveMusicId === c.musicId);
        if (row && row._musicType) mv.musicType = row._musicType;
      }
      const key = mv.musicType + "|" + mv.tags.join(",") + (scoreMode && pairX ? "|" + c.scoreId : "");
      if (!groups.has(key)) groups.set(key, { music: mv, charts: [] });
      groups.get(key).charts.push(c);
    }

    // Live skill (and Gekisou skill) score per unit of power of a member on a chart, and with pair rates the snaps'
    // rates paired with it (per snap, aligned with `snaps`): snap skills and Gekisou support skills.
    const skillRateOf = (v, c) => liveRateOf(v, c.scoreId);
    const chartIdx = new Map(chartList.map((c, i) => [c, i]));
    // Gekisou interactions the pairs miss (gekisouSupportTerms measured each support skill beside a member whose own
    // Gekisou skill does nothing): a member's LUCK gauge skill brings more rushes, which every LUCKY RUSH 分數UP of the
    // deck acts in (luckGaugeBoost), and a member's COMBO count-up skill makes every COMBO-stacking support skill of the
    // deck stack sooner (comboBoost). A deck's boost profile `g` (boostOf; null without any) gives, per chart of
    // chartList, the share each kind of support gain grows by: `rush`, and `combo` by member match. Bounds and card
    // pruning use the largest, `gMax` (the strongest gauge owned and each chart's saturation).
    const comboData = gkSup && input.comboBoost ? input.comboBoost : null;
    const comboOf = (c) => (comboData ? comboData.byScore.get(c.scoreId) || (comboData.byMusic && comboData.byMusic.get(c.musicId)) || null : null);
    const comboCharts = chartList.map(comboOf);
    const boosts = new Map(); // profile key -> profile
    const boostOf = (vs) => {
      if (!gkSup) return null;
      let gauge = 0;
      const keys = [];
      for (const v of vs) {
        if (v.luckGauge > gauge) gauge = v.luckGauge;
        if (comboData && v.comboCount) keys.push(v.comboCount);
      }
      if (!gauge && !keys.length) return null;
      keys.sort();
      const key = gauge + "|" + keys.join(",");
      if (!boosts.has(key)) {
        boosts.set(key, {
          key,
          rush: Float64Array.from(chartList, (c) => luckGaugeBoost(battle, gauge, c.scoreId)),
          combo: [0, 1].map((match) => Float64Array.from(comboCharts, (cb) => (cb ? comboCountBoost(cb, keys, match) : 0))),
        });
      }
      return boosts.get(key);
    };
    const gMax = gkSup
      ? {
          key: "max",
          rush: Float64Array.from(chartList, (c) => luckGaugeBoost(battle, Math.max(0, ...members.map((v) => v.luckGauge)), c.scoreId)),
          combo: [0, 1].map((match) => Float64Array.from(comboCharts, (cb) => (cb && members.some((v) => v.comboCount) ? cb.s[match] : 0))),
        }
      : null;
    // A card's COMBO count-up is at least another's on every chart and member match.
    const comboAsGood = (b, a) => {
      if (!comboData || !a.comboCount || a.comboCount === b.comboCount) return true;
      if (!b.comboCount) return false;
      return comboCharts.every((cb) => !cb || [0, 1].every((k) => comboCountBoost(cb, [b.comboCount], k) >= comboCountBoost(cb, [a.comboCount], k)));
    };
    // Gekisou support gain of snap j beside member v on each chart of chartList (Float64Array), or null, in a deck of
    // boost profile g. Members that meet the same member conditions share it.
    const supKeys = new Map(); // member view -> cache key per snap
    const supCache = new Map(); // key -> {all, rush, combo: [by match] (the parts a profile raises, or null), by: profile key -> gains} or null
    const supOf = (v, j, g = null) => {
      if (!supKeys.has(v)) {
        const match = (id) => (gekisouSupportMatch(m, v, id, m.gekisouSupportSkillMaxLevel.get(id) || 1) ? 1 : 0);
        supKeys.set(v, snaps.map((s, k) => (v.gekisouSkillId && s.gekisouSupportSkills.length ? k + "|" + s.gekisouSupportSkills.map(([id]) => match(id)).join("") : null)));
      }
      const key = supKeys.get(v)[j];
      if (!key) return null;
      if (!supCache.has(key)) {
        const nC = chartList.length;
        const all = new Float64Array(nC);
        const parts = { rush: new Float64Array(nC), combo0: new Float64Array(nC), combo1: new Float64Array(nC) };
        chartList.forEach((c, i) => {
          for (const [, x, kind, match] of gekisouSupportTerms(m, battle, bt, v, snaps[j], c.scoreId, input.gekisouSupportLevels)) {
            all[i] += x;
            if (kind === "rush") parts.rush[i] += x;
            if (kind === "combo") parts[match ? "combo1" : "combo0"][i] += x;
          }
        });
        const some = (a) => (a.some((x) => x !== 0) ? a : null);
        supCache.set(key, all.some((x) => x !== 0) ? { all, rush: some(parts.rush), combo: [some(parts.combo0), some(parts.combo1)], by: new Map() } : null);
      }
      const e = supCache.get(key);
      if (!e || !g || !(e.rush || e.combo[0] || e.combo[1])) return e ? e.all : null;
      if (!e.by.has(g.key)) {
        e.by.set(g.key, e.all.map((x, i) =>
          x + (e.rush ? g.rush[i] * e.rush[i] : 0) + (e.combo[0] ? g.combo[0][i] * e.combo[0][i] : 0) + (e.combo[1] ? g.combo[1][i] * e.combo[1][i] : 0)));
      }
      return e.by.get(g.key);
    };
    // Rough snap skill gain (roughSnapRate) of snap j beside member v on each chart of chartList, or null; members of
    // one live skill and level that get the same extension share it.
    const roughKeys = new Map(); // member view -> cache key per snap
    const roughCache = new Map();
    const roughOf = (v, j) => {
      if (!roughSnaps) return null;
      if (!roughKeys.has(v)) roughKeys.set(v, snaps.map((s) => {
        const ext = v.liveSkillId ? snapExtension(m, v, s) : 0;
        return ext ? v.liveSkillId + ":" + v.liveSkillLevel + "|" + ext : null;
      }));
      const key = roughKeys.get(v)[j];
      if (!key) return null;
      if (!roughCache.has(key)) {
        const a = Float64Array.from(chartList, (c) => roughSnapRate(m, [v], [snaps[j]], c.scoreId, sw));
        roughCache.set(key, a.some((x) => x !== 0) ? a : null);
      }
      return roughCache.get(key);
    };
    // Points: a pairing's whole gain (Gekisou support skills and rough snap skills) in a deck of boost profile g, or null.
    const pairCache = new Map(); // member view -> profile key -> per snap
    const pairOf = (v, j, g = null) => {
      if (!pairCache.has(v)) pairCache.set(v, new Map());
      const byG = pairCache.get(v);
      const gk = g ? g.key : "";
      if (!byG.has(gk)) byG.set(gk, new Array(snaps.length));
      const row = byG.get(gk);
      if (row[j] === undefined) {
        const a = gkSup ? supOf(v, j, g) : null;
        const b = roughOf(v, j);
        row[j] = a && b ? a.map((x, i) => x + b[i]) : a || b;
      }
      return row[j];
    };
    const snapKeys = new Map(); // member view -> snapSkillKey per snap
    const snapRatesOf = (v, c, g = null) => {
      const i = chartIdx.get(c);
      if (snapSkill && !snapKeys.has(v)) snapKeys.set(v, snaps.map((s) => snapSkillKey(m, v, s)));
      const keys = snapSkill ? snapKeys.get(v) : null;
      const rates = snapSkill ? snapSkill.byScore.get(c.scoreId) : null;
      return Float64Array.from(snaps, (_, j) => {
        const x = keys && keys[j] ? rates.get(keys[j]) || 0 : 0;
        const sup = pairPts ? pairOf(v, j, g) : gkSup ? supOf(v, j, g) : null;
        return sup ? x + sup[i] : x;
      });
    };

    // Candidate member cards: per character, drop a card another card beats in every respect that feeds the deck: event
    // bonuses, every stat, skills on every chart (live, Gekisou, and the snap skills paired with it, with no boost
    // profile and the largest: a gain is linear in it), the LUCK gauge and COMBO count-up it brings, and the same card
    // type, tags and skill categories (song bonus, snap type link, leader targets), song bonus rates and leader skill.
    // At most 4 are kept per character, the most promising first.
    const statBase = new Map(members.map((v) => [v, memberBase(m, v, ctx).map((b, i) => b + pctOf(b, v.bandItemPct[i]))]));
    const baseSum = new Map(members.map((v) => [v, statBase.get(v).reduce((a, b) => a + b, 0)]));
    const skillsOf = new Map(members.map((v) => [v, Float64Array.from(chartList, (c) => skillRateOf(v, c))]));
    const snapsOf = pairX ? new Map(members.map((v) => [v, chartList.map((c) => snapRatesOf(v, c, gMax))])) : null;
    const snapsOf0 = pairX && gMax ? new Map(members.map((v) => [v, chartList.map((c) => snapRatesOf(v, c, null))])) : null;
    const sameList = (x, y) => x.length === y.length && x.every((e) => y.includes(e));
    const leaderAsGood = (b, a) =>
      !isUsefulLeader(a) || (a.leaderSkillId === b.leaderSkillId && b.leaderSkillLevel >= a.leaderSkillLevel);
    const skillAsGood = (b, a) => {
      const kb = skillsOf.get(b), ka = skillsOf.get(a);
      for (let i = 0; i < kb.length; i++) if (kb[i] < ka[i]) return false;
      for (const of of [snapsOf, snapsOf0]) {
        if (!of) continue;
        const xb = of.get(b), xa = of.get(a);
        for (let i = 0; i < xb.length; i++) for (let j = 0; j < xb[i].length; j++) if (xb[i][j] < xa[i][j]) return false;
      }
      return true;
    };
    const dominates = (b, a) => {
      if (b.cardType !== a.cardType || !sameList(b.tags, a.tags) || !sameList(b.liveSkillCategories, a.liveSkillCategories) ||
        !sameList(b.gekisouSkillCategories, a.gekisouSkillCategories) || b.gekisouMissionType !== a.gekisouMissionType) return false;
      if (b.musicTypeRate < a.musicTypeRate || b.musicTagRate < a.musicTagRate || !leaderAsGood(b, a) || !skillAsGood(b, a)) return false;
      if (gMax && (b.luckGauge < a.luckGauge || !comboAsGood(b, a))) return false;
      const ea = ctx.memberBonus.get(a), eb = ctx.memberBonus.get(b);
      const sa = statBase.get(a), sb = statBase.get(b);
      if (eb.point < ea.point || eb.item < ea.item || sb.some((x, i) => x < sa[i])) return false;
      const gt = eb.point > ea.point || eb.item > ea.item || sb.some((x, i) => x > sa[i]) ||
        b.musicTypeRate > a.musicTypeRate || b.musicTagRate > a.musicTagRate || b.leaderSkillLevel > a.leaderSkillLevel ||
        (!!gMax && (b.luckGauge > a.luckGauge || (!!comboData && !!b.comboCount && !a.comboCount)));
      return gt || !leaderAsGood(a, b) || !skillAsGood(a, b) || b.id < a.id;
    };
    const byChar = new Map();
    for (const v of members) {
      if (!byChar.has(v.characterId)) byChar.set(v.characterId, []);
      byChar.get(v.characterId).push(v);
    }
    // The score objective orders a character's cards by what they add to a deck's score on their best chart: their
    // stats at the chart's score per unit of power, and their skills over a deck of their own stats.
    const scoreKey = (v) => {
      let best = 0;
      chartList.forEach((c, i) => {
        const x = snapsOf ? Math.max(0, ...snapsOf.get(v)[i]) : 0;
        best = Math.max(best, baseSum.get(v) * (c.perPower + 5 * (skillsOf.get(v)[i] + x)));
      });
      return best;
    };
    const candidates = [];
    for (const list of byChar.values()) {
      const kept = list.filter((a) => !list.some((b) => b !== a && dominates(b, a)));
      const bonusOf = (v) => ctx.memberBonus.get(v).point * W.point + ctx.memberBonus.get(v).item * W.item;
      if (scoreMode) {
        const key = new Map(kept.map((v) => [v, scoreKey(v)]));
        kept.sort((a, b) => key.get(b) - key.get(a));
      } else kept.sort((a, b) => bonusOf(b) - bonusOf(a) || baseSum.get(b) - baseSum.get(a));
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

    // Leader terms by candidate index: LT[L * N + v] = whole points L adds to v's slot; for a leader that is not simple,
    // an upper bound (every condition met, cumulative counts at their cap, negative effects dropped).
    const N = allCand.length;
    const LT = new Int32Array(N * N);
    const simpleAt = allCand.map((L) => leaderTerm.has(L));
    allCand.forEach((L, li) => {
      const row = leaderTerm.get(L);
      const effects = row ? null : m.leaderEffects.get(L.leaderSkillId + ":" + L.leaderSkillLevel) || [];
      allCand.forEach((v, vi) => {
        if (row) {
          LT[li * N + vi] = row.get(v);
          return;
        }
        const acc = [0, 0, 0];
        for (const e of effects) {
          let n = 1;
          const cum = (e._skillEffectType & ~3) === 1500 && m.cumulative.get(e._skillCumulativeConditionID);
          if (cum) n = Math.max(1, cum._maxCumulativeCount < 1 ? 5 : Math.min(5, cum._maxCumulativeCount));
          const ts = targetsOf(m, e._skillTargetIDs);
          if (!ts || matchesAny(v, ts)) accumulate(e._skillEffectType, Math.max(0, e._effectValue) * n, acc);
        }
        const b = memberBase(m, v, ctx);
        LT[li * N + vi] = pctOf(b[0], acc[0]) + pctOf(b[1], acc[1]) + pctOf(b[2], acc[2]);
      });
    });
    const ptOf = allCand.map((v) => ctx.memberBonus.get(v).point);
    const itOf = allCand.map((v) => ctx.memberBonus.get(v).item);
    const gOf = allCand.map((v) => bestG.get(v));

    // Member sets (song independent): characters choose 5, one candidate card each. They are stored flat (`setV`: five
    // candidate indices each) and grouped by their (point bonus, item bonus) pair into buckets [bStart, bEnd). `setSU`
    // is the song-independent part of a power bound: the best snap per slot plus the best leader term bound.
    const charLists = candidates.map((l) => l.map((v) => allCand.indexOf(v)));
    function forEachSet(fn) {
      const vs = [0, 0, 0, 0, 0];
      for (const cs of combinations(charLists.length, 5)) {
        const lists = cs.map((c) => charLists[c]);
        const idx = [0, 0, 0, 0, 0];
        for (;;) {
          for (let i = 0; i < 5; i++) vs[i] = lists[i][idx[i]];
          fn(vs);
          let k = 4;
          while (k >= 0 && ++idx[k] >= lists[k].length) idx[k--] = 0;
          if (k < 0) break;
        }
      }
    }
    const bucketOf = new Map(); // pt * 1e7 + it -> bucket
    const bPt = [];
    const bIt = [];
    const bCount = [];
    let nSets = 0;
    forEachSet((vs) => {
      const pt = ptOf[vs[0]] + ptOf[vs[1]] + ptOf[vs[2]] + ptOf[vs[3]] + ptOf[vs[4]];
      const it = itOf[vs[0]] + itOf[vs[1]] + itOf[vs[2]] + itOf[vs[3]] + itOf[vs[4]];
      const key = pt * 1e7 + it;
      let b = bucketOf.get(key);
      if (b === undefined) {
        b = bPt.length;
        bucketOf.set(key, b);
        bPt.push(pt);
        bIt.push(it);
        bCount.push(0);
      }
      bCount[b]++;
      nSets++;
    });
    const B = bPt.length;
    const bStart = new Int32Array(B);
    const bEnd = new Int32Array(B);
    for (let b = 1; b < B; b++) bStart[b] = bStart[b - 1] + bCount[b - 1];
    bEnd.set(bStart);
    const setV = new Uint8Array(nSets * 5);
    const setSU = new Int32Array(nSets);
    const setEnum = new Int32Array(nSets); // enumeration order: ties break as in the stable sort this replaced
    let nEnum = 0;
    forEachSet((vs) => {
      const pt = ptOf[vs[0]] + ptOf[vs[1]] + ptOf[vs[2]] + ptOf[vs[3]] + ptOf[vs[4]];
      const it = itOf[vs[0]] + itOf[vs[1]] + itOf[vs[2]] + itOf[vs[3]] + itOf[vs[4]];
      const s = bEnd[bucketOf.get(pt * 1e7 + it)]++;
      let lt = 0;
      for (let L = 0; L < 5; L++) {
        const r = vs[L] * N;
        const x = LT[r + vs[0]] + LT[r + vs[1]] + LT[r + vs[2]] + LT[r + vs[3]] + LT[r + vs[4]];
        if (x > lt) lt = x;
      }
      setSU[s] = lt + gOf[vs[0]] + gOf[vs[1]] + gOf[vs[2]] + gOf[vs[3]] + gOf[vs[4]];
      for (let i = 0; i < 5; i++) setV[s * 5 + i] = vs[i];
      setEnum[s] = nEnum++;
    });
    // Sets are numbered in bucket order; within a bucket, in enumeration order.
    const setOf = (s) => {
      const vs = [];
      let g = 0;
      for (let i = 0; i < 5; i++) {
        const v = setV[s * 5 + i];
        vs.push(allCand[v]);
        g += gOf[v];
      }
      return { vs, pt: bPt[bucketIdx(s)], it: bIt[bucketIdx(s)], g };
    };
    const bucketIdx = (s) => {
      let a = 0;
      let b = B - 1;
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (bStart[mid] <= s) a = mid;
        else b = mid - 1;
      }
      return a;
    };
    const bfF = new Int32Array(nSets); // exact best F per group, -1 = not yet computed
    const bfL = new Int8Array(nSets);

    /**
     * Visits sets in descending upper bound `ubOf(s, T)` (ties in enumeration order) while that bound reaches
     * `threshold()` (which only rises). Exact bounds are computed only for sets a bucket bound can't rule out: `T`'s
     * payoff is a step function of power (it changes only at the table's power breakpoints), so a bucket splits into
     * levels between breakpoints, each bounded by its lowest power and the bucket's pt/it; `powBound` places sets.
     */
    function bestFirst(T, bMax, powBound, ubOf, threshold, visit) {
      const ps = new Set();
      for (const n of T.need.values()) ps.add(n.power);
      if (T.frontier) for (const kept of T.frontier.values()) for (const o of kept) ps.add(o.power);
      const P = Float64Array.from(ps).sort();
      const levelOf = (p) => {
        let a = 0;
        let b = P.length;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (P[mid] <= p) a = mid + 1;
          else b = mid;
        }
        return a; // p in [P[a - 1], P[a])
      };
      const levelUb = (b, k) => choose(T, k > 0 ? P[k - 1] : -Infinity, bPt[b] + maxSnapPoint, bIt[b] + maxSnapItem).sc;
      const buckets = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.b < y.b));
      for (let b = 0; b < B; b++) {
        if (bEnd[b] === bStart[b]) continue;
        const k = levelOf(bMax[b]);
        buckets.push({ key: levelUb(b, k), b, k });
      }
      const sets = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.e < y.e));
      for (;;) {
        while (buckets.size && buckets.top().key >= threshold() && (!sets.size || buckets.top().key >= sets.top().key)) {
          const { b, k } = buckets.pop();
          const lo = k > 0 ? P[k - 1] : -Infinity;
          const hi = k < P.length ? P[k] : Infinity;
          const th = threshold();
          for (let s = bStart[b]; s < bEnd[b]; s++) {
            const p = powBound(s);
            if (p < lo || p >= hi) continue;
            const key = ubOf(s, T);
            if (key >= th) sets.push({ key, s, e: setEnum[s] });
          }
          if (k > 0) buckets.push({ key: levelUb(b, k - 1), b, k: k - 1 });
        }
        if (!sets.size) break;
        const x = sets.pop();
        if (x.key < threshold()) break;
        visit(x.s);
      }
    }

    // Score mode: the payoff is the expected score, linear in power, so there are no breakpoints to split buckets at (and
    // with no event bonuses one bucket holds every set). Each group sorts the sets into bins by powBound once
    // (binSets, a counting sort), and walkScore visits the bins from the top, bounding a bin by its largest powBound at
    // T's best rate, then the sets by ubOf.
    const NB = 4096;
    let bins = null;
    let binPow = null;
    let binOrder = null;
    function binSets(powBound) {
      if (!binPow) {
        binPow = new Int32Array(nSets);
        binOrder = new Int32Array(nSets);
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = 0; s < nSets; s++) {
        const p = powBound(s);
        binPow[s] = p;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      const w = (hi - lo + 1) / NB;
      const binOf = (p) => Math.min(NB - 1, Math.floor((p - lo) / w));
      const start = new Int32Array(NB + 1);
      const max = new Float64Array(NB).fill(-Infinity);
      for (let s = 0; s < nSets; s++) {
        const b = binOf(binPow[s]);
        start[b + 1]++;
        if (binPow[s] > max[b]) max[b] = binPow[s];
      }
      for (let b = 0; b < NB; b++) start[b + 1] += start[b];
      const fill = start.slice(0, NB);
      for (let s = 0; s < nSets; s++) binOrder[fill[binOf(binPow[s])]++] = s;
      return { start, max, order: binOrder };
    }
    function walkScore(T, bMax, powBound, ubOf, threshold, visit) {
      const { start, max, order } = bins;
      const rMax = T.rate.get(T.best);
      const sets = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.e < y.e));
      let b = NB - 1;
      for (;;) {
        while (b >= 0) {
          if (start[b] === start[b + 1]) {
            b--;
            continue;
          }
          const key = max[b] * rMax;
          if (key < threshold() || (sets.size && key < sets.top().key)) break;
          const th = threshold();
          for (let i = start[b]; i < start[b + 1]; i++) {
            const s = order[i];
            const k = ubOf(s, T);
            if (k >= th) sets.push({ key: k, s, e: setEnum[s] });
          }
          b--;
        }
        if (!sets.size) break;
        const x = sets.pop();
        if (x.key < threshold()) break;
        visit(x.s);
      }
    }

    // Per rank, the chart needing the least power among `list`; rankFor(power) is the best rank that power reaches.
    // `skill` (aligned with `list`, or null) adds the deck's live skill score per unit of power to each chart's.
    // `optimistic` takes each chart's best play share instead of its mean: a bound on the expected payoff. With combo
    // breaks, a mean table also lists the candidate charts for the expected payoff (`cands`): per rank the three
    // needing the least power, or per minute the frontier charts.
    function rankTable(list, skill, optimistic) {
      const rateP = new Map(list.map((c, i) => [c, c.perPower + (skill ? skill[i] : 0)]));
      const rate = new Map(list.map((c) => [c, rateP.get(c) * (optimistic ? shares(c).max : shares(c).mean)]));
      // Score mode: the chart of the highest expected score per unit of power (the same for every power).
      if (scoreMode) {
        let best = list[0];
        for (const c of list) if (rate.get(c) > rate.get(best)) best = c;
        return { need: new Map(), rankList: [], rankFor: () => 0, frontier: null, rate, cands: null, best, charts: list };
      }
      // Ties (in a room, often ranks the others' scores reach alone) go solo to the easier chart, in a room to the
      // higher own score, which leaves the room more margin.
      const tie = (c, cur) => (multi ? rate.get(c) > rate.get(cur.chart) : c.level < cur.chart.level);
      const need = new Map();
      for (const c of list) {
        for (const [r, req] of ownThresholds(c)) {
          const p = Math.ceil(req / rate.get(c));
          const cur = need.get(r);
          if (!cur || p < cur.power || (p === cur.power && tie(c, cur))) need.set(r, { power: p, chart: c });
        }
      }
      const rankList = [...need.keys()].sort((a, b) => b - a);
      const rankFor = (power) => {
        for (const r of rankList) if (need.get(r).power <= power) return r;
        return rankList[rankList.length - 1];
      };
      // Per minute: per rank, the charts not beaten by one needing no more power and taking no longer, by power.
      let frontier = null;
      if (perMinute) {
        frontier = new Map();
        for (const r of rankList) {
          const opts = [];
          for (const c of list) {
            const th = ownThresholds(c).find((x) => x[0] === r);
            if (th && c.lengthSec) opts.push({ power: Math.ceil(th[1] / rate.get(c)), chart: c, min: minutesOf(c) });
          }
          opts.sort((a, b) => a.power - b.power || a.min - b.min || a.chart.level - b.chart.level);
          const kept = [];
          for (const o of opts) if (!kept.length || o.min < kept[kept.length - 1].min) kept.push(o);
          frontier.set(r, kept);
        }
      }
      let cands = null;
      if (stochastic && !optimistic) {
        const picked = new Set();
        if (frontier) for (const kept of frontier.values()) for (const o of kept) picked.add(o.chart);
        else {
          for (const r of rankList) {
            const needOf = (c) => {
              const th = ownThresholds(c).find((x) => x[0] === r);
              return th ? th[1] / rate.get(c) : Infinity;
            };
            list.slice().sort((a, b) => needOf(a) - needOf(b)).slice(0, 3).forEach((c) => picked.add(c));
          }
        }
        cands = [...picked].map((c) => ({
          chart: c,
          // [rank, power reaching it at share 1], highest rank first
          xs: ownThresholds(c).map(([r, req]) => [r, req / rateP.get(c)]).sort((a, b) => b[0] - a[0]),
          q: shares(c).q,
          mean: shares(c).mean,
          min: perMinute ? minutesOf(c) : 0,
        }));
      }
      return { need, rankList, rankFor, frontier, rate, cands };
    }
    // Rank and chart a deck of `power` with bonuses pb/ib plays: the best rank (per live), or the best rank and chart
    // pair per minute. Monotone in power and bonuses, so it also gives the upper bounds. `x`: the deck's snap skill
    // score per unit of power (score objective).
    function choose(rt, power, pb, ib, x = 0) {
      if (rt.best) {
        // Score mode: the expected score, and the score rank it reaches on the chart (needPower: that rank's power).
        const c = rt.best;
        const r = rt.rate.get(c) + x * shares(c).mean;
        const sc = power * r;
        const rank = scoreRankOf(c.thresholds, sc);
        const th = c.thresholds.find((t) => t[0] === rank);
        return { rank, chart: c, needPower: th ? Math.ceil(th[1] / r) : 0, points: 0, items: 0, sc, x };
      }
      if (rt.cands) return chooseExpected(rt, power, pb, ib);
      const at = (r, chart, needPower, min) => {
        const points = eventPoints(pb, rate, pay.points.get(r) || 0);
        const items = eventItems(pay.items.get(r) || 0, ib, rate);
        const sc = scoreOf(points, items, r);
        return { rank: r, chart, needPower, points, items, sc: min ? sc / min : sc };
      };
      if (rt.frontier) {
        let best = null;
        for (const r of rt.rankList) {
          let o = null;
          for (const x of rt.frontier.get(r)) {
            if (x.power > power) break;
            o = x;
          }
          if (!o) continue;
          const v = at(r, o.chart, o.power, o.min);
          if (!best || v.sc > best.sc) best = v;
        }
        if (best) return best;
      }
      const r = rt.rankFor(power);
      const n = rt.need.get(r);
      return at(r, n.chart, n.power, rt.frontier && n.chart.lengthSec ? minutesOf(n.chart) : 0);
    }
    // With combo breaks: per candidate chart, the chance of each rank over the play's shares, and the expected payoff
    // (per minute: over the chart's minutes). `rank` is the median rank and `chance` the chance of reaching it.
    function chooseExpected(rt, power, pb, ib) {
      let best = null;
      for (const cd of rt.cands) {
        let above = 0;
        let sc = 0;
        let points = 0;
        let items = 0;
        let cp = 0;
        let median = null;
        const dist = [];
        for (const [r, x] of cd.xs) {
          const P = Math.max(above, x <= 0 ? 1 : survive(cd.q, x / power));
          const p = P - above;
          if (p > 0) {
            const pt = eventPoints(pb, rate, pay.points.get(r) || 0);
            const it = eventItems(pay.items.get(r) || 0, ib, rate);
            sc += p * scoreOf(pt, it, r);
            points += p * pt;
            items += p * it;
            cp += p * cpOf(r);
            dist.push([r, p]);
          }
          if (!median && P >= 0.5) median = { rank: r, chance: P, x };
          above = P;
        }
        if (cd.min) sc /= cd.min;
        if (!best || sc > best.sc) {
          best = {
            rank: median.rank, chance: median.chance, dist, chart: cd.chart, needPower: Math.ceil(median.x / cd.mean),
            points, items, cp, sc,
          };
        }
      }
      return best;
    }
    const upperBound = (s, bf, rt) => choose(rt, bf.f + s.g, s.pt + maxSnapPoint, s.it + maxSnapItem).sc;

    // Points with pair gains (pairOf: Gekisou support skills, rough snap skills): a snap assignment's gains differ by chart,
    // so each assignment the snap DP keeps plays a rank table of its own (pairTable). The DP ranks a pairing by its gain
    // averaged over the charts (`supportMeans`): a random song keeps the assignments no other beats in that mean, power and bonuses (few
    // sets are evaluated there); a chosen song, which evaluates many sets, adds the mean to the snap power at `w` power
    // per unit of gain (`effectiveG`: a deck of power P on a chart of rate r scores P * (r + x), so P / r with the set's
    // power bound and mean rate), which keeps the DP as small as without support skills. Either may drop an assignment
    // that would have won on the chart that sets the rank, so this is approximate (in the cases checked, the top deck
    // of a random song lost up to 0.7% of its payoff with effectiveG and none with the means). The score objective plays
    // one chart per group and keeps (power, gain) pairs exactly. `px`: {list (charts), idx (their chartList indices),
    // skill (the set's skill rates on them, or null), rate (their mean no-skill plus skill rate)}.
    const pairsOn = (list, idx, skill) => {
      let r = 0;
      list.forEach((c, i) => (r += c.perPower + (skill ? skill[i] : 0)));
      return { list, idx, skill, rate: r / list.length };
    };
    const supportMeans = (members, idx) => {
      const g = boostOf(members);
      return members.map((v) => {
        const row = new Float64Array(snaps.length);
        for (let j = 0; j < snaps.length; j++) {
          const sup = pairOf(v, j, g);
          if (!sup) continue;
          let x = 0;
          for (const ci of idx) x += sup[ci];
          row[j] = x / idx.length;
        }
        return row;
      });
    };
    const effectiveG = (members, G, idx, w) => supportMeans(members, idx).map((row, i) => row.map((x, j) => G[i][j] + w * x));
    const pickPower = (G, pick) => {
      let g = 0;
      for (let p = pick; p; p = p.prev) g += G[p.i][p.j];
      return g;
    };
    // The pair gains of the snaps `pick` (snapStates) gives `members` (slot by slot), on each chart of idx.
    const pairSum = (members, pick, idx) => {
      const out = new Float64Array(idx.length);
      const g = boostOf(members);
      for (let p = pick; p; p = p.prev) {
        const sup = pairOf(members[p.i], p.j, g);
        if (sup) for (let c = 0; c < idx.length; c++) out[c] += sup[idx[c]];
      }
      return out;
    };
    const pairTable = (px, members, pick) => {
      const x = pairSum(members, pick, px.idx);
      if (px.skill) for (let c = 0; c < x.length; c++) x[c] += px.skill[c];
      return rankTable(px.list, x, false);
    };
    // The gain per unit of power of a deck's pairs on chart c from `of` (supOf: Gekisou support skills; roughOf).
    const deckSupport = (members, snapObjs, c, of) => {
      const ci = chartIdx.get(c);
      const g = boostOf(members);
      let x = 0;
      members.forEach((v, i) => {
        const sup = snapObjs[i] ? of(v, snaps.indexOf(snapObjs[i]), g) : null;
        if (sup) x += sup[ci];
      });
      return x;
    };

    // The exact best deck of a member set: leader from bestF, snaps from the slot-mask DP. `Xm` (score objective, or
    // null): the deck's boost profile -> member view -> pair rates per snap on rt's chart. `px` (points with Gekisou
    // support, or null): see pairTable.
    function evaluate(s, bf, rt, music, Xm, px) {
      evaluated++;
      const order = s.vs.slice();
      [order[bf.leader], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[bf.leader]];
      const G = order.map((v) => Gm.get(v));
      const xm = Xm ? Xm(boostOf(order)) : null;
      const X = xm ? order.map((v) => xm.get(v)) : null;
      const Gd = px ? effectiveG(order, G, px.idx, (bf.f + s.g) / px.rate) : G;
      let best = null;
      for (const st of snapStates(Gd, snapPoint, snapItem, snaps.length, X)) {
        const power = bf.f + (px ? pickPower(G, st.pick) : st.power);
        const pb = s.pt + st.pt;
        const ib = s.it + st.it;
        const t = px ? pairTable(px, order, st.pick) : rt;
        const v = choose(t, power, pb, ib, Xm ? st.x : 0);
        if (!best || v.sc > best.sc || (v.sc === best.sc && power > best.power)) best = { ...v, power, pb, ib, st, t };
      }
      const snapObjs = pickToSnaps(best.st.pick).map((j) => (j === null ? null : snaps[j]));
      return deckOf(order, snapObjs, best, best.t, music);
    }
    // The deck of members `order` (leader in LEADER_SLOT) and `snapObjs` playing `best` (a `choose` result with the
    // deck's power, pb and ib) on table rt.
    function deckOf(order, snapObjs, best, rt, music) {
      const deck = {
        members: order,
        snaps: snapObjs,
        power: best.power,
        displayPower: Math.floor(best.power),
        rank: best.rank,
        rankName: RANK_NAMES[best.rank] || String(best.rank),
        chart: best.chart,
        needPower: best.needPower,
        needDisplayPower: Math.ceil(best.needPower),
        pointBonus: best.pb,
        itemBonus: best.ib,
        points: Math.round(best.points),
        items: Math.round(best.items),
        cp: best.cp === undefined ? cpOf(best.rank) : Math.round(best.cp),
        cpPoints: (best.cp === undefined ? cpOf(best.rank) : best.cp) * cpValue,
        score: best.sc,
        music,
      };
      if (best.dist) {
        deck.expectedPoints = best.points;
        deck.rankChance = best.chance;
        deck.rankDist = best.dist.map(([r, p]) => ({ rank: r, rankName: RANK_NAMES[r] || String(r), p }));
      }
      // Pair rates (score objective): their score per unit of power, with the play's share.
      const snapRate = (best.x || 0) * shares(best.chart).mean;
      // Next rank: on any chart of the table per live, on the same chart per minute.
      if (scoreMode) {
        const nx = best.chart.thresholds.filter(([r]) => r > best.rank).sort((a, b) => a[0] - b[0])[0];
        if (nx) {
          deck.nextRank = nx[0];
          deck.nextRankName = RANK_NAMES[nx[0]];
          deck.nextNeedDisplayPower = Math.ceil(nx[1] / (rt.rate.get(best.chart) + snapRate));
        }
      }
      const nextRank = rt.rankList.slice().reverse().find((r) => r > best.rank);
      if (nextRank) {
        let need = rt.need.get(nextRank).power;
        if (perMinute) {
          const th = ownThresholds(best.chart).find((x) => x[0] === nextRank);
          need = th ? Math.ceil(th[1] / rt.rate.get(best.chart)) : null;
        }
        if (need !== null) {
          deck.nextRank = nextRank;
          deck.nextRankName = RANK_NAMES[nextRank];
          deck.nextNeedDisplayPower = Math.ceil(need);
        }
      }
      if (perMinute) deck.minutes = minutesOf(best.chart);
      deck.scoreRate = rt.rate.get(best.chart) + snapRate;
      deck.accuracy = accuracyFactor(m, best.chart.scoreId, accuracy);
      deck.estScore = Math.floor(best.power * deck.scoreRate);
      deck.baseScore = Math.floor(best.power * deck.chart.perPower * deck.accuracy);
      // Snaps' Gekisou support skills apart from their (non-Gekisou) snap skills; in points they are in rt's rates.
      const sup = gkSup ? deckSupport(order, snapObjs, best.chart, supOf) : 0;
      if (best.x) deck.snapScore = Math.floor(best.power * Math.max(0, best.x - sup) * deck.accuracy);
      if (roughSnaps) {
        deck.snapScore = Math.floor(best.power * deckSupport(order, snapObjs, best.chart, roughOf) * deck.accuracy);
        deck.snapRough = true;
      }
      if (gkSup) deck.gekisouSupportScore = Math.floor(best.power * sup * deck.accuracy);
      if (bt) {
        const g = order.reduce((a, v) => a + gekisouSkillRate(m, battle, bt, v, best.chart.scoreId, input.gekisouLevels), 0);
        deck.gekisouScore = Math.floor(best.power * g * deck.accuracy);
      }
      return deck;
    }

    // Live skill score per unit of power of each candidate on each chart of `list`; a set adds its five. The bound takes,
    // per chart, the five largest gains of any candidates.
    // With Gekisou, a member's Gekisou skill adds its own gain (whatever the performance order).
    // With pair rates (snap skills, Gekisou support skills), a bound also adds each member's best snap pairing at the
    // largest boost profile (`setBound`; `maxSkill` includes them) and `snapRates(c, g)` gives member view -> rates per
    // snap on chart c in a deck of boost profile g.
    function skillRates(list) {
      const skillOf = new Map();
      const boundOf = new Map();
      if (sw) {
        for (const v of allCand) {
          const terms = liveSkillTerms(m, v, sw.kinds);
          const gk = bt ? list.map((c) => gekisouSkillRate(m, battle, bt, v, c.scoreId, input.gekisouLevels)) : null;
          if (!terms.length && !(gk && gk.some((x) => x > 0))) continue;
          const a = new Float64Array(list.length);
          list.forEach((c, i) => {
            const w = sw.byScore.get(c.scoreId);
            if (w) for (const [q, f] of terms) a[i] += f * w[q];
            if (gk) a[i] += gk[i];
          });
          skillOf.set(v, a);
        }
      }
      // Pair rates per chart of list (member view -> rates per snap) in a deck of boost profile g; bounds take gMax.
      const ratesAt = new Map();
      const snapRatesAt = (g) => {
        const gk = g ? g.key : "";
        if (!ratesAt.has(gk)) ratesAt.set(gk, list.map((c) => new Map(allCand.map((v) => [v, snapRatesOf(v, c, g)]))));
        return ratesAt.get(gk);
      };
      const snapByChart = pairX ? snapRatesAt(gMax) : null;
      if (pairX) {
        for (const v of allCand) {
          const a = Float64Array.from(skillOf.get(v) || new Float64Array(list.length));
          list.forEach((c, i) => (a[i] += Math.max(0, ...snapByChart[i].get(v))));
          boundOf.set(v, a);
        }
      }
      const bounds = pairX ? boundOf : skillOf;
      const anySkill = bounds.size > 0;
      const maxSkill = new Float64Array(list.length);
      if (anySkill) {
        const all = [...bounds.values()];
        for (let i = 0; i < list.length; i++) {
          const top = all.map((a) => a[i]).sort((a, b) => b - a);
          for (let k = 0; k < 5 && k < top.length; k++) maxSkill[i] += top[k];
        }
      }
      const sum = (of) => (vs) => {
        const a = new Float64Array(list.length);
        for (const v of vs) {
          const x = of.get(v);
          if (x) for (let i = 0; i < a.length; i++) a[i] += x[i];
        }
        return a;
      };
      const snapRates = pairX ? (c, g = null) => snapRatesAt(g)[list.indexOf(c)] : null;
      return { anySkill, maxSkill, setSkill: sum(skillOf), setBound: sum(bounds), snapRates };
    }

    let evaluated = 0;
    if (randomSong) return scoreMode ? randomScoreSearch() : randomSongSearch();

    // The score objective on a random song: decks by the mean expected score over the songs, each played on one chart
    // (the one scoring most with the roster's five best skills, as scoreScope with margin 0). One leader and one snap
    // assignment serve every song; the power varies by song group (music type and tag bonuses), skill and pair rates by
    // chart. Sets are visited in the order of a cheap bound (the best skills of any five candidates on each chart), then
    // bounded by their own skills and best pairings, and evaluated exactly: per leader kept (one another matches or
    // beats in every song group is dropped) and per snap assignment the DP keeps in power and the pairs' mean rate.
    // That mean weighs each chart by its play share and the leader's F there, so the DP can drop an assignment that the
    // exact sum would have preferred by a rounding of the songs' bonuses.
    function randomScoreSearch() {
      const top5 = chartList.map((c, i) => {
        const r = members.map((v) => skillsOf.get(v)[i]).sort((a, b) => b - a);
        return r.slice(0, 5).reduce((a, b) => a + b, 0);
      });
      const pickBy = new Map();
      chartList.forEach((c, i) => {
        const r = (c.perPower + top5[i]) * shares(c).mean;
        const cur = pickBy.get(c.musicId);
        if (!cur || r > cur.r) pickBy.set(c.musicId, { c, r });
      });
      const list = [...pickBy.values()].map((x) => x.c);
      const nS = list.length;
      const w = list.map((c) => shares(c).mean);
      const gKey = new Map();
      const gl = [];
      const gOf = new Int32Array(nS);
      list.forEach((c, k) => {
        const mv = musicView(m, c.musicId);
        const key = mv.musicType + "|" + mv.tags.join(",");
        if (!gKey.has(key)) {
          gKey.set(key, gl.length);
          gl.push({ music: mv, fNo: Int32Array.from(allCand, (v) => slotF(m, v, [0, 0, 0], mv, ctx)) });
        }
        gOf[k] = gKey.get(key);
      });
      const nG = gl.length;
      const sk = skillRates(list);
      const powB = (g, s) => {
        const o = s * 5;
        const f = gl[g].fNo;
        return setSU[s] + f[setV[o]] + f[setV[o + 1]] + f[setV[o + 2]] + f[setV[o + 3]] + f[setV[o + 4]];
      };
      // Cheap bound: sum over groups of W_g * powB(g, s), W_g the group's charts' best rates (weighted by play share).
      const Wg = new Float64Array(nG);
      list.forEach((c, k) => (Wg[gOf[k]] += w[k] * (c.perPower + (sk.anySkill ? sk.maxSkill[k] : 0))));
      const Wtot = Wg.reduce((a, b) => a + b, 0);
      const h = Float64Array.from(allCand, (_, vi) => {
        let x = 0;
        for (let g = 0; g < nG; g++) x += Wg[g] * gl[g].fNo[vi];
        return x;
      });
      const cheap = new Float64Array(nSets);
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = 0; s < nSets; s++) {
        const o = s * 5;
        const x = setSU[s] * Wtot + h[setV[o]] + h[setV[o + 1]] + h[setV[o + 2]] + h[setV[o + 3]] + h[setV[o + 4]];
        cheap[s] = x;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      const bw = (hi - lo) / NB || 1;
      const binOf = (x) => Math.min(NB - 1, Math.max(0, Math.floor((x - lo) / bw)));
      const start = new Int32Array(NB + 1);
      const bmax = new Float64Array(NB).fill(-Infinity);
      for (let s = 0; s < nSets; s++) {
        const b = binOf(cheap[s]);
        start[b + 1]++;
        if (cheap[s] > bmax[b]) bmax[b] = cheap[s];
      }
      for (let b = 0; b < NB; b++) start[b + 1] += start[b];
      const fill = start.slice(0, NB);
      const order = new Int32Array(nSets);
      for (let s = 0; s < nSets; s++) order[fill[binOf(cheap[s])]++] = s;
      const setVs = (s) => [0, 1, 2, 3, 4].map((i) => allCand[setV[s * 5 + i]]);
      // A set's own bound: its skills and each member's best pairing (at the strongest gauge) at its power bound per group.
      const ubOf = (s) => {
        const b = sk.anySkill ? sk.setBound(setVs(s)) : null;
        const pg = new Float64Array(nG);
        for (let g = 0; g < nG; g++) pg[g] = powB(g, s);
        let x = 0;
        for (let k = 0; k < nS; k++) x += w[k] * pg[gOf[k]] * (list[k].perPower + (b ? b[k] : 0));
        return x;
      };
      // Pair sums of a snap assignment on each chart (xr[k]: member view -> rates per snap).
      const pairSums = (vs, pick, xr) => {
        const xs = new Float64Array(nS);
        if (!xr) return xs;
        for (let p = pick; p; p = p.prev) {
          const v = vs[p.i];
          for (let k = 0; k < nS; k++) xs[k] += xr[k].get(v)[p.j];
        }
        return xs;
      };
      const ratesOf = (vs) => (sk.snapRates ? list.map((c) => sk.snapRates(c, boostOf(vs))) : null);

      function exact(s) {
        evaluated++;
        const o = s * 5;
        const vs = setVs(s);
        const skill = sk.anySkill ? sk.setSkill(vs) : null;
        const leads = [];
        for (let L = 0; L < 5; L++) {
          const li = setV[o + L];
          const lorder = vs.slice();
          [lorder[L], lorder[LEADER_SLOT]] = [lorder[LEADER_SLOT], lorder[L]];
          let lt = 0;
          if (simpleAt[li]) for (let i = 0; i < 5; i++) lt += LT[li * N + setV[o + i]];
          const f = new Float64Array(nG);
          gl.forEach((g, gi) => {
            if (simpleAt[li]) {
              f[gi] = lt;
              for (let i = 0; i < 5; i++) f[gi] += g.fNo[setV[o + i]];
            } else {
              const lead = leaderBonuses(m, lorder, LEADER_SLOT, g.music);
              lorder.forEach((v, i) => (f[gi] += slotF(m, v, lead[i], g.music, ctx)));
            }
          });
          leads.push({ L, f });
        }
        const geq = (a, b) => a.f.every((x, g) => x >= b.f[g]);
        const kept = leads.filter((a, i) => !leads.some((b, j) => j !== i && geq(b, a) && (j < i || !geq(a, b))));
        const G = vs.map((v) => Gm.get(v));
        const xr = ratesOf(vs);
        let X = null;
        if (xr) {
          const f0 = kept[0].f;
          X = vs.map((v) => {
            const row = new Float64Array(snaps.length);
            for (let k = 0; k < nS; k++) {
              const r = xr[k].get(v);
              const wk = w[k] * f0[gOf[k]];
              for (let j = 0; j < row.length; j++) row[j] += wk * r[j];
            }
            return row;
          });
        }
        let best = null;
        for (const st of snapStates(G, snapPoint, snapItem, snaps.length, X)) {
          const xs = pairSums(vs, st.pick, xr);
          for (const ld of kept) {
            let sum = 0;
            for (let k = 0; k < nS; k++) sum += w[k] * (ld.f[gOf[k]] + st.power) * (list[k].perPower + (skill ? skill[k] : 0) + xs[k]);
            if (!best || sum > best.sum || (sum === best.sum && st.power > best.g)) best = { sum, st, g: st.power, ld, xs };
          }
        }
        return { s, vs, best };
      }

      const found = [];
      const slack = (x) => x - Math.abs(x) * 1e-9;
      const threshold = () => (found.length >= topK ? slack(found[topK - 1].best.sum) : -Infinity);
      const heap = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.e < y.e));
      let b = NB - 1;
      for (;;) {
        while (b >= 0) {
          if (start[b] === start[b + 1]) {
            b--;
            continue;
          }
          if (bmax[b] < threshold() || (heap.size && bmax[b] < heap.top().key)) break;
          const th = threshold();
          for (let i = start[b]; i < start[b + 1]; i++) {
            const s = order[i];
            const key = ubOf(s);
            if (key >= th) heap.push({ key, s, e: setEnum[s] });
          }
          b--;
        }
        if (!heap.size) break;
        const x = heap.pop();
        if (x.key < threshold()) break;
        const r = exact(x.s);
        r.e = x.e;
        found.push(r);
        found.sort((p, q) => q.best.sum - p.best.sum || p.e - q.e);
        if (found.length > topK) found.length = topK;
      }

      // A found set as a deck: the mean expected score over the songs and the power the multiplayer formation screen
      // shows (no song, so no music bonus); `perSong` holds the deck on each song.
      const build = (r) => {
        const { best, vs } = r;
        const lorder = vs.slice();
        const snapObjs = pickToSnaps(best.st.pick).map((j) => (j === null ? null : snaps[j]));
        const L = best.ld.L;
        [lorder[L], lorder[LEADER_SLOT]] = [lorder[LEADER_SLOT], lorder[L]];
        [snapObjs[L], snapObjs[LEADER_SLOT]] = [snapObjs[LEADER_SLOT], snapObjs[L]];
        const skill = sk.anySkill ? sk.setSkill(vs) : null;
        const perSong = list.map((c, k) => {
          const power = best.ld.f[gOf[k]] + best.g;
          const rt = rankTable([c], skill ? [skill[k]] : null, false);
          const v = choose(rt, power, 0, 0, best.xs[k]);
          return deckOf(lorder, snapObjs, { ...v, power, pb: 0, ib: 0 }, rt, gl[gOf[k]].music);
        });
        const power = deckPower(m, lorder, snapObjs, null, ctx);
        const mean = (f) => perSong.reduce((a, d) => a + (f(d) || 0), 0) / nS;
        const deck = {
          members: lorder,
          snaps: snapObjs,
          power,
          displayPower: Math.floor(power),
          random: true,
          songCount: nS,
          rank: null,
          rankName: "—",
          chart: null,
          pointBonus: 0,
          itemBonus: 0,
          points: 0,
          items: 0,
          cp: 0,
          cpPoints: 0,
          score: best.sum / nS,
          estScore: Math.round(mean((d) => d.estScore)),
          baseScore: Math.round(mean((d) => d.baseScore)),
          snapScore: Math.round(mean((d) => d.snapScore)),
          accuracy: mean((d) => d.accuracy),
        };
        if (bt) deck.gekisouScore = Math.round(mean((d) => d.gekisouScore));
        if (gkSup) deck.gekisouSupportScore = Math.round(mean((d) => d.gekisouSupportScore));
        perSong.sort((a, b2) => b2.score - a.score || b2.power - a.power);
        return { deck, perSong };
      };
      const built = found.map(build);
      return {
        results: built.map((x) => x.deck),
        songs: input.compareSongs && built.length ? built[0].perSong : [],
        perSong: built.map((x) => x.perSong),
        random: true,
        rate,
        gekisou: bt ? { rank: bt.rank, justRate: bt.justRate } : null,
        payoff: pay,
        ctx,
        stats: { sets: nSets, evaluated, groups: nG, songs: nS, ms: Date.now() - t0 },
      };
    }

    // A public room plays a song drawn at random (直接開始, or a draw among the players' picks): the deck is set
    // before the song is known, so decks are ranked by the mean payoff over the songs, each played on its best allowed
    // chart. One leader and one snap assignment serve every song; the power varies by song group (music type and tag
    // bonuses). Bounds use, per group, a step table of how many songs reach each rank at each power level.
    function randomSongSearch() {
      const gl = [...groups.values()];
      const nG = gl.length;
      const chartIdx = new Map(chartList.map((c, i) => [c, i]));
      const songList = [];
      gl.forEach((g, gi) => {
        const byMusic = new Map();
        for (const c of g.charts) {
          if (!byMusic.has(c.musicId)) byMusic.set(c.musicId, []);
          byMusic.get(c.musicId).push(c);
        }
        for (const list of byMusic.values()) songList.push({ g: gi, list, idx: list.map((c) => chartIdx.get(c)) });
      });
      const nSongs = songList.length;
      const sk = skillRates(chartList);
      const allIdx = Int32Array.from(chartList, (_, i) => i);
      const pick = (a, so) => (a ? Float64Array.from(so.idx, (i) => a[i]) : null);
      const tablesOf = (skill, optimistic) => songList.map((so) => rankTable(so.list, pick(skill, so), optimistic));
      const boundT = tablesOf(sk.anySkill ? sk.maxSkill : null, stochastic);
      let meanNoSkill = null;
      let RMAX = 1;
      for (const t of boundT) for (const r of t.rankList) RMAX = Math.max(RMAX, r + 1);
      // Payoff of each rank with bonuses pb/ib, indexed by rank.
      const values = (pb, ib) => {
        const out = new Float64Array(RMAX);
        for (let r = 0; r < RMAX; r++) {
          out[r] = scoreOf(eventPoints(pb, rate, pay.points.get(r) || 0), eventItems(pay.items.get(r) || 0, ib, rate), r);
        }
        return out;
      };
      // Per group: power levels P (a power p is in level l when P[l - 1] <= p < P[l]) and cnt[l * RMAX + r], the songs
      // the bound tables put at rank r in level l.
      const steps = gl.map((g, gi) => {
        const ks = [];
        songList.forEach((so, k) => so.g === gi && ks.push(k));
        const ps = new Set();
        for (const k of ks) for (const n of boundT[k].need.values()) ps.add(n.power);
        const P = Float64Array.from(ps).sort();
        const cnt = new Float64Array((P.length + 1) * RMAX);
        for (const k of ks) for (let l = 0; l <= P.length; l++) cnt[l * RMAX + boundT[k].rankFor(l ? P[l - 1] : -Infinity)]++;
        const fNo = Int32Array.from(allCand, (v) => slotF(m, v, [0, 0, 0], g.music, ctx));
        return { P, cnt, fNo };
      });
      const levelOf = (P, p) => {
        let a = 0;
        let b = P.length;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (P[mid] <= p) a = mid + 1;
          else b = mid;
        }
        return a;
      };
      // Per group, the summed payoff of its songs at each level.
      const levelVals = (pb, ib) => {
        const vals = values(pb, ib);
        return steps.map(({ P, cnt }) => {
          const lv = new Float64Array(P.length + 1);
          for (let l = 0; l <= P.length; l++) for (let r = 0; r < RMAX; r++) lv[l] += cnt[l * RMAX + r] * vals[r];
          return lv;
        });
      };
      // Song-independent bound on a set's power in group g (F without leader + setSU).
      const powBound = (g, s) => {
        const o = s * 5;
        const f = steps[g].fNo;
        return setSU[s] + f[setV[o]] + f[setV[o + 1]] + f[setV[o + 2]] + f[setV[o + 3]] + f[setV[o + 4]];
      };
      const bMax = new Float64Array(nG * B).fill(-Infinity);
      for (let g = 0; g < nG; g++) {
        for (let b = 0; b < B; b++) {
          for (let s = bStart[b]; s < bEnd[b]; s++) {
            const p = powBound(g, s);
            if (p > bMax[g * B + b]) bMax[g * B + b] = p;
          }
        }
      }
      // Sums over songs in a different order: a bound may fall a rounding error short of the exact payoff.
      const slack = (x) => x - Math.abs(x) * 1e-9;

      // The exact best deck of set s (sum of the payoff over the songs), or null when its own bound misses `th`.
      function exact(s, th) {
        evaluated++;
        const o = s * 5;
        const vs = [0, 1, 2, 3, 4].map((i) => allCand[setV[o + i]]);
        const bk = bucketIdx(s);
        const pt = bPt[bk];
        const it = bIt[bk];
        const skill = sk.anySkill ? sk.setSkill(vs) : null;
        // With Gekisou support skills, the bound adds each member's best pairing and every snap assignment plays tables
        // of its own (as pairTable).
        const bound = pairPts ? sk.setBound(vs) : skill;
        const bndT = bound ? tablesOf(bound, stochastic) : boundT;
        const meanT = pairPts ? null : !stochastic ? bndT : skill ? tablesOf(skill, false) : meanNoSkill || (meanNoSkill = tablesOf(null, false));
        if (bound && th > -Infinity) {
          const vals = values(pt + maxSnapPoint, it + maxSnapItem);
          const pb = gl.map((_, g) => powBound(g, s));
          let ub = 0;
          songList.forEach((so, k) => (ub += vals[bndT[k].rankFor(pb[so.g])]));
          if (ub < th) return null;
        }
        // Exact F per group for each leader; leaders another matches or beats in every group are dropped.
        const leads = [];
        for (let L = 0; L < 5; L++) {
          const li = setV[o + L];
          const order = vs.slice();
          [order[L], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[L]];
          let lt = 0;
          if (simpleAt[li]) for (let i = 0; i < 5; i++) lt += LT[li * N + setV[o + i]];
          const f = new Float64Array(nG);
          gl.forEach((g, gi) => {
            if (simpleAt[li]) {
              f[gi] = lt;
              for (let i = 0; i < 5; i++) f[gi] += steps[gi].fNo[setV[o + i]];
            } else {
              const lead = leaderBonuses(m, order, LEADER_SLOT, g.music);
              order.forEach((v, i) => (f[gi] += slotF(m, v, lead[i], g.music, ctx)));
            }
          });
          leads.push({ L, f });
        }
        const geq = (a, b) => a.f.every((x, g) => x >= b.f[g]);
        const kept = leads.filter((a, i) => !leads.some((b, j) => j !== i && geq(b, a) && (j < i || !geq(a, b))));
        const G = vs.map((v) => Gm.get(v));
        let best = null;
        for (const st of snapStates(G, snapPoint, snapItem, snaps.length, pairPts ? supportMeans(vs, allIdx) : null)) {
          const pb = pt + st.pt;
          const ib = it + st.it;
          const vals = stochastic ? null : values(pb, ib);
          const g = st.power;
          let T = meanT;
          if (pairPts) {
            const x = pairSum(vs, st.pick, allIdx);
            if (skill) for (let c = 0; c < x.length; c++) x[c] += skill[c];
            T = tablesOf(x, false);
          }
          for (const ld of kept) {
            let sum = 0;
            for (let k = 0; k < nSongs; k++) {
              const p = ld.f[songList[k].g] + g;
              sum += vals ? vals[T[k].rankFor(p)] : choose(T[k], p, pb, ib).sc;
            }
            if (!best || sum > best.sum || (sum === best.sum && g > best.g)) best = { sum, st, g, ld, pb, ib, T };
          }
        }
        return { s, vs, best, meanT: best.T };
      }

      const found = [];
      const threshold = () => (found.length >= topK ? slack(found[topK - 1].best.sum) : -Infinity);
      const buckets = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.b < y.b));
      for (let b = 0; b < B; b++) {
        if (bEnd[b] === bStart[b]) continue;
        const lv = levelVals(bPt[b] + maxSnapPoint, bIt[b] + maxSnapItem);
        let key = 0;
        for (let g = 0; g < nG; g++) key += lv[g][levelOf(steps[g].P, bMax[g * B + b])];
        buckets.push({ key, b });
      }
      const sets = new Heap((x, y) => x.key > y.key || (x.key === y.key && x.e < y.e));
      for (;;) {
        while (buckets.size && buckets.top().key >= threshold() && (!sets.size || buckets.top().key >= sets.top().key)) {
          const { b } = buckets.pop();
          const lv = levelVals(bPt[b] + maxSnapPoint, bIt[b] + maxSnapItem);
          const th = threshold();
          for (let s = bStart[b]; s < bEnd[b]; s++) {
            let key = 0;
            for (let g = 0; g < nG; g++) key += lv[g][levelOf(steps[g].P, powBound(g, s))];
            if (key >= th) sets.push({ key, s, e: setEnum[s] });
          }
        }
        if (!sets.size) break;
        const x = sets.pop();
        if (x.key < threshold()) break;
        const r = exact(x.s, threshold());
        if (!r) continue;
        r.e = x.e;
        found.push(r);
        found.sort((a, b) => b.best.sum - a.best.sum || a.e - b.e);
        if (found.length > topK) found.length = topK;
      }

      // A found set as a deck: the mean payoff over the songs, the share of songs at each rank and the power the
      // multiplayer formation screen shows (no song, so no music bonus); `songs` holds the deck on each song.
      const build = (r) => {
        const { best, vs, meanT } = r;
        const order = vs.slice();
        const snapObjs = pickToSnaps(best.st.pick).map((j) => (j === null ? null : snaps[j]));
        const L = best.ld.L;
        [order[L], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[L]];
        [snapObjs[L], snapObjs[LEADER_SLOT]] = [snapObjs[LEADER_SLOT], snapObjs[L]];
        const dist = new Map();
        let points = 0;
        let items = 0;
        let cp = 0;
        const perSong = songList.map((so, k) => {
          const power = best.ld.f[so.g] + best.g;
          const v = choose(meanT[k], power, best.pb, best.ib);
          if (v.dist) for (const [rk, p] of v.dist) dist.set(rk, (dist.get(rk) || 0) + p / nSongs);
          else dist.set(v.rank, (dist.get(v.rank) || 0) + 1 / nSongs);
          points += v.points / nSongs;
          items += v.items / nSongs;
          cp += (v.cp === undefined ? cpOf(v.rank) : v.cp) / nSongs;
          return deckOf(order, snapObjs, { ...v, power, pb: best.pb, ib: best.ib }, meanT[k], gl[so.g].music);
        });
        const rankDist = [...dist].sort((a, b) => b[0] - a[0]).map(([rk, p]) => ({ rank: rk, rankName: RANK_NAMES[rk] || String(rk), p }));
        let acc = 0;
        let median = rankDist[rankDist.length - 1];
        for (const x of rankDist) {
          acc += x.p;
          if (acc >= 0.5 - 1e-9) {
            median = { ...x, chance: acc };
            break;
          }
        }
        const power = deckPower(m, order, snapObjs, null, ctx);
        const mean = (f) => perSong.reduce((a, d) => a + (f(d) || 0), 0) / nSongs;
        const deck = {
          members: order,
          snaps: snapObjs,
          power,
          displayPower: Math.floor(power),
          random: true,
          songCount: nSongs,
          rank: median.rank,
          rankName: median.rankName,
          rankChance: median.chance,
          rankDist,
          chart: null,
          pointBonus: best.pb,
          itemBonus: best.ib,
          points: Math.round(points),
          items: Math.round(items),
          cp: Math.round(cp * 10) / 10,
          cpPoints: cp * cpValue,
          score: best.sum / nSongs,
          estScore: Math.round(mean((d) => d.estScore)),
          baseScore: Math.round(mean((d) => d.baseScore)),
        };
        if (bt) deck.gekisouScore = Math.round(mean((d) => d.gekisouScore));
        if (gkSup) deck.gekisouSupportScore = Math.round(mean((d) => d.gekisouSupportScore));
        if (roughSnaps) {
          deck.snapScore = Math.round(mean((d) => d.snapScore || 0));
          deck.snapRough = true;
        }
        perSong.sort((a, b) => b.score - a.score || b.power - a.power);
        return { deck, perSong };
      };
      const built = found.map(build);
      return {
        results: built.map((x) => x.deck),
        songs: input.compareSongs && built.length ? built[0].perSong : [],
        perSong: built.map((x) => x.perSong),
        random: true,
        rate,
        gekisou: bt ? { rank: bt.rank, justRate: bt.justRate } : null,
        payoff: pay,
        ctx,
        stats: { sets: nSets, evaluated, groups: nG, songs: nSongs, ms: Date.now() - t0 },
      };
    }

    const found = [];
    const songs = [];
    for (const group of groups.values()) {
      const music = group.music;
      const gc = group.charts;
      const { anySkill, maxSkill, setSkill, setBound, snapRates } = skillRates(gc);
      // The score objective with pair rates plays one chart per group: a pairing's rate is one number. Points with
      // Gekisou support skills bound a set by each member's best pairing and give each snap assignment a table of its own
      // (`px`, see pairTable).
      const Xm = snapRates && scoreMode ? (g) => snapRates(gc[0], g) : null;
      const pairPoints = pairPts;
      const rt = rankTable(gc, anySkill ? maxSkill : null, stochastic);
      const gcIdx = Int32Array.from(gc, (c) => chartIdx.get(c));
      const tables = (vs) => {
        const skill = anySkill ? setSkill(vs) : null;
        if (pairPoints) return { bound: rankTable(gc, setBound(vs), stochastic), mean: null, px: pairsOn(gc, gcIdx, skill) };
        return stochastic ? { bound: rankTable(gc, skill, true), mean: rankTable(gc, skill, false) } : { bound: rankTable(gc, skill), mean: null };
      };
      const fNo = Int32Array.from(allCand, (v) => slotF(m, v, [0, 0, 0], music, ctx));

      // Exact best leader F of set s (cached in bfF/bfL): simple leaders from LT, others exactly.
      bfF.fill(-1);
      const bestF = (s) => {
        if (bfF[s] < 0) {
          const o = s * 5;
          let base = 0;
          for (let i = 0; i < 5; i++) base += fNo[setV[o + i]];
          let bf = base;
          let leader = 0;
          for (let L = 0; L < 5; L++) {
            const li = setV[o + L];
            let f;
            if (simpleAt[li]) {
              f = base;
              for (let i = 0; i < 5; i++) f += LT[li * N + setV[o + i]];
            } else {
              const order = [0, 1, 2, 3, 4].map((i) => allCand[setV[o + i]]);
              [order[L], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[L]];
              const lead = leaderBonuses(m, order, LEADER_SLOT, music);
              f = 0;
              order.forEach((v, i) => (f += slotF(m, v, lead[i], music, ctx)));
            }
            if (f > bf || (L === 0 && leader === 0 && f >= bf)) {
              bf = f;
              leader = L;
            }
          }
          bfF[s] = bf;
          bfL[s] = leader;
        }
        return { f: bfF[s], leader: bfL[s] };
      };
      // Song-independent bound on each set's power for this group (F without leader + setSU), its maximum per bucket.
      const powBound = (s) => {
        const o = s * 5;
        return setSU[s] + fNo[setV[o]] + fNo[setV[o + 1]] + fNo[setV[o + 2]] + fNo[setV[o + 3]] + fNo[setV[o + 4]];
      };
      const bMax = new Float64Array(B);
      if (scoreMode) bins = binSets(powBound);
      else {
        for (let b = 0; b < B; b++) {
          let mx = -Infinity;
          for (let s = bStart[b]; s < bEnd[b]; s++) {
            const p = powBound(s);
            if (p > mx) mx = p;
          }
          bMax[b] = mx;
        }
      }
      // Score mode bounds a set by its own skills (and each member's best snap pairing) on T's charts (choose's
      // arithmetic at the power bound).
      const gcIndex = new Map(gc.map((c, i) => [c, i]));
      const ubOf = scoreMode
        ? (s, T) => {
            const so = setOf(s);
            const bf = bestF(s);
            const sk = anySkill ? setBound(so.vs) : null;
            let r = 0;
            for (const c of T.charts) {
              const x = (c.perPower + (sk ? sk[gcIndex.get(c)] : 0)) * shares(c).mean;
              if (x > r) r = x;
            }
            return (bf.f + so.g) * r;
          }
        : (s, T) => upperBound(setOf(s), bestF(s), T);
      const walk = scoreMode ? walkScore : bestFirst;

      const groupFound = [];
      let kth = -Infinity;
      // walkScore visits a set only when its own bound (ubOf) reaches the threshold.
      walk(rt, bMax, powBound, ubOf, () => (groupFound.length >= topK ? kth : -Infinity), (s) => {
        const so = setOf(s);
        const bf = bestF(s);
        const t = anySkill || stochastic ? tables(so.vs) : { bound: rt, mean: null };
        if (!scoreMode && anySkill && groupFound.length >= topK && upperBound(so, bf, t.bound) < kth) return;
        groupFound.push(evaluate(so, bf, t.mean || t.bound, music, Xm, t.px));
        groupFound.sort((a, b) => b.score - a.score || b.power - a.power);
        if (groupFound.length > topK) groupFound.length = topK;
        if (groupFound.length >= topK) kth = groupFound[topK - 1].score;
      });
      found.push(...groupFound);

      // Song comparison: the best deck of every song of the group, from the same leader terms. The set with the
      // highest bound gives a floor; only sets whose bound reaches it can beat it.
      if (input.compareSongs) {
        const bySong = new Map();
        gc.forEach((c, i) => {
          if (!bySong.has(c.musicId)) bySong.set(c.musicId, []);
          bySong.get(c.musicId).push(i);
        });
        for (const idx of bySong.values()) {
          const list = idx.map((i) => gc[i]);
          const pick = (a) => Float64Array.from(idx, (i) => a[i]);
          const srt = rankTable(list, anySkill ? pick(maxSkill) : null, stochastic);
          const songTables = (vs) => {
            const sk = anySkill ? pick(setSkill(vs)) : null;
            if (pairPoints) return { bound: rankTable(list, pick(setBound(vs)), stochastic), mean: null, px: pairsOn(list, Int32Array.from(idx, (i) => gcIdx[i]), sk) };
            if (stochastic) return { bound: rankTable(list, sk, true), mean: rankTable(list, sk, false) };
            const b = anySkill ? rankTable(list, sk) : srt;
            return { bound: b, mean: b };
          };
          let best = null;
          walk(srt, bMax, powBound, ubOf, () => (best ? best.score : -Infinity), (s) => {
            const so = setOf(s);
            const bf = bestF(s);
            const ti = songTables(so.vs);
            if (!scoreMode && best && (anySkill || stochastic) && upperBound(so, bf, ti.bound) < best.score) return;
            const d = evaluate(so, bf, ti.mean || ti.bound, music, Xm, ti.px);
            if (!best || d.score > best.score || (d.score === best.score && d.power > best.power)) best = d;
          });
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
    // With one chart per group a song can appear once per difficulty: keep its best.
    if (snapSkill) {
      const seenSong = new Set();
      for (let i = 0; i < songs.length; i++) {
        if (seenSong.has(songs[i].chart.musicId)) songs.splice(i--, 1);
        else seenSong.add(songs[i].chart.musicId);
      }
    }
    const gekisou = bt ? { rank: bt.rank, justRate: bt.justRate } : null;
    return { results, songs, rate, gekisou, payoff: pay, ctx, stats: { sets: nSets, evaluated, groups: groups.size, ms: Date.now() - t0 } };
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

  // ---------------------------------------------------------------------------------------------------------------
  // Multiplayer lives with Gekisou
  //
  // A multiplayer (激奏) live plays the chart's three fevers as Gekisou ranges: Just judgements inside Just-count
  // ranges (230% of a note's score), the Gekisou combo and luck rushes, and at each range's end a rank bonus of a share
  // of the range's score, by the player's rank in the room for the range's mission. The room's rank compares the summed
  // Gekisou scores with the battle thresholds; the score saved as the high score (and shown big on the result screen)
  // has no Gekisou at all. Gekisou skills (member cards) and Gekisou support skills (snaps) only act here.

  /**
   * Gekisou-on chart data from music-data.json, as nnnotes measured it (theoretical best play: Just inside Just-count
   * ranges, Perfect elsewhere; rank 1 in every range; luck ranges on the first published seeds):
   * {power, kinds, shapes: "gekisouSkillId:level" -> aptitude shape of member Gekisou skills (measured at level 5),
   *  supportShapes: "gekisouSupportSkillId:level" -> aptitude shape of snaps' Gekisou support skills (level 5),
   *  byScore: scoreId -> {seeds: [{seed, score, scorePerfect, ranges: [[rangeScore, rangeScorePerfect, rankBonus]],
   *  weights, rangeWeights}], percents: rank bonus % per range at ranks 1..5, missions (the song's range missions: 1 COMBO,
   *  2 LUCK, 3 JUST), luck (whether a range is a LUCK one, whose lottery draws from the live's seed), apt: shape -> {tail, tailPerfect, ranges: [[rangeScore, rangeScorePerfect]]}
   *  (seed means of the increments), aptSupport: "shape:match" -> the same for a support shape, paired with a member
   *  that is (1) or is not (0) a target of its member condition (5000), justRanges: per range [Just notes, notes] of the
   *  Just play (0 Just notes outside the Just-count ranges)}}.
   * Plain data (structured-cloneable).
   */
  function battleFromMusicData(md) {
    const dk = md && md.deck;
    const out = {
      power: (dk && dk.model && dk.model.power) || 0, kinds: (dk && dk.kinds) || [], shapes: new Map(), supportShapes: new Map(), byScore: new Map(),
    };
    if (!out.power) return out;
    for (const sh of (dk.gekisouAptitude && dk.gekisouAptitude.shapes) || []) {
      const to = sh.source === "member" ? out.shapes : sh.source === "support" ? out.supportShapes : null;
      if (to) for (const s of sh.skills) to.set(s.id + ":" + s.level, sh.id);
    }
    const inc = (v) => ({ tail: v.tail[0], tailPerfect: v.tailPerfect[0], ranges: v.ranges.map((r) => [r.rangeScore[0], r.rangeScorePerfect[0]]) });
    for (const s of md.songs || []) {
      for (const c of s.charts || []) {
        const d = c.deck;
        if (!d || d.unplayable || !d.seeds || !d.seeds.length || !d.ranges || d.ranges.length !== 3) continue;
        const apt = new Map();
        const aptSupport = new Map();
        for (const v of (d.gekisouAptitude && d.gekisouAptitude.variants) || []) {
          if (v.bandMatch === null || v.bandMatch === undefined) apt.set(v.shape, inc(v));
          else aptSupport.set(v.shape + ":" + (v.bandMatch ? 1 : 0), inc(v));
        }
        out.byScore.set(c.scoreId, {
          seeds: d.seeds.map((x) => ({
            seed: x.seed || 0,
            score: x.score,
            scorePerfect: x.scorePerfect,
            ranges: x.ranges.map((r) => [r.rangeScore, r.rangeScorePerfect, r.rankBonus]),
            weights: x.weights,
            rangeWeights: x.rangeWeights,
          })),
          percents: d.ranges.map((r) => r.rankBonusPercents),
          missions: (s.gekisouMissions || []).slice(),
          luck: (s.gekisouMissions || []).includes(2),
          apt,
          aptSupport,
          justRanges: d.seeds[0].ranges.map((r) => [r.justCount || 0, r.maxCombo || 0]),
        });
      }
    }
    return out;
  }

  /**
   * Per chart, the no-skill score per unit of power with Gekisou at `rank` (1..5, every range) and `justRate` (share of
   * the Just-count ranges' Just notes judged Just, the rest Perfect), and the live skill weights at that rank
   * (music-data `ranks`: the rank bonus changes by (p(r) - p(1)) / 100 of each range's score). The Just rate
   * interpolates linearly between the Perfect and the Just play, which is approximate; skill weights were measured on
   * the Just play, so each range's part of them (rangeWeights) is scaled by the range's score at the Just rate over the
   * Just play's. `apt` (scoreId -> shape -> {tail, ranges}) holds the member Gekisou skills' measured increments
   * per unit of power, `aptSupport` (scoreId -> "shape:match" -> increment) the snaps' Gekisou support skills'.
   * For the support skills that add up per Just (gekisouSupportJustStack), `aptSupportJust` (scoreId -> "shape:match" ->
   * {tail, ranges}) keeps the Just play's increments at the rank and `justRanges` (scoreId -> [[Just notes, notes, range
   * score at the Just rate over the Just play's]]) what scales them.
   */
  function battleRates(battle, rank, justRate) {
    const r = Math.min(5, Math.max(1, Math.round(rank || 1)));
    const j = Math.min(1, Math.max(0, justRate ?? 1));
    const P = battle.power;
    const nk = battle.kinds.length;
    const perPower = new Map();
    const weights = new Map();
    const apt = new Map();
    const aptSupport = new Map();
    const aptSupportJust = new Map();
    const justRanges = new Map();
    for (const [sid, b] of battle.byScore) {
      const p = b.percents.map((row) => [row[0], row[r - 1]]);
      let base = 0;
      const w = new Float64Array(nk);
      // Each range's score at Just rate j over the Just play's (seed means): a Just note scores more than a Perfect one.
      const rs = [0, 0, 0];
      const rsP = [0, 0, 0];
      for (const s of b.seeds) {
        s.ranges.forEach(([x, xP], i) => {
          rs[i] += x;
          rsP[i] += xP;
        });
      }
      const js = rs.map((x, i) => (x > 0 ? (rsP[i] + j * (x - rsP[i])) / x : 1));
      for (const s of b.seeds) {
        let sc = s.score;
        let sp = s.scorePerfect;
        s.ranges.forEach(([rs, rsP, rb], i) => {
          sc += Math.trunc((rs * p[i][1]) / 100) - rb;
          sp += Math.trunc((rsP * p[i][1]) / 100) - Math.trunc((rsP * p[i][0]) / 100);
        });
        base += sp + j * (sc - sp);
        (s.weights || []).forEach((row, q) => {
          if (!row || q >= nk) return;
          const rw = s.rangeWeights && s.rangeWeights[q];
          for (let k = 0; k < 5; k++) {
            w[q] += row[k] || 0;
            if (rw && rw[k]) for (let i = 0; i < 3; i++) w[q] += ((p[i][1] - p[i][0]) / 100 - (1 + p[i][1] / 100) * (1 - js[i])) * (rw[k][i] || 0);
          }
        });
      }
      perPower.set(sid, base / b.seeds.length / P);
      for (let q = 0; q < nk; q++) w[q] /= 5 * b.seeds.length;
      weights.set(sid, w);
      const at = (a) => ({
        tail: (a.tailPerfect + j * (a.tail - a.tailPerfect)) / P,
        ranges: a.ranges.map(([rs, rsP], i) => ((rsP + j * (rs - rsP)) * (1 + p[i][1] / 100)) / P),
      });
      const g = new Map();
      for (const [shape, a] of b.apt) g.set(shape, at(a));
      apt.set(sid, g);
      const gs = new Map();
      const gj = new Map();
      for (const [key, a] of b.aptSupport || []) {
        const x = at(a);
        gs.set(key, x.tail + x.ranges.reduce((s, y) => s + y, 0));
        gj.set(key, { tail: a.tail / P, ranges: a.ranges.map(([y], i) => (y * (1 + p[i][1] / 100)) / P) });
      }
      aptSupport.set(sid, gs);
      aptSupportJust.set(sid, gj);
      if (b.justRanges) justRanges.set(sid, b.justRanges.map(([J, n], i) => [J, n, js[i]]));
    }
    return { rank: r, justRate: j, perPower, weights, apt, aptSupport, aptSupportJust, justRanges, memo: new Map() };
  }

  /**
   * Expected score per unit of power a member's Gekisou skill adds on chart `scoreId`: nnnotes' measured increment of
   * its shape (alone, at the top level) times `levels` ("skillId:level" -> factor, Simulate.gekisouLevelFactors) for a
   * lower level, whose trigger conditions or activation time differ. 0 when the shape was not measured on the chart or a
   * lower level has no factor. Skills of one deck are added up, which is approximate (the simulation plays them all).
   */
  function gekisouSkillRate(m, battle, bt, v, scoreId, levels) {
    if (!v.gekisouSkillId) return 0;
    const top = m.gekisouSkillMaxLevel.get(v.gekisouSkillId) || 1;
    const factor = v.gekisouSkillLevel >= top ? 1 : (levels && levels.get(v.gekisouSkillId + ":" + v.gekisouSkillLevel)) || 0;
    const shape = battle.shapes.get(v.gekisouSkillId + ":" + top);
    const g = factor && shape !== undefined && bt.apt.get(scoreId) && bt.apt.get(scoreId).get(shape);
    if (!g) return 0;
    return factor * (g.tail + g.ranges.reduce((a, x) => a + x, 0));
  }

  /**
   * Whether member `v` is a target of the member condition (5000) of Gekisou support skill `id` at `level`: the first
   * one among its effect rows, as music-data's support shapes were measured (bandMatch). false without one.
   */
  function gekisouSupportMatch(m, v, id, level) {
    for (const e of m.gekisouSupportSkillEffects.get(id + ":" + level) || []) {
      for (const g of [e._skillTriggerConditionGroup, e._skillConditionGroup, e._skillReleaseConditionGroup]) {
        for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c && c._conditionType === 5000) return matchesAny(v, targetsOf(m, c._conditionTargetIDs));
          }
        }
      }
    }
    return false;
  }

  // Score-up effects whose gain is proportional to the effect value (2001 with a cap in the same proportion).
  const LINEAR_SUPPORT_EFFECTS = new Set([2000, 2001]);

  /**
   * The gain of Gekisou support skill `id` at `level` over its top level, when the two differ only in values and caps
   * that every effect row scales by one ratio, all of them score-ups (LUCKY RUSH 分數UP, the COMBO range's cumulative
   * score-up); else null, for Simulate.gekisouSupportLevelFactors to measure.
   */
  function gekisouSupportLevelRatio(m, id, level) {
    const top = m.gekisouSupportSkillMaxLevel.get(id) || 1;
    const a = m.gekisouSupportSkillEffects.get(id + ":" + level) || [];
    const b = m.gekisouSupportSkillEffects.get(id + ":" + top) || [];
    if (!a.length || a.length !== b.length) return null;
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    let ratio = null;
    for (let i = 0; i < a.length; i++) {
      const { _id: i1, _level: l1, _effectValue: v1, _maxEffectValue: c1, ...ra } = a[i];
      const { _id: i2, _level: l2, _effectValue: v2, _maxEffectValue: c2, ...rb } = b[i];
      if (!same(ra, rb) || !LINEAR_SUPPORT_EFFECTS.has(ra._skillEffectType) || !(v2 > 0)) return null;
      const r = v1 / v2;
      if ((ratio !== null && Math.abs(r - ratio) > 1e-9) || (c1 || c2 ? !(c2 > 0) || Math.abs(c1 / c2 - r) > 1e-9 : false)) return null;
      ratio = r;
    }
    return ratio;
  }

  /**
   * A Gekisou support skill that adds a score-up per Just up to a cap (the Just-count range's cumulative score-up): the
   * effect row of `id` at `level` for a member that is (`match` 1) or is not a target of its member condition, as
   * {value, cap, per (Justs per step), steps (most steps)}; null for any other skill.
   */
  function gekisouSupportJustStack(m, id, level, match) {
    const rows = m.gekisouSupportSkillEffects.get(id + ":" + level) || [];
    let out = null;
    for (const e of rows) {
      const cum = m.cumulative.get(e._skillCumulativeConditionID);
      const perJust = cum && cum._skillCumulativeConditionType === 1000 &&
        (cum._conditionTargetIDs || []).some((t) => m.skillTargets.get(t) && m.skillTargets.get(t)._judgement === 6);
      if (e._skillEffectType !== 2001 || !perJust || !(e._maxEffectValue > 0)) return null;
      let positive = null; // the row's member condition: whether it asks for a target (true) or a non-target (false)
      for (const cs of m.conditionSets.get(e._skillConditionGroup) || []) {
        for (const cid of cs._conditionIds) {
          const c = m.skillConditions.get(cid);
          if (c && c._conditionType === 5000) positive = !!c._isPositive;
        }
      }
      if (positive === null || positive === !!match) {
        out = { value: e._effectValue, cap: e._maxEffectValue, per: (cum._conditionValues && cum._conditionValues[0]) || 1, steps: cum._maxCumulativeCount || Infinity };
      }
    }
    return out;
  }

  /**
   * The mean score-up (in 1/10000) over a range of `n` notes, `J` of them Just notes in the Just play spread evenly, at
   * Just rate `j` (the simulation judges every 1/j-th Just note Just, as Simulate.gekisouRequest), of a stack `st`
   * (gekisouSupportJustStack) counting the Justs judged so far, the current note's included.
   */
  function justStackShare(J, n, j, st) {
    if (!(J > 0) || !(n > 0)) return 0;
    let sum = 0;
    let k = 0;
    let justs = 0;
    for (let i = 1; i <= n; i++) {
      if (Math.floor((i * J) / n) > Math.floor(((i - 1) * J) / n)) {
        k++;
        if (Math.floor(k * j) > Math.floor((k - 1) * j)) justs++;
      }
      sum += Math.min(st.cap, st.value * Math.min(st.steps, Math.floor(justs / st.per)));
    }
    return sum / n;
  }

  /**
   * What the Gekisou support skills of snap `s` add paired with member `v` on chart `scoreId`, per unit of power, as
   * [[mission, gain, kind (gekisouSupportKind: what other members' Gekisou skills raise), match]] (one per skill):
   * nnnotes' measured increment of the skill's shape (at the top level, beside a
   * Gekisou skill that does nothing) for whether `v` meets its member condition, times the level's factor below the top
   * level: gekisouSupportLevelRatio, else `levels` ("skillId:level:match" -> factor, Simulate.gekisouSupportLevelFactors;
   * 0 without one). A score-up per Just up to a cap (gekisouSupportJustStack) depends on the Just rate and the cap, not
   * in proportion: each range's increment of the Just play is scaled by the modelled stack (justStackShare) at the Just
   * rate and level over the Just play's at the top level, and by the range's score (Just notes score more); this is
   * within a few % of the simulation (13% low at worst, at Just rate 20%). Nothing when the member has no Gekisou
   * skill: the client builds support skills only beside one. Pairings are added up, which is approximate: the
   * simulation plays them together with the members' Gekisou skills (a member's LUCK gauge skill brings more of the
   * rushes that LUCKY RUSH 分數UP acts in, a COMBO count-up skill stacks the COMBO range's score-up sooner: the search
   * adds luckGaugeBoost's and comboCountBoost's share).
   */
  function gekisouSupportTerms(m, battle, bt, v, s, scoreId, levels) {
    const out = [];
    const g = v.gekisouSkillId && bt.aptSupport && bt.aptSupport.get(scoreId);
    if (!g) return out;
    for (const [id, level] of s.gekisouSupportSkills || []) {
      const top = m.gekisouSupportSkillMaxLevel.get(id) || 1;
      const shape = battle.supportShapes.get(id + ":" + top);
      const row = m.gekisouSupportSkills.get(id);
      if (shape === undefined || !row) continue;
      const match = gekisouSupportMatch(m, v, id, top) ? 1 : 0;
      const stack = gekisouSupportJustStack(m, id, Math.min(level, top), match);
      const gj = stack && bt.aptSupportJust && bt.aptSupportJust.get(scoreId);
      if (gj) {
        const a = gj.get(shape + ":" + match);
        const jr = bt.justRanges.get(scoreId);
        if (!a || !jr) continue;
        const k = scoreId + "|" + id + ":" + level + ":" + match;
        if (!bt.memo.has(k)) {
          const st1 = gekisouSupportJustStack(m, id, top, match);
          let x = 0;
          let x1 = 0;
          a.ranges.forEach((y, i) => {
            const [J, n, sj] = jr[i];
            const f1 = st1 ? justStackShare(J, n, 1, st1) : 0;
            x1 += y;
            if (f1 > 0) x += (y * sj * justStackShare(J, n, bt.justRate, stack)) / f1;
          });
          bt.memo.set(k, x1 > 0 ? x + (a.tail * x) / x1 : 0);
        }
        const gain = bt.memo.get(k);
        if (gain) out.push([row._gekisouMissionType, gain, null, match]);
        continue;
      }
      const factor = level >= top ? 1 : gekisouSupportLevelRatio(m, id, level) ?? (levels && levels.get(id + ":" + level + ":" + match)) ?? 0;
      const gain = g.get(shape + ":" + match);
      if (factor && gain) out.push([row._gekisouMissionType, factor * gain, gekisouSupportKind(m, id), match]);
    }
    return out;
  }

  /** The sum of gekisouSupportTerms. */
  function gekisouSupportRate(m, battle, bt, v, s, scoreId, levels) {
    return gekisouSupportTerms(m, battle, bt, v, s, scoreId, levels).reduce((a, [, x]) => a + x, 0);
  }

  // A member's LUCK gauge Gekisou skill brings more lucky rushes, and every LUCKY RUSH 分數UP of the deck (whoever holds
  // it) gains in proportion. Measured 2026-10-07 on every chart with a LUCK range (32 seeds, rank 3, five rush snaps on
  // members whose own Gekisou skill does nothing, with and without one gauge member): gauge accumulation up (11001) adds
  // 17% to the rush snaps' gain on all-LUCK charts (14–20% by skill, ±7 points chart to chart) and 32% on charts with one
  // LUCK range, at any level (Lv1 acts 2 s at the range's start, but an early rush chains); the LIFE version (11003) acts
  // with a chance (condition 4011, at full LIFE) and adds in proportion to it, 50% ≈ 11001. A second gauge member adds
  // little, so a deck takes its strongest. Per-chart values were too noisy to use (±5 points with 64 seeds).
  const LUCK_GAUGE_BOOST = { allLuck: 0.17, mixed: 0.32 };
  const LUCK_GAUGE_CHANCE = 0.5;

  /**
   * The strength of the LUCK gauge Gekisou skill `id` at `level` (1 = gauge accumulation up, 11001; the LIFE version,
   * 11003, its chance at full LIFE over LUCK_GAUGE_CHANCE), or 0 for any other skill.
   */
  function luckGaugeOf(m, id, level) {
    let out = 0;
    for (const e of (id && m.gekisouSkillEffects.get(id + ":" + level)) || []) {
      if (e._skillEffectType === 11001) out = Math.max(out, 1);
      if (e._skillEffectType !== 11003) continue;
      let chance = null;
      let lifeOk = true;
      for (const cs of m.conditionSets.get(e._skillConditionGroup) || []) {
        for (const cid of cs._conditionIds) {
          const c = m.skillConditions.get(cid);
          if (!c) continue;
          // LIFE conditions (2000–2004) hold at full LIFE when positive (an all-Perfect play keeps it full).
          if (c._conditionType >= 2000 && c._conditionType <= 2004 && !c._isPositive) lifeOk = false;
          if (c._conditionType === 4011) chance = ((c._conditionValues && c._conditionValues[0]) || 0) / 100;
        }
      }
      if (lifeOk) out = Math.max(out, chance === null ? 1 : chance / LUCK_GAUGE_CHANCE);
    }
    return out;
  }

  /**
   * The share a deck's LUCK gauge (its members' strongest luckGauge) adds to its LUCKY RUSH 分數UP gains on chart
   * `scoreId` (see LUCK_GAUGE_BOOST); 0 on a chart without a LUCK range.
   */
  function luckGaugeBoost(battle, gauge, scoreId) {
    const b = gauge > 0 && battle && battle.byScore.get(scoreId);
    if (!b || !b.luck) return 0;
    const allLuck = !!b.missions && b.missions.length > 0 && b.missions.every((x) => x === 2);
    return gauge * (allLuck ? LUCK_GAUGE_BOOST.allLuck : LUCK_GAUGE_BOOST.mixed);
  }

  /** A song's Gekisou range type from its range missions: 1 all COMBO, 2 all LUCK, 3 all JUST, 0 mixed; null without. */
  function gekisouSongType(missions) {
    if (!missions || !missions.length) return null;
    return missions.every((x) => x === missions[0]) ? missions[0] : 0;
  }

  /**
   * The songs a public room can draw (input as for search with `multi` and `battle`: the allowed charts with Gekisou
   * data) by Gekisou range type, for decks saved one per type: [{type (gekisouSongType), musicIds}], COMBO, LUCK, JUST,
   * then mixed. The types come from music-data, so a new song falls in its group by itself.
   */
  function gekisouSongGroups(input) {
    const { chartList, battle } = liveSetup(input);
    const byType = new Map();
    for (const c of chartList) {
      const b = battle && battle.byScore.get(c.scoreId);
      const t = b ? gekisouSongType(b.missions) : null;
      if (t === null) continue;
      if (!byType.has(t)) byType.set(t, new Set());
      byType.get(t).add(c.musicId);
    }
    return [1, 2, 3, 0].filter((t) => byType.has(t)).map((t) => ({ type: t, musicIds: [...byType.get(t)] }));
  }

  /**
   * The expected payoff of a multiplayer normal live (input as for search: master, event, boosts, objective, cpValue,
   * accuracy, multi) on `chart` (a charts() entry) when the player's all-Perfect score is `score` and the deck's
   * bonuses are pb/ib: {points, items, cp, sc (what the search ranks by), rankDist: [[rank, p]]}. The play keeps a share
   * of the score as playShares; the room's rank adds multi.othersScore (E counts as D, as in the search).
   */
  function roomPayoff(input, chart, score, pb, ib) {
    const m = input.master;
    const multi = input.multi;
    const pay = payoff(m, input.event, "normal");
    const rate = boostRate(m, "normal", input.boosts || 0);
    const W = input.objective === "items" ? { point: 1, item: 1e6 } : { point: 1e6, item: 1 };
    const th = chart.battle
      .map(([r, base]) => [Math.max(r, 2), Math.max(0, battleRequiredScore(base, multi.players) - (multi.othersScore || 0))])
      .sort((a, b) => a[1] - b[1]);
    const lowest = Math.min(...th.map((x) => x[0]));
    const dist = new Map();
    for (const [x, p] of playShares(m, chart.scoreId, input.accuracy || null)) {
      const r = scoreRankOf(th, score * x) || lowest;
      dist.set(r, (dist.get(r) || 0) + p);
    }
    const out = { points: 0, items: 0, cp: 0, sc: 0, rankDist: [...dist].sort((a, b) => b[0] - a[0]) };
    for (const [r, p] of dist) {
      const points = eventPoints(pb, rate, pay.points.get(r) || 0);
      const items = eventItems(pay.items.get(r) || 0, ib, rate);
      const cp = (pay.cp.get(r) || 0) * rate;
      out.points += p * points;
      out.items += p * items;
      out.cp += p * cp;
      out.sc += p * ((points + cp * (input.cpValue || 0)) * W.point + items * W.item);
    }
    return out;
  }

  /**
   * What raises Gekisou support skill `id`'s gain beyond music-data's (measured beside a member whose own Gekisou skill
   * does nothing): "rush" for a LUCKY RUSH 分數UP (LUCK mission, score-ups only; a member's LUCK gauge skill), "combo"
   * for a score-up stacking per Gekisou combo (COMBO mission, cumulative condition 7001; a member's COMBO count-up
   * skill), else null.
   */
  function gekisouSupportKind(m, id) {
    const row = m.gekisouSupportSkills.get(id);
    const top = m.gekisouSupportSkillMaxLevel.get(id) || 1;
    const rows = m.gekisouSupportSkillEffects.get(id + ":" + top) || [];
    if (!row || !rows.length) return null;
    if (row._gekisouMissionType === 2 && rows.every((e) => e._skillEffectType === 2000)) return "rush";
    const perCombo = (e) => {
      const cum = m.cumulative.get(e._skillCumulativeConditionID);
      return e._skillEffectType === 2001 && !!cum && cum._skillCumulativeConditionType === 7001;
    };
    if (row._gekisouMissionType === 1 && rows.every(perCombo)) return "combo";
    return null;
  }

  /**
   * A member's COMBO count-up Gekisou skill (effect 12000: more Gekisou combo per note while it acts) as
   * "skillId:level", or null. The Gekisou combo is the player's, so it stacks every COMBO-stacking support skill of the
   * deck (gekisouSupportKind "combo") sooner: by 30–190% of their gain (measured 2026-10-07, by skill, level and chart;
   * Simulate.comboBoosts measures it per chart).
   */
  function comboCountOf(m, id, level) {
    for (const e of (id && m.gekisouSkillEffects.get(id + ":" + level)) || []) if (e._skillEffectType === 12000) return id + ":" + level;
    return null;
  }

  /**
   * The share the COMBO count-up skills `keys` of a deck add to its COMBO-stacking support gains on a chart, for a
   * member that does (`match` 1) or does not meet the support skill's member condition: `cb` (Simulate.comboBoosts) =
   * {b: Map(key -> [share alone by match]), s: [share at saturation by match]}. The Gekisou combo adds up over the
   * members, but the stacks reach their cap, so the shares combine as s * (1 - prod(1 - b / s)) (within 6% of the
   * simulation on (1 + share) on the charts checked; a count-up triggered by the combo itself, 12 and 13, gains more
   * beside another).
   */
  function comboCountBoost(cb, keys, match) {
    const s = cb.s[match];
    if (!(s > 0) || !keys.length) return 0;
    let p = 1;
    for (const k of keys) {
      const b = cb.b.get(k);
      if (b) p *= Math.max(0, 1 - Math.min(s, Math.max(0, b[match])) / s);
    }
    return s * (1 - p);
  }

  const api = {
    TABLES, RANK_NAMES, buildMaster, memberView, snapView, memberLimits, snapLimit, makeContext, deckPower,
    leaderBonuses, cardEventBonus, eventEffects, describeEventBonus, payoff, boostRate, eventPoints, eventItems,
    charts, rankThresholds, battleThresholds, battleRequiredScore, scoreRankOf, search, planEvent, currentEvent, perPowerFromMusicData, chartLengthsFromMusicData, musicView,
    parseTime, comboBreakFactors, playShares, accuracyFactor, shareQuantiles, skillWeightsFromMusicData, skillFactor, skillKindOf, liveSkillTerms, liveSkillRate,
    battleFromMusicData, battleRates, gekisouSkillRate, gekisouSupportMatch, gekisouSupportLevelRatio, gekisouSupportTerms, comboScope,
    gekisouSupportRate, gekisouSupportJustStack, justStackShare, snapSkillKey, scoreScope, roughSnapRate,
    luckGaugeOf, luckGaugeBoost, gekisouSupportKind, comboCountOf, comboCountBoost, gekisouSongType, gekisouSongGroups, roomPayoff,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== "undefined" ? self : this);
