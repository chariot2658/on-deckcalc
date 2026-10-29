/*
 * Exact live score of a deck from ournotes-deck's whole-live simulation: the replay WASM that nnnotes publishes beside
 * music-data.json (`replay` pointer). It plays live skills and snap skills, every judged note Perfect, with Gekisou off
 * (solo lives) or, for a multiplayer live, on: Just inside the Just-count ranges at a given rate, a fixed rank in every
 * range, and the members' Gekisou skills and the snaps' Gekisou support skills.
 *
 * The client shuffles the performance order at the start of every live, so a deck has 120 possible scores. Each
 * member's skills add the same amount at a given position whatever the others do (checked on real decks), so the 120
 * scores come from 1 + 25 runs: no skills, and each member alone at each position. One full order is run as a check;
 * when it disagrees, all 120 orders are run.
 */
(function (root) {
  "use strict";

  const FPS = 60;

  function permutations(n) {
    const out = [];
    const go = (a, rest) => {
      if (!rest.length) out.push(a);
      rest.forEach((x, i) => go(a.concat([x]), rest.filter((_, j) => j !== i)));
    };
    go([], [...Array(n).keys()]);
    return out;
  }
  const ORDERS = permutations(5);

  /**
   * Replay performers of a deck: members [{id, skillLevel, gekisouSkillLevel}], snaps [{id, rank} | null], slot by
   * slot. Snap skill levels (and Gekisou support skill levels) follow the snap's rank (MasterSupportCardRank), as in
   * ournotes-deck cards.rs. The Gekisou fields are read only by a live with Gekisou on.
   */
  function performers(m, members, snaps) {
    return members.map((o, i) => {
      const c = m.memberCards.get(o.id);
      const ch = c && m.characters.get(c._characterID);
      const live = c && m.liveSkills.get(c._liveSkillID);
      const maxLv = (c && m.liveSkillMaxLevel.get(c._liveSkillID)) || 1;
      const sn = snaps[i];
      const s = sn && m.snaps.get(sn.id);
      const rk = s && m.supportRank.get(s._supportCardRankGroup + ":" + (sn.rank || 1));
      const support = [];
      const gkSupport = [];
      if (s && rk) {
        if (s._supportSkillId01) support.push([s._supportSkillId01, rk._supportSkill01Level]);
        if (s._supportSkillId02) support.push([s._supportSkillId02, rk._supportSkill02Level]);
        if (s._gekisouSupportSkillId01) gkSupport.push([s._gekisouSupportSkillId01, rk._gekisouSupportSkill01Level]);
        if (s._gekisouSupportSkillId02) gkSupport.push([s._gekisouSupportSkillId02, rk._gekisouSupportSkill02Level]);
      }
      const gk = c && c._gekisouSkillID ? m.gekisouSkills.get(c._gekisouSkillID) : null;
      const gkMax = (gk && m.gekisouSkillMaxLevel.get(gk._id)) || 1;
      return {
        liveSkill: c && c._liveSkillID ? [c._liveSkillID, Math.min(maxLv, Math.max(1, o.skillLevel || 1))] : null,
        supportSkills: support,
        bandId: ch ? ch._bandID : 0,
        characterId: c ? c._characterID : 0,
        cardType: c ? c._cardType : 0,
        tagIds: (c && c._bestMusicTagIDs) || [],
        liveSkillCategories: (live && live._skillCategories) || [],
        gekisouSkillCategories: (gk && gk._skillCategories) || [],
        gekisouMissionType: gk ? gk._gekisouMissionType : 0,
        gekisouSkill: gk ? [gk._id, Math.min(gkMax, Math.max(1, o.gekisouSkillLevel || 1))] : null,
        gekisouSupportSkills: gkSupport,
      };
    });
  }

  /**
   * A Gekisou play of a template (every judged note Perfect): in the Just-count ranges (the fevers whose mission is 3)
   * the notes that can be judged Just (`justTypes`, MasterLiveJudgementTiming) are judged Just at `justRate`, spread
   * evenly; the rank is fixed at `ranks` in the three ranges. Frames and fevers follow ournotes-deck JustRule.
   */
  function gekisouRequest(session, tpl, scoreId, gekisou) {
    const d = JSON.parse(session.describeChart(scoreId));
    const types = new Map(d.notes.map((n) => [n.noteId, n.judgementType]));
    const ranges = d.fevers.filter((_, i) => d.missions[i] === 3);
    const rate = Math.min(1, Math.max(0, gekisou.justRate ?? 1));
    let k = 0;
    const frames = tpl.frames.map((f) => {
      if (!f.judgements.length || !ranges.some(([s, e]) => f.timeMs >= s && f.timeMs < e)) return f;
      return {
        ...f,
        judgements: f.judgements.map((j) => {
          if (j.judgement !== 5 || !gekisou.justTypes.has(types.get(j.noteId))) return j;
          k++;
          return Math.floor(k * rate) > Math.floor((k - 1) * rate) ? { ...j, judgement: 6 } : j;
        }),
      };
    });
    return { ...tpl, frames, mode: { kind: "fixedSoloGekisou", ranks: gekisou.ranks }, seed: (gekisou.seeds && gekisou.seeds[0]) || 0 };
  }

  /**
   * gekisouRequest's `gekisou` for a search's Gekisou rank `gk` ({rank, ranks, justRate}: Engine.battleRates or a
   * search's `gekisou`) on a chart whose ranges give the bonus `percents` (Engine.battleFromMusicData: per range the
   * percent of each rank): every range at gk.rank, or with gk.ranks one play at the first of them, which scoreOf turns
   * into their mean (`mean`: per range the percents of those ranks). `seeds` as for orderScores.
   */
  function gekisouPlay(gk, percents, justTypes, seeds) {
    const r = gk.ranks ? gk.ranks[0] : gk.rank;
    const out = { ranks: [r, r, r], justRate: gk.justRate, justTypes };
    if (seeds) out.seeds = seeds;
    if (gk.ranks) {
      if (!percents) throw new Error("no rank bonus percents for the mean over ranks");
      out.mean = percents.map((row) => gk.ranks.map((x) => row[x - 1]));
    }
    return out;
  }

  /**
   * The score of a replay result `res`; with gekisou.mean (gekisouPlay) the mean over its ranks. A range's rank bonus is
   * its score times the rank's percent, truncated, and nothing else depends on the rank (gekisou.test.js checks it), so
   * one play gives every rank's score.
   */
  function scoreOf(res, gekisou) {
    if (!gekisou || !gekisou.mean) return res.score;
    let s = res.score;
    gekisou.mean.forEach((pcts, i) => {
      const x = res.ranges && res.ranges[i];
      if (!x) return;
      const range = x.endScore - x.startScore;
      s += pcts.reduce((a, p) => a + Math.trunc((range * p) / 100), 0) / pcts.length - x.rankBonus;
    });
    return s;
  }

  /**
   * The score of every performance order of a deck on a chart at `power`: {base (no skills), scores (ascending, one
   * per order), mean, exact (whether the additive scores were confirmed)}. null when the replay data lacks the chart.
   * `gekisou` ({ranks, justRate, justTypes, seeds}) plays a multiplayer live (gekisouRequest). Gekisou skills act
   * whatever the order, so they stay in `base`. Luck ranges draw from the live's seed: the first of `seeds` is played,
   * and every score is moved by the seed mean of the no-live-skill score minus its value on that seed.
   */
  function orderScores(session, scoreId, power, perf, gekisou) {
    let tpl;
    try {
      tpl = JSON.parse(session.template(scoreId, power, FPS));
      if (gekisou) tpl = gekisouRequest(session, tpl, scoreId, gekisou);
    } catch (e) {
      return null;
    }
    const run = (ps, order, seed) =>
      scoreOf(JSON.parse(session.run(JSON.stringify({ ...tpl, performers: ps, skillOrder: order, ...(seed === undefined ? {} : { seed }) }))), gekisou);
    const bare = (p) => ({ ...p, liveSkill: null, supportSkills: [] });
    let base = run(perf.map(bare), [0, 1, 2, 3, 4]);
    let shift = 0;
    if (gekisou && gekisou.seeds && gekisou.seeds.length > 1) {
      const others = gekisou.seeds.slice(1).map((sd) => run(perf.map(bare), [0, 1, 2, 3, 4], sd));
      shift = (others.reduce((a, b) => a + b, base) / gekisou.seeds.length) - base;
    }
    const gain = perf.map((p, i) => {
      if (!p.liveSkill && !p.supportSkills.length) return [0, 0, 0, 0, 0];
      const alone = perf.map((q, j) => (j === i ? q : bare(q)));
      return [0, 1, 2, 3, 4].map((k) => {
        const order = [0, 1, 2, 3, 4].filter((x) => x !== i);
        order.splice(k, 0, i);
        return run(alone, order) - base;
      });
    });
    const additive = (order) => order.reduce((s, i, k) => s + gain[i][k], base);
    let scores = ORDERS.map(additive);
    let exact = run(perf, ORDERS[0]) === scores[0];
    if (!exact) {
      scores = ORDERS.map((o) => run(perf, o));
      exact = true;
    }
    scores = scores.map((x) => x + shift).sort((a, b) => a - b);
    base += shift;
    return { base, scores, mean: scores.reduce((a, b) => a + b, 0) / scores.length, exact, gekisou: !!gekisou };
  }

  /**
   * Whole runs of chart `scoreId`: run(power, perf, order, seed) -> score (with Gekisou when `gekisou` is given, as
   * gekisouRequest; its seeds are not used). A chart's template differs by power only in its `power` field, so it is
   * built and serialised once.
   */
  function chartRunner(session, scoreId, gekisou) {
    let tpl = JSON.parse(session.template(scoreId, 1e6, FPS));
    if (gekisou) tpl = gekisouRequest(session, tpl, scoreId, gekisou);
    const { performers: _p, skillOrder: _o, seed: _s, power: _w, ...rest } = tpl;
    // ReplayFrame's serde decoder also accepts fields in declaration order: timeMs, deltaSeconds, judgements,
    // liveFinished. Trailing fields default to [] and false. Arrays avoid repeating field names at every 60 Hz tick
    // on every run, cutting JSON transfer/parsing without dropping frames or changing the binary32 clock.
    rest.frames = rest.frames.map((f) => {
      // A later replay may add/reorder fields. Its template exposes the declaration order; keep named fields then.
      const { judgements, liveFinished, ...named } = f;
      if (Object.keys(f).join(",") !== "timeMs,deltaSeconds,judgements,liveFinished") {
        if (judgements && judgements.length) named.judgements = judgements;
        if (liveFinished) named.liveFinished = true;
        return named;
      }
      const frame = [f.timeMs, f.deltaSeconds];
      if ((judgements && judgements.length) || liveFinished) frame.push(judgements || []);
      if (liveFinished) frame.push(true);
      return frame;
    });
    const body = JSON.stringify(rest).slice(0, -1);
    return (power, perf, order, seed) =>
      scoreOf(JSON.parse(session.run(`${body},"power":${power},"performers":${JSON.stringify(perf)},"skillOrder":${JSON.stringify(order)},"seed":${seed || 0}}`)), gekisou);
  }

  /**
   * The mean score of a deck over the performance orders (and the seeds of a chart with a LUCK range) from `runs` whole
   * runs of a chartRunner: run t plays the cyclic order shifted by t on seeds[t]. Five consecutive runs put every member
   * at every position once, which gives the mean over the 120 orders exactly when the members' gains add up (as
   * orderScores checks); a LUCK chart takes `runs` seeds (a multiple of 5), the same for every deck compared. `from`
   * skips the first runs (the mean of runs from..runs-1), to add runs to an earlier mean.
   */
  function meanScore(run, power, perf, seeds, runs, from = 0) {
    let sum = 0;
    for (let t = from; t < runs; t++) sum += run(power, perf, [0, 1, 2, 3, 4].map((i) => (i + t) % 5), seeds[t % seeds.length]);
    return sum / (runs - from);
  }

  // Keep individual runs for reuse across overlapping requests (ranking five runs, then showing ten, or the same
  // deck appearing in several comparisons). Callers sum the requested range in its original order, preserving the
  // rounding of meanScore, including when a previous mean is extended.
  function sampleScores(run, power, perf, seeds, runs, from = 0) {
    const out = [];
    for (let t = from; t < runs; t++) out.push(run(power, perf, [0, 1, 2, 3, 4].map((i) => (i + t) % 5), seeds[t % seeds.length]));
    return out;
  }

  /**
   * Snap skill score per unit of power of each kind of member/snap pairing on chart `scoreId`, for the score search
   * (Engine.search snapSkill; pairs from Engine.scoreScope: [{key, keys, member: {id, skillLevel}, snap: {id, rank}}],
   * the pairing measured for every key of `keys`, its class).
   * A pairing's gain at a performance position does not depend on the other slots, so five copies of it in one run
   * add up its gains at the five positions: (five copies with the snap - five without) / 5 / power is its mean over the
   * uniformly random order. Gekisou skills and Gekisou support skills are left out (the search adds the members' own;
   * the snaps' are left to orderScores). `gekisou` as for orderScores. Returns Map key -> rate; `progress(done, total)`
   * counts pairs.
   */
  function snapSkillRates(session, m, scoreId, pairs, gekisou, progress, power = 1e6) {
    return measureSnapJobs(session, scoreId, snapSkillJobs(m, pairs), gekisou, progress, power);
  }

  /** snapSkillRates in two steps, the second without the master data (worker helpers): each pair's performers. */
  function snapSkillJobs(m, pairs) {
    return pairs.map((pr) => {
      const p = { ...performers(m, [pr.member], [pr.snap])[0], gekisouSkill: null, gekisouSupportSkills: [] };
      // Members of one live skill score alike without snaps (the key's member part, Engine.snapSkillKey).
      const bare = { ...p, supportSkills: [] };
      return { keys: pr.keys || [pr.key], without: pr.memberKey || JSON.stringify(bare), p, bare };
    });
  }

  function measureSnapJobs(session, scoreId, jobs, gekisou, progress, power = 1e6) {
    const replay = chartRunner(session, scoreId, gekisou);
    const seed = (gekisou && gekisou.seeds && gekisou.seeds[0]) || 0;
    const run = (p) => replay(power, [p, p, p, p, p], [0, 1, 2, 3, 4], seed);
    const without = new Map(); // member side -> score of five copies without snap skills
    const out = new Map();
    jobs.forEach((job, i) => {
      if (!without.has(job.without)) without.set(job.without, run(job.bare));
      const r = (run(job.p) - without.get(job.without)) / 5 / power;
      for (const key of job.keys) out.set(key, r);
      if (progress) progress(i + 1, jobs.length);
    });
    return out;
  }

  /**
   * Level factors of member Gekisou skills for the search (Engine.gekisouSkillRate): music-data measured each skill at
   * its top level only, and a lower level changes trigger conditions or the activation time rather than a value. For
   * each [skillId, level] below the top: the simulated increment of the skill alone at that level over the increment at
   * the top level, summed over up to `sample` charts where the top level gains (spread over them), at rank `rank` in
   * every range and Just rate `justRate`, on each chart's first seed. Returns "skillId:level" -> factor (at least 0).
   * `bt` is Engine.battleRates(battle, rank, justRate). The ratio varies a lot by chart (Gekisou skill 4 Lv1: 0.15–0.43
   * on most charts, 0.28 over all 168 where it gains), so 6 charts were off by up to a quarter (0.21 on 2026-10-28's
   * charts) and some LUCK skills far more; 24 charts take about 4.6 s for the user's 17 lower levels (Node, 2026-10-29).
   */
  function gekisouLevelFactors(session, m, battle, bt, pairs, sample = 24) {
    const out = new Map();
    const empty = () => ({
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    });
    const reqs = new Map(); // scoreId -> [request, no-skill score]
    const request = (sid) => {
      if (!reqs.has(sid)) {
        const b = battle.byScore.get(sid);
        const gekisou = gekisouPlay(bt, b.percents, m.justTypes, [b.seeds[0].seed]);
        const tpl = gekisouRequest(session, JSON.parse(session.template(sid, battle.power, FPS)), sid, gekisou);
        const run = (perf) => scoreOf(JSON.parse(session.run(JSON.stringify({ ...tpl, performers: perf }))), gekisou);
        reqs.set(sid, { run, base: run([0, 1, 2, 3, 4].map(empty)) });
      }
      return reqs.get(sid);
    };
    for (const [id, level] of pairs) {
      const key = id + ":" + level;
      const row = m.gekisouSkills.get(id);
      const top = m.gekisouSkillMaxLevel.get(id) || 1;
      const shape = battle.shapes.get(id + ":" + top);
      if (out.has(key) || !row || level >= top || shape === undefined) continue;
      const charts = [];
      for (const [sid, g] of bt.apt) {
        const a = g.get(shape);
        if (a && a.tail + a.ranges.reduce((x, y) => x + y, 0) > 0) charts.push(sid);
      }
      charts.sort((a, b) => a - b);
      const step = Math.max(1, charts.length / sample);
      let lo = 0;
      let hi = 0;
      for (let k = 0; k < Math.min(sample, charts.length); k++) {
        let r;
        try {
          r = request(charts[Math.floor(k * step)]);
        } catch (e) {
          continue;
        }
        const at = (lv) => {
          const perf = [0, 1, 2, 3, 4].map(empty);
          perf[0] = { ...perf[0], gekisouSkill: [id, lv], gekisouSkillCategories: row._skillCategories || [], gekisouMissionType: row._gekisouMissionType };
          return r.run(perf) - r.base;
        };
        lo += at(level);
        hi += at(top);
      }
      out.set(key, hi > 0 ? Math.max(0, lo / hi) : 0);
    }
    return out;
  }

  /**
   * Level factors of snaps' Gekisou support skills for the search (Engine.gekisouSupportTerms), for the levels that
   * differ from the top level in more than one proportional value (Engine.gekisouSupportLevelRatio is null, e.g. a cap
   * or a probability): for each [skillId, level, match] below the top level, the simulated increment of the skill at
   * that level over its increment at the top level, paired with a member that is (match 1) or is not a target of its
   * member condition and whose Gekisou skill is of another mission (so it cannot act on the support skill's ranges),
   * summed over up to `sample` charts where the top level gains, at bt's rank and Just rate on each chart's first
   * seed. Returns "skillId:level:match" -> factor (at least 0). `bt` is Engine.battleRates(battle, rank, justRate).
   */
  function gekisouSupportLevelFactors(session, m, battle, bt, triples, sample = 3) {
    const out = new Map();
    const empty = () => ({
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    });
    const runs = new Map(); // scoreId -> run(performers)
    const runOn = (sid) => {
      if (!runs.has(sid)) {
        const b = battle.byScore.get(sid);
        const gekisou = gekisouPlay(bt, b.percents, m.justTypes, [b.seeds[0].seed]);
        const tpl = gekisouRequest(session, JSON.parse(session.template(sid, battle.power, FPS)), sid, gekisou);
        runs.set(sid, (perf) => scoreOf(JSON.parse(session.run(JSON.stringify({ ...tpl, performers: perf }))), gekisou));
      }
      return runs.get(sid);
    };
    const cache = new Map(); // "sid|host|skill:level" -> score
    for (const [id, level, match] of triples) {
      const key = id + ":" + level + ":" + match;
      const row = m.gekisouSupportSkills.get(id);
      const top = m.gekisouSupportSkillMaxLevel.get(id) || 1;
      const shape = battle.supportShapes.get(id + ":" + top);
      if (out.has(key) || !row || level >= top || shape === undefined) continue;
      // The host: a Gekisou skill of another mission, and the member condition's first target when it should match.
      const gk = m.t.MasterGekisouSkill.find((g) => g._gekisouMissionType >= 1 && g._gekisouMissionType <= 3 && g._gekisouMissionType !== row._gekisouMissionType);
      if (!gk) continue;
      const host = { ...empty(), gekisouSkill: [gk._id, 1], gekisouMissionType: gk._gekisouMissionType, gekisouSkillCategories: gk._skillCategories || [] };
      if (match) {
        let t = null;
        for (const e of m.gekisouSupportSkillEffects.get(id + ":" + top) || []) {
          for (const g of [e._skillTriggerConditionGroup, e._skillConditionGroup, e._skillReleaseConditionGroup]) {
            for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
              for (const cid of cs._conditionIds) {
                const c = m.skillConditions.get(cid);
                if (!t && c && c._conditionType === 5000) t = m.skillTargets.get(c._conditionTargetIDs[0]);
              }
            }
          }
        }
        if (!t) continue;
        Object.assign(host, { bandId: t._bandID || 0, characterId: t._characterID || 0, cardType: t._cardType || 0, tagIds: t._tagID > 0 ? [t._tagID] : [] });
      }
      const charts = [];
      for (const [sid, g] of bt.aptSupport) if (g.get(shape + ":" + match) > 0 && battle.byScore.has(sid)) charts.push(sid);
      charts.sort((a, b) => a - b);
      const step = Math.max(1, charts.length / sample);
      let lo = 0;
      let hi = 0;
      for (let k = 0; k < Math.min(sample, charts.length); k++) {
        const sid = charts[Math.floor(k * step)];
        const at = (lv) => {
          const ck = sid + "|" + gk._id + ":" + match + "|" + (lv ? id + ":" + lv : "-");
          if (!cache.has(ck)) {
            const perf = [0, 1, 2, 3, 4].map(empty);
            perf[0] = { ...host, gekisouSupportSkills: lv ? [[id, lv]] : [] };
            cache.set(ck, runOn(sid)(perf));
          }
          return cache.get(ck);
        };
        try {
          lo += at(level) - at(0);
          hi += at(top) - at(0);
        } catch (e) {
          continue;
        }
      }
      out.set(key, hi > 0 ? Math.max(0, lo / hi) : 0);
    }
    return out;
  }

  /**
   * What COMBO count-up Gekisou skills (Engine.comboCountOf keys "skillId:level") add to the COMBO-stacking support
   * gains (Engine.gekisouSupportKind "combo") on chart `scoreId`, for Engine.comboCountBoost: `entry` ({b: Map(key ->
   * [share by match]), s: [upper bound by match], timeline}, new or measured before, updated for the keys it lacks) with each
   * share = the support skills' gain with the count-up over their gain without, minus 1. Five hosts whose own Gekisou
   * skill (`idle`, a skill id) adds no score hold the support skill `support` at its top level, beside a member of its
   * condition's band (match 1) or not (0); one host takes the count-up for `b`. Combinations use a shared COMBO
   * timeline instead of a saturation fit. COMBO ranges do not depend on the seed, so one run each, at bt's rank and Just rate (`bt`: {rank,
   * ranks, justRate, percents}, the chart's percents for averaged ranks, see gekisouPlay).
   */
  function comboBoosts(session, m, bt, scoreId, keys, support, idle, entry) {
    const known = entry ? [...entry.b.keys()] : [];
    return comboBoostsWith(session, comboContext(m, keys.concat(known), support, idle), bt, scoreId, keys, entry);
  }

  /** comboBoosts in two steps, the second without the master data (worker helpers): what its hosts take from it. */
  function comboContext(m, keys, support, idle) {
    const top = m.gekisouSupportSkillMaxLevel.get(support) || 1;
    const target = conditionTarget(m, support, top);
    const rows = {};
    for (const id of [idle, ...keys.map((k) => Number(k.split(":")[0]))]) {
      const row = m.gekisouSkills.get(id);
      rows[id] = { missionType: row._gekisouMissionType, categories: row._skillCategories || [] };
    }
    const conditions = (group) => (m.conditionSets.get(group) || []).flatMap((s) => s._conditionIds.map((id) => m.skillConditions.get(id)));
    const countRows = new Map();
    for (const k of keys) {
      const compiled = [];
      for (const e of m.gekisouSkillEffects.get(k) || []) {
        const cs = conditions(e._skillTriggerConditionGroup);
        // Full Perfect keeps LIFE at its initial value. The supported rows are timed range-start, sustained
        // range-playing, or a COMBO threshold (optionally ANDed with LIFE). Reject a new shape, never guess it.
        if (e._skillEffectType !== 12000 || e._skillConditionGroup || e._skillReleaseConditionGroup ||
            (m.conditionSets.get(e._skillTriggerConditionGroup) || []).length !== 1 ||
            cs.some((c) => ![2001, 7005, 7010, 7020].includes(c._conditionType) || (c._conditionType !== 2001 && !c._isPositive))) {
          throw new Error("Unsupported COMBO count skill " + k);
        }
        if (cs.some((c) => c._conditionType === 2001 && ((1000 >= c._conditionValues[0]) !== c._isPositive))) continue;
        const gate = cs.find((c) => c._conditionType === 7005);
        compiled.push({ threshold: gate ? gate._conditionValues[0] : 0, value: e._effectValue,
          backdate: cs.length === 1, duration: Math.round(e._activationTimeSecond * 1000) });
      }
      countRows.set(k, compiled);
    }
    const ramps = [];
    for (const e of m.gekisouSupportSkillEffects.get(support + ":" + top) || []) {
      const c = m.cumulative.get(e._skillCumulativeConditionID);
      const member = conditions(e._skillConditionGroup).find((c) => c._conditionType === 5000);
      if (e._skillEffectType !== 2001 || !c || c._skillCumulativeConditionType !== 7001 || !member) throw new Error("Unsupported COMBO support " + support);
      ramps[Number(member._isPositive)] = { unit: c._conditionValues[0], value: e._effectValue,
        max: Math.min(e._maxEffectValue || Infinity, (c._maxCumulativeCount || Infinity) * e._effectValue) };
    }
    if (!ramps[0] || !ramps[1]) throw new Error("Missing COMBO support member conditions " + support);
    return {
      justTypes: m.justTypes, support, top, idle, rows,
      bandId: target ? target._bandID || 0 : 0, characterId: target ? target._characterID || 0 : 0,
      countRows, ramps,
      comboTable: m.t.MasterLiveComboScoreBonus,
      noteWeights: new Map(m.t.MasterLiveNoteParameter.map((r) => [r._noteOperateType, r._scorePercent])),
    };
  }

  function comboTimeline(session, ctx, bt, scoreId) {
    const d = JSON.parse(session.describeChart(scoreId));
    const tpl = JSON.parse(session.template(scoreId, 1e6, FPS));
    const judged = d.notes.filter((n) => n.defaultJudgement >= 3 && n.defaultJudgement <= 6).sort((a, b) => a.noteMs - b.noteMs);
    const table = (kind) => {
      let sum = 0;
      return ctx.comboTable.filter((r) => r._comboBonusType === kind).sort((a, b) => a._requiredComboCount - b._requiredComboCount)
        .map((r) => [r._requiredComboCount, 1 + Math.min(1, sum = Math.fround(sum + r._bonusFactor))]);
    };
    const ordinary = table(0), byId = new Map(d.notes.map((n) => [n.noteId, n]));
    const ranges = [];
    d.fevers.forEach(([start, end], ri) => {
      if (d.missions[ri] !== 1) return;
      const r = { start, notes: [], frames: [] };
      const percents = bt.percents && bt.percents[ri];
      const rank = percents ? 1 + (bt.ranks || [bt.rank]).reduce((a, k) => a + percents[k - 1], 0) / (bt.ranks || [bt.rank]).length / 100 : 1;
      for (const f of tpl.frames) {
        if (f.timeMs < start || f.timeMs > end + 40) continue;
        const ns = f.judgements.filter((j) => j.judgement >= 3 && j.judgement <= 6).map((j) => byId.get(j.noteId)).filter((n) => n.noteMs >= start && n.noteMs <= end);
        const notes = ns.map((n) => {
          const cutoff = Math.ceil(Math.fround(n.noteMs / 40)) * 40 - 40;
          let lo = 0, hi = judged.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (judged[mid].noteMs <= cutoff) lo = mid + 1; else hi = mid; }
          const count = lo;
          let factor = 1;
          for (const [c, v] of ordinary) { if (c > count) break; factor = v; }
          return { time: n.noteMs, cutoff, weight: (ctx.noteWeights.get(n.opType) || 0) * factor * rank };
        });
        r.frames.push({ time: f.timeMs, notes });
        r.notes.push(...notes);
      }
      ranges.push(r);
    });
    const tl = { rows: ctx.countRows, support: ctx.ramps, combo: table(1), ranges };
    const engine = typeof module !== "undefined" && module.exports ? require("./engine.js") : root.Engine;
    tl.base = engine.comboTimelineGain(tl, []);
    // Every note at the largest COMBO factor and support cap: a safe, roster-independent search bound.
    const weight = ranges.reduce((a, r) => a + r.notes.reduce((b, n) => b + n.weight, 0), 0);
    tl.upper = tl.support.map((sup, match) => tl.base[match] > 0 ? Math.max(0, weight * tl.combo[tl.combo.length - 1][1] * sup.max / tl.base[match] - 1) : 0);
    return tl;
  }

  function comboBoostsWith(session, ctx, bt, scoreId, keys, entry) {
    const out = entry || { b: new Map(), s: [0, 0] };
    const todo = keys.filter((k) => !out.b.has(k));
    if (!todo.length && out.timeline) return out;
    const run = chartRunner(session, scoreId, gekisouPlay(bt, bt.percents, ctx.justTypes));
    const { support, top, idle } = ctx;
    const empty = {
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    };
    const host = (gk, match, sup) => {
      const row = ctx.rows[gk[0]];
      return {
        ...empty, bandId: match ? ctx.bandId : 0, characterId: match ? ctx.characterId : 0,
        gekisouSkill: gk, gekisouMissionType: row.missionType, gekisouSkillCategories: row.categories,
        gekisouSupportSkills: sup ? [[support, top]] : [],
      };
    };
    const key = (k) => k.split(":").map(Number);
    const score = (gks, match, sup) => run(1e6, [0, 1, 2, 3, 4].map((i) => host(gks[i] || [idle, 1], match, sup)), [0, 1, 2, 3, 4], 0);
    const s0 = score([], 0, false);
    const s1 = [0, 1].map((match) => score([], match, true));
    const share = (gks) => {
      const g0 = score(gks, 0, false);
      return [0, 1].map((match) => (s1[match] > s0 ? (score(gks, match, true) - g0 - (s1[match] - s0)) / (s1[match] - s0) : 0));
    };
    for (const k of todo) out.b.set(k, share([key(k)]));
    out.timeline = comboTimeline(session, ctx, bt, scoreId);
    out.s = out.timeline.upper;
    return out;
  }

  // The first member condition (5000) target of Gekisou support skill `id` at `level`, or null.
  function conditionTarget(m, id, level) {
    for (const e of m.gekisouSupportSkillEffects.get(id + ":" + level) || []) {
      for (const g of [e._skillTriggerConditionGroup, e._skillConditionGroup, e._skillReleaseConditionGroup]) {
        for (const cs of g > 0 ? m.conditionSets.get(g) || [] : []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c && c._conditionType === 5000) return m.skillTargets.get(c._conditionTargetIDs[0]) || null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Seeds to play a chart with a LUCK range on: the published `seeds`, then more from a fixed sequence, `n` in all.
   * A LUCK range's lottery draws from the live's seed (one live of a strong LUCK deck varies by ±15%); nothing else
   * does, so other charts need one seed.
   */
  function luckSeeds(seeds, n) {
    const out = seeds.slice(0, n);
    let x = 20261007;
    while (out.length < n) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      if (!out.includes(x)) out.push(x);
    }
    return out;
  }

  /**
   * The replay's deck data (JSON text) for 激奏舞台: `patch.missions` replaces every song's three Gekisou missions (the
   * day's rule; the replay reads a chart's missions from its song, and its requests take no override), and
   * `patch.probes` (Engine.kindProbes) adds a live skill of one effect row per music-data kind.
   */
  function patchDeck(deckText, patch) {
    const d = JSON.parse(deckText);
    const t = d.master;
    if (patch.missions) {
      const lm = t.MasterLiveMusic;
      const at = ["_gekisouMission1", "_gekisouMission2", "_gekisouMission3"].map((c) => lm.columns.indexOf(c));
      if (at.some((i) => i < 0)) throw new Error("replay deck data without Gekisou missions");
      for (const r of lm.rows) at.forEach((i, k) => (r[i] = patch.missions[k]));
    }
    for (const p of patch.probes || []) {
      const ls = t.MasterLiveSkill;
      const le = t.MasterLiveSkillEffect;
      ls.rows.push(ls.columns.map((c) => (c === "_id" ? p.row._liveSkillID : c === "_skillCategories" ? [] : 0)));
      le.rows.push(le.columns.map((c) => (p.row[c] === undefined ? 0 : p.row[c])));
    }
    return JSON.stringify(d);
  }

  /**
   * What measureBattleChart plays on a chart whose ranges are all `missions` (plain data, so helpers need no master):
   * {power, seeds, kindSeeds (how many of the seeds measure the live skill weights), percents, missions, justTypes,
   * kinds: number of music-data kinds, probes (Engine.kindProbes, live skills patchDeck adds), members: [{shape, perf}]
   * (each member Gekisou skill shape of a mission the ranges have, alone on one performer),
   * supports: [{key: "shape:match", host, perf}] (each support skill shape beside a host whose own Gekisou skill is of
   * another mission, a target of its member condition 5000 (match 1) or not (0)), as nnnotes' aptitude}. `opts`:
   * {percents (Engine.rankBonusPercents), probes, seeds, kindSeeds}.
   */
  function battleSpec(m, battle, missions, opts) {
    const empty = () => ({
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    });
    const members = [];
    const supports = [];
    for (const sh of battle.shapeList || []) {
      // A shape of a mission no range has adds nothing (checked on charts of each type).
      if (sh.mission && !missions.includes(sh.mission)) continue;
      const [id, level] = sh.skill;
      if (sh.source === "member") {
        const row = m.gekisouSkills.get(id);
        if (!row) continue;
        members.push({
          shape: sh.id,
          perf: { ...empty(), gekisouSkill: [id, level], gekisouMissionType: row._gekisouMissionType, gekisouSkillCategories: row._skillCategories || [] },
        });
        continue;
      }
      const row = m.gekisouSupportSkills.get(id);
      const gk = row && m.t.MasterGekisouSkill.find((g) => g._gekisouMissionType >= 1 && g._gekisouMissionType <= 3 && g._gekisouMissionType !== row._gekisouMissionType);
      if (!gk) continue;
      const host = { ...empty(), gekisouSkill: [gk._id, 1], gekisouMissionType: gk._gekisouMissionType, gekisouSkillCategories: gk._skillCategories || [] };
      const t = conditionTarget(m, id, level);
      for (const match of t ? [0, 1] : [0]) {
        const h = match ? { ...host, bandId: t._bandID || 0, characterId: t._characterID || 0, cardType: t._cardType || 0, tagIds: t._tagID > 0 ? [t._tagID] : [] } : host;
        supports.push({ key: sh.id + ":" + match, host: h, perf: { ...h, gekisouSupportSkills: [[id, level]] } });
      }
    }
    return {
      power: battle.power, seeds: opts.seeds, kindSeeds: opts.kindSeeds || opts.seeds.length, percents: opts.percents, missions,
      justTypes: [...m.justTypes], kinds: battle.kinds.length, probes: opts.probes.map(({ q, skill, f }) => ({ q, skill, f })), members, supports,
    };
  }

  /**
   * Gekisou data of chart `scoreId` measured on `session` (whose songs play spec.missions, patchDeck) as
   * Engine.battleFromMusicData's byScore entry: per seed the no-skill score of the Just play (Just at every Just-able
   * note of the Just-count ranges) and of the Perfect play at rank 1, each range's score and rank bonus, the live skill
   * weights (score per unit of power and of factor of each kind at each position, Just play) and their parts in each
   * range's score (on the first spec.kindSeeds seeds, their mean in every entry: on 4 seeds within 0.4% of 64); the
   * seed means of each Gekisou skill shape's and support shape's increments (tail: outside the ranges); per
   * range the Just play's Just count and notes. Without a Just-count range the Perfect play is the Just play.
   * `progress(runs)`.
   */
  function measureBattleChart(session, scoreId, spec, progress) {
    const P = spec.power;
    const justTypes = new Set(spec.justTypes);
    const tpl = JSON.parse(session.template(scoreId, P, FPS));
    const playOf = (justRate) => {
      const { performers: _p, skillOrder: _o, seed: _s, ...rest } = gekisouRequest(session, tpl, scoreId, { ranks: [1, 1, 1], justRate, justTypes });
      const body = JSON.stringify(rest).slice(0, -1);
      return (perf, order, seed) =>
        JSON.parse(session.run(`${body},"performers":${JSON.stringify(perf)},"skillOrder":${JSON.stringify(order)},"seed":${seed}}`));
    };
    const just = playOf(1);
    const perfect = spec.missions.includes(3) ? playOf(0) : null;
    // The Just and the Perfect play of performers `perf` (one run when they are the same).
    const both = (perf, order, seed) => {
      const rJ = count(just(perf, order, seed));
      return [rJ, perfect ? count(perfect(perf, order, seed)) : rJ];
    };
    const empty = {
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    };
    const alone = (p) => [p, empty, empty, empty, empty];
    const I = [0, 1, 2, 3, 4];
    const rs = (r) => r.endScore - r.startScore;
    const outside = (res) => res.score - res.ranges.reduce((a, r) => a + rs(r) + r.rankBonus, 0);
    let runs = 0;
    const count = (res) => {
      if (progress) progress(++runs);
      return res;
    };
    const inc = () => ({ tail: 0, tailPerfect: 0, ranges: [[0, 0], [0, 0], [0, 0]] });
    const apt = new Map(spec.members.map((x) => [x.shape, inc()]));
    const aptSupport = new Map(spec.supports.map((x) => [x.key, inc()]));
    // An increment over a base play pair (Just, Perfect), added to a's seed sum.
    const add = (a, [rJ, rP], [baseJ, baseP]) => {
      a.tail += outside(rJ) - outside(baseJ);
      a.tailPerfect += outside(rP) - outside(baseP);
      rJ.ranges.forEach((r, i) => {
        a.ranges[i][0] += rs(r) - rs(baseJ.ranges[i]);
        a.ranges[i][1] += rs(rP.ranges[i]) - rs(baseP.ranges[i]);
      });
    };
    const nk = Math.max(1, Math.min(spec.kindSeeds || spec.seeds.length, spec.seeds.length));
    const weights = new Array(spec.kinds).fill(null);
    const rangeWeights = new Array(spec.kinds).fill(null);
    for (const { q } of spec.probes) {
      weights[q] = [0, 0, 0, 0, 0];
      rangeWeights[q] = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
    }
    const seeds = [];
    let justRanges = null;
    spec.seeds.forEach((seed, n) => {
      const base = both(alone(empty), I, seed);
      const [bJ, bP] = base;
      if (!justRanges) justRanges = bJ.ranges.map((r) => [r.justCount || 0, r.maxCombo || 0]);
      if (n < nk) {
        for (const { q, skill, f } of spec.probes) {
          for (let k = 0; k < 5; k++) {
            const order = [1, 2, 3, 4];
            order.splice(k, 0, 0);
            const res = count(just(alone({ ...empty, liveSkill: skill }), order, seed));
            weights[q][k] += (res.score - bJ.score) / (P * f) / nk;
            res.ranges.forEach((r, i) => (rangeWeights[q][k][i] += (rs(r) - rs(bJ.ranges[i])) / (P * f) / nk));
          }
        }
      }
      for (const x of spec.members) add(apt.get(x.shape), both(alone(x.perf), I, seed), base);
      const hosts = new Map();
      for (const x of spec.supports) {
        const hk = JSON.stringify(x.host);
        if (!hosts.has(hk)) hosts.set(hk, both(alone(x.host), I, seed));
        add(aptSupport.get(x.key), both(alone(x.perf), I, seed), hosts.get(hk));
      }
      seeds.push({
        seed,
        score: bJ.score,
        scorePerfect: bP.score,
        ranges: bJ.ranges.map((r, i) => [rs(r), rs(bP.ranges[i]), r.rankBonus, bP.ranges[i].rankBonus]),
        weights,
        rangeWeights,
      });
    });
    const mean = (src) => {
      const out = new Map();
      const n = spec.seeds.length;
      for (const [key, a] of src) out.set(key, { tail: a.tail / n, tailPerfect: a.tailPerfect / n, ranges: a.ranges.map(([x, y]) => [x / n, y / n]) });
      return out;
    };
    return {
      seeds,
      replaySeeds: spec.seeds.slice(),
      percents: spec.percents,
      missions: spec.missions.slice(),
      luck: spec.missions.includes(2),
      apt: mean(apt),
      aptSupport: mean(aptSupport),
      justRanges,
    };
  }

  /**
   * Browser: loads the replay engine and deck data named by music-data.json's `replay` pointer (URLs relative to
   * the music-data URL), cached with the Cache API under the manifest hash. Returns a ReplaySession; with `patch`
   * (patchDeck) one on the patched deck data.
   */
  async function loadReplay(musicDataUrl, pointer, patch) {
    const manifestUrl = new URL(pointer.manifestUrl, musicDataUrl).href;
    const cacheName = "deckcalc-replay-" + String(pointer.sha256 || "").slice(0, 16);
    const cache = typeof caches !== "undefined" ? await caches.open(cacheName) : null;
    if (cache) for (const n of await caches.keys()) if (n.startsWith("deckcalc-replay-") && n !== cacheName) await caches.delete(n);
    const get = async (url) => {
      const hit = cache && (await cache.match(url));
      if (hit) return hit;
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) throw new Error(url + ": HTTP " + res.status);
      if (cache) await cache.put(url, res.clone());
      return res;
    };
    const manifest = await (await get(manifestUrl)).json();
    if (!manifest.engine) throw new Error("replay manifest without an engine");
    const at = (u) => new URL(u, manifestUrl).href;
    const [js, wasm, deck] = await Promise.all([
      get(at(manifest.engine.js.url)).then((r) => r.text()),
      get(at(manifest.engine.wasm.url)).then((r) => r.arrayBuffer()),
      get(at(manifest.deckData.url)).then((r) => r.text()),
    ]);
    const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
    try {
      const mod = await import(url);
      mod.initSync({ module: wasm });
      return new mod.ReplaySession(patch ? patchDeck(deck, patch) : deck);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const api = {
    ORDERS, performers, gekisouRequest, gekisouPlay, scoreOf, orderScores, chartRunner, meanScore, sampleScores, snapSkillRates, snapSkillJobs, measureSnapJobs,
    gekisouLevelFactors, gekisouSupportLevelFactors,
    comboBoosts, comboContext, comboBoostsWith, luckSeeds, loadReplay, patchDeck, battleSpec, measureBattleChart,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Simulate = api;
})(typeof self !== "undefined" ? self : this);
