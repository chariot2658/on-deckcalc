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
    "MasterSupportSkillEffect", "MasterLiveNoteParameter", "MasterLiveSettings", "MasterLiveGekisouRankingScoreBonus",
    "MasterArenaSeason", "MasterArenaLeague", "MasterArenaLeagueRegulation", "MasterArenaRank", "MasterBattleLivePlace",
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

  /** A result deck for postMessage: its member and snap views back as owned cards, every other field as is. */
  function plainDeck(d) {
    return {
      ...d,
      members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })),
      snaps: d.snaps.map((s) => (s ? { id: s.id, level: s.level, rank: s.rank } : null)),
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

  /** A song's power view; `musicType` (激奏舞台's daily song type, 99 = every type) replaces the song's own. */
  function musicView(m, musicId, musicType) {
    const mu = m.musics.get(musicId);
    if (!mu) return null;
    return { id: mu._id, musicType: musicType || mu._musicType, tags: mu._bestMusicTagIDs || [], typeBonusRate: 0, tagBonusRate: 0 };
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

  // A public room's opponents are not known when the deck is chosen (multi.auto): the others' average score is taken
  // log-uniform over OPPONENT_RANGE, in OPPONENT_LEVELS equally likely levels (each level's geometric midpoint), and the
  // rank in every Gekisou range uniform over the room's ranks. Measured with every card owned (2026-10-12, true rank
  // uniform 1–5, the others' average 1–20M): saved decks chosen this way lost 0.6% on average against the best candidate
  // for the true others' average (1.6% at worst), decks chosen for one fixed guess 0.9–5.0% (2.0–9.8% at worst); picking
  // among five candidates, the decks for 2–8M were those for 1–20M.
  const OPPONENT_RANGE = [1e6, 2e7];
  const OPPONENT_LEVELS = 10;

  /** The others' total score in a room: [[total, weight]] (multi.auto: OPPONENT_LEVELS levels, else othersScore). */
  function opponentLevels(multi) {
    if (!multi) return [[0, 1]];
    if (!multi.auto) return [[multi.othersScore || 0, 1]];
    const [a, b] = OPPONENT_RANGE;
    const n = Math.max(0, (multi.players || 1) - 1);
    return Array.from({ length: OPPONENT_LEVELS }, (_, i) => [n * a * Math.pow(b / a, (i + 0.5) / OPPONENT_LEVELS), 1 / OPPONENT_LEVELS]);
  }

  /** The Gekisou rank a search assumes: multi.gekisouRank (at most the room size), or with multi.auto every rank of the room. */
  function gekisouRanks(multi) {
    const n = Math.min(5, Math.max(1, (multi && multi.players) || 1));
    if (multi && multi.auto) return Array.from({ length: n }, (_, i) => i + 1);
    return Math.min((multi && multi.gekisouRank) || 1, n);
  }

  /** A search's `gekisou`: {rank, justRate}, or with averaged ranks {rank: null, ranks, justRate}. */
  function gekisouOut(bt) {
    return bt.ranks ? { rank: null, ranks: bt.ranks, justRate: bt.justRate } : { rank: bt.rank, justRate: bt.justRate };
  }

  /** A cache key of battleRates' (or a search's `gekisou`) rank and Just rate. */
  function gekisouKey(gk) {
    return (gk.ranks ? "r" + gk.ranks.join("") : gk.rank) + ":" + gk.justRate;
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
   * same way. A snap that five others match or beat on a slot (in bonuses, and in power and pair rate there) does not
   * go to that slot: one of those five is always free to take its place. `X` (or null): X[slot][snap] = the snap's pair rate with that
   * slot's member (the score objective: its snap skills' and Gekisou support skills' score per unit of power on the
   * chart; points on a random song: supportMeans); a state's `x` sums them.
   * `jd` (or null): a deck's Just windows. jd.wins(i, j): the windows snap j gives on slot i ({key, list}, or null);
   * jd.add(prof, w): the Just profile with them added; jd.Xof(prof, only): X at a profile (the entries of snaps `only`
   * at least, or all); jd.lo and jd.hi: per slot the least
   * and most a snap's X can be at any profile. Snaps with windows are placed first, so a state's `prof` is final when
   * the others come (their X is the profile's; a window snap's own is X's). States merge only within one profile (a
   * window raises most gains but lowers JUST時機支援's); a window snap is never left out of a slot it gives windows on,
   * nor leaves another out. With jd.value and jd.bound (score searches) the profiles are played one by one (twoPhase
   * below): jd.anyWin[j] marks the snaps with Just windows at all, and jd.slotCache holds the other snaps' slots per
   * profile. Without X (points) the profiles share the other snaps' DP (shared below).
   */
  function snapStates(G, snapPoint, snapItem, nSnaps, X, slotCache = null, jd = null) {
    // Per slot, the snaps that may go there (rates Xr, with lo and hi in place of them when given). Snaps that
    // `skip(i, j)` marks are kept and do not count among the five. G and X rows are immutable within a search. The
    // same member/profile appears in many sets: compute its eligible snaps once (in `cache`, for one skip rule),
    // retaining snap-index tie order. Dynamic effectiveG rows are weak keys and can be collected.
    const slotOks = (Xr, lo, hi, skip, cache) => G.map((g, i) => {
      const x = Xr ? Xr[i] : null;
      const l = lo ? lo[i] : x;
      const h = hi ? hi[i] : x;
      const ck = h || g;
      let byX = cache && cache.get(g);
      if (byX && byX.has(ck)) return byX.get(ck);
      const ok = new Uint8Array(nSnaps);
      const atLeast = (k, j) => snapPoint[k] >= snapPoint[j] && snapItem[k] >= snapItem[j] && g[k] >= g[j] && (!x || l[k] >= h[j]);
      for (let j = 0; j < nSnaps; j++) {
        if (skip && skip(i, j)) {
          ok[j] = 1;
          continue;
        }
        let n = 0;
        for (let k = 0; k < nSnaps && n < 5; k++) {
          if (k !== j && !(skip && skip(i, k)) && atLeast(k, j) && (k < j || !atLeast(j, k))) n++;
        }
        if (n < 5) ok[j] = 1;
      }
      if (cache) {
        if (!byX) cache.set(g, byX = new WeakMap());
        byX.set(ck, ok);
      }
      return ok;
    });
    const slotOk = jd
      ? slotOks(X, jd.lo, jd.hi, (i, j) => !!jd.wins(i, j), null)
      : slotOks(X, null, null, null, slotCache);
    const useful = [];
    for (let j = 0; j < nSnaps; j++) {
      if (slotOk.some((ok) => ok[j])) useful.push(j);
    }
    const winAny = jd ? useful.filter((j) => [0, 1, 2, 3, 4].some((i) => slotOk[i][j] && jd.wins(i, j))) : [];
    if (winAny.length) useful.splice(0, useful.length, ...winAny, ...useful.filter((j) => !winAny.includes(j)));
    // Pareto front in (pt, it, x, power): what the callers rank states by is monotone in all four, and a dominated
    // partial state stays dominated whatever snaps are added to it. Ties keep the earlier state. Without bonuses (the
    // score objective) the front is in (x, power) alone: one sweep down the power order.
    const flat = snapPoint.every((p) => p === 0) && snapItem.every((p) => p === 0);
    const front1 = (list) => {
      list.sort(flat ? (a, b) => b.power - a.power || b.x - a.x : (a, b) => b.power - a.power || b.pt - a.pt || b.it - a.it || b.x - a.x);
      const kept = [];
      if (flat) {
        let x = -Infinity;
        for (const st of list) {
          if (st.x > x) {
            kept.push(st);
            x = st.x;
          }
        }
        return kept;
      }
      for (const st of list) if (!kept.some((k) => k.pt >= st.pt && k.it >= st.it && k.x >= st.x)) kept.push(st);
      return kept;
    };
    const front = (list) => {
      if (!winAny.length || list.every((st) => !st.prof)) return front1(list);
      const by = new Map();
      for (const st of list) {
        const k = st.prof ? st.prof.key : "";
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(st);
      }
      const out = [];
      for (const l of by.values()) out.push(...front1(l));
      return out;
    };
    const empty = () => {
      const s = [[{ pt: 0, it: 0, x: 0, power: 0, pick: null, prof: null }]];
      for (let mask = 1; mask < 32; mask++) s.push([]);
      return s;
    };
    // The states after snap j may go on a free slot of any of `states`.
    const rest = useful.slice(winAny.length);
    const step = (states, j) => {
      const next = states.map((b) => b.slice());
      const isWin = winAny.includes(j);
      for (let mask = 0; mask < 32; mask++) {
        for (const st of states[mask]) {
          // A window snap adds its own X; any other snap the X of the state's (final) profile.
          const Xs = X && !isWin && st.prof ? jd.Xof(st.prof, rest) : X;
          for (let i = 0; i < 5; i++) {
            if (mask & (1 << i) || !slotOk[i][j]) continue;
            const w = isWin ? jd.wins(i, j) : null;
            next[mask | (1 << i)].push({
              pt: st.pt + snapPoint[j], it: st.it + snapItem[j], x: X ? st.x + Xs[i][j] : 0, power: st.power + G[i][j], pick: { i, j, prev: st.pick },
              prof: w ? jd.add(st.prof, w) : st.prof,
            });
          }
        }
      }
      return next.map((b, mask) => (b.length > states[mask].length ? front(b) : b));
    };
    if (jd && jd.value && X && jd.hiOf && flat && winAny.length) return twoPhase();
    if (jd && !X && winAny.length) return shared();
    let states = empty();
    for (const j of useful) states = step(states, j);
    return front([].concat(...states));

    // Without pair rates in the DP (points) the other snaps add the same at every profile, so their DP runs once, from
    // the empty deck: per free-slot mask the front over its subsets completes each window state. Placing them on each
    // profile's states instead pushed ~40000 states per member set on the user's roster (~655 window states, ~108
    // profiles).
    function shared() {
      let s1 = empty();
      for (const j of winAny) s1 = step(s1, j);
      let s2 = empty();
      for (const j of useful.slice(winAny.length)) s2 = step(s2, j);
      const sub = [];
      for (let F = 0; F < 32; F++) {
        const list = [];
        for (let m = F; ; m = (m - 1) & F) {
          list.push(...s2[m]);
          if (!m) break;
        }
        sub.push(front1(list));
      }
      const out = [];
      for (let m1 = 0; m1 < 32; m1++) {
        for (const a of s1[m1]) {
          for (const b of sub[31 & ~m1]) out.push({ pt: a.pt + b.pt, it: a.it + b.it, x: 0, power: a.power + b.power, a, b, prof: a.prof });
        }
      }
      // The kept states' picks: b's snaps placed after a's, as step does.
      return front(out).map(({ pt, it, x, power, a, b, prof }) => {
        const tail = [];
        for (let p = b.pick; p; p = p.prev) tail.push(p);
        let pick = a.pick;
        for (let t = tail.length - 1; t >= 0; t--) pick = { i: tail[t].i, j: tail[t].j, prev: pick };
        return { pt, it, x, power, pick, prof };
      });
    }

    // Score searches (no bonuses) with jd.value and jd.lin: the window snaps first (states per slot mask, a front per
    // profile; `n` counts the windows given), then per profile the other snaps at its X (jd.Xof) in a DP of their own,
    // whose fronts per free-slot mask complete every window state. A deck of profile prof, snap power P and pair rate x
    // scores at most c (a + P)(b + x) ({a, b, c} = jd.lin(prof)), so at most c (k (a + P) + (b + x) / k)^2 / 4 for
    // any k > 0 (AM-GM), whose largest value over the free slots is one assignment DP on k G + X / k. Profiles go in
    // the order of that bound at the rates of the strongest profile n windows can make (jd.hiOf(n)) and stop once it is
    // below the best deck so far (jd.value(state)) or jd.floor (the k-th deck the caller has: a set that cannot reach it
    // returns no state); a profile is also skipped when the bound at its own rates is.
    // Returns the fronts of the profiles played. Without the bounds, ~400 profiles per member set each priced every
    // pairing at its profile; bounding power and rates apart left them ~10% above the best (different snaps maximise
    // each), so most were played.
    function twoPhase() {
      // Per slot mask, per profile (null: none), its front; a snap's new states go after the old ones of their mask and
      // profile, in the order of the states they extend.
      const s1 = [];
      for (let mask = 0; mask < 32; mask++) s1.push(new Map());
      s1[0].set(null, [{ pt: 0, it: 0, x: 0, n: 0, power: 0, pick: null, prof: null }]);
      for (const j of winAny) {
        const added = new Array(32).fill(null);
        for (let mask = 0; mask < 32; mask++) {
          for (const list of s1[mask].values()) {
            for (const st of list) {
              for (let i = 0; i < 5; i++) {
                if (mask & (1 << i) || !slotOk[i][j]) continue;
                const w = jd.wins(i, j);
                const prof = w ? jd.add(st.prof, w) : st.prof;
                const to = mask | (1 << i);
                const byP = added[to] || (added[to] = new Map());
                let l = byP.get(prof);
                if (!l) byP.set(prof, (l = []));
                l.push({ pt: 0, it: 0, x: st.x + X[i][j], n: st.n + (w ? 1 : 0), power: st.power + G[i][j], pick: { i, j, prev: st.pick }, prof });
              }
            }
          }
        }
        for (let mask = 0; mask < 32; mask++) {
          if (!added[mask]) continue;
          for (const [prof, l] of added[mask]) {
            const old = s1[mask].get(prof);
            s1[mask].set(prof, front1(old ? old.concat(l) : l));
          }
        }
      }
      const rest = [];
      for (let j = 0; j < nSnaps; j++) if (!winAny.includes(j)) rest.push(j);
      // Per mask of the slots taken, the most the other snaps (distinct, each slot taking one of its five largest) can
      // add on the free ones in rows Xr (power: G); a slot may stay empty.
      const remOf = (Xr) => {
        const use = new Set();
        for (let i = 0; i < 5; i++) {
          const r = Xr[i];
          const top = [];
          for (const j of rest) {
            if (top.length < 5) top.push(j);
            else {
              let lo = 0;
              for (let t = 1; t < 5; t++) if (r[top[t]] < r[top[lo]]) lo = t;
              if (r[j] > r[top[lo]]) top[lo] = j;
            }
          }
          for (const j of top) use.add(j);
        }
        const best = new Float64Array(32).fill(-Infinity);
        best[0] = 0;
        for (const j of use) {
          for (let mask = 31; mask >= 0; mask--) {
            if (best[mask] === -Infinity) continue;
            for (let i = 0; i < 5; i++) {
              const bit = 1 << i;
              if (!(mask & bit)) best[mask | bit] = Math.max(best[mask | bit], best[mask] + Xr[i][j]);
            }
          }
        }
        const rem = new Float64Array(32);
        for (let mask = 0; mask < 32; mask++) {
          const free = 31 ^ mask;
          for (let m2 = free; ; m2 = (m2 - 1) & free) {
            rem[mask] = Math.max(rem[mask], best[m2]);
            if (!m2) break;
          }
        }
        return rem;
      };
      const remG = remOf(G);
      // Per rates rows Xr: their remOf, and per balance k (quantised: AM-GM holds at every k) remOf of k G + Xr / k.
      const rems = new Map();
      const remsOf = (Xr) => {
        if (!rems.has(Xr)) rems.set(Xr, { x: remOf(Xr), byK: new Map() });
        return rems.get(Xr);
      };
      const lins = new Map();
      const linOf = (prof) => {
        if (!lins.has(prof)) lins.set(prof, jd.lin(prof));
        return lins.get(prof);
      };
      // The bound of window states of profile prof with snap power at most power and window pair rates at most xw, on
      // slot masks `masks` (a bit per mask) with rates Xr: each remainder at its largest over the masks.
      const bound = (prof, power, xw, masks, Xr) => {
        const { a, b, c } = linOf(prof);
        const r = remsOf(Xr);
        let rg = -Infinity;
        let rx = -Infinity;
        for (let mask = 0; mask < 32; mask++) {
          if (!((masks >>> mask) & 1)) continue;
          rg = Math.max(rg, remG[mask]);
          rx = Math.max(rx, r.x[mask]);
        }
        const A = a + power;
        const B = b + xw;
        // ln k in steps of 0.1: at most 0.25% above the bound at the best k.
        const k = Math.exp(Math.round(5 * Math.log((B + rx) / (A + rg))) / 10);
        if (!(k > 0) || !Number.isFinite(k)) return c * (A + rg) * (B + rx);
        if (!r.byK.has(k)) r.byK.set(k, remOf(G.map((g, i) => g.map((x, j) => k * x + Xr[i][j] / k))));
        const rk = r.byK.get(k);
        let rz = -Infinity;
        for (let mask = 0; mask < 32; mask++) if ((masks >>> mask) & 1) rz = Math.max(rz, rk[mask]);
        const z = k * A + B / k + rz;
        const ub = Math.min(c * (A + rg) * (B + rx), (c * z * z) / 4);
        return ub + Math.abs(ub) * 1e-9;
      };
      // Window state st's pair rate with rates Xr (its window snaps' at the larger of X and Xr), and its bound.
      const xwOf = (st, Xr) => {
        let xw = 0;
        for (let p = st.pick; p; p = p.prev) xw += Math.max(X[p.i][p.j], Xr[p.i][p.j]);
        return xw;
      };
      const boundAt = (prof, st, mask, Xr) => bound(prof, st.power, xwOf(st, Xr), 1 << mask, Xr);
      // Per profile its states, and per number of windows n their largest power and pair rate at jd.hiOf(n) and their
      // masks: a bound on all of them at once (`ub`), before the states' own.
      const groups = new Map();
      s1.forEach((byP, mask) => byP.forEach((b) => b.forEach((st) => {
        let gr = groups.get(st.prof);
        if (!gr) groups.set(st.prof, (gr = { prof: st.prof, items: [], byN: new Map(), ub: -Infinity }));
        gr.items.push([st, mask]);
        const n = st.n || 0;
        let e = gr.byN.get(n);
        if (!e) gr.byN.set(n, (e = { Xr: n ? jd.hiOf(n) : X, power: -Infinity, xw: -Infinity, masks: 0 }));
        e.power = Math.max(e.power, st.power);
        e.xw = Math.max(e.xw, xwOf(st, e.Xr));
        e.masks |= 1 << mask;
      })));
      for (const gr of groups.values()) for (const e of gr.byN.values()) gr.ub = Math.max(gr.ub, bound(gr.prof, e.power, e.xw, e.masks, e.Xr));
      const out = [];
      let best = jd.floor;
      for (const gr of [...groups.values()].sort((a, b) => b.ub - a.ub)) {
        if (gr.ub < best) break;
        if (gr.items.every(([st, mask]) => boundAt(gr.prof, st, mask, gr.byN.get(st.n || 0).Xr) < best)) continue;
        const Xp = gr.prof ? jd.Xof(gr.prof) : X;
        if (gr.prof && gr.items.every(([st, mask]) => boundAt(gr.prof, st, mask, Xp) < best)) continue;
        const ok = slotOks(Xp, null, null, (i, j) => jd.anyWin[j], jd.slotCache);
        let s2 = empty();
        for (const j of rest) {
          if (!ok.some((o) => o[j])) continue;
          const next = s2.map((b) => b.slice());
          for (let mask = 0; mask < 32; mask++) {
            for (const st of s2[mask]) {
              for (let i = 0; i < 5; i++) {
                if (mask & (1 << i) || !ok[i][j]) continue;
                next[mask | (1 << i)].push({ pt: 0, it: 0, x: st.x + Xp[i][j], power: st.power + G[i][j], pick: { i, j, prev: st.pick } });
              }
            }
          }
          s2 = next.map((b, mask) => (b.length > s2[mask].length ? front1(b) : b));
        }
        // Per free-slot mask, the front of the states on any of its subsets.
        const sub = new Map();
        const subOf = (mask) => {
          if (!sub.has(mask)) {
            const l = [];
            for (let m2 = mask; ; m2 = (m2 - 1) & mask) {
              l.push(...s2[m2]);
              if (!m2) break;
            }
            sub.set(mask, front1(l));
          }
          return sub.get(mask);
        };
        const comb = [];
        for (const [st, mask] of gr.items) {
          for (const t of subOf(31 ^ mask)) comb.push({ pt: 0, it: 0, x: st.x + t.x, power: st.power + t.power, a: st.pick, b: t.pick });
        }
        for (const c of front1(comb)) {
          let pick = c.a;
          for (let p = c.b; p; p = p.prev) pick = { i: p.i, j: p.j, prev: pick };
          const st = { pt: 0, it: 0, x: c.x, power: c.power, pick, prof: gr.prof };
          best = Math.max(best, jd.value(st));
          out.push(st);
        }
      }
      return out;
    }
  }

  /**
   * The most that distinct snaps add to five slots, W[slot][snap] each (a slot may stay empty): a DP over filled-slot
   * masks, the snap DP without its states. Bounds use it.
   */
  function bestAssignment(W, nSnaps) {
    // A slot takes one of its five largest weights (snapStates' argument), so only those snaps enter the DP.
    const use = new Uint8Array(nSnaps);
    for (let i = 0; i < 5; i++) {
      const top = [];
      for (let j = 0; j < nSnaps; j++) {
        if (top.length < 5) top.push(j);
        else {
          let lo = 0;
          for (let t = 1; t < 5; t++) if (W[i][top[t]] < W[i][top[lo]]) lo = t;
          if (W[i][j] > W[i][top[lo]]) top[lo] = j;
        }
      }
      for (const j of top) use[j] = 1;
    }
    const best = new Float64Array(32);
    for (let j = 0; j < nSnaps; j++) {
      if (!use[j]) continue;
      for (let mask = 31; mask >= 0; mask--) {
        const b = best[mask];
        for (let i = 0; i < 5; i++) {
          const bit = 1 << i;
          if (mask & bit) continue;
          const x = b + W[i][j];
          if (x > best[mask | bit]) best[mask | bit] = x;
        }
      }
    }
    let a = 0;
    for (let mask = 0; mask < 32; mask++) if (best[mask] > a) a = best[mask];
    return a;
  }

  /**
   * bestAssignment with exactly `k` slots holding a snap that `mk[i][j]` (1 or 0) marks (a Just window), -Infinity
   * when none can. A slot takes one of its five largest weights among the marked snaps or among the others.
   */
  function bestAssignmentK(W, nSnaps, mk, k) {
    const use = new Uint8Array(nSnaps);
    for (let i = 0; i < 5; i++) {
      for (const marked of [0, 1]) {
        const top = [];
        for (let j = 0; j < nSnaps; j++) {
          if (mk[i][j] !== marked) continue;
          if (top.length < 5) top.push(j);
          else {
            let lo = 0;
            for (let t = 1; t < 5; t++) if (W[i][top[t]] < W[i][top[lo]]) lo = t;
            if (W[i][j] > W[i][top[lo]]) top[lo] = j;
          }
        }
        for (const j of top) use[j] = 1;
      }
    }
    const S = k + 1;
    const best = new Float64Array(32 * S).fill(-Infinity);
    best[0] = 0;
    for (let j = 0; j < nSnaps; j++) {
      if (!use[j]) continue;
      for (let mask = 31; mask >= 0; mask--) {
        for (let n = 0; n < S; n++) {
          const b = best[mask * S + n];
          if (b === -Infinity) continue;
          for (let i = 0; i < 5; i++) {
            const bit = 1 << i;
            if (mask & bit) continue;
            const n2 = n + mk[i][j];
            if (n2 > k) continue;
            const x = b + W[i][j];
            const at = (mask | bit) * S + n2;
            if (x > best[at]) best[at] = x;
          }
        }
      }
    }
    let a = -Infinity;
    for (let mask = 0; mask < 32; mask++) if (best[mask * S + k] > a) a = best[mask * S + k];
    return a;
  }

  /**
   * At least bestAssignmentK(W, nSnaps, mk, k), without its DP: each slot at its largest weight among the marked
   * snaps or the others (or empty), the k slots gaining most from a marked one taking it; snaps may repeat.
   */
  function assignmentBoundK(W, nSnaps, mk, k) {
    let a = 0;
    const gain = [];
    for (let i = 0; i < 5; i++) {
      let on = -Infinity;
      let off = 0;
      for (let j = 0; j < nSnaps; j++) {
        if (mk[i][j]) on = Math.max(on, W[i][j]);
        else off = Math.max(off, W[i][j]);
      }
      a += off;
      if (on > -Infinity) gain.push(on - off);
    }
    if (gain.length < k) return -Infinity;
    gain.sort((x, y) => y - x);
    for (let t = 0; t < k; t++) a += gain[t];
    return a;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live skills

  /**
   * Live skill weights from nnnotes music-data.json `deck`: {kinds, byScore: scoreId -> Float64Array per kind}. One
   * effect of kind q at factor f at performance position k adds P * f * weights[q][k] (offSeeds: Gekisou off, every
   * note Perfect). The client shuffles the performance order uniformly at the start of every live, so a member's
   * expected gain uses the mean over the five positions; positions the chart never fires weigh 0. `noteRate`:
   * scoreId -> judged notes per second from the first note to the last judged one (roughSnapRate's score-up ramps).
   */
  function skillWeightsFromMusicData(md) {
    const kinds = (md && md.deck && md.deck.kinds) || [];
    const byScore = new Map();
    const noteRate = new Map();
    for (const s of (md && md.songs) || []) {
      for (const c of s.charts || []) {
        const span = (c.lastJudgedNoteMs - c.firstNoteMs) / 1000;
        if (c.notes && c.notes.judged > 0 && span > 0) noteRate.set(c.scoreId, c.notes.judged / span);
        const off = c.deck && c.deck.offSeeds && c.deck.offSeeds[0];
        if (!off || !off.weights) continue;
        const w = new Float64Array(kinds.length);
        off.weights.forEach((row, q) => {
          if (row) w[q] = row.reduce((a, b) => a + (b || 0), 0) / 5;
        });
        byScore.set(c.scoreId, w);
      }
    }
    return { kinds, byScore, noteRate };
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

  /**
   * Pairings that score alike (snapSkillKey's member part and the same effect rows acting) share a class: the effect
   * rows of the snap's skills, without their ids. A condition group of member conditions (5000) alone is decided here
   * (as the replay does: any condition set whose conditions all hold) and becomes T or F, a row whose condition or
   * trigger group is F never acting; a group without member conditions stays by id, and one mixing them keeps the
   * pairing's own key. null as for snapSkillKey.
   */
  function snapSkillClass(m, v, s) {
    const key = snapSkillKey(m, v, s);
    if (!key) return null;
    // true/false: a member condition group that holds or not; "keep": no member condition; null: mixed.
    const decide = (g) => {
      if (!(g > 0)) return "keep";
      let member = false;
      let other = false;
      let any = false;
      for (const cs of m.conditionSets.get(g) || []) {
        let all = true;
        let items = 0;
        for (const cid of cs._conditionIds) {
          const c = m.skillConditions.get(cid);
          if (!c || c._conditionType === 0) continue;
          items++;
          if (c._conditionType !== 5000) {
            other = true;
            continue;
          }
          member = true;
          if (matchesAny(v, targetsOf(m, c._conditionTargetIDs)) !== c._isPositive) all = false;
        }
        if (items && all) any = true;
      }
      if (!member) return "keep";
      return other ? null : any;
    };
    const rows = [];
    for (const [id, level] of s.supportSkills || []) {
      for (const e of m.supportSkillEffects.get(id + ":" + level) || []) {
        if (!SNAP_SCORE_EFFECTS.has(e._skillEffectType)) continue;
        const { _id, _supportSkillID, _level, ...rest } = e;
        let acts = true;
        for (const f of ["_skillConditionGroup", "_skillTriggerConditionGroup", "_skillReleaseConditionGroup"]) {
          const d = decide(e[f]);
          if (d === null) return key;
          if (d === "keep") continue;
          if (!d && f !== "_skillReleaseConditionGroup") acts = false;
          rest[f] = d ? "T" : "F";
        }
        if (acts) rows.push(JSON.stringify(rest));
      }
    }
    return key.slice(0, key.indexOf("|")) + "|" + rows.sort().join(";");
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Skill coverage
  //
  // Every card's skills in every region are covered (test/coverage.test.js). A new card may bring a skill the model
  // leaves out; skillGaps finds it, so that the UI says so instead of scoring the card low without a word.

  // What leaderBonuses reads: effect types (accumulate), formation condition types (formationCondition) and cumulative
  // count types (cumulativeCount).
  const LEADER_EFFECTS = new Set([1000, 1001, 1002, 1003, 1500, 1501, 1502, 1503]);
  const LEADER_CONDITIONS = new Set([0, 3000, 3001, 4012]);
  const LEADER_CUMULATIVE = new Set([3000, 3001, 3002, 3003, 3004, 3005]);
  // Effect types that cannot change the score of an all-Perfect play (heal, guard, Great to Perfect).
  const NO_SCORE_EFFECTS = new Set([3001, 3003, 12006]);
  // Condition types the simulation holds false in every live (ournotes-deck conditions.rs).
  const NEVER_CONDITIONS = new Set([8000]);

  /**
   * The skills of master card `id` (`kind` "member" or "snap"), at every level, that the calculator leaves out, as
   * [{part, skillId, effectType, why}]: part "leader" (why "unknown": an effect, condition or cumulative type power
   * does not read), "live" (a live skill row of no music-data kind: "unmeasured"), "gekisou" (a Gekisou skill
   * music-data has not measured: "unmeasured"), "snap" (a snap skill row: "rough", a score-up the points search's
   * estimate (roughSnapRate: 15000 and score-up ramps) leaves out but the score objective measures; "never", a
   * condition the simulation holds false; "unknown", an effect type of no known kind) and "gekisouSupport" (a Gekisou
   * support skill music-data has not measured: "unmeasured"; a Just window row, effect 4004, of a form justWindowRows
   * does not read: "unknown"). `data` {skillWeights, battle}: the parts they cover are skipped without them.
   */
  function skillGaps(m, kind, id, data = {}) {
    const out = [];
    const seen = new Set();
    const add = (part, skillId, effectType, why) => {
      const k = [part, skillId, effectType, why].join(":");
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ part, skillId, effectType, why });
      }
    };
    const rowsOf = (map, skillId) => {
      const rows = [];
      if (skillId) for (const [k, rs] of map) if (k.slice(0, k.indexOf(":")) === String(skillId)) rows.push(...rs);
      return rows;
    };
    const conditionTypes = (groups) => {
      const types = [];
      for (const g of groups) {
        for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c) types.push(c._conditionType);
          }
        }
      }
      return types;
    };
    const { skillWeights, battle } = data;
    if (kind === "member") {
      const c = m.memberCards.get(id);
      if (!c) return out;
      for (const e of rowsOf(m.leaderEffects, c._leaderSkillID)) {
        const cum = e._skillCumulativeConditionID > 0 ? m.cumulative.get(e._skillCumulativeConditionID) : null;
        if (
          !LEADER_EFFECTS.has(e._skillEffectType) ||
          conditionTypes([e._skillConditionGroup]).some((t) => !LEADER_CONDITIONS.has(t)) ||
          ((e._skillEffectType & ~3) === 1500 && (!cum || !LEADER_CUMULATIVE.has(cum._skillCumulativeConditionType)))
        ) add("leader", c._leaderSkillID, e._skillEffectType, "unknown");
      }
      if (skillWeights && skillWeights.kinds.length) {
        for (const e of rowsOf(m.liveSkillEffects, c._liveSkillID)) {
          if (!NO_SCORE_EFFECTS.has(e._skillEffectType) && !skillKindOf(skillWeights.kinds, e)) add("live", c._liveSkillID, e._skillEffectType, "unmeasured");
        }
      }
      if (c._gekisouSkillID && battle && battle.power) {
        const top = m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1;
        if (!battle.shapes.has(c._gekisouSkillID + ":" + top)) add("gekisou", c._gekisouSkillID, null, "unmeasured");
      }
      return out;
    }
    const s = m.snaps.get(id);
    if (!s) return out;
    for (const skillId of [s._supportSkillId01, s._supportSkillId02]) {
      for (const e of rowsOf(m.supportSkillEffects, skillId)) {
        const t = e._skillEffectType;
        if (NO_SCORE_EFFECTS.has(t)) continue;
        if (!SNAP_SCORE_EFFECTS.has(t)) add("snap", skillId, t, "unknown");
        else if (conditionTypes([e._skillTriggerConditionGroup, e._skillConditionGroup]).some((x) => NEVER_CONDITIONS.has(x))) add("snap", skillId, t, "never");
        else if (t !== 15000 && !snapRampOf(m, e)) add("snap", skillId, t, "rough");
      }
    }
    if (battle && battle.power) {
      for (const skillId of [s._gekisouSupportSkillId01, s._gekisouSupportSkillId02]) {
        if (!skillId) continue;
        const top = m.gekisouSupportSkillMaxLevel.get(skillId) || 1;
        if (!battle.supportShapes.has(skillId + ":" + top)) add("gekisouSupport", skillId, null, "unmeasured");
        for (let lv = 1; lv <= top; lv++) if (justWindowRows(m, skillId, lv).unknown.length) add("gekisouSupport", skillId, 4004, "unknown");
      }
    }
    return out;
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

  /** Whether member `v` meets the member conditions (5000) of snap skill row `e`. */
  function snapRowHolds(m, v, e) {
    for (const cs of e._skillConditionGroup > 0 ? m.conditionSets.get(e._skillConditionGroup) || [] : []) {
      for (const cid of cs._conditionIds) {
        const c = m.skillConditions.get(cid);
        if (c && c._conditionType === 5000 && matchesAny(v, targetsOf(m, c._conditionTargetIDs)) !== c._isPositive) return false;
      }
    }
    return true;
  }

  /** The seconds snap `s` extends member `v`'s live skill by (15000 rows whose member conditions `v` meets). */
  function snapExtension(m, v, s) {
    let ext = 0;
    for (const [id, level] of (s && s.supportSkills) || []) {
      for (const e of m.supportSkillEffects.get(id + ":" + level) || []) {
        if (e._skillEffectType === 15000 && snapRowHolds(m, v, e)) ext += e._effectValue / 1000;
      }
    }
    return ext;
  }

  /**
   * A snap skill row roughSnapRate estimates as a score-up ramp, as {n, max}, or null: a score-up (2001) started by the
   * paired member's live skill (trigger 4010), of its effect value per n Perfect or Just notes judged while it runs
   * (cumulative condition 1000), at most `max` times and at most its max effect value (snap 76's skill 74, 2026-10-28).
   */
  function snapRampOf(m, e) {
    if (e._skillEffectType !== 2001 || e._skillReleaseConditionGroup > 0 || e._effectLimitCount || e._effectExecuteLimitCount) return null;
    const sets = e._skillTriggerConditionGroup > 0 ? m.conditionSets.get(e._skillTriggerConditionGroup) || [] : [];
    const typeOf = (cid) => (m.skillConditions.get(cid) || {})._conditionType;
    if (!sets.length || !sets.every((cs) => cs._conditionIds.every((cid) => typeOf(cid) === 4010))) return null;
    for (const cs of e._skillConditionGroup > 0 ? m.conditionSets.get(e._skillConditionGroup) || [] : []) {
      if (!cs._conditionIds.every((cid) => typeOf(cid) === 5000)) return null;
    }
    const cum = m.cumulative.get(e._skillCumulativeConditionID);
    const n = cum && (cum._conditionValues || [])[0];
    const judgements = cum ? (cum._conditionTargetIDs || []).map((t) => (m.skillTargets.get(t) || {})._judgement) : [];
    if (!cum || cum._skillCumulativeConditionType !== 1000 || !(n > 0) || !judgements.includes(5) || !judgements.includes(6)) return null;
    return { n, max: cum._maxCumulativeCount };
  }

  /** Snap `s`'s score-up ramp rows (snapRampOf) whose member conditions member `v` meets. */
  function snapRamps(m, v, s) {
    const out = [];
    for (const [id, level] of (s && s.supportSkills) || []) {
      for (const e of m.supportSkillEffects.get(id + ":" + level) || []) if (snapRampOf(m, e) && snapRowHolds(m, v, e)) out.push(e);
    }
    return out;
  }

  /**
   * A rough snap skill score per unit of power of a deck (member and snap views, slot by slot) on chart `scoreId`:
   * each snap's live skill extension (15000) over the live skill's own 5 s, times the member's live skill rate, plus its
   * score-up ramps (snapRampOf): the mean factor over a run at the chart's mean note rate, times the weight of a plain
   * score-up of that length (a kind of music-data). The extension is 8% below the replay's rates on the charts checked
   * (spread ±15%); the ramps are 0.79–1.19 of the replay on charts of 5 notes per second or more and up to 2.3 times
   * it on sparse easy charts (2026-10-29), where skill windows are denser than the chart. It picks which songs the
   * score objective measures, and it is what snap skills add in the points search, which has no measured rates.
   */
  function roughSnapRate(m, members, snaps, scoreId, skillWeights) {
    let r = 0;
    const w = skillWeights && skillWeights.byScore.get(scoreId);
    const rate = skillWeights && skillWeights.noteRate && skillWeights.noteRate.get(scoreId);
    members.forEach((v, i) => {
      const ext = snapExtension(m, v, snaps[i]);
      if (ext) r += (liveSkillRate(m, [v], scoreId, skillWeights) * ext) / 5;
      if (!w || !rate || !v.liveSkillId) return;
      for (const e of snapRamps(m, v, snaps[i])) {
        const k = skillWeights.kinds.find((k) =>
          k.effectType === 2000 && k.activationTimeSecond === e._activationTimeSecond && !(k.skillTargetIds || []).length && !k.skillConditionGroup &&
          !k.skillReleaseConditionGroup && !k.effectLimitCount && !k.effectExecuteLimitCount && !k.effectExecuteLimitResetConditionGroup);
        if (!k) continue;
        // The j-th note of the run scores at floor(j / n) steps (the notes judged before it).
        const { n, max } = snapRampOf(m, e);
        const notes = rate * e._activationTimeSecond;
        const step = (j) => Math.min(e._effectValue * Math.min(Math.floor(j / n), max), e._maxEffectValue > 0 ? e._maxEffectValue : Infinity) / 10000;
        let sum = 0;
        for (let j = 0; j < Math.floor(notes); j++) sum += step(j);
        sum += (notes - Math.floor(notes)) * step(Math.floor(notes));
        r += (sum / notes) * w[k.id];
      }
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
    // the rank assumed in every range (at most the room size; multi.auto: the mean over the room's ranks) and the Just rate.
    const battle = multi && input.battle && input.battle.power ? input.battle : null;
    const bt = battle ? battleRates(battle, gekisouRanks(multi), multi.justRate) : null;
    const sw = bt
      ? { kinds: battle.kinds, byScore: bt.weights, noteRate: input.skillWeights && input.skillWeights.noteRate }
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
   * difficulty seldom scores more), and one owned member and snap of every class of pairings (snapSkillClass), with the
   * keys (snapSkillKey) of the class. Returns {scoreIds, pairs: [{key, keys, memberKey (the key's member part), member,
   * snap}]} (member and snap as owned).
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
    const pairs = new Map(); // class -> pair
    for (const [mo, v] of members) {
      for (const [so, s] of snaps) {
        const key = snapSkillKey(m, v, s);
        if (!key) continue;
        const cls = snapSkillClass(m, v, s);
        if (!pairs.has(cls)) pairs.set(cls, { key, keys: [], memberKey: key.slice(0, key.indexOf("|")), member: mo, snap: so });
        const p = pairs.get(cls);
        if (!p.keys.includes(key)) p.keys.push(key);
      }
    }
    return { scoreIds, pairs: [...pairs.values()] };
  }

  /**
   * What Simulate.comboBoosts measures before a multiplayer search (input as for search): the owned members' COMBO
   * count-up skills (comboCountOf keys), and every allowed chart with a COMBO range, with the support skill and idle
   * Gekisou skill to measure them with. null when there is nothing to measure.
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
    const scoreIds = [];
    for (const c of chartList) {
      const b = battle.byScore.get(c.scoreId);
      if (!b || !(b.missions || []).includes(1)) continue;
      scoreIds.push(c.scoreId);
    }
    if (!scoreIds.length) return null;
    return {
      keys: [...keys].sort(),
      scoreIds,
      byMusic: new Map(), // Keep the transport shape; timelines must never be borrowed from another difficulty.
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
   *         score objective adds the snap skills and plays only the charts measured; points and items take them in place
   *         of roughSnapRate's estimate, also playing only the charts measured), maxLevel, difficulties, accuracy ({perfectRate, breaks}: see playShares; null plays all Perfect; with
   *         combo breaks the score varies, and decks are ranked by their expected payoff over the ranks they may reach),
   *         boosts, objective: "points"|"items"|"score", topK, musicIds, fixed: {memberIds, excludeMemberIds},
   *         cpValue: event points one challenge point is worth (normal lives; 0 ignores the CP they earn),
   *         compareSongs: also return `songs`, the best deck of every song, lengthByScore: scoreId -> seconds,
   *         songTopK: also return up to this many `songCandidates` per song (same full-roster pruning scope),
   *         chartCandidateMargin: attach nearby `chartCandidates` to random perSong and songCandidates for replay,
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
    const songTopK = input.songTopK || 1;
    const searchK = input.compareSongs ? Math.max(topK, songTopK) : topK;
    const accuracy = input.accuracy || null;
    // A room whose others are unknown (multi.auto): the payoff is the expected one over opponentLevels.
    const oppLevels = !scoreMode && mode === "normal" && input.multi && input.multi.players >= 1 && input.multi.auto ? opponentLevels(input.multi) : null;
    // The expected score is linear in the play share, so the score mode needs only its mean.
    const stochastic = !scoreMode && (!!(accuracy && accuracy.breaks > 0) || !!oppLevels);
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
        // One play share (no combo breaks): every quantile is the same.
        v.det = !!v.q && v.q[0] === v.q[v.q.length - 1];
        sharesOf.set(c.scoreId, v);
      }
      return v;
    };
    const exclude = new Set((input.excludeMemberIds || []).map(Number));
    const members = input.members.filter((o) => !exclude.has(Number(o.id))).map((o) => memberView(m, o, player)).filter(Boolean);
    const snaps = input.snaps.map((o) => snapView(m, o)).filter(Boolean);
    const snapSlotCache = new WeakMap();
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
    const ownThresholds = (c, others = multi ? multi.othersScore || 0 : 0) =>
      multi
        ? c.battle.map(([r, base]) => [Math.max(r, 2), Math.max(0, battleRequiredScore(base, multi.players) - others)])
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
    // (gekisouSupportTerms). Points' snap skills are roughSnapRate's estimate (`roughSnaps`, off with
    // input.roughSnapSkills false), or with input.snapSkill the measured rates in its place (`measuredPts`: the worker
    // measures a challenge live's charts, where the estimate ran 1.37× the replay on 怪物 EXPERT and showed an S deck as
    // SS, 2026-11-07). With any of them, a snap adds score depending on its member and the chart (`pairX`; `pairPts` in
    // points).
    const gkSup = !!(bt && battle.supportShapes && battle.supportShapes.size);
    const measuredPts = !scoreMode && input.snapSkill ? input.snapSkill : null;
    const roughSnaps = !scoreMode && (!!measuredPts || (!!sw && input.roughSnapSkills !== false));
    const pairPts = !scoreMode && (gkSup || roughSnaps);
    const pairX = !!snapSkill || gkSup || roughSnaps;
    // The score objective plays one chart per group with pair rates; without measured snap skill rates, the charts
    // scoreScope would measure (a random song: one chart per song).
    const scope = scoreMode && gkSup && !snapSkill
      ? new Set(scoreScope(input, input.chartCandidateMargin ?? (randomSong ? 0 : undefined)).scoreIds) : null;
    const measured = snapSkill || measuredPts;
    const chartList = measured ? playable.filter((c) => measured.byScore.has(c.scoreId)) : scope ? playable.filter((c) => scope.has(c.scoreId)) : playable;
    if (chartList.length === 0) return { error: "no-charts", results: [] };

    // Charts grouped by the song features that change deck power; with pair rates in the score objective, which
    // depend on the chart, one chart per group.
    const groups = new Map();
    for (const c of chartList) {
      const mv = musicView(m, c.musicId, input.arena && input.arena.musicType);
      if (mode === "challenge") {
        const row = m.t.MasterChallengeMusic.find((r) => r._eventId === event._id && r._liveMusicId === c.musicId);
        if (row && row._musicType) mv.musicType = row._musicType;
      }
      const musicKey = mv.musicType + "|" + mv.tags.join(",");
      const key = musicKey + (scoreMode && pairX ? "|" + c.scoreId : "");
      if (!groups.has(key)) groups.set(key, { music: mv, musicKey, charts: [] });
      groups.get(key).charts.push(c);
    }

    // Live skill (and Gekisou skill) score per unit of power of a member on a chart, and with pair rates the snaps'
    // rates paired with it (per snap, aligned with `snaps`): snap skills and Gekisou support skills.
    const skillRateOf = (v, c) => liveRateOf(v, c.scoreId);
    const chartIdx = new Map(chartList.map((c, i) => [c, i]));
    // Just windows (justWindowsOf): a snap of effect 4004 beside a member with a Gekisou skill raises the deck's Just rate
    // in the JUST ranges, so a deck plays everything Gekisou at its Just profile (justProfile, battleRates with it): the
    // chart's rate and its members' skills (`jw.delta`, added to the deck's pair rate) and its pairs (supOf at the
    // profile). The snap DP carries the profile in its states (snapStates' `jd`). Bounds play every deck at the strongest
    // profile five snaps make (`jw.top(5)`), where gains only rise, and also without windows, as JUST時機支援's gains fall.
    const jw = (() => {
      // At Just rate 0 or 1 (or none: battleRates takes 1) a window changes nothing (widenedJustRate).
      if (!bt || !(multi.justRate > 0 && multi.justRate < 1)) return { on: false };
      const isWin = snaps.map((s) => (s.gekisouSupportSkills || []).some(([id, lv]) => justWindowRows(m, id, lv).rows.length > 0));
      const justIdx = [];
      chartList.forEach((c, i) => ((battle.byScore.get(c.scoreId) || { missions: [] }).missions.includes(3) && justIdx.push(i)));
      if (!isWin.some(Boolean) || !justIdx.length) return { on: false };
      const isJust = new Uint8Array(chartList.length);
      for (const i of justIdx) isJust[i] = 1;
      // A profile changes only the charts with a JUST range: battleRates at it covers those.
      const only = new Set(justIdx.map((i) => chartList[i].scoreId));
      const bts = new Map(); // profile key -> battleRates
      const btOf = (prof) => {
        if (!prof) return bt;
        if (!bts.has(prof.key)) bts.set(prof.key, battleRates(battle, gekisouRanks(multi), multi.justRate, prof, only));
        return bts.get(prof.key);
      };
      // One object per profile key, so that caches can key on it.
      const profs = new Map();
      const canon = (p) => {
        if (!p) return null;
        if (!profs.has(p.key)) profs.set(p.key, p);
        return profs.get(p.key);
      };
      const added = new Map(); // "profile key+windows key" -> profile
      const addedBy = new Map(); // profile (or null) -> windows -> profile
      const add = (prof, w) => {
        let byW = addedBy.get(prof);
        if (!byW) addedBy.set(prof, (byW = new Map()));
        let p = byW.get(w);
        if (p === undefined) {
          const k = (prof ? prof.key : "") + "+" + w.key;
          if (!added.has(k)) added.set(k, canon(justProfile([...(prof ? prof.wins : []), ...w.list])));
          byW.set(w, (p = added.get(k)));
        }
        return p;
      };
      // The windows snap j gives beside member v ({key, list: [[sec, f]]}), or null.
      const winCache = new Map();
      const wins = (v, j) => {
        if (!isWin[j]) return null;
        if (!winCache.has(v)) winCache.set(v, new Array(snaps.length));
        const row = winCache.get(v);
        if (row[j] === undefined) {
          const list = justWindowsOf(m, v, snaps[j]).map((w) => [w.sec, w.f]);
          row[j] = list.length ? { key: list.map(([sec, f]) => sec + ":" + f).join(","), list } : null;
        }
        return row[j];
      };
      // Member v's live and Gekisou skill rates per chart of chartList at profile prof (none: liveSetup's).
      const terms = new Map();
      const skills = new Map(); // profile key -> member view -> rates
      const skillAt = (prof, v) => {
        const key = prof ? prof.key : "";
        if (!skills.has(key)) skills.set(key, new Map());
        const byV = skills.get(key);
        if (!byV.has(v)) {
          if (!terms.has(v)) terms.set(v, liveSkillTerms(m, v, battle.kinds));
          const rate = (b, c) => {
            const w = b.weights.get(c.scoreId);
            let r = 0;
            if (w) for (const [q, f] of terms.get(v)) r += f * w[q];
            return r + gekisouSkillRate(m, battle, b, v, c.scoreId, input.gekisouLevels);
          };
          if (prof) {
            const a = Float64Array.from(skillAt(null, v));
            const b = btOf(prof);
            for (const i of justIdx) a[i] = rate(b, chartList[i]);
            byV.set(v, a);
          } else byV.set(v, Float64Array.from(chartList, (c) => rate(bt, c)));
        }
        return byV.get(v);
      };
      // What members vs gain on chart i of chartList at profile prof in the chart's rate and their skills. Per profile
      // object (they are canonical), the chart's gain per chart (NaN until needed) and each member's.
      const gains = new WeakMap();
      const deltaAt = (prof, vs, i) => {
        if (!prof || !isJust[i]) return 0;
        let e = gains.get(prof);
        if (!e) gains.set(prof, (e = { chart: new Float64Array(chartList.length).fill(NaN), byV: new Map() }));
        let d = e.chart[i];
        if (d !== d) d = e.chart[i] = btOf(prof).perPower.get(chartList[i].scoreId) - chartList[i].perPower;
        for (const v of vs) {
          let a = e.byV.get(v);
          if (!a) {
            const t = skillAt(prof, v);
            const z = skillAt(null, v);
            a = new Float64Array(chartList.length);
            for (const j of justIdx) a[j] = t[j] - z[j];
            e.byV.set(v, a);
          }
          d += a[i];
        }
        return d;
      };
      // The same per chart of chartList.
      const delta = (prof, vs) => {
        const out = new Float64Array(chartList.length);
        if (!prof) return out;
        const b = btOf(prof);
        for (const i of justIdx) out[i] = b.perPower.get(chartList[i].scoreId) - chartList[i].perPower;
        for (const v of vs) {
          const a = skillAt(prof, v);
          const z = skillAt(null, v);
          for (const i of justIdx) out[i] += a[i] - z[i];
        }
        return out;
      };
      // The strongest profile k window snaps make beside the members `vs` (k = 1..5; 0: null): at every time of a range,
      // the k largest widenings of the snaps acting then (each snap's strongest beside any of vs).
      const tops = new WeakMap(); // member list -> k -> profile
      const topsBy = new Map(); // member ids -> k -> profile
      const viewIds = new Map();
      const top = (vs, k) => {
        if (!(k > 0)) return null;
        if (!tops.has(vs)) {
          const ids = vs.map((v) => {
            if (!viewIds.has(v)) viewIds.set(v, viewIds.size);
            return viewIds.get(v);
          });
          const key = ids.sort((a, b) => a - b).join(",");
          if (!topsBy.has(key)) topsBy.set(key, new Map());
          tops.set(vs, topsBy.get(key));
        }
        if (tops.get(vs).has(k)) return tops.get(vs).get(k);
        const per = []; // per window snap: [[sec, f]] summed over its windows, the strongest member's
        for (let j = 0; j < snaps.length; j++) {
          if (!isWin[j]) continue;
          let best = null;
          let bestF = 0;
          for (const v of vs) {
            const w = wins(v, j);
            const f = w ? w.list.reduce((a, [, x]) => a + x, 0) : 0;
            if (w && f > bestF) {
              best = w.list;
              bestF = f;
            }
          }
          if (best) per.push(best);
        }
        const cuts = [...new Set(per.flat().map(([sec]) => sec))].sort((a, b) => b - a);
        const list = [];
        let prev = 0;
        for (const cut of cuts) {
          const at = per.map((ws) => ws.reduce((a, [sec, f]) => a + (sec >= cut ? f : 0), 0)).sort((a, b) => b - a);
          const F = at.slice(0, k).reduce((a, b) => a + b, 0);
          if (F > prev) list.push([cut, F - prev]);
          prev = Math.max(prev, F);
        }
        const p = canon(justProfile(list));
        tops.get(vs).set(k, p);
        return p;
      };
      // Per snap, 1 when it gives member v windows.
      const winRows = new Map();
      const winRow = (v) => {
        if (!winRows.has(v)) winRows.set(v, Uint8Array.from(snaps, (_, j) => (wins(v, j) ? 1 : 0)));
        return winRows.get(v);
      };
      return { on: true, isWin, justIdx, isJust, btOf, add, wins, winRow, skillAt, delta, deltaAt, top };
    })();
    // Gekisou interactions the pairs miss (gekisouSupportTerms measured each support skill beside a member whose own
    // Gekisou skill does nothing): a member's LUCK gauge skill brings more rushes, which every LUCKY RUSH 分數UP of the
    // deck acts in (luckGaugeBoost), and a member's COMBO count-up skill makes every COMBO-stacking support skill of the
    // deck stack sooner (comboBoost). A deck's boost profile `g` (boostOf; null without any) gives, per chart of
    // chartList, the share each kind of support gain grows by: `rush`, and `combo` by member match. Bounds and card
    // pruning use the largest, `gMax` (each chart's largest gauge gain and COMBO saturation).
    const comboData = gkSup && input.comboBoost ? input.comboBoost : null;
    const comboOf = (c) => (comboData ? comboData.byScore.get(c.scoreId) || (comboData.byMusic && comboData.byMusic.get(c.musicId)) || null : null);
    const comboCharts = chartList.map(comboOf);
    const boosts = new Map(); // profile key -> profile
    const boostOf = (vs) => {
      if (!gkSup) return null;
      const gauges = new Set();
      const keys = [];
      for (const v of vs) {
        if (v.luckGauge) gauges.add(v.gekisouSkillId + ":" + v.gekisouSkillLevel);
        if (comboData && v.comboCount) keys.push(v.comboCount);
      }
      if (!gauges.size && !keys.length) return null;
      keys.sort();
      const key = [...gauges].sort().join(",") + "|" + keys.join(",");
      if (!boosts.has(key)) {
        boosts.set(key, {
          key,
          rush: Float64Array.from(chartList, (c) => luckGaugeBoost(m, battle, bt, vs, c.scoreId)),
          combo: [0, 1].map((match) => Float64Array.from(comboCharts, (cb) => (cb ? comboCountBoost(cb, keys, match) : 0))),
        });
      }
      return boosts.get(key);
    };
    const gMax = gkSup
      ? {
          key: "max",
          rush: Float64Array.from(chartList, (c) => luckGaugeBoost(m, battle, bt, members, c.scoreId)),
          combo: [0, 1].map((match) => Float64Array.from(comboCharts, (cb) => (cb && members.some((v) => v.comboCount) ? cb.s[match] : 0))),
        }
      : null;
    // A larger single-skill gain does not prove dominance beside other COMBO skills: gates can open earlier.
    const comboAsGood = (b, a) => !comboData || !a.comboCount || a.comboCount === b.comboCount;
    // Gauge gains depend on the chart, not just the LIFE skill's activation chance.
    const gaugeAsGood = (b, a) => {
      const x = boostOf([b])?.rush, y = boostOf([a])?.rush;
      return !y || y.every((v, i) => (x ? x[i] : 0) >= v);
    };
    // Gekisou support gain of snap j beside member v on each chart of chartList (Float64Array), or null, in a deck of
    // boost profile g and Just profile prof. Members that meet the same member conditions share it.
    const supKeys = new Map(); // member view -> cache key per snap
    // Just and boost profiles are one object per key (jw, boostOf), so the caches key on them.
    const supCache = new Map(); // key -> {all, rush, combo: [by match] (the parts a profile raises, or null), by: boost profile -> gains} or null
    const supAt = new Map(); // Just profile -> key -> the same at it
    const supOf = (v, j, g = null, prof = null) => {
      if (!supKeys.has(v)) {
        const match = (id) => (gekisouSupportMatch(m, v, id, m.gekisouSupportSkillMaxLevel.get(id) || 1) ? 1 : 0);
        supKeys.set(v, snaps.map((s, k) => (v.gekisouSkillId && s.gekisouSupportSkills.length ? k + "|" + s.gekisouSupportSkills.map(([id]) => match(id)).join("") : null)));
      }
      const key0 = supKeys.get(v)[j];
      if (!key0) return null;
      let cache = supCache;
      if (prof) {
        cache = supAt.get(prof);
        if (!cache) supAt.set(prof, (cache = new Map()));
      }
      if (!cache.has(key0)) {
        const nC = chartList.length;
        const all = new Float64Array(nC);
        const parts = { rush: new Float64Array(nC), combo0: new Float64Array(nC), combo1: new Float64Array(nC) };
        const b = prof ? jw.btOf(prof) : bt;
        // A Just profile changes only charts with a JUST range: the others copy the gains without one.
        const e0 = prof ? (supOf(v, j), supCache.get(key0)) : null;
        chartList.forEach((c, i) => {
          if (prof && !jw.isJust[i]) {
            if (e0) {
              all[i] = e0.all[i];
              if (e0.rush) parts.rush[i] = e0.rush[i];
              if (e0.combo[0]) parts.combo0[i] = e0.combo[0][i];
              if (e0.combo[1]) parts.combo1[i] = e0.combo[1][i];
            }
            return;
          }
          for (const [, x, kind, match] of gekisouSupportTerms(m, battle, b, v, snaps[j], c.scoreId, input.gekisouSupportLevels)) {
            all[i] += x;
            if (kind === "rush") parts.rush[i] += x;
            if (kind === "combo") parts[match ? "combo1" : "combo0"][i] += x;
          }
        });
        const some = (a) => (a.some((x) => x !== 0) ? a : null);
        cache.set(key0, all.some((x) => x !== 0) ? { all, rush: some(parts.rush), combo: [some(parts.combo0), some(parts.combo1)], by: new Map() } : null);
      }
      const e = cache.get(key0);
      if (!e || !g || !(e.rush || e.combo[0] || e.combo[1])) return e ? e.all : null;
      let a = e.by.get(g);
      if (!a) {
        e.by.set(g, (a = e.all.map((x, i) =>
          x + (e.rush ? g.rush[i] * e.rush[i] : 0) + (e.combo[0] ? g.combo[0][i] * e.combo[0][i] : 0) + (e.combo[1] ? g.combo[1][i] * e.combo[1][i] : 0))));
      }
      return a;
    };
    // Rough snap skill gain (roughSnapRate) of snap j beside member v on each chart of chartList, or null; members of
    // one live skill and level that get the same extension and score-up ramp rows share it. With measuredPts, the
    // measured rate of the pairing's snapSkillKey instead.
    const roughKeys = new Map(); // member view -> cache key per snap
    const roughCache = new Map();
    const roughOf = (v, j) => {
      if (!roughSnaps) return null;
      if (!roughKeys.has(v)) roughKeys.set(v, snaps.map((s) => {
        if (measuredPts) {
          const k = snapSkillKey(m, v, s);
          return k ? "=" + k : null;
        }
        const ext = v.liveSkillId ? snapExtension(m, v, s) : 0;
        const ramps = v.liveSkillId ? snapRamps(m, v, s).map((e) => e._id).join(",") : "";
        return ext || ramps ? v.liveSkillId + ":" + v.liveSkillLevel + "|" + ext + "|" + ramps : null;
      }));
      const key = roughKeys.get(v)[j];
      if (!key) return null;
      if (!roughCache.has(key)) {
        const a = measuredPts
          ? Float64Array.from(chartList, (c) => measuredPts.byScore.get(c.scoreId).get(key.slice(1)) || 0)
          : Float64Array.from(chartList, (c) => roughSnapRate(m, [v], [snaps[j]], c.scoreId, sw));
        roughCache.set(key, a.some((x) => x !== 0) ? a : null);
      }
      return roughCache.get(key);
    };
    // Points: a pairing's whole gain (Gekisou support skills and rough snap skills) in a deck of boost profile g, or null.
    // Boost and Just profiles are one object per key (boostOf, jw), so the cache keys on them.
    const pairCache = new Map(); // member view -> boost profile (or null) -> Just profile (or null) -> per snap
    // Different members/profiles often resolve to the same two immutable source arrays. Share their sum as well,
    // instead of retaining another whole-chart array for every view/profile/snap combination.
    const combinedPairs = new Map(); // support array -> rough-skill array -> combined rates
    const pairOf = (v, j, g = null, prof = null) => {
      let byG = pairCache.get(v);
      if (!byG) pairCache.set(v, (byG = new Map()));
      let byP = byG.get(g);
      if (!byP) byG.set(g, (byP = new Map()));
      let row = byP.get(prof);
      if (!row) byP.set(prof, (row = new Array(snaps.length)));
      if (row[j] === undefined) {
        const a = gkSup ? supOf(v, j, g, prof) : null;
        const b = roughOf(v, j);
        if (a && b) {
          if (!combinedPairs.has(a)) combinedPairs.set(a, new Map());
          const byRough = combinedPairs.get(a);
          if (!byRough.has(b)) byRough.set(b, a.map((x, i) => x + b[i]));
          row[j] = byRough.get(b);
        } else row[j] = a || b;
      }
      return row[j];
    };
    // Measured snap skill rates of member v per chart of chartList (per snap), or null without them.
    const snapX = new Map();
    const snapXOf = (v) => {
      if (!snapSkill) return null;
      if (!snapX.has(v)) {
        const keys = snaps.map((s) => snapSkillKey(m, v, s));
        snapX.set(v, chartList.map((c) => {
          const rates = snapSkill.byScore.get(c.scoreId);
          return Float64Array.from(keys, (k) => (k ? rates.get(k) || 0 : 0));
        }));
      }
      return snapX.get(v);
    };
    const supportOf = (v, j, g, prof = null) => (pairPts ? pairOf(v, j, g, prof) : gkSup ? supOf(v, j, g, prof) : null);
    // Score searches revisit a member/profile on many single-chart groups. The support arrays already cover every
    // chart: retain their references once, rather than repeating the nested support-cache lookups for every chart.
    // Do not cache all combined chart/snap rows here; those stay local to each group to bound memory use.
    const supportSources = new Map();
    const sourcesOf = (v, g, prof = null) => {
      const key = (g ? g.key : "") + (prof ? "#" + prof.key : "");
      if (!supportSources.has(key)) supportSources.set(key, new Map());
      const byV = supportSources.get(key);
      if (!byV.has(v)) byV.set(v, snaps.map((_, j) => supportOf(v, j, g, prof)));
      return byV.get(v);
    };
    // Member v's pair rates (per snap) on the charts of chartList at indices idx, in a deck of boost profile g and Just
    // profile prof.
    const snapRatesOf = (v, idx, g = null, prof = null) => {
      const xs = snapXOf(v);
      const sources = scoreMode ? sourcesOf(v, g, prof) : null;
      const out = idx.map(() => new Float64Array(snaps.length));
      for (let j = 0; j < snaps.length; j++) {
        const sup = sources ? sources[j] : supportOf(v, j, g, prof);
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          const x = xs ? xs[i][j] : 0;
          out[k][j] = sup ? x + sup[i] : x;
        }
      }
      return out;
    };
    // Member v's best pairing (at least 0) on each chart of chartList, in a deck of boost profile g: bounds. With a Just
    // profile, at whichever is larger, no windows or the profile (for every profile it bounds). `only` (or null): the
    // snaps to take.
    const bestPairs = new Map(); // profile key -> member view -> Float64Array
    const bestPairOf = (v, g = null, prof = null, only = null, sub = null) => {
      const gk = (g ? g.key : "") + (prof ? "#" + prof.key : "") + (only ? "|" + only.key : "") + (prof && sub ? "@" + sub.key : "");
      if (!bestPairs.has(gk)) bestPairs.set(gk, new Map());
      const byV = bestPairs.get(gk);
      if (!byV.has(v)) {
        // A profile changes only the JUST charts: the others keep the best pairing without one. With `sub` ({key, idx}),
        // only the charts at idx are computed at the profile (the others hold the pairing without it).
        const out = prof ? Float64Array.from(bestPairOf(v, g, null, only)) : new Float64Array(chartList.length);
        const idx = prof ? (sub ? sub.idx : jw.justIdx) : null;
        const xs = snapXOf(v);
        const sources = scoreMode ? sourcesOf(v, g, prof) : null;
        for (let j = 0; j < snaps.length; j++) {
          if (only && !only.has(j)) continue;
          const sup = sources ? sources[j] : supportOf(v, j, g, prof);
          const n = idx ? idx.length : out.length;
          for (let t = 0; t < n; t++) {
            const i = idx ? idx[t] : t;
            const x = xs ? xs[i][j] : 0;
            const r = sup ? x + sup[i] : x;
            if (r > out[i]) out[i] = r;
          }
        }
        byV.set(v, out);
      }
      return byV.get(v);
    };

    // Candidate member cards: per character, drop a card another card beats in every respect that feeds the deck: event
    // bonuses, every stat, skills on every chart (live, Gekisou, and the snap skills paired with it, with no boost
    // profile and the largest: a gain is linear in it), the LUCK gauge and COMBO count-up it brings, and the same card
    // type, tags and skill categories (song bonus, snap type link, leader targets), song bonus rates and leader skill.
    // At most 4 are kept per character, the most promising first.
    const statBase = new Map(members.map((v) => [v, memberBase(m, v, ctx).map((b, i) => b + pctOf(b, v.bandItemPct[i]))]));
    const baseSum = new Map(members.map((v) => [v, statBase.get(v).reduce((a, b) => a + b, 0)]));
    const skillsOf = new Map(members.map((v) => [v, Float64Array.from(chartList, (c) => skillRateOf(v, c))]));
    const everyChart = chartList.map((_, i) => i);
    const snapsOf = pairX ? new Map(members.map((v) => [v, snapRatesOf(v, everyChart, gMax)])) : null;
    const snapsOf0 = pairX && gMax ? new Map(members.map((v) => [v, snapRatesOf(v, everyChart, null)])) : null;
    // With Just windows, skills and pairs also at the strongest profile (they are linear in the ranges' Just rates, or
    // rise with them), and only a card with a Gekisou skill takes a window.
    const topM = jw.on ? jw.top(members, 5) : null;
    const skillsOfTop = topM ? new Map(members.map((v) => [v, jw.skillAt(topM, v)])) : null;
    const snapsOfTop = topM && pairX ? new Map(members.map((v) => [v, snapRatesOf(v, everyChart, gMax, topM)])) : null;
    const sameList = (x, y) => x.length === y.length && x.every((e) => y.includes(e));
    const leaderAsGood = (b, a) =>
      !isUsefulLeader(a) || (a.leaderSkillId === b.leaderSkillId && b.leaderSkillLevel >= a.leaderSkillLevel);
    const skillAsGood = (b, a) => {
      if (topM && a.gekisouSkillId && !b.gekisouSkillId) return false;
      for (const of of [skillsOf, skillsOfTop]) {
        if (!of) continue;
        const kb = of.get(b), ka = of.get(a);
        for (let i = 0; i < kb.length; i++) if (kb[i] < ka[i]) return false;
      }
      for (const of of [snapsOf, snapsOf0, snapsOfTop]) {
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
      if (gMax && (!gaugeAsGood(b, a) || !comboAsGood(b, a))) return false;
      const ea = ctx.memberBonus.get(a), eb = ctx.memberBonus.get(b);
      const sa = statBase.get(a), sb = statBase.get(b);
      if (eb.point < ea.point || eb.item < ea.item || sb.some((x, i) => x < sa[i])) return false;
      const gt = eb.point > ea.point || eb.item > ea.item || sb.some((x, i) => x > sa[i]) ||
        b.musicTypeRate > a.musicTypeRate || b.musicTagRate > a.musicTagRate || b.leaderSkillLevel > a.leaderSkillLevel ||
        (!!gMax && (!gaugeAsGood(a, b) || (!!comboData && !!b.comboCount && !a.comboCount)));
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
    const snapPowerOrder = new Map();
    for (const v of allCand) {
      const row = snaps.map((s) => slotG(m, v, s, ctx));
      Gm.set(v, row);
      bestG.set(v, row.length ? Math.max(0, ...row) : 0);
      if (scoreMode && pairX) snapPowerOrder.set(v, row.map((_, j) => j).sort((a, b) => row[b] - row[a]));
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
    const boostBySet = new Map(); // only visited sets; the profile is independent of the song and leader
    const setBoost = (s, vs) => {
      if (!boostBySet.has(s)) boostBySet.set(s, boostOf(vs));
      return boostBySet.get(s);
    };

    /**
     * Visits sets in descending upper bound `ubOf(s, T)` (ties in enumeration order) while that bound reaches
     * `threshold()` (which only rises). Exact bounds are computed only for sets a bucket bound can't rule out: `T`'s
     * payoff is a step function of power (it changes only at the table's power breakpoints), so a bucket splits into
     * levels between breakpoints, each bounded by its lowest power and the bucket's pt/it; `powBound` places sets.
     */
    function bestFirst(T, bMax, powBound, ubOf, threshold, visit) {
      const ps = new Set();
      if (T.mix) for (const sub of mixSubs(T)) for (const n of sub.need.values()) ps.add(n.power);
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
    // T's best rate, then the sets by ubOf, and a set ubOf leaves by `refine` (or null), a tighter bound, before it is
    // visited. `refine` goes in steps ({start(s) -> state, step(s, state, threshold), key(state), done(state)}): a set's key
    // is the smaller of ubOf and the bound so far, and it goes back to the heap after each step.
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
    function walkScore(T, bMax, powBound, ubOf, threshold, visit, refine = null) {
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
        if (refine && !x.refined) {
          const r = x.r || refine.start(x.s);
          if (!refine.done(r)) refine.step(x.s, r, threshold());
          const key = Math.min(x.key, refine.key(r));
          if (key >= threshold()) sets.push({ key, s: x.s, e: x.e, r, refined: refine.done(r) });
          continue;
        }
        visit(x.s);
      }
    }

    // Per rank, the chart needing the least power among `list`; rankFor(power) is the best rank that power reaches.
    // `skill` (aligned with `list`, or null) adds the deck's live skill score per unit of power to each chart's.
    // `optimistic` takes each chart's best play share instead of its mean: a bound on the expected payoff. With combo
    // breaks, a mean table also lists the candidate charts for the expected payoff (`cands`): per rank the three
    // needing the least power, or per minute the frontier charts; `allCands` lists every chart, so that choose bounds the
    // expected payoff of any deck whose power and chart rates are at most the table's (expBound).
    function rankTable(list, skill, optimistic, allCands = false) {
      const rateP = new Map(list.map((c, i) => [c, c.perPower + (skill ? skill[i] : 0)]));
      const rate = new Map(list.map((c) => [c, rateP.get(c) * (optimistic ? shares(c).max : shares(c).mean)]));
      // Score mode: the chart of the highest expected score per unit of power (the same for every power).
      if (scoreMode) {
        let best = list[0];
        for (const c of list) if (rate.get(c) > rate.get(best)) best = c;
        return { need: new Map(), rankList: [], rankFor: () => 0, frontier: null, rate, cands: null, best, charts: list };
      }
      if (oppLevels) return mixTable(list, rateP, rate, optimistic);
      const { need, rankList, rankFor } = stepTable(list, rate, ownThresholds);
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
        if (allCands) for (const c of list) picked.add(c);
        else if (frontier) for (const kept of frontier.values()) for (const o of kept) picked.add(o.chart);
        else {
          for (const r of rankList) {
            const needOf = (c) => {
              const th = ownThresholds(c).find((x) => x[0] === r);
              return th ? th[1] / rate.get(c) : Infinity;
            };
            list.slice().sort((a, b) => needOf(a) - needOf(b)).slice(0, 3).forEach((c) => picked.add(c));
          }
        }
        cands = [...picked].map((c) => candOf(c, rateP, [[multi ? multi.othersScore || 0 : 0, 1]]));
      }
      return { need, rankList, rankFor, frontier, rate, cands };
    }
    // Per rank the chart of `list` needing the least power at chart rates `rate` and thresholds `thOf(c)`.
    function stepTable(list, rate, thOf) {
      // Ties (in a room, often ranks the others' scores reach alone) go solo to the easier chart, in a room to the
      // higher own score, which leaves the room more margin.
      const tie = (c, cur) => (multi ? rate.get(c) > rate.get(cur.chart) : c.level < cur.chart.level);
      const need = new Map();
      for (const c of list) {
        for (const [r, req] of thOf(c)) {
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
      return { need, rankList, rankFor };
    }
    // A candidate chart for chooseExpected: per level of the others' total ([[others, weight]]), [rank, power reaching
    // it at share 1], highest rank first.
    function candOf(c, rateP, levels) {
      return {
        chart: c,
        levels: levels.map(([others, w]) => [w, ownThresholds(c, others).map(([r, req]) => [r, req / rateP.get(c)]).sort((a, b) => b[0] - a[0])]),
        q: shares(c).q,
        mean: shares(c).mean,
        min: perMinute ? minutesOf(c) : 0,
      };
    }
    // The others unknown (oppLevels): per chart and level, [rank, own score needed], highest rank first (cached).
    const levelTh = new Map();
    const levelThresholds = (c) => {
      let a = levelTh.get(c);
      if (!a) {
        a = oppLevels.map(([others]) => ownThresholds(c, others).slice().sort((x, y) => y[0] - x[0]));
        levelTh.set(c, a);
      }
      return a;
    };
    // An optimistic table (`opt`) bounds the expected payoff by each level on its own chart, at the best play share
    // (choose); per level the step table at its thresholds (mixSubs, built when needed) gives the power breakpoints
    // between which that bound is constant. A mean table holds the `cands` (with their rate `rp`) that give the
    // expected payoff on one chart (chooseExpected): per level and rank the three charts needing the least power.
    function mixTable(list, rateP, rate, optimistic) {
      const base = { mix: true, list, need: new Map(), rankList: [], rankFor: null, frontier: null, rate };
      if (optimistic) return { ...base, opt: true, cands: null };
      let picked = list;
      if (list.length > 3) {
        // A song's charts share its thresholds, so of each song only the chart of the highest rate can need the least.
        const bySong = new Map();
        for (const c of list) {
          const cur = bySong.get(c.musicId);
          if (!cur || rate.get(c) > rate.get(cur)) bySong.set(c.musicId, c);
        }
        const top = new Map(); // level * 64 + rank -> [[need, chart]] (at most 3, ascending)
        for (const c of bySong.values()) {
          const rc = rate.get(c);
          levelThresholds(c).forEach((th, j) => {
            for (const [r, req] of th) {
              const key = j * 64 + r;
              const need = req / rc;
              let t = top.get(key);
              if (!t) top.set(key, (t = []));
              if (t.length < 3 || need < t[t.length - 1][0]) {
                t.push([need, c]);
                t.sort((x, y) => x[0] - y[0]);
                if (t.length > 3) t.pop();
              }
            }
          });
        }
        const set = new Set();
        for (const t of top.values()) for (const [, c] of t) set.add(c);
        picked = [...set];
      }
      const cands = picked.map((c) => ({ chart: c, rp: rateP.get(c), q: shares(c).q, mean: shares(c).mean, min: perMinute ? minutesOf(c) : 0 }));
      return { ...base, cands };
    }
    // An optimistic mix table's step tables per level ({w, need, rankList, rankFor}), built once.
    const mixSubs = (t) => t.subs || (t.subs = oppLevels.map(([, w], j) => ({ w, ...stepTable(t.list, t.rate, (c) => levelThresholds(c)[j]) })));
    // A mix table's weighted payoff with `vals` (payoff by rank) at `power`, each level on its own chart (a bound).
    const mixVal = (rt, vals, power) => mixSubs(rt).reduce((a, s) => a + s.w * vals[s.rankFor(power)], 0);
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
      if (rt.mix) {
        // A bound: each level of the others' total on its own chart (the step tables' arithmetic; powers are whole).
        let sc = 0;
        for (let j = 0; j < oppLevels.length; j++) {
          let r = -1;
          let low = 0;
          for (const c of rt.list) {
            const th = levelThresholds(c)[j];
            low = th[th.length - 1][0];
            const y = power * rt.rate.get(c);
            for (const [rk, req] of th) {
              if (req <= y) {
                if (rk > r) r = rk;
                break;
              }
            }
          }
          if (r < 0) r = low;
          sc += oppLevels[j][1] * scoreOf(eventPoints(pb, rate, pay.points.get(r) || 0), eventItems(pay.items.get(r) || 0, ib, rate), r);
        }
        return { sc };
      }
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
    // With combo breaks or the others unknown: per candidate chart, the chance of each rank over the play's shares (and
    // the levels of the others' total), and the expected payoff (per minute: over the chart's minutes). `rank` is the
    // median rank and `chance` the chance of reaching it; `needPower` the power reaching it at the mean share (with one
    // level of the others' total).
    function chooseExpected(rt, power, pb, ib) {
      let best = null;
      for (const cd of rt.cands) {
        const byRank = new Map();
        if (cd.rp !== undefined) {
          // The others unknown: the levels' thresholds (levelThresholds) at the candidate's rate.
          const th = levelThresholds(cd.chart);
          const s0 = power * cd.rp;
          for (let j = 0; j < th.length; j++) {
            const w = oppLevels[j][1];
            let above = 0;
            for (const [r, req] of th[j]) {
              const P = Math.max(above, req <= 0 ? 1 : survive(cd.q, req / s0));
              if (P > above) byRank.set(r, (byRank.get(r) || 0) + w * (P - above));
              above = P;
            }
          }
        } else {
          for (const [w, xs] of cd.levels) {
            let above = 0;
            for (const [r, x] of xs) {
              const P = Math.max(above, x <= 0 ? 1 : survive(cd.q, x / power));
              if (P > above) byRank.set(r, (byRank.get(r) || 0) + w * (P - above));
              above = P;
            }
          }
        }
        const dist = [...byRank].sort((a, b) => b[0] - a[0]);
        let sc = 0;
        let points = 0;
        let items = 0;
        let cp = 0;
        let acc = 0;
        let median = null;
        for (const [r, p] of dist) {
          const pt = eventPoints(pb, rate, pay.points.get(r) || 0);
          const it = eventItems(pay.items.get(r) || 0, ib, rate);
          sc += p * scoreOf(pt, it, r);
          points += p * pt;
          items += p * it;
          cp += p * cpOf(r);
          acc += p;
          if (!median && acc >= 0.5 - 1e-9) median = { rank: r, chance: acc };
        }
        if (!median) median = dist.length ? { rank: dist[dist.length - 1][0], chance: acc } : { rank: 0, chance: 0 };
        if (cd.min) sc /= cd.min;
        if (!best || sc > best.sc) {
          const x = cd.levels && cd.levels.length === 1 ? (cd.levels[0][1].find(([r]) => r === median.rank) || [0, 0])[1] : null;
          best = {
            rank: median.rank, chance: median.chance, dist, chart: cd.chart, needPower: x === null ? null : Math.ceil(x / cd.mean),
            points, items, cp, sc,
          };
        }
      }
      return best;
    }
    const upperBound = (s, bf, rt) => choose(rt, bf.f + s.g, s.pt + maxSnapPoint, s.it + maxSnapItem).sc;
    // Whether set s (best leader bf, bound table `bound`) can enter a full top list whose last deck is `kd`: its bound
    // must reach kd's payoff, and pass it unless it has more power (ties go to power). With combo breaks (one level of
    // the others' total) it must also reach it in expectation over the play's shares on some chart of `list`, at the
    // set's bound skill rates `sk` (the optimistic table plays every chart at its best share: with 2 breaks 6% above the
    // mean, which let half the sets of event 3 through for nothing).
    const canEnter = (s, bf, bound, list, sk, kd) => {
      let ub = upperBound(s, bf, bound);
      if (ub >= kd.score && stochastic && !oppLevels) ub = Math.min(ub, upperBound(s, bf, rankTable(list, sk, false, true)));
      return ub > kd.score || (ub === kd.score && bf.f + s.g > kd.power);
    };

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
    // `only` (or null): the snaps whose entries the caller reads; the others may be NaN (not computed yet). The snap DP
    // reads few of them at each of its many Just profiles.
    const supportMeanCache = new WeakMap(); // chart indices -> profile -> member -> {row (entries fixed once computed), all}
    const supportMeans = (members, idx, prof = null, only = null) => {
      const g = boostOf(members);
      let byG = supportMeanCache.get(idx);
      if (!byG) supportMeanCache.set(idx, byG = new Map());
      const key = (g ? g.key : "") + (prof ? "#" + prof.key : "");
      let byV = byG.get(key);
      if (!byV) byG.set(key, byV = new Map());
      return members.map((v) => {
        let e = byV.get(v);
        if (!e) byV.set(v, e = { row: new Float64Array(snaps.length).fill(NaN), all: false });
        if (e.all) return e.row;
        for (const j of only || snaps.keys()) {
          if (!Number.isNaN(e.row[j])) continue;
          const sup = pairOf(v, j, g, prof);
          let x = 0;
          if (sup) for (const ci of idx) x += sup[ci];
          e.row[j] = sup ? x / idx.length : 0;
        }
        if (!only) e.all = true;
        return e.row;
      });
    };
    const effectiveG = (members, G, idx, w) => supportMeans(members, idx).map((row, i) => row.map((x, j) => G[i][j] + w * x));
    const pickPower = (G, pick) => {
      let g = 0;
      for (let p = pick; p; p = p.prev) g += G[p.i][p.j];
      return g;
    };
    // The pair gains of the snaps `pick` (snapStates) gives `members` (slot by slot), on each chart of idx; with a Just
    // profile at it, plus what it gives the members (`d`, jw.delta). `g`: the members' boost profile.
    const pairSum = (members, pick, idx, prof = null, d = prof ? jw.delta(prof, members) : null, g = boostOf(members)) => {
      const out = new Float64Array(idx.length);
      for (let p = pick; p; p = p.prev) {
        const sup = pairOf(members[p.i], p.j, g, prof);
        if (sup) for (let c = 0; c < idx.length; c++) out[c] += sup[idx[c]];
      }
      if (d) for (let c = 0; c < idx.length; c++) out[c] += d[idx[c]];
      return out;
    };
    // `x`: pairSum's result when computed already (added to).
    const pairTable = (px, members, pick, prof = null, x = pairSum(members, pick, px.idx, prof)) => {
      if (px.skill) for (let c = 0; c < x.length; c++) x[c] += px.skill[c];
      return rankTable(px.list, x, false);
    };
    // The snap DP's states for `order` worth a rank table of their own (pairTable), as {st, p (snap power), x
    // (pairSum)}. The payoff rises with power, bonuses and the pair gain on each chart, so a state another matches or
    // beats in all of them is never better; it is dropped when that other also has more power or comes first, the ties
    // evaluate keeps. With Just windows the DP keeps a front per profile, ~490 states per set on the user's roster, of
    // which this keeps ~33.
    const pairFront = (states, G, order, px) => {
      const g = boostOf(order);
      const ds = new Map(); // profile -> what it gives the members on px's charts (as jw.delta)
      const L = states.map((st, n) => {
        const x = pairSum(order, st.pick, px.idx, st.prof, null, g);
        if (st.prof) {
          if (!ds.has(st.prof)) ds.set(st.prof, Float64Array.from(px.idx, (i) => jw.deltaAt(st.prof, order, i)));
          const d = ds.get(st.prof);
          for (let c = 0; c < x.length; c++) x[c] += d[c];
        }
        return { st, n, p: pickPower(G, st.pick), x };
      });
      L.sort((a, b) => b.p - a.p || a.n - b.n);
      const kept = [];
      for (const a of L) {
        const beaten = kept.some((k) => k.st.pt >= a.st.pt && k.st.it >= a.st.it && (k.p > a.p || k.n < a.n) && k.x.every((v, c) => v >= a.x[c]));
        if (!beaten) kept.push(a);
      }
      return kept.sort((a, b) => a.n - b.n);
    };
    // The gain per unit of power of a deck's pairs on chart c from `of` (supOf: Gekisou support skills; roughOf), at
    // Just profile prof.
    const deckSupport = (members, snapObjs, c, of, prof = null) => {
      const ci = chartIdx.get(c);
      const g = boostOf(members);
      let x = 0;
      members.forEach((v, i) => {
        const sup = snapObjs[i] ? of(v, snaps.indexOf(snapObjs[i]), g, prof) : null;
        if (sup) x += sup[ci];
      });
      return x;
    };
    // The snap DP's Just windows (snapStates' jd) for members `order`, slot by slot, or null. `Xof(prof)`: X at a profile
    // (score objective; null in points, whose pairTable plays the pairs at the deck's profile); `lohi`: [lo, hi] (jd);
    // `play` (score objective, or null): {value, lin, floor} (jd).
    const winSlotCache = new WeakMap();
    const justDP = (order, Xof, lohi, play = null) => {
      if (!jw.on || !order.some((v) => v.gekisouSkillId)) return null;
      const cache = new Map();
      const his = new Map();
      const jd = {
        wins: (i, j) => jw.wins(order[i], j),
        add: jw.add,
        // `only` (or null): the snaps whose entries are read (the same in every call).
        Xof: Xof ? (prof, only = null) => {
          if (!cache.has(prof)) cache.set(prof, Xof(prof, only));
          return cache.get(prof);
        } : null,
        lo: lohi ? lohi[0] : null,
        hi: lohi ? lohi[1] : null,
        anyWin: jw.isWin,
        slotCache: winSlotCache,
        value: play ? play.value : null,
        lin: play ? play.lin : null,
        floor: play && play.floor !== undefined ? play.floor : -Infinity,
        // Per slot and snap, the larger of X and X at the strongest profile n of these members' windows make.
        hiOf: play && Xof ? (n) => {
          if (!his.has(n)) his.set(n, loHi(jd.Xof(null), jd.Xof(jw.top(order, n)))[1]);
          return his.get(n);
        } : null,
      };
      return jd;
    };
    // The Just profile of members `order` with snap views `snapObjs` (slot by slot), or null.
    const deckProf = (order, snapObjs) => {
      let p = null;
      if (!jw.on) return p;
      order.forEach((v, i) => {
        const j = snapObjs[i] ? snaps.indexOf(snapObjs[i]) : -1;
        const w = j >= 0 ? jw.wins(v, j) : null;
        if (w) p = jw.add(p, w);
      });
      return p;
    };
    // Per slot, the least and most of rows X and Y, snap by snap (justDP's lohi).
    const loHi = (X, Y) => [X.map((r, i) => r.map((x, j) => Math.min(x, Y[i][j]))), X.map((r, i) => r.map((x, j) => Math.max(x, Y[i][j])))];

    // The exact best deck of a member set: leader from bestF, snaps from the slot-mask DP. `Xm` (score objective, or
    // null): the deck's boost profile (and Just profile) -> member view -> pair rates per snap on rt's chart. `px`
    // (points with Gekisou support, or null): see pairTable. `floor`: with Just windows in the score objective, null when
    // the set cannot reach it (twoPhase).
    function evaluate(s, bf, rt, music, Xm, px, floor = -Infinity) {
      evaluated++;
      const order = s.vs.slice();
      [order[bf.leader], order[LEADER_SLOT]] = [order[LEADER_SLOT], order[bf.leader]];
      const G = order.map((v) => Gm.get(v));
      const g = Xm ? boostOf(order) : null;
      const xm = Xm ? Xm(g) : null;
      const X = xm ? order.map((v) => xm.get(v)) : null;
      const Gd = px ? effectiveG(order, G, px.idx, (bf.f + s.g) / px.rate) : G;
      const xAt = (prof) => {
        const x = Xm(g, prof);
        return order.map((v) => x.get(v));
      };
      const ci = Xm ? chartIdx.get(rt.best) : -1;
      const deltas = new Map();
      const dOf = (prof) => {
        if (!prof) return 0;
        if (!deltas.has(prof)) deltas.set(prof, jw.deltaAt(prof, order, ci));
        return deltas.get(prof);
      };
      // choose's score: (F + P) (rate + share x).
      const sh = Xm ? shares(rt.best).mean : 0;
      const play = Xm ? {
        value: (st) => choose(rt, bf.f + st.power, s.pt, s.it, st.x + dOf(st.prof)).sc,
        lin: (prof) => ({ a: bf.f, b: rt.rate.get(rt.best) / sh + dOf(prof), c: sh }),
        floor,
      } : null;
      // Windows change only JUST charts: a deck playing none carries no profile.
      const onJust = jw.on && (Xm ? jw.isJust[ci] : px ? px.idx.some((i) => jw.isJust[i]) : false);
      const jd = onJust ? justDP(order, Xm ? xAt : null, Xm ? loHi(X, xAt(jw.top(allCand, 5))) : null, play) : null;
      let best = null;
      const states = snapStates(Gd, snapPoint, snapItem, snaps.length, X, snapSlotCache, jd);
      for (const { st, p, x } of px && jd ? pairFront(states, G, order, px) : states.map((st) => ({ st }))) {
        const power = bf.f + (px ? (p !== undefined ? p : pickPower(G, st.pick)) : st.power);
        const pb = s.pt + st.pt;
        const ib = s.it + st.it;
        const t = px ? pairTable(px, order, st.pick, st.prof, x) : rt;
        const v = choose(t, power, pb, ib, Xm ? st.x + dOf(st.prof) : 0);
        if (!best || v.sc > best.sc || (v.sc === best.sc && power > best.power)) best = { ...v, power, pb, ib, st, t, prof: st.prof };
      }
      if (!best) return null;
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
      // Just windows: what they add to the chart's rate and the members' skills (`justScore`; the pairs' share is in
      // theirs), and the Just rate they give in the chart's JUST ranges.
      const prof = best.prof || null;
      const dj = prof ? jw.deltaAt(prof, order, chartIdx.get(best.chart)) : 0;
      if (prof) {
        deck.justWindows = prof.wins.map(([sec, f]) => ({ sec: Number.isFinite(sec) ? sec : null, f }));
        const jr = jw.btOf(prof).justRanges.get(best.chart.scoreId) || [];
        let n = 0;
        let jsum = 0;
        jr.forEach(([J, , , seg]) => {
          if (!seg || !(J > 0)) return;
          n += J;
          jsum += J * segmentMean(seg);
        });
        if (n > 0) deck.justRate = jsum / n;
        deck.justScore = Math.floor(best.power * dj * deck.accuracy);
      }
      // Snaps' Gekisou support skills apart from their (non-Gekisou) snap skills; in points they are in rt's rates.
      const sup = gkSup ? deckSupport(order, snapObjs, best.chart, supOf, prof) : 0;
      if (best.x) deck.snapScore = Math.floor(best.power * Math.max(0, best.x - sup - dj) * deck.accuracy);
      if (roughSnaps) {
        deck.snapScore = Math.floor(best.power * deckSupport(order, snapObjs, best.chart, roughOf) * deck.accuracy);
        deck.snapRough = !measuredPts;
      }
      if (gkSup) deck.gekisouSupportScore = Math.floor(best.power * sup * deck.accuracy);
      if (bt) {
        // Without the windows' share, which justScore holds.
        const g = order.reduce((a, v) => a + gekisouSkillRate(m, battle, bt, v, best.chart.scoreId, input.gekisouLevels), 0);
        deck.gekisouScore = Math.floor(best.power * g * deck.accuracy);
      }
      return deck;
    }

    // Replay candidates keep the formation fixed while comparing allowed charts of the same song. This is opt-in:
    // ordinary searches retain their original result shape and chart selection. Never re-search a narrowed roster
    // here: that would change the four-card pruning and could move the leader or snap assignments.
    function withChartCandidates(d) {
      if (input.chartCandidateMargin === undefined) return d;
      const prof = deckProf(d.members, d.snaps);
      const candidates = chartList.filter((c) => c.musicId === d.chart.musicId).map((c) => {
        if (c.scoreId === d.chart.scoreId) return d;
        const skill = d.members.reduce((n, v) => n + skillRateOf(v, c), 0);
        const pair = (pairX ? deckSupport(d.members, d.snaps, c, pairOf, prof) : 0) + (prof ? jw.deltaAt(prof, d.members, chartIdx.get(c)) : 0);
        const rt = rankTable([c], [skill + (scoreMode ? 0 : pair)], false);
        const v = choose(rt, d.power, d.pointBonus, d.itemBonus, scoreMode ? pair : 0);
        return deckOf(d.members, d.snaps, { ...v, power: d.power, pb: d.pointBonus, ib: d.itemBonus, prof }, rt, d.music);
      });
      // Payoff has wide plateaus: several much lower-scoring charts can pay the same estimated rank. Use expected
      // own score to keep nearby difficulties, always retaining choose's original (important with combo breaks).
      const floor = Math.max(...candidates.map((c) => c.estScore)) * (1 - input.chartCandidateMargin);
      return { ...d, chartCandidates: candidates.filter((c) => c === d || c.estScore >= floor) };
    }

    // Live skill score per unit of power of each candidate on each chart of `list`; a set adds its five. The bound takes,
    // per chart, the five largest gains of any candidates.
    // With Gekisou, a member's Gekisou skill adds its own gain (whatever the performance order).
    // With pair rates (snap skills, Gekisou support skills), a bound also adds each member's best snap pairing: a set's
    // at its own boost profile (`setBound`), `maxSkill` at the largest. `snapRates(c, g)` gives member view -> rates per
    // snap on chart c in a deck of boost profile g.
    function skillRates(list) {
      // Per-song points queries visit few members of each boost profile too. Public-room mean searches still
      // benefit from eager rows; keep that path while avoiding unused whole-roster bounds in individual searches.
      const lazyBounds = scoreMode || !randomSong;
      const listIdx = list.map((c) => chartIdx.get(c));
      const skillOf = new Map();
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
      const profileKeys = new Map();
      const profileKey = (g) => {
        if (!g) return "";
        if (randomSong) return g.key;
        // Different skill combinations often give exactly the same boosts on these charts (e.g. LUCK skills on
        // an all-COMBO chart). Only those numeric boosts feed the pair rates; share rows/bounds for equal vectors.
        if (!profileKeys.has(g)) profileKeys.set(g, JSON.stringify(listIdx.map((i) => [g.rush[i], g.combo[0][i], g.combo[1][i]])));
        return profileKeys.get(g);
      };
      const ratesAt = new Map();
      const snapRatesAt = (g, prof = null) => {
        const gk = profileKey(g) + (prof ? "#" + prof.key : "");
        if (!ratesAt.has(gk)) {
          // Payoff queries reuse most candidates: keep their eager maps and reserve lazy rows for score searches.
          if (!scoreMode) {
            const byChart = list.map(() => new Map());
            for (const v of allCand) snapRatesOf(v, listIdx, g, prof).forEach((r, k) => byChart[k].set(v, r));
            ratesAt.set(gk, byChart);
            return byChart;
          }
          // A profile usually belongs to only a few member sets. Materialising every candidate's rows here made
          // per-song searches spend most of their time on pairings they never read.
          const byV = new Map();
          const byChart = list.map((_, k) => ({ get(v) {
            if (!byV.has(v)) byV.set(v, snapRatesOf(v, listIdx, g, prof));
            return byV.get(v)[k];
          } }));
          ratesAt.set(gk, byChart);
        }
        return ratesAt.get(gk);
      };
      // Member view -> skill rates plus the best pairing per chart, in a deck of boost profile g.
      const boundAt = new Map();
      const boundsAt = (g) => {
        const gk = profileKey(g);
        if (!boundAt.has(gk)) {
          if (!lazyBounds) {
            const out = new Map();
            for (const v of allCand) {
              const a = Float64Array.from(skillOf.get(v) || new Float64Array(list.length));
              const best = bestPairOf(v, g);
              for (let i = 0; i < a.length; i++) a[i] += best[listIdx[i]];
              out.set(v, a);
            }
            boundAt.set(gk, out);
            return out;
          }
          const byV = new Map();
          const out = { get(v) {
            if (!byV.has(v)) {
              const a = Float64Array.from(skillOf.get(v) || new Float64Array(list.length));
              const best = bestPairOf(v, g);
              for (let i = 0; i < a.length; i++) a[i] += best[listIdx[i]];
              byV.set(v, a);
            }
            return byV.get(v);
          } };
          boundAt.set(gk, out);
        }
        return boundAt.get(gk);
      };
      const bounds = pairX ? boundsAt(gMax) : skillOf;
      const wk = windowBounds(list, listIdx);
      const anySkill = pairX && lazyBounds ? true : bounds.size > 0 || !!wk;
      const maxSkill = new Float64Array(list.length);
      if (anySkill) {
        const all = pairX && lazyBounds ? allCand.map((v) => bounds.get(v)) : [...bounds.values()];
        for (let i = 0; i < list.length; i++) {
          const top = all.map((a) => a[i]).sort((a, b) => b - a);
          for (let k = 0; k < 5 && k < top.length; k++) maxSkill[i] += top[k];
        }
        if (wk) wk.raiseAll(maxSkill);
      }
      const sum = (of) => (vs) => {
        const a = new Float64Array(list.length);
        for (const v of vs) {
          const x = of.get(v);
          if (x) for (let i = 0; i < a.length; i++) a[i] += x[i];
        }
        return a;
      };
      const snapRates = pairX ? (c, g = null, prof = null) => snapRatesAt(g, prof)[list.indexOf(c)] : null;
      // `coarse`: with Just windows, wk.raiseCoarse (a looser bound, cheaper).
      const raised = (of, vs, g, coarse = false) => {
        const a = sum(of)(vs);
        if (wk) (coarse ? wk.raiseCoarse : wk.raise)(a, vs, g);
        return a;
      };
      const setBound = !pairX ? (vs) => raised(skillOf, vs, null) : scoreMode
        ? (vs, g = boostOf(vs), coarse = false) => raised(boundsAt(g), vs, g, coarse)
        : (vs) => {
            const g = boostOf(vs);
            return raised(boundsAt(g), vs, g);
          };
      return { anySkill, maxSkill, setSkill: sum(skillOf), setBound, snapRates, profileKey, wk };
    }

    // Just windows in bounds, on the JUST charts of `list` (null without any): a deck with k window snaps plays at most
    // the strongest profile k of them make (prof[k] = jw.top(allCand, k)), so the chart's rate and its members' skills
    // gain at most what that profile gives (`dp`, `ds`), its other snaps pair at most at the larger of no windows and
    // that profile (`pn`), and the k window slots hold window snaps (`pw`: the best one beside a member that takes a
    // window). Bounds take the best k (k = 0 is the bound without windows).
    let windowLists = 0;
    function windowBounds(list, listIdx) {
      if (!jw.on) return null;
      const jl = [];
      list.forEach((_, i) => jw.isJust[listIdx[i]] && jl.push(i));
      if (!jl.length) return null;
      const K = 5;
      const prof = [null];
      for (let k = 1; k <= K; k++) prof.push(jw.top(allCand, k));
      const dp = prof.map((p) => {
        const a = new Float64Array(list.length);
        if (p) for (const i of jl) a[i] = Math.max(0, jw.btOf(p).perPower.get(list[i].scoreId) - list[i].perPower);
        return a;
      });
      const dsCache = new Map(); // member -> per k rates on list
      const ds = (v, k) => {
        if (!dsCache.has(v)) {
          const z = jw.skillAt(null, v);
          dsCache.set(v, prof.map((p) => {
            const a = new Float64Array(list.length);
            if (p) {
              const t = jw.skillAt(p, v);
              for (const i of jl) a[i] = Math.max(0, t[listIdx[i]] - z[listIdx[i]]);
            }
            return a;
          }));
        }
        return dsCache.get(v)[k];
      };
      // Its rows read the JUST charts of list only.
      const subJ = { key: "w" + windowLists++, idx: jl.map((i) => listIdx[i]) };
      const pn = (v, g, k) => bestPairOf(v, g, prof[k], null, subJ);
      // The window snaps beside v (as bestPairOf's `only`), or null when v takes none.
      const hosts = new Map();
      const hostOf = (v) => {
        if (!hosts.has(v)) {
          const set = new Set();
          for (let j = 0; j < snaps.length; j++) if (jw.wins(v, j)) set.add(j);
          set.key = "w" + [...set].join(",");
          hosts.set(v, set.size ? set : null);
        }
        return hosts.get(v);
      };
      const pw = (v, g) => (hostOf(v) ? bestPairOf(v, g, null, hostOf(v)) : null);
      // Per boost profile and member, per k and chart of list: its skills and best pairing at prof[k] (`s`), and what
      // taking its best window snap instead costs (`d`, null when it takes none). Only the JUST charts are read, so boost
      // profiles equal there share them.
      const rowsAt = new Map();
      const jKeys = new Map();
      const jKey = (g) => {
        if (!g) return "";
        if (!jKeys.has(g)) jKeys.set(g, JSON.stringify(jl.map((i) => [g.rush[listIdx[i]], g.combo[0][listIdx[i]], g.combo[1][listIdx[i]]])));
        return jKeys.get(g);
      };
      const rowsOf = (v, g) => {
        const key = jKey(g);
        if (!rowsAt.has(key)) rowsAt.set(key, new Map());
        const byV = rowsAt.get(key);
        if (!byV.has(v)) {
          const L = list.length;
          const s = new Float64Array((K + 1) * L);
          const w = pw(v, g);
          const d = w ? new Float64Array((K + 1) * L) : null;
          const z = jw.skillAt(null, v);
          // `e`: per m and chart, the most s plus what a negative cost gives back, over k = 1..m (raiseCoarse).
          const e = new Float64Array((K + 1) * L).fill(-Infinity);
          for (let k = 1; k <= K; k++) {
            const p = pn(v, g, k);
            const x = ds(v, k);
            for (const i of jl) {
              const ci = listIdx[i];
              const o = k * L + i;
              s[o] = z[ci] + x[i] + p[ci];
              if (d) d[o] = p[ci] - w[ci];
              e[o] = Math.max(e[o - L], s[o] + (d ? Math.max(0, -d[o]) : 0));
            }
          }
          byV.set(v, { s, d, e });
        }
        return byV.get(v);
      };
      // dp's most over k = 1..m, per m and chart.
      const dpUpTo = dp.map(() => new Float64Array(list.length).fill(-Infinity));
      for (let k = 1; k <= K; k++) for (const i of jl) dpUpTo[k][i] = Math.max(dpUpTo[k - 1][i], dp[k][i]);
      // a[i] (a set's bound without windows on chart i of list) raised to the best k for members vs, boost profile g.
      const diffs = new Float64Array(5);
      const raise = (a, vs, g) => {
        const L = list.length;
        const rows = vs.map((v) => rowsOf(v, g));
        const cs = rows.filter((r) => r.d).map((r) => r.d);
        const nh = Math.min(K, cs.length);
        for (const i of jl) {
          let best = a[i];
          for (let k = 1; k <= nh; k++) {
            const o = k * L + i;
            let s = dp[k][i];
            for (const r of rows) s += r.s[o];
            // the k smallest of the hosts' costs (insertion sort)
            for (let n = 0; n < cs.length; n++) {
              const x = cs[n][o];
              let p = n;
              while (p > 0 && diffs[p - 1] > x) {
                diffs[p] = diffs[p - 1];
                p--;
              }
              diffs[p] = x;
            }
            for (let t = 0; t < k; t++) s -= diffs[t];
            if (s > best) best = s;
          }
          a[i] = best;
        }
      };
      // At least raise's a, cheaper: the k smallest costs take back at most the hosts' negative ones, so with m the
      // most window snaps the hosts allow, each k's sum is at most dp's most plus each member's `e` over k = 1..m.
      const raiseCoarse = (a, vs, g) => {
        const L = list.length;
        const rows = vs.map((v) => rowsOf(v, g));
        const m = Math.min(K, rows.filter((r) => r.d).length);
        if (!m) return;
        const o = m * L;
        for (const i of jl) {
          let s = dpUpTo[m][i];
          for (const r of rows) s += r.e[o + i];
          // Leave room for raise's other summation order.
          s += Math.abs(s) * 1e-12;
          if (s > a[i]) a[i] = s;
        }
      };
      // maxSkill raised: the best k of the five largest skills, the 5 - k largest pairings and the k best window snaps
      // of any candidates (at the largest boost profile).
      const raiseAll = (a) => {
        const topSum = (xs, n) => xs.sort((x, y) => y - x).slice(0, n).reduce((x, y) => x + y, 0);
        for (const i of jl) {
          const ci = listIdx[i];
          const hostsW = allCand.filter((v) => hostOf(v)).map((v) => pw(v, gMax)[ci]);
          for (let k = 1; k <= K && k <= hostsW.length; k++) {
            const s = dp[k][i] + topSum(allCand.map((v) => jw.skillAt(null, v)[ci] + ds(v, k)[i]), 5) +
              topSum(allCand.map((v) => pn(v, gMax, k)[ci]), 5 - k) + topSum(hostsW.slice(), k);
            if (s > a[i]) a[i] = s;
          }
        }
      };
      // For one set (refine): the strongest profile k windows beside its members vs make, and what it gives the chart's
      // rate and their skills (`d`, per chart of list), each at least 0.
      const dpAt = new Map();
      const setAt = (vs, k) => {
        const p = jw.top(vs, k);
        if (!dpAt.has(p)) {
          const a = new Float64Array(list.length);
          for (const i of jl) a[i] = Math.max(0, jw.btOf(p).perPower.get(list[i].scoreId) - list[i].perPower);
          dpAt.set(p, a);
        }
        const d = Float64Array.from(dpAt.get(p));
        for (const v of vs) {
          const t = jw.skillAt(p, v);
          const z = jw.skillAt(null, v);
          for (const i of jl) d[i] += Math.max(0, t[listIdx[i]] - z[listIdx[i]]);
        }
        return { prof: p, d };
      };
      return { jl, K, prof, dp, ds, raise, raiseCoarse, raiseAll, hostOf, setAt };
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
        const mv = musicView(m, c.musicId, input.arena && input.arena.musicType);
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
      // A set's own bound: its skills and each member's best pairing (at its boost profile) at its power bound per group.
      // `coarse`: with Just windows, the cheaper and looser window bound (raiseCoarse): sets go to the heap with it and get
      // the exact one when they reach the top (with every card owned, 1 in 8 did).
      const ubOf = (s, coarse = false) => {
        const vs = setVs(s);
        const b = sk.anySkill ? sk.setBound(vs, boostOf(vs), coarse) : null;
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
      const ratesOf = (vs, prof = null) => (sk.snapRates ? list.map((c) => sk.snapRates(c, boostOf(vs), prof)) : null);
      const listIdx = list.map((c) => chartIdx.get(c));
      // A tighter bound for a set ubOf could not rule out, where each snap goes to one slot (ubOf gives every member its
      // best pairing): a deck of power F + P plays sum_k w_k (F_k + P) (c_k + x_k), with F_k at most the set's leader term
      // bound (Fb), P at most the best snap per slot (Pmax) and x_k the pairs' rates, so it is at most sum_k w_k Fb_k c_k
      // plus the best assignment of weights C G[i][j] + sum_k w_k (Fb_k + Pmax) X_k[i][j] (bestAssignment). The pair part
      // comes from wRatesOf: per boost profile and member, R[G nJ + j] = sum over the charts k of song group G of
      // w_k max(0, X_k[j]), and R[nG nJ + j] their sum over the groups. With Just windows (sk.wk), the best of these over
      // the number of window snaps, as the per-song refine.
      const wRates = new Map(); // profile key -> member view -> R
      const wRatesOf = (v, g, kk) => {
        const gk = (g ? sk.profileKey(g) : "") + "|" + kk;
        if (!wRates.has(gk)) wRates.set(gk, new Map());
        const byV = wRates.get(gk);
        if (!byV.has(v)) {
          const nJ = snaps.length;
          const R = new Float64Array((nG + 1) * nJ);
          const lo = list.map((c) => sk.snapRates(c, g));
          if (kk > 0) {
            // A profile changes only the JUST charts: R without windows plus what the profile adds there.
            R.set(wRatesOf(v, g, 0));
            const jl = sk.wk.jl;
            const hi = snapRatesOf(v, jl.map((k) => listIdx[k]), g, sk.wk.prof[kk]);
            jl.forEach((k, t) => {
              const r = lo[k].get(v);
              const h = hi[t];
              const o = gOf[k] * nJ;
              for (let j = 0; j < nJ; j++) {
                const d = Math.max(0, r[j], h[j]) - Math.max(0, r[j]);
                if (d > 0) {
                  R[o + j] += w[k] * d;
                  R[nG * nJ + j] += w[k] * d;
                }
              }
            });
          } else {
            for (let k = 0; k < nS; k++) {
              const r = lo[k].get(v);
              const o = gOf[k] * nJ;
              for (let j = 0; j < nJ; j++) if (r[j] > 0) R[o + j] += w[k] * r[j];
            }
            for (let G = 0; G < nG; G++) for (let j = 0; j < nJ; j++) R[nG * nJ + j] += R[G * nJ + j];
          }
          byV.set(v, R);
        }
        return byV.get(v);
      };
      // What the strongest k windows give the charts' rates (wk.dp) and each member's skills (wk.ds), summed per song
      // group with the weights w (index k nG + G): refine's terms per k without a pass over the songs.
      const nK = sk.wk ? sk.wk.K + 1 : 1;
      const dpG = new Float64Array(nK * nG);
      if (sk.wk) for (let kk = 1; kk < nK; kk++) for (let k = 0; k < nS; k++) dpG[kk * nG + gOf[k]] += w[k] * sk.wk.dp[kk][k];
      const dsGs = new Map();
      const dsG = (v) => {
        if (!dsGs.has(v)) {
          const a = new Float64Array(nK * nG);
          for (let kk = 1; kk < nK; kk++) {
            const d = sk.wk.ds(v, kk);
            for (let k = 0; k < nS; k++) a[kk * nG + gOf[k]] += w[k] * d[k];
          }
          dsGs.set(v, a);
        }
        return dsGs.get(v);
      };
      // Refinement goes one number of window snaps at a time (refineStep), in the order of a cheap bound (the assignment
      // bound of assignmentBoundK, every group's power at the largest): a set's key is the largest of the bounds done and
      // the cheap bound of the next (refineKey), so a set that falls behind costs no more DPs. No more window snaps than
      // members that take one; without windows, one step. The state keeps per step [k, base, C, cheap bound].
      const refineCtx = (s) => {
        const vs = setVs(s);
        let pMax = 0;
        for (const v of vs) pMax += bestG.get(v);
        const fb = new Float64Array(nG);
        for (let g = 0; g < nG; g++) fb[g] = powB(g, s) - pMax;
        return { vs, pMax, fb, profile: boostOf(vs), win: sk.wk ? vs.map((v) => jw.winRow(v)) : null };
      };
      const refineStart = (s) => {
        const { vs, pMax, fb, profile, win } = refineCtx(s);
        const skill = sk.anySkill ? sk.setSkill(vs) : null;
        const nJ = snaps.length;
        const wk = sk.wk;
        let fMax = 0;
        for (let g = 0; g < nG; g++) fMax = Math.max(fMax, fb[g]);
        let base0 = 0;
        let C0 = 0;
        for (let k = 0; k < nS; k++) {
          const c = list[k].perPower + (skill ? skill[k] : 0);
          base0 += w[k] * fb[gOf[k]] * c;
          C0 += w[k] * c;
        }
        const hosts = wk ? Math.min(wk.K, vs.filter((v) => wk.hostOf(v)).length) : 0;
        const ds = wk ? vs.map(dsG) : null;
        const cand = [];
        for (let kk = 0; kk <= hosts; kk++) {
          let base = base0;
          let C = C0;
          if (kk > 0) {
            for (let G = 0; G < nG; G++) {
              let d = dpG[kk * nG + G];
              for (const a of ds) d += a[kk * nG + G];
              base += fb[G] * d;
              C += d;
            }
          }
          let ub = Infinity;
          if (wk) {
            const rows = vs.map((v) => {
              const g = Gm.get(v);
              const R = sk.snapRates ? wRatesOf(v, profile, kk) : null;
              const row = new Float64Array(nJ);
              for (let j = 0; j < nJ; j++) row[j] = C * g[j] + (R ? (fMax + pMax) * R[nG * nJ + j] : 0);
              return row;
            });
            ub = base + assignmentBoundK(rows, nJ, win, kk);
            if (ub === -Infinity) continue;
          }
          cand.push([kk, base, C, ub]);
        }
        cand.sort((a, b) => b[3] - a[3]);
        return { cand: Float64Array.from(cand.flat()), n: cand.length, i: 0, out: -Infinity };
      };
      const refineKey = (r) => Math.max(r.out, r.i < r.n ? r.cand[r.i * 4 + 3] : -Infinity);
      const refineStep = (s, r, th) => {
        const o = 4 * r.i++;
        const kk = r.cand[o];
        const base = r.cand[o + 1];
        const C = r.cand[o + 2];
        if (r.cand[o + 3] < Math.max(r.out, th)) return;
        const { vs, pMax, fb, profile, win } = refineCtx(s);
        const nJ = snaps.length;
        const wk = sk.wk;
        const W = vs.map((v) => {
          const g = Gm.get(v);
          const row = new Float64Array(nJ);
          for (let j = 0; j < nJ; j++) row[j] = C * g[j];
          if (sk.snapRates) {
            const R = wRatesOf(v, profile, kk);
            for (let G = 0; G <= nG; G++) {
              const f = G < nG ? fb[G] : pMax;
              const o = G * nJ;
              for (let j = 0; j < nJ; j++) row[j] += f * R[o + j];
            }
          }
          return row;
        });
        if (wk && base + assignmentBoundK(W, nJ, win, kk) < Math.max(r.out, th)) return;
        const x = base + (wk ? bestAssignmentK(W, nJ, win, kk) : bestAssignment(W, nJ));
        if (x > r.out) r.out = x;
      };

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
        // The DP's pair rates: each chart's weighted by its play share and the first leader's F there.
        const f0 = kept[0].f;
        const weighted = (rates) => vs.map((v) => {
          const row = new Float64Array(snaps.length);
          for (let k = 0; k < nS; k++) {
            const r = rates[k].get(v);
            const wk = w[k] * f0[gOf[k]];
            for (let j = 0; j < row.length; j++) row[j] += wk * r[j];
          }
          return row;
        });
        const X = xr ? weighted(xr) : null;
        // With Just windows, pairs at each deck's profile, and what the profile gives the members (jw.delta).
        const xrAt = new Map();
        const ratesAt = (prof) => {
          if (!prof) return xr;
          if (!xrAt.has(prof)) xrAt.set(prof, ratesOf(vs, prof));
          return xrAt.get(prof);
        };
        // The payoff of a deck of DP state st with leader ld.
        const xsOf = (st) => {
          const xs = pairSums(vs, st.pick, ratesAt(st.prof));
          if (st.prof) {
            const d = jw.delta(st.prof, vs);
            for (let k = 0; k < nS; k++) xs[k] += d[listIdx[k]];
          }
          return xs;
        };
        const sumOf = (ld, power, xs) => {
          let sum = 0;
          for (let k = 0; k < nS; k++) sum += w[k] * (ld.f[gOf[k]] + power) * (list[k].perPower + (skill ? skill[k] : 0) + xs[k]);
          return sum;
        };
        // With Just windows, profiles the DP plays one by one, bounded from the DP's rates x (each chart's weighted by its
        // play share and f0; all rates at least 0): a leader's payoff, sum_k w_k (f_k + P)(r_k + x_k) with r_k the
        // chart's rate at the profile, is at most (a + P)(S + x / f0min) with a the largest f of any leader and
        // S = sum_k w_k r_k.
        let play = null;
        if (xr && jw.on) {
          const a = Math.max(...kept.map((ld) => Math.max(...ld.f)));
          const f0min = Math.min(...f0);
          play = {
            value: (st) => {
              const xs = xsOf(st);
              return Math.max(...kept.map((ld) => sumOf(ld, st.power, xs)));
            },
            lin: (prof) => {
              const d = prof ? jw.delta(prof, vs) : null;
              let S = 0;
              for (let k = 0; k < nS; k++) S += w[k] * (list[k].perPower + (skill ? skill[k] : 0) + (d ? d[listIdx[k]] : 0));
              return { a, b: S * f0min, c: 1 / f0min };
            },
          };
        }
        const jd = xr ? justDP(vs, (prof) => weighted(ratesAt(prof)), jw.on ? loHi(X, weighted(ratesOf(vs, jw.top(allCand, 5)))) : null, play) : null;
        let best = null;
        for (const st of snapStates(G, snapPoint, snapItem, snaps.length, X, snapSlotCache, jd)) {
          const xs = xsOf(st);
          for (const ld of kept) {
            const sum = sumOf(ld, st.power, xs);
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
            const key = ubOf(s, !!sk.wk);
            if (key >= th) heap.push({ key, s, e: setEnum[s], coarse: !!sk.wk });
          }
          b--;
        }
        if (!heap.size) break;
        const x = heap.pop();
        if (x.key < threshold()) break;
        if (x.coarse) {
          const key = Math.min(x.key, ubOf(x.s));
          if (key >= threshold()) heap.push({ key, s: x.s, e: x.e });
          continue;
        }
        if (!x.refined) {
          const r = x.r || refineStart(x.s);
          if (r.n) refineStep(x.s, r, threshold());
          const key = Math.min(x.key, refineKey(r));
          if (key >= threshold()) heap.push({ key, s: x.s, e: x.e, r, refined: r.i >= r.n });
          continue;
        }
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
          return deckOf(lorder, snapObjs, { ...v, power, pb: 0, ib: 0, prof: best.st.prof }, rt, gl[gOf[k]].music);
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
        justSummary(deck, perSong, best.st.prof);
        perSong.sort((a, b2) => b2.score - a.score || b2.power - a.power);
        return { deck, perSong: perSong.map(withChartCandidates) };
      };
      const built = found.map(build);
      return {
        results: built.map((x) => x.deck),
        songs: input.compareSongs && built.length ? built[0].perSong : [],
        perSong: built.map((x) => x.perSong),
        random: true,
        rate,
        gekisou: bt ? gekisouOut(bt) : null,
        payoff: pay,
        ctx,
        stats: { sets: nSets, evaluated, groups: nG, songs: nS, ms: Date.now() - t0 },
      };
    }

    // A random-song deck's Just windows from its songs' decks (perSong): the windows, their mean score and the mean Just
    // rate over the songs with a JUST range.
    function justSummary(deck, perSong, prof) {
      if (!prof) return;
      deck.justWindows = perSong[0].justWindows;
      deck.justScore = Math.round(perSong.reduce((a, d) => a + (d.justScore || 0), 0) / perSong.length);
      const withJust = perSong.filter((d) => d.justRate !== undefined);
      if (withJust.length) deck.justRate = withJust.reduce((a, d) => a + d.justRate, 0) / withJust.length;
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
      for (const t of boundT) for (const r of t.mix ? mixSubs(t).flatMap((x) => x.rankList) : t.rankList) RMAX = Math.max(RMAX, r + 1);
      // A bound table's payoff with `vals` (payoff by rank) at power p (mix tables: weighted over the others' levels).
      const valAt = (t, vals, p) => (t.mix ? mixVal(t, vals, p) : vals[t.rankFor(p)]);
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
        for (const k of ks) for (const t of boundT[k].mix ? mixSubs(boundT[k]) : [boundT[k]]) for (const n of t.need.values()) ps.add(n.power);
        const P = Float64Array.from(ps).sort();
        const cnt = new Float64Array((P.length + 1) * RMAX);
        for (const k of ks) {
          const t = boundT[k];
          for (let l = 0; l <= P.length; l++) {
            const p = l ? P[l - 1] : -Infinity;
            if (t.mix) for (const s of mixSubs(t)) cnt[l * RMAX + s.rankFor(p)] += s.w;
            else cnt[l * RMAX + t.rankFor(p)]++;
          }
        }
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

      // The others unknown (oppLevels): a song's payoff straight from its charts' thresholds per level, without tables
      // (build() makes the tables of the decks found). `x`: per chartList chart the rate added to perPower, or null;
      // `p` the power, `V` the payoff by rank. oppUb bounds it (each level on its own chart, at the best play share);
      // oppSong is chooseExpected's arithmetic, one chart for every level.
      const oppUb = (so, x, p, V) => {
        let v = 0;
        for (let j = 0; j < oppLevels.length; j++) {
          let best = -1;
          let low = 0;
          so.list.forEach((c, i) => {
            const sc = p * (c.perPower + (x ? x[so.idx[i]] : 0)) * shares(c).max;
            const th = levelThresholds(c)[j];
            low = th[th.length - 1][0];
            for (const [r, req] of th) {
              if (req <= sc) {
                if (r > best) best = r;
                break;
              }
            }
          });
          v += oppLevels[j][1] * V[best < 0 ? low : best];
        }
        return v;
      };
      const oppSong = (so, x, p, V) => {
        // A song's charts share its room thresholds: with one play share each, the chart scoring most pays most.
        if (so.list.every((c) => shares(c).det)) {
          let c = null;
          let sc = -Infinity;
          so.list.forEach((d, i) => {
            const y = p * (d.perPower + (x ? x[so.idx[i]] : 0)) * shares(d).q[0];
            if (y > sc) {
              sc = y;
              c = d;
            }
          });
          const th = levelThresholds(c);
          let v = 0;
          for (let j = 0; j < th.length; j++) {
            for (const [r, req] of th[j]) {
              if (req <= sc) {
                v += oppLevels[j][1] * V[r];
                break;
              }
            }
          }
          return v;
        }
        let best = -Infinity;
        so.list.forEach((c, i) => {
          const s0 = p * (c.perPower + (x ? x[so.idx[i]] : 0));
          const q = shares(c).q;
          const th = levelThresholds(c);
          let v = 0;
          for (let j = 0; j < th.length; j++) {
            let above = 0;
            for (const [r, req] of th[j]) {
              const P = Math.max(above, req <= 0 ? 1 : survive(q, req / s0));
              if (P > above) v += oppLevels[j][1] * (P - above) * V[r];
              above = P;
            }
          }
          if (v > best) best = v;
        });
        return best;
      };

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
        const bndT = oppLevels ? null : bound ? tablesOf(bound, stochastic) : boundT;
        const meanT = oppLevels || pairPts ? null : !stochastic ? bndT : skill ? tablesOf(skill, false) : meanNoSkill || (meanNoSkill = tablesOf(null, false));
        if (bound && th > -Infinity) {
          const vals = values(pt + maxSnapPoint, it + maxSnapItem);
          const pb = gl.map((_, g) => powBound(g, s));
          let ub = 0;
          if (oppLevels) for (const so of songList) ub += oppUb(so, bound, pb[so.g], vals);
          else songList.forEach((so, k) => (ub += valAt(bndT[k], vals, pb[so.g])));
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
        // With Just windows, each profile's mean pairs (and pairSum adds what it gives the members).
        const X = pairPts ? supportMeans(vs, allIdx) : null;
        const jd = X ? justDP(vs, (prof, only) => supportMeans(vs, allIdx, prof, only), jw.on ? loHi(X, supportMeans(vs, allIdx, jw.top(allCand, 5))) : null) : null;
        const dOf = new Map(); // profile -> jw.delta
        const gv = boostOf(vs);
        const pairsAt = (st) => {
          if (st.prof && !dOf.has(st.prof)) dOf.set(st.prof, jw.delta(st.prof, vs));
          return pairSum(vs, st.pick, allIdx, st.prof, st.prof ? dOf.get(st.prof) : null, gv);
        };
        for (const st of snapStates(G, snapPoint, snapItem, snaps.length, X, snapSlotCache, jd)) {
          const pb = pt + st.pt;
          const ib = it + st.it;
          const g = st.power;
          if (oppLevels) {
            const V = values(pb, ib);
            let x = skill;
            if (pairPts) {
              x = pairsAt(st);
              if (skill) for (let c = 0; c < x.length; c++) x[c] += skill[c];
            }
            for (const ld of kept) {
              let sum = 0;
              for (let k = 0; k < nSongs; k++) sum += oppSong(songList[k], x, ld.f[songList[k].g] + g, V);
              if (!best || sum > best.sum || (sum === best.sum && g > best.g)) best = { sum, st, g, ld, pb, ib, x };
            }
            continue;
          }
          const vals = stochastic ? null : values(pb, ib);
          let T = meanT;
          if (pairPts) {
            const x = pairsAt(st);
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
        return { s, vs, best, meanT: best.T || tablesOf(best.x, false) };
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
          return deckOf(order, snapObjs, { ...v, power, pb: best.pb, ib: best.ib, prof: best.st.prof }, meanT[k], gl[so.g].music);
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
          deck.snapRough = !measuredPts;
        }
        justSummary(deck, perSong, best.st.prof);
        perSong.sort((a, b) => b.score - a.score || b.power - a.power);
        return { deck, perSong: perSong.map(withChartCandidates) };
      };
      const built = found.map(build);
      return {
        results: built.map((x) => x.deck),
        songs: input.compareSongs && built.length ? built[0].perSong : [],
        perSong: built.map((x) => x.perSong),
        random: true,
        rate,
        gekisou: bt ? gekisouOut(bt) : null,
        payoff: pay,
        ctx,
        stats: { sets: nSets, evaluated, groups: nG, songs: nSongs, ms: Date.now() - t0 },
      };
    }

    // Groups of one music type and tags (with pair rates the score objective's groups are single charts) are visited one
    // after another: their sets' power bounds, bins and best leaders are the same. Results keep the groups' order.
    const groupList = [...groups.values()];
    const firstOf = new Map();
    groupList.forEach((g, i) => firstOf.has(g.musicKey) || firstOf.set(g.musicKey, i));
    const visitOrder = groupList.map((_, i) => i).sort((a, b) => firstOf.get(groupList[a].musicKey) - firstOf.get(groupList[b].musicKey) || a - b);
    const foundBy = groupList.map(() => []);
    const songsBy = groupList.map(() => []);
    let lastMusic = null;
    let bMax = null;
    for (const gi of visitOrder) {
      const group = groupList[gi];
      const sameMusic = group.musicKey === lastMusic;
      lastMusic = group.musicKey;
      const music = group.music;
      const gc = group.charts;
      const { anySkill, maxSkill, setSkill, setBound, snapRates, profileKey, wk } = skillRates(gc);
      // The score objective with pair rates plays one chart per group: a pairing's rate is one number. Points with
      // Gekisou support skills bound a set by each member's best pairing and give each snap assignment a table of its own
      // (`px`, see pairTable). With Just windows on the chart (`wk`), refine bounds by the number of window snaps.
      const Xm = snapRates && scoreMode ? (g, prof = null) => snapRates(gc[0], g, prof) : null;
      const pairPoints = pairPts;
      const rt = rankTable(gc, anySkill ? maxSkill : null, stochastic);
      const gcIdx = Int32Array.from(gc, (c) => chartIdx.get(c));
      // A set's skill rates on gc for bounds: with pair rates each member's best pairing too.
      const boundSkill = (vs) => (pairPoints ? setBound(vs) : anySkill ? setSkill(vs) : null);
      const tables = (vs) => {
        const skill = anySkill ? setSkill(vs) : null;
        if (pairPoints) return { bound: rankTable(gc, setBound(vs), stochastic), mean: null, px: pairsOn(gc, gcIdx, skill) };
        return stochastic ? { bound: rankTable(gc, skill, true), mean: rankTable(gc, skill, false) } : { bound: rankTable(gc, skill), mean: null };
      };
      const fNo = Int32Array.from(allCand, (v) => slotF(m, v, [0, 0, 0], music, ctx));

      // Exact best leader F of set s (cached in bfF/bfL): simple leaders from LT, others exactly.
      if (!sameMusic) bfF.fill(-1);
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
      if (!sameMusic) {
        bMax = new Float64Array(B);
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
      }
      // Score mode bounds a set by its own skills (and each member's best snap pairing) on T's charts (choose's
      // arithmetic at the power bound).
      const gcIndex = new Map(gc.map((c, i) => [c, i]));
      const balancedRows = new Map(); // boost profile -> balance k -> member -> max_j(k*G + X)
      const balancedPairs = new Map(); // profile -> member -> non-dominated [G, max(0, X)] pairs on this chart
      const balanceStep = gc[0].perPower * 1e-7;
      const productBound = (so, bf, rate, profile) => {
        const mult = bf.f + so.g;
        // Quantisation only shares work; AM-GM is an upper bound at every positive k.
        const k = Math.round(rate / mult / balanceStep) * balanceStep;
        if (!(k > 0) || !Number.isFinite(k)) return Infinity;
        const key = profileKey(profile);
        if (!balancedRows.has(key)) balancedRows.set(key, new Map());
        const byK = balancedRows.get(key);
        if (!byK.has(k)) byK.set(k, new Map());
        const byV = byK.get(k);
        const xm = Xm(profile);
        if (!balancedPairs.has(key)) balancedPairs.set(key, new Map());
        const pairsByV = balancedPairs.get(key);
        let z = k * bf.f + gc[0].perPower + (anySkill ? setSkill(so.vs)[0] : 0);
        for (const v of so.vs) {
          if (!byV.has(v)) {
            if (!pairsByV.has(v)) {
              const g = Gm.get(v), x = xm.get(v);
              const pairs = [];
              let high = -Infinity;
              // Descending G: a previous pair with X >= this X dominates it for every positive k. This only
              // accelerates the bound's maximum; the actual snap assignment retains all snaps and its tie order.
              for (const j of snapPowerOrder.get(v)) {
                const gain = Math.max(0, x[j]);
                if (gain > high) { pairs.push([g[j], gain]); high = gain; }
              }
              pairsByV.set(v, pairs);
            }
            let best = 0;
            for (const [power, gain] of pairsByV.get(v)) best = Math.max(best, k * power + gain);
            byV.set(v, best);
          }
          z += byV.get(v);
        }
        const bound = z * z / (4 * k);
        return bound + Math.abs(bound) * 1e-9;
      };
      const ubOf = scoreMode
        ? (s, T) => {
            const so = setOf(s);
            const bf = bestF(s);
            const profile = Xm ? setBoost(s, so.vs) : undefined;
            const sk = anySkill ? setBound(so.vs, profile) : null;
            let r = 0;
            for (const c of T.charts) {
              const x = (c.perPower + (sk ? sk[gcIndex.get(c)] : 0)) * shares(c).mean;
              if (x > r) r = x;
            }
            const bound = (bf.f + so.g) * r;
            // The product bound plays no Just windows: refine bounds those.
            return Xm && !wk ? Math.min(bound, shares(gc[0]).mean * productBound(so, bf, gc[0].perPower + (sk ? sk[0] : 0), profile)) : bound;
          }
        : (s, T) => upperBound(setOf(s), bestF(s), T);
      const walk = scoreMode ? walkScore : bestFirst;
      // With pair rates (one chart per group), ubOf gives every member its best pairing; `refine` gives each snap to one
      // slot: a deck of power F + P scores share (F + P) (c + x), at most share (F c + the best assignment of
      // c G[i][j] + (F + Pmax) X[i][j]), Pmax the best snap per slot.
      // With Just windows (wk), the best of these over the number k of window snaps: the chart's rate and the members'
      // skills at most what the strongest k windows give (wk.dp, wk.ds), the pairs at most at the larger of no windows
      // and those, and exactly k slots holding window snaps (bestAssignmentK). As randomScoreSearch's refine, one k per
      // step, in the order of a cheap bound (assignmentBoundK on the linear weights).
      const refine = scoreMode && Xm
        ? (() => {
            const ctx = (s) => {
              const so = setOf(s);
              const bf = bestF(s);
              const g0 = setBoost(s, so.vs);
              return { so, bf, g0, mult: bf.f + so.g, x0: so.vs.map((v) => Xm(g0).get(v)), win: wk ? so.vs.map((v) => jw.winRow(v)) : null };
            };
            // c0 G + mult max(0, X) per slot, X at the larger of x0 and hi (a profile's rates, or null).
            // `out` (or null): rows to fill instead of new ones.
            const linearW = (so, x0, hi, c0, mult, out = null) => so.vs.map((v, i) => {
              const g = Gm.get(v);
              const x = x0[i];
              const y = hi ? hi.get(v) : x;
              const row = out ? out[i] : new Float64Array(snaps.length);
              for (let j = 0; j < row.length; j++) row[j] = c0 * g[j] + mult * Math.max(0, x[j], y[j]);
              return row;
            });
            const scratch = [0, 1, 2, 3, 4].map(() => new Float64Array(snaps.length));
            const sh = shares(gc[0]).mean;
            // Per step [k, c0, cheap bound] and its profile (null for k = 0).
            const start = (s) => {
              const { so, bf, g0, mult, x0, win } = ctx(s);
              const cBase = gc[0].perPower + (anySkill ? setSkill(so.vs)[0] : 0);
              const hosts = wk ? Math.min(wk.K, so.vs.filter((v) => wk.hostOf(v)).length) : 0;
              const cand = [];
              for (let kk = 0; kk <= hosts; kk++) {
                let c0 = cBase;
                let prof = null;
                if (kk > 0) {
                  const at = wk.setAt(so.vs, kk);
                  c0 += at.d[0];
                  prof = at.prof;
                }
                let ub = Infinity;
                if (wk) {
                  ub = sh * (bf.f * c0 + assignmentBoundK(linearW(so, x0, prof && Xm(g0, prof), c0, mult, scratch), snaps.length, win, kk));
                  if (ub === -Infinity) continue;
                }
                cand.push({ kk, c0, prof, ub });
              }
              cand.sort((a, b) => b.ub - a.ub);
              return { cand, i: 0, out: -Infinity };
            };
            const key = (r) => Math.max(r.out, r.i < r.cand.length ? r.cand[r.i].ub : -Infinity);
            const step = (s, r, th) => {
              const { kk, c0, prof, ub } = r.cand[r.i++];
              if (ub < Math.max(r.out, th)) return;
              const { so, bf, g0, mult, x0, win } = ctx(s);
              const nJ = snaps.length;
              const hi = prof && Xm(g0, prof);
              const xs = hi ? so.vs.map((v, i) => x0[i].map((x, j) => Math.max(x, hi.get(v)[j]))) : x0;
              const assign = (W) => (wk ? bestAssignmentK(W, nJ, win, kk) : bestAssignment(W, nJ));
              const W = linearW(so, x0, hi, c0, mult);
              const linear = bf.f * c0 + assign(W);
              if (linear === -Infinity || sh * linear < Math.max(r.out, th)) return;
              // The product bound above uses Pmax for every pairing's cross term P*X. AM-GM gives a tighter
              // bound without a Pareto DP: 4*k*(F+P)*(c+X) <= (k*(F+P)+c+X)^2. For fixed k>0 the expression
              // inside the square is linear in the assignment, so bestAssignment maximises it exactly.
              // Choose k near the deck's rate/power ratio; the inequality holds for any positive choice.
              let xMax = 0;
              for (const x of xs) xMax += Math.max(0, ...x);
              const k = (c0 + xMax) / mult;
              if (!(k > 0) || !Number.isFinite(k)) {
                r.out = Math.max(r.out, sh * linear);
                return;
              }
              so.vs.forEach((v, i) => {
                const g = Gm.get(v);
                const x = xs[i];
                for (let j = 0; j < nJ; j++) W[i][j] = k * g[j] + Math.max(0, x[j]);
              });
              if (wk) {
                const zc = k * bf.f + c0 + assignmentBoundK(W, nJ, win, kk);
                if (sh * Math.min(linear, (zc * zc) / (4 * k) * (1 + 1e-9)) < Math.max(r.out, th)) return;
              }
              const z = k * bf.f + c0 + assign(W);
              const product = z * z / (4 * k);
              // Leave room for different floating-point summation orders at a score tie.
              r.out = Math.max(r.out, sh * Math.min(linear, product + Math.abs(product) * 1e-9));
            };
            return { start, step, key, done: (r) => r.i >= r.cand.length };
          })()
        : null;

      const groupFound = [];
      let kth = -Infinity;
      // walkScore visits a set only when its own bound (ubOf) reaches the threshold.
      walk(rt, bMax, powBound, ubOf, () => (groupFound.length >= searchK ? kth : -Infinity), (s) => {
        const so = setOf(s);
        const bf = bestF(s);
        const t = anySkill || stochastic ? tables(so.vs) : { bound: rt, mean: null };
        if (!scoreMode && groupFound.length >= searchK && !canEnter(so, bf, t.bound, gc, boundSkill(so.vs), groupFound[searchK - 1])) return;
        const d = evaluate(so, bf, t.mean || t.bound, music, Xm, t.px, groupFound.length >= searchK ? kth - Math.abs(kth) * 1e-9 : -Infinity);
        if (!d) return;
        groupFound.push(d);
        groupFound.sort((a, b) => b.score - a.score || b.power - a.power);
        if (groupFound.length > searchK) groupFound.length = searchK;
        if (groupFound.length >= searchK) kth = groupFound[searchK - 1].score;
      }, refine);
      foundBy[gi].push(...groupFound);

      // Song comparison: the best deck of every song of the group, from the same leader terms. The set with the
      // highest bound gives a floor; only sets whose bound reaches it can beat it.
      if (input.compareSongs) {
        const bySong = new Map();
        gc.forEach((c, i) => {
          if (!bySong.has(c.musicId)) bySong.set(c.musicId, []);
          bySong.get(c.musicId).push(i);
        });
        for (const idx of bySong.values()) {
          // A group of one song (the score objective with pair rates: one chart per group): the group's walk found it.
          if (bySong.size === 1 && groupFound.length) {
            songsBy[gi].push(...groupFound.slice(0, songTopK));
            continue;
          }
          const list = idx.map((i) => gc[i]);
          const songIdx = Int32Array.from(idx, (i) => gcIdx[i]);
          const pick = (a) => Float64Array.from(idx, (i) => a[i]);
          const srt = rankTable(list, anySkill ? pick(maxSkill) : null, stochastic);
          const songTables = (vs) => {
            const sk = anySkill ? pick(setSkill(vs)) : null;
            if (pairPoints) return { bound: rankTable(list, pick(setBound(vs)), stochastic), mean: null, px: pairsOn(list, songIdx, sk) };
            if (stochastic) return { bound: rankTable(list, sk, true), mean: rankTable(list, sk, false) };
            const b = anySkill ? rankTable(list, sk) : srt;
            return { bound: b, mean: b };
          };
          const best = [];
          const threshold = () => best.length >= songTopK ? best[best.length - 1].score : -Infinity;
          walk(srt, bMax, powBound, ubOf, threshold, (s) => {
            const so = setOf(s);
            const bf = bestF(s);
            const ti = songTables(so.vs);
            if (!scoreMode && best.length >= songTopK) {
              const sk = boundSkill(so.vs);
              if (!canEnter(so, bf, ti.bound, list, sk && pick(sk), best[best.length - 1])) return;
            }
            const th = threshold();
            const d = evaluate(so, bf, ti.mean || ti.bound, music, Xm, ti.px, th - Math.abs(th) * 1e-9);
            if (!d) return;
            best.push(d);
            best.sort((a, b) => b.score - a.score || b.power - a.power);
            if (best.length > songTopK) best.length = songTopK;
          });
          songsBy[gi].push(...best);
        }
      }
    }
    const found = foundBy.flat();
    const songs = songsBy.flat();
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
    const songCandidates = [];
    if (songTopK > 1) {
      const kept = new Map();
      for (const d of songs) {
        const id = d.chart.musicId;
        if (!kept.has(id)) kept.set(id, new Set());
        const keys = kept.get(id);
        const key = d.members.map((v, i) => v.id + ":" + (d.snaps[i] ? d.snaps[i].id : "")).join(",");
        if (keys.size >= songTopK || keys.has(key)) continue;
        keys.add(key);
        songCandidates.push(withChartCandidates(d));
      }
    }
    // With one chart per group a song can appear once per difficulty: keep its best.
    if (snapSkill || songTopK > 1) {
      const seenSong = new Set();
      for (let i = 0; i < songs.length; i++) {
        if (seenSong.has(songs[i].chart.musicId)) songs.splice(i--, 1);
        else seenSong.add(songs[i].chart.musicId);
      }
    }
    const gekisou = bt ? gekisouOut(bt) : null;
    return { results, songs, ...(songTopK > 1 ? { songCandidates } : {}), rate, gekisou, payoff: pay, ctx,
      stats: { sets: nSets, evaluated, groups: groups.size, ms: Date.now() - t0 } };
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
   * ranges, Perfect elsewhere; rank 1 in every range). Format /2 gives the expectation over the lotteries' nominal
   * probabilities, each value an Estimate [center, radius] (the centers are kept), and the replay seeds apart; /1 gave
   * the results on the first published seeds, which `seeds` still reads (a cached copy):
   * {power, kinds, shapes: "gekisouSkillId:level" -> aptitude shape of member Gekisou skills (measured at level 5),
   *  supportShapes: "gekisouSupportSkillId:level" -> aptitude shape of snaps' Gekisou support skills (level 5),
   *  shapeList: [{id, source ("member" | "support"), mission, skill: [id, level]}] (a skill of each shape),
   *  byScore: scoreId -> {seeds: [{seed, score, scorePerfect, ranges: [[rangeScore, rangeScorePerfect, rankBonus, rankBonusPerfect]],
   *  weights, rangeWeights}] (/2: one entry, the expectation), replaySeeds (the seeds to replay it on), percents: rank bonus % per range at ranks 1..5, missions (the song's range missions: 1 COMBO,
   *  2 LUCK, 3 JUST), luck (whether a range is a LUCK one, whose lottery draws from the live's seed), apt: shape -> {tail, tailPerfect, ranges: [[rangeScore, rangeScorePerfect]]}
   *  (seed means of the increments), aptSupport: "shape:match" -> the same for a support shape, paired with a member
   *  that is (1) or is not (0) a target of its member condition (5000), justRanges: per range [Just notes, notes] of the
   *  Just play (0 Just notes outside the Just-count ranges), spans: per range [start, end] ms}}.
   * Plain data (structured-cloneable).
   */
  function battleFromMusicData(md) {
    const dk = md && md.deck;
    const out = {
      power: (dk && dk.model && dk.model.power) || 0, kinds: (dk && dk.kinds) || [], shapes: new Map(), supportShapes: new Map(), shapeList: [],
      byScore: new Map(),
    };
    if (!out.power) return out;
    for (const sh of (dk.gekisouAptitude && dk.gekisouAptitude.shapes) || []) {
      const to = sh.source === "member" ? out.shapes : sh.source === "support" ? out.supportShapes : null;
      if (!to) continue;
      for (const s of sh.skills) to.set(s.id + ":" + s.level, sh.id);
      // What Simulate.measureBattleChart plays for the shape: its first skill, at the level measured.
      if (sh.skills.length) out.shapeList.push({ id: sh.id, source: sh.source, mission: sh.mission, skill: [sh.skills[0].id, sh.skills[0].level] });
    }
    const inc = (v) => ({ tail: v.tail[0], tailPerfect: v.tailPerfect[0], ranges: v.ranges.map((r) => [r.rangeScore[0], r.rangeScorePerfect[0]]) });
    const est = (x) => (Array.isArray(x) ? x[0] : x);
    const rows = (a, depth) => a && a.map((x) => (x === null ? null : depth > 1 ? rows(x, depth - 1) : est(x)));
    for (const s of md.songs || []) {
      for (const c of s.charts || []) {
        const d = c.deck;
        const e = d && d.expectation;
        const seeds = !d ? null : e ? [{
          seed: (d.replaySeeds && d.replaySeeds[0]) || 0,
          score: est(e.score),
          scorePerfect: est(e.scorePerfect),
          ranges: e.ranges.map((r) => ({ rangeScore: est(r.rangeScore), rangeScorePerfect: est(r.rangeScorePerfect), rankBonus: est(r.rankBonus), rankBonusPerfect: est(r.rankBonusPerfect), justCount: r.justCount, maxCombo: r.maxCombo })),
          weights: rows(e.weights, 2),
          rangeWeights: rows(e.rangeWeights, 3),
        }] : d.seeds;
        if (!d || d.unplayable || !seeds || !seeds.length || !d.ranges || d.ranges.length !== 3) continue;
        const apt = new Map();
        const aptSupport = new Map();
        for (const v of (d.gekisouAptitude && d.gekisouAptitude.variants) || []) {
          if (v.bandMatch === null || v.bandMatch === undefined) apt.set(v.shape, inc(v));
          else aptSupport.set(v.shape + ":" + (v.bandMatch ? 1 : 0), inc(v));
        }
        out.byScore.set(c.scoreId, {
          seeds: seeds.map((x) => ({
            seed: x.seed || 0,
            score: x.score,
            scorePerfect: x.scorePerfect,
            ranges: x.ranges.map((r, i) => [r.rangeScore, r.rangeScorePerfect, r.rankBonus, r.rankBonusPerfect ?? Math.trunc((r.rangeScorePerfect * d.ranges[i].rankBonusPercent) / 100)]),
            weights: x.weights,
            rangeWeights: x.rangeWeights,
          })),
          replaySeeds: d.replaySeeds || seeds.map((x) => x.seed || 0),
          percents: d.ranges.map((r) => r.rankBonusPercents),
          missions: (s.gekisouMissions || []).slice(),
          luck: (s.gekisouMissions || []).includes(2),
          apt,
          aptSupport,
          justRanges: seeds[0].ranges.map((r) => [r.justCount || 0, r.maxCombo || 0]),
          spans: d.ranges.map((r) => [r.startMs || 0, r.endMs || 0]),
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
   * score at the Just rate over the Just play's, the range's justSegments with windows or null]]) what scales them.
   * `rank` may be a list of ranks (gekisouRanks with multi.auto): every rate above is linear in the ranges' bonus
   * percents, so the mean over those ranks is the rate at their mean percents (`rank` is then null and `ranks` the list).
   * `prof` (justProfile, or null): a deck's Just windows. Each JUST range then plays at its mean Just rate over time
   * (justTimeline; the part of the score difference outside the ranges at the ranges' mean, weighted by their
   * difference), and the per-Just stacks count the Justs as they come (justRanges' fourth entry: justSegments).
   * `only` (a Set of scoreIds, or null): the charts to compute.
   */
  function battleRates(battle, rank, justRate, prof = null, only = null) {
    const ranks = Array.isArray(rank) ? rank.map((x) => Math.min(5, Math.max(1, Math.round(x)))) : null;
    const r = ranks ? null : Math.min(5, Math.max(1, Math.round(rank || 1)));
    const pctOf = (row) => (ranks ? ranks.reduce((a, x) => a + row[x - 1], 0) / ranks.length : row[r - 1]);
    const j = Math.min(1, Math.max(0, justRate ?? 1));
    const timeline = prof ? justTimeline(prof, j) : null;
    const P = battle.power;
    const nk = battle.kinds.length;
    const perPower = new Map();
    const weights = new Map();
    const apt = new Map();
    const aptSupport = new Map();
    const aptSupportJust = new Map();
    const justRanges = new Map();
    for (const [sid, b] of battle.byScore) {
      if (only && !only.has(sid)) continue;
      const p = b.percents.map((row) => [row[0], pctOf(row)]);
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
      // Per range the Just rate (with windows, the JUST ranges' mean over time), and outside the ranges their mean.
      const segs = timeline && timeline.length && b.spans
        ? b.missions.map((ms, i) => (ms === 3 && b.spans[i] ? justSegments(timeline, j, b.spans[i][1] - b.spans[i][0]) : null))
        : null;
      const jr = [0, 1, 2].map((i) => (segs && segs[i] ? segmentMean(segs[i]) : j));
      let jt = j;
      if (segs) {
        let dd = 0;
        let dj = 0;
        rs.forEach((x, i) => {
          dd += x - rsP[i];
          dj += jr[i] * (x - rsP[i]);
        });
        if (dd > 0) jt = dj / dd;
      }
      const js = rs.map((x, i) => (x > 0 ? (rsP[i] + jr[i] * (x - rsP[i])) / x : 1));
      for (const s of b.seeds) {
        let sc = s.score;
        let sp = s.scorePerfect;
        // The measured rank-1 bonus, replaced at another rank by the range's score × its percent, truncated as the game
        // does when the score is one play's (an integer); an expectation's truncation is not the expected truncation.
        const bonus = (x, pct) => (Number.isInteger(x) ? Math.trunc((x * pct) / 100) : (x * pct) / 100);
        const d = [0, 0, 0];
        s.ranges.forEach(([rs, rsP, rb, rbP], i) => {
          if (p[i][1] !== p[i][0]) {
            sc += bonus(rs, p[i][1]) - rb;
            sp += bonus(rsP, p[i][1]) - rbP;
          }
          if (segs) d[i] = rs - rsP + (p[i][1] !== p[i][0] ? bonus(rs, p[i][1]) - bonus(rsP, p[i][1]) : rb - rbP);
        });
        if (!segs) base += sp + j * (sc - sp);
        else base += sp + jr[0] * d[0] + jr[1] * d[1] + jr[2] * d[2] + jt * (sc - sp - d[0] - d[1] - d[2]);
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
        tail: (a.tailPerfect + jt * (a.tail - a.tailPerfect)) / P,
        ranges: a.ranges.map(([rs, rsP], i) => ((rsP + jr[i] * (rs - rsP)) * (1 + p[i][1] / 100)) / P),
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
      if (b.justRanges) justRanges.set(sid, b.justRanges.map(([J, n], i) => [J, n, js[i], segs ? segs[i] : null]));
    }
    return { rank: r, ranks, justRate: j, prof, perPower, weights, apt, aptSupport, aptSupportJust, justRanges, memo: new Map() };
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
  const levelRatios = new WeakMap(); // master -> "id:level" -> ratio
  function gekisouSupportLevelRatio(m, id, level) {
    if (!levelRatios.has(m)) levelRatios.set(m, new Map());
    const memo = levelRatios.get(m);
    const k = id + ":" + level;
    if (!memo.has(k)) memo.set(k, levelRatioOf(m, id, level));
    return memo.get(k);
  }
  function levelRatioOf(m, id, level) {
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
   * (gekisouSupportJustStack) counting the Justs judged so far, the current note's included. `j` may be justSegments
   * instead (Just windows): each Just note adds the rate at its share of the range's time, and is judged Just when the
   * sum passes a whole number.
   */
  // justStackShare at Just rate 1, which every Just profile's support gains divide by.
  const allJustShares = new Map();
  function justStackShareAll(J, n, st) {
    const k = J + "|" + n + "|" + st.value + "|" + st.cap + "|" + st.per + "|" + st.steps;
    if (!allJustShares.has(k)) allJustShares.set(k, justStackShare(J, n, 1, st));
    return allJustShares.get(k);
  }
  function justStackShare(J, n, j, st) {
    if (!(J > 0) || !(n > 0)) return 0;
    const segs = typeof j === "number" ? null : j;
    let sum = 0;
    let k = 0;
    let justs = 0;
    let acc = 0;
    let si = 0;
    for (let i = 1; i <= n; i++) {
      if (Math.floor((i * J) / n) > Math.floor(((i - 1) * J) / n)) {
        k++;
        if (segs) {
          const u = (i - 0.5) / n;
          while (si < segs.length - 1 && u >= segs[si][0]) si++;
          const before = acc;
          acc += segs[si][1];
          if (Math.floor(acc + 1e-9) > Math.floor(before + 1e-9)) justs++;
        } else if (Math.floor(k * j) > Math.floor((k - 1) * j)) justs++;
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
            const [J, n, sj, seg] = jr[i];
            const f1 = st1 ? justStackShareAll(J, n, st1) : 0;
            x1 += y;
            if (f1 > 0) x += (y * sj * justStackShare(J, n, seg || bt.justRate, stack)) / f1;
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

  // Just windows. A note is judged Just within ±2 ms of its time (MasterLiveJudgementTiming; Perfect ±50 ms), so the
  // player's Just rate is an input (multi.justRate). Gekisou support skills of effect 4004 widen the Just window by `f`
  // times its base half-width when a JUST range starts, for 2–5 s (levels 1–4) or while the range plays (level 5). The
  // replay judges notes as it is told, so a window only changes how many Justs the player hits: with a timing error
  // spread like a centred normal one, a player hitting Just at rate j0 hits it at erf((1 + F) erfinv(j0)) with the
  // window 1 + F times as wide (about (1 + F) j0 at low rates). That is an assumption about the player.

  /** erf(x), within 1.2e-7 (Numerical Recipes' erfc). */
  function erf(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? 1 - r : r - 1;
  }

  /** The inverse of erf on (-1, 1): Winitzki's approximation, then Newton steps. */
  function erfinv(y) {
    const a = 0.147;
    const l = Math.log(1 - y * y);
    const b = 2 / (Math.PI * a) + l / 2;
    let x = Math.sign(y) * Math.sqrt(Math.sqrt(b * b - l / a) - b);
    for (let i = 0; i < 3; i++) x -= (erf(x) - y) / ((2 / Math.sqrt(Math.PI)) * Math.exp(-x * x));
    return x;
  }

  /** The Just rate of a player who hits Just at rate `j0` when the Just window is 1 + F times as wide (see above). */
  function widenedJustRate(j0, F) {
    if (!(F > 0) || !(j0 > 0)) return j0;
    if (j0 >= 1) return 1;
    return Math.min(1, Math.max(j0, erf((1 + F) * erfinv(j0))));
  }

  /**
   * The Just windows of Gekisou support skill `id` at `level`: {rows: [{f (the window's widening: the effect value /
   * 10000 of its base half-width), sec (seconds from a JUST range's start; Infinity: while the range plays), e (the effect
   * row, whose member conditions decide whether it acts)}], unknown: [effect rows of type 4004 that are not such a window
   * (another trigger, target or condition), which skillGaps lists]}.
   */
  function justWindowRows(m, id, level) {
    const cache = m.justWindowCache || (m.justWindowCache = new Map());
    const key = id + ":" + level;
    if (cache.has(key)) return cache.get(key);
    const out = { rows: [], unknown: [] };
    for (const e of m.gekisouSupportSkillEffects.get(key) || []) {
      if (e._skillEffectType !== 4004) continue;
      const sets = m.conditionSets.get(e._skillTriggerConditionGroup) || [];
      const c = sets.length === 1 && sets[0]._conditionIds.length === 1 ? m.skillConditions.get(sets[0]._conditionIds[0]) : null;
      const range = c && (c._conditionTargetIDs || []).length === 1 && m.skillTargets.get(c._conditionTargetIDs[0]);
      const target = m.skillTargets.get((e._skillTargetIDs || [])[0]);
      // Only member conditions (5000) may hold the row back.
      const memberOnly = (m.conditionSets.get(e._skillConditionGroup) || []).every((cs) =>
        cs._conditionIds.every((cid) => (m.skillConditions.get(cid) || {})._conditionType === 5000));
      let sec = null;
      if (c && c._isPositive && range && range._gekisouMissionType === 3 && !(e._skillReleaseConditionGroup > 0)) {
        if (c._conditionType === 7010 && e._skillTriggerType === 1 && e._activationTimeSecond > 0) sec = e._activationTimeSecond;
        else if (c._conditionType === 7020 && e._skillTriggerType === 2 && !(e._activationTimeSecond > 0)) sec = Infinity;
      }
      // The first target sets the lowest judgement widened (ournotes-deck RELAX_TARGET_JUDGEMENTS): Just only.
      if (sec !== null && target && target._judgement === 6 && memberOnly && e._effectValue > 0) out.rows.push({ f: e._effectValue / 10000, sec, e });
      else out.unknown.push(e);
    }
    cache.set(key, out);
    return out;
  }

  /**
   * The Just windows snap view `s` gives beside member view `v` ([{f, sec}], justWindowRows): none beside a member
   * without a Gekisou skill, as the client builds support skills only beside one.
   */
  function justWindowsOf(m, v, s) {
    const out = [];
    if (!v || !v.gekisouSkillId || !s) return out;
    for (const [id, level] of s.gekisouSupportSkills || []) {
      for (const w of justWindowRows(m, id, level).rows) if (snapRowHolds(m, v, w.e)) out.push({ f: w.f, sec: w.sec });
    }
    return out;
  }

  /**
   * A deck's Just windows ([{f, sec}] or [[sec, f]]) as one profile, or null without any: {key, wins: [[sec, f]], longest
   * first}. Every window starts with the range, so a profile is all that the Just rates depend on.
   */
  function justProfile(wins) {
    if (!wins || !wins.length) return null;
    const ws = wins.map((w) => (Array.isArray(w) ? w.slice() : [w.sec, w.f])).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    return { key: ws.map(([sec, f]) => sec + ":" + f).join(","), wins: ws };
  }

  /** The Just profile of a deck: member views and snap views (or null) slot by slot. */
  function deckJustProfile(m, members, snaps) {
    const wins = [];
    members.forEach((v, i) => wins.push(...justWindowsOf(m, v, snaps[i])));
    return justProfile(wins);
  }

  /**
   * The Just rate through each JUST range of a deck of Just profile `prof` (justProfile) for a player of Just rate `j0`:
   * [[untilMs, rate]] by the time since the range started (increasing untilMs; a window lasting while the range plays
   * ends at 1e9), j0 after the last. Empty without windows. Simulate.gekisouRequest takes it as `justBoost`.
   */
  function justTimeline(prof, j0) {
    const out = [];
    if (!prof) return out;
    for (const cut of [...new Set(prof.wins.map(([sec]) => sec))].sort((a, b) => a - b)) {
      let F = 0;
      for (const [sec, f] of prof.wins) if (sec >= cut) F += f;
      out.push([Number.isFinite(cut) ? cut * 1000 : 1e9, widenedJustRate(j0, F)]);
    }
    return out;
  }

  /**
   * Simulate.gekisouRequest's justBoost for a search's deck (its `justWindows`) and a player of Just rate `j0`: [] without
   * windows.
   */
  function deckJustBoost(deck, j0) {
    const ws = (deck && deck.justWindows) || [];
    return justTimeline(justProfile(ws.map((w) => [w.sec === null ? Infinity : w.sec, w.f])), j0);
  }

  /**
   * A justTimeline over a range of `span` ms as [[end, rate]] by the share of the range's time (notes spread evenly):
   * increasing ends, the last 1.
   */
  function justSegments(timeline, j0, span) {
    const out = [];
    for (const [until, r] of timeline) {
      const e = span > 0 ? Math.min(1, until / span) : 1;
      out.push([e, r]);
      if (e >= 1) return out;
    }
    out.push([1, j0]);
    return out;
  }

  /** The mean rate of justSegments. */
  function segmentMean(segs) {
    let a = 0;
    let prev = 0;
    for (const [e, r] of segs) {
      a += (e - prev) * r;
      prev = e;
    }
    return a;
  }

  // Retained as a gauge-skill flag and, for 11003, the relative full-LIFE activation chance between levels.
  // It is not a strength ordering between different skills; luckGaugeBoost uses their chart measurements.
  const LUCK_GAUGE_CHANCE = 0.5;

  /**
   * The LUCK gauge Gekisou skill `id` at `level` (1 = gauge accumulation up, 11001; the LIFE version,
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
   * Approximate share the deck's gauge skills add to RUSH support gains, using music-data's per-chart expectations.
   * A pure gauge skill's own score gain is the extra RUSH exposure times the game's native RUSH score bonus. A
   * reference RUSH support gain / its effect value gives the original exposure. Their ratio estimates the extra
   * share, including this rank's range bonuses. Native and support activation frames differ, so this remains an
   * estimate; final deck comparisons use replay. Taking the largest single avoids adding overlapping gauge gains.
   * Lower levels use the LIFE probability ratio (11003) or the top-level exposure (11001). The latter approximates
   * the shorter activation window. Single-seed member level factors are too noisy to scale RUSH interactions.
   */
  function luckGaugeBoost(m, battle, bt, members, scoreId) {
    const b = battle && battle.byScore.get(scoreId);
    if (!b || !b.luck) return 0;
    const scaleKey = "luck-scale|" + scoreId;
    if (!bt.memo.has(scaleKey)) {
      const native = Number(m.t.MasterLiveSettings.find((r) => r._key === "gekisou_luck_rush_score_bonus_percent")?._value) / 100;
      let scale = 0;
      if (native > 0) for (const [id] of m.gekisouSupportSkills) {
        if (gekisouSupportKind(m, id) !== "rush") continue;
        const top = m.gekisouSupportSkillMaxLevel.get(id) || 1;
        const shape = battle.supportShapes.get(id + ":" + top);
        const gain = bt.aptSupport.get(scoreId)?.get(shape + ":0");
        if (!(gain > 0)) continue;
        let value = 0;
        for (const e of m.gekisouSupportSkillEffects.get(id + ":" + top) || []) {
          const conditions = (m.conditionSets.get(e._skillConditionGroup) || []).flatMap((cs) => cs._conditionIds.map((cid) => m.skillConditions.get(cid)));
          if (!conditions.some((c) => c && c._conditionType === 5000 && c._isPositive)) value += e._effectValue / 10000;
        }
        if (value > 0) { scale = value / native / gain; break; }
      }
      bt.memo.set(scaleKey, scale);
    }
    const scale = bt.memo.get(scaleKey);
    if (!scale) return 0;
    let best = 0;
    for (const v of members) {
      if (!v.luckGauge) continue;
      const id = v.gekisouSkillId, level = v.gekisouSkillLevel;
      const top = m.gekisouSkillMaxLevel.get(id) || 1;
      const effects = m.gekisouSkillEffects.get(id + ":" + top) || [];
      // Only a pure gauge gain can be attributed to RUSH exposure.
      if (!effects.length || effects.some((e) => e._skillEffectType !== 11001 && e._skillEffectType !== 11003)) continue;
      const factor = level >= top ? 1 : v.luckGauge / luckGaugeOf(m, id, top);
      const a = bt.apt.get(scoreId)?.get(battle.shapes.get(id + ":" + top));
      if (a) best = Math.max(best, factor * (a.tail + a.ranges.reduce((s, x) => s + x, 0)) * scale);
    }
    return best;
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

  // ---------------------------------------------------------------------------------------------------------------
  // 激奏舞台 (撃奏アリーナ, from 1.1.0 on 2026-10-28)
  //
  // A ranked multiplayer live per band (a league): only that band's members (snaps from any band), a song drawn from
  // the ones the matched players picked among the band's songs, and a daily rule (MasterArenaLeagueRegulation, from
  // 4:00) that makes all three Gekisou ranges one mission and sets the song type the type bonus reads (99: every type).
  // Arena pt go by the place in the room (MasterBattleLivePlace, by the arena rank group and the room size), and the
  // Gekisou score decides the place, so decks are ranked by the expected Gekisou score. music-data measured each chart
  // with its own missions only, so the worker measures the pool's charts with the rule's mission on a replay whose
  // songs all play it (Simulate.patchMissions, Simulate.measureBattleChart) and searches with that `battle`.

  const inPeriod = (row, t) => parseTime(row._startAt) <= t && t <= parseTime(row._endAt);

  /**
   * The rule of league `leagueId` at `now`: {season, league, regulation, bandId, musicType, missions: [3 missions]},
   * or null outside a season or a regulation.
   */
  function arenaRule(m, leagueId, now) {
    const t = now || new Date();
    const season = m.t.MasterArenaSeason.find((r) => inPeriod(r, t)) || null;
    const league = m.t.MasterArenaLeague.find((r) => r._id === leagueId) || null;
    const regulation = m.t.MasterArenaLeagueRegulation.find((r) => r._leagueId === leagueId && inPeriod(r, t)) || null;
    if (!season || !league || !regulation) return null;
    return {
      season, league, regulation, bandId: league._bandId, musicType: regulation._liveMusicType,
      missions: [regulation._gekisouMission1, regulation._gekisouMission2, regulation._gekisouMission3],
    };
  }

  /** The songs of band `bandId` released by `now` (the songs its league plays), by id. */
  function arenaSongs(m, bandId, now) {
    const t = now || new Date();
    return m.t.MasterLiveMusic
      .filter((mu) => (mu._bandIDs || []).includes(bandId) && !(mu._startAt && parseTime(mu._startAt) > t))
      .map((mu) => mu._id)
      .sort((a, b) => a - b);
  }

  /** Arena pt of each place (1st first) in a room of `players` at arena rank group `matchRank` (1 新手 … 5 白金). */
  function arenaPlacePoints(m, matchRank, players) {
    return m.t.MasterBattleLivePlace
      .filter((r) => r._matchRank === matchRank && r._matchPlayers === players)
      .sort((a, b) => a._place - b._place)
      .map((r) => r._basePoint);
  }

  /**
   * The rank bonus percents [range][rank - 1] of three Gekisou missions (MasterLiveGekisouRankingScoreBonus rows of
   * their pattern: 1 all the same, 2 all different, 3 otherwise; a later row wins), as nnnotes reads them.
   */
  function rankBonusPercents(m, missions) {
    const [a, b, c] = missions;
    const pattern = !(a && b && c) ? 0 : a === b ? (a === c ? 1 : 3) : b !== c && a !== c ? 2 : 3;
    const out = [0, 1, 2].map(() => [0, 0, 0, 0, 0]);
    for (const r of m.t.MasterLiveGekisouRankingScoreBonus) {
      const i = r._count - 1;
      const k = r._rank - 1;
      if (r._missionPattern === pattern && i >= 0 && i < 3 && k >= 0 && k < 5) out[i][k] = r._scoreBonusPercent;
    }
    return out;
  }

  /**
   * A search input (as for search) for 激奏舞台 from one with `arena` ({bandId, musicType, missions}) and `multi`
   * ({players, justRate, pickSong}): the band's members only, the band's songs (within input.musicIds), a public room's
   * random song (with multi.pickSong each song's own deck) with every rank of the room averaged, scored by the expected
   * Gekisou score. `battle` must be the arena's (measured with the rule's missions).
   */
  function arenaInput(input) {
    const m = input.master;
    const a = input.arena;
    const bandOf = (id) => {
      const c = m.memberCards.get(Number(id));
      const ch = c && m.characters.get(c._characterID);
      return ch ? ch._bandID : 0;
    };
    const pool = arenaSongs(m, a.bandId, input.now);
    const multi = input.multi || {};
    return {
      ...input,
      mode: "normal",
      objective: "score",
      members: input.members.filter((o) => bandOf(o.id) === a.bandId),
      musicIds: input.musicIds && input.musicIds.length ? pool.filter((id) => input.musicIds.includes(id)) : pool,
      multi: { ...multi, players: Math.min(5, Math.max(2, multi.players || 5)), auto: true, othersScore: 0 },
      perMinute: null,
    };
  }

  // Ids of the live skills Simulate.patchDeck adds to the replay's master, one per music-data kind (PROBE_SKILL + kind id).
  const PROBE_SKILL = 90000;

  /**
   * The live skills to measure music-data's kinds with (Simulate.measureBattleChart): many kinds occur only in
   * skills of several effect rows, so each is a skill of its own with one row of the kind at its largest value. Per
   * kind {q (its id), skill: [liveSkillId, 1], f (skillFactor of the value), row (MasterLiveSkillEffect fields)}.
   */
  function kindProbes(kinds) {
    return kinds.map((k) => {
      const value = Math.max(...k.values);
      return {
        q: k.id,
        skill: [PROBE_SKILL + k.id, 1],
        f: skillFactor(k.effectType, value),
        row: {
          _id: PROBE_SKILL + k.id, _liveSkillID: PROBE_SKILL + k.id, _level: 1, _skillConditionGroup: k.skillConditionGroup,
          _skillReleaseConditionGroup: k.skillReleaseConditionGroup, _skillTargetIDs: k.skillTargetIds || [], _skillEffectType: k.effectType,
          _activationTimeSecond: k.activationTimeSecond, _effectValue: value, _maxEffectValue: 0, _effectLimitCount: k.effectLimitCount,
          _skillCumulativeConditionID: 0, _effectExecuteLimitCount: k.effectExecuteLimitCount,
          _effectExecuteLimitResetConditionGroup: k.effectExecuteLimitResetConditionGroup,
        },
      };
    });
  }

  /**
   * The expected payoff of a multiplayer normal live (input as for search: master, event, boosts, objective, cpValue,
   * accuracy, multi) on `chart` (a charts() entry) when the player's all-Perfect score is `score` and the deck's
   * bonuses are pb/ib: {points, items, cp, sc (what the search ranks by), rankDist: [[rank, p]]}. The play keeps a share
   * of the score as playShares; the room's rank adds multi.othersScore, or with multi.auto each of opponentLevels (E counts as D, as in the search).
   */
  /**
   * A deck's event bonuses {point, item} for `event` (members and snaps as views, snaps may be null), as the search sums
   * them; null outside the event's period. 激奏舞台 ranks by score with the bonuses zeroed, but pays event pt by the room.
   */
  function deckEventBonus(m, event, player, members, snaps, now) {
    if (!event || now < parseTime(event._startAt) || now > parseTime(event._endAt)) return null;
    const sn = snaps.filter(Boolean);
    const ctx = makeContext(m, player || {}, event._id, members, sn, "normal");
    const out = { point: 0, item: 0 };
    for (const b of [...members.map((v) => ctx.memberBonus.get(v)), ...sn.map((s) => ctx.snapBonus.get(s))]) {
      out.point += b.point;
      out.item += b.item;
    }
    return out;
  }

  function roomPayoff(input, chart, score, pb, ib) {
    const m = input.master;
    const multi = input.multi;
    const pay = payoff(m, input.event, "normal");
    const rate = boostRate(m, "normal", input.boosts || 0);
    const W = input.objective === "items" ? { point: 1, item: 1e6 } : { point: 1e6, item: 1 };
    const dist = new Map();
    const plays = playShares(m, chart.scoreId, input.accuracy || null);
    for (const [others, w] of opponentLevels(multi)) {
      const th = chart.battle
        .map(([r, base]) => [Math.max(r, 2), Math.max(0, battleRequiredScore(base, multi.players) - others)])
        .sort((a, b) => a[1] - b[1]);
      const lowest = Math.min(...th.map((x) => x[0]));
      for (const [x, p] of plays) {
        const r = scoreRankOf(th, score * x) || lowest;
        dist.set(r, (dist.get(r) || 0) + w * p);
      }
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
   * member that does (`match` 1) or does not meet the support skill's member condition. Singles retain the replay
   * measurement; combinations use the chart's count/score timeline, including thresholds, duration and ramp caps.
   * The bound `s` is independent of the owned skills; it is never used to combine their gains.
   */
  const comboTimelineCache = new WeakMap();
  function comboCountBoost(cb, keys, match) {
    if (!keys.length) return 0;
    if (keys.length === 1) return (cb.b.get(keys[0]) || [0, 0])[match];
    const tl = cb.timeline;
    if (!(tl.base[match] > 0)) return 0;
    if (!comboTimelineCache.has(tl)) comboTimelineCache.set(tl, new Map());
    const cache = comboTimelineCache.get(tl), key = keys.slice().sort().join(",");
    if (!cache.has(key)) cache.set(key, comboTimelineGain(tl, keys).map((gain, i) => tl.base[i] > 0 ? Math.max(0, gain / tl.base[i] - 1) : 0));
    return cache.get(key)[match];
  }

  // Full-Perfect COMBO timeline. Counts are shared by the deck; gated rows read the previous play frame.
  // A lone threshold backdates its bonus to the last judgement; an AND condition (GK18/19's LIFE) does not.
  // Score COMBO reads the previous 40 ms score frame. Per-note score flooring is left to the full replay.
  function comboTimelineGain(tl, keys, match) {
    const rows = keys.flatMap((k) => tl.rows.get(k) || []);
    const gains = [0, 0];
    for (const r of tl.ranges) {
      const starts = new Float64Array(rows.length).fill(Infinity);
      const counts = new Float64Array(r.notes.length);
      const steps = [];
      let count = 0, n = 0, lastSupportCount = 0;
      for (const f of r.frames) {
        // All threshold conditions read the same state before this frame's count recalculation.
        const before = count;
        let added = 0;
        for (let k = 0; k < rows.length; k++) {
          const row = rows[k];
          if (starts[k] === Infinity && before >= row.threshold) {
            starts[k] = row.backdate ? (row.threshold > 0 && n ? r.notes[n - 1].time : r.start) : f.time;
            if (row.backdate && row.threshold > 0 && n) added += row.value;
          }
        }
        // The support ramp reads before the recount, even when a member's gate opens in this frame.
        if (before !== lastSupportCount) { steps.push([f.time, before]); lastSupportCount = before; }
        if (added) { count += added; counts[n - 1] = count; }
        for (const note of f.notes) {
          let active = 0;
          for (let k = 0; k < rows.length; k++) if (note.time >= starts[k] && (!rows[k].duration || note.time < starts[k] + rows[k].duration)) active += rows[k].value;
          count += 1 + active;
          counts[n++] = count;
        }
      }
      let p = 0, q = 0;
      for (const note of r.notes) {
        while (p < r.notes.length && r.notes[p].time <= note.cutoff) p++;
        while (q < steps.length && steps[q][0] <= note.time) q++;
        const c = p ? counts[p - 1] : 0;
        let factor = 1;
        for (const [threshold, value] of tl.combo) { if (threshold > c) break; factor = value; }
        for (let i = 0; i < 2; i++) {
          const sup = tl.support[i], count = q ? steps[q - 1][1] : 0;
          gains[i] += note.weight * factor * Math.min(sup.max, Math.floor(count / sup.unit) * sup.value);
        }
      }
    }
    return match === undefined ? gains : gains[match];
  }

  const api = {
    TABLES, RANK_NAMES, buildMaster, memberView, snapView, plainDeck,memberLimits, snapLimit, makeContext, deckPower,
    leaderBonuses, cardEventBonus, eventEffects, describeEventBonus, payoff, boostRate, eventPoints, eventItems,
    charts, rankThresholds, battleThresholds, battleRequiredScore, scoreRankOf, search, planEvent, currentEvent, perPowerFromMusicData, chartLengthsFromMusicData, musicView,
    parseTime, comboBreakFactors, playShares, accuracyFactor, shareQuantiles, skillWeightsFromMusicData, skillFactor, skillKindOf, liveSkillTerms, liveSkillRate,
    battleFromMusicData, battleRates, gekisouSkillRate, gekisouSupportMatch, gekisouSupportLevelRatio, gekisouSupportTerms, comboScope,
    gekisouSupportRate, gekisouSupportJustStack, justStackShare, widenedJustRate, justWindowRows, justWindowsOf, justProfile,
    deckJustProfile, justTimeline, deckJustBoost, justSegments, snapSkillKey, snapSkillClass, skillGaps, scoreScope, roughSnapRate,
    luckGaugeOf, luckGaugeBoost, gekisouSupportKind, comboCountOf, comboCountBoost, comboTimelineGain, gekisouSongType, gekisouSongGroups, roomPayoff, opponentLevels, gekisouRanks, gekisouKey, gekisouOut, OPPONENT_RANGE,
    arenaRule, arenaSongs, arenaPlacePoints, rankBonusPercents, arenaInput, kindProbes, deckEventBonus,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== "undefined" ? self : this);
