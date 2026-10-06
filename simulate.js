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
      JSON.parse(session.run(JSON.stringify({ ...tpl, performers: ps, skillOrder: order, ...(seed === undefined ? {} : { seed }) }))).score;
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
   * Snap skill score per unit of power of each kind of member/snap pairing on chart `scoreId`, for the score search
   * (Engine.search snapSkill; pairs from Engine.scoreScope: [{key, member: {id, skillLevel}, snap: {id, rank}}]).
   * A pairing's gain at a performance position does not depend on the other slots, so five copies of it in one run
   * add up its gains at the five positions: (five copies with the snap - five without) / 5 / power is its mean over the
   * uniformly random order. Gekisou skills and Gekisou support skills are left out (the search adds the members' own;
   * the snaps' are left to orderScores). `gekisou` as for orderScores. Returns Map key -> rate; `progress(done, total)`.
   */
  function snapSkillRates(session, m, scoreId, pairs, gekisou, progress, power = 1e6) {
    let tpl = JSON.parse(session.template(scoreId, power, FPS));
    if (gekisou) tpl = gekisouRequest(session, tpl, scoreId, gekisou);
    const run = (p) => JSON.parse(session.run(JSON.stringify({ ...tpl, performers: [p, p, p, p, p] }))).score;
    const without = new Map(); // member side -> score of five copies without snap skills
    const out = new Map();
    pairs.forEach((pr, i) => {
      const p = { ...performers(m, [pr.member], [pr.snap])[0], gekisouSkill: null, gekisouSupportSkills: [] };
      const bare = { ...p, supportSkills: [] };
      // Members of one live skill score alike without snaps (the key's member part, Engine.snapSkillKey).
      const k = pr.memberKey || JSON.stringify(bare);
      if (!without.has(k)) without.set(k, run(bare));
      out.set(pr.key, (run(p) - without.get(k)) / 5 / power);
      if (progress) progress(i + 1, pairs.length);
    });
    return out;
  }

  /**
   * Level factors of member Gekisou skills for the search (Engine.gekisouSkillRate): music-data measured each skill at
   * its top level only, and a lower level changes trigger conditions or the activation time rather than a value. For
   * each [skillId, level] below the top: the simulated increment of the skill alone at that level over the increment at
   * the top level, summed over up to `sample` charts where the top level gains (spread over them), at rank `rank` in
   * every range and Just rate `justRate`, on each chart's first seed. Returns "skillId:level" -> factor (at least 0).
   * `bt` is Engine.battleRates(battle, rank, justRate).
   */
  function gekisouLevelFactors(session, m, battle, bt, pairs, sample = 6) {
    const out = new Map();
    const empty = () => ({
      liveSkill: null, supportSkills: [], bandId: 0, characterId: 0, cardType: 0, tagIds: [], liveSkillCategories: [],
      gekisouSkillCategories: [], gekisouMissionType: 0, gekisouSkill: null, gekisouSupportSkills: [],
    });
    const reqs = new Map(); // scoreId -> [request, no-skill score]
    const request = (sid) => {
      if (!reqs.has(sid)) {
        const b = battle.byScore.get(sid);
        const gekisou = { ranks: [bt.rank, bt.rank, bt.rank], justRate: bt.justRate, justTypes: m.justTypes, seeds: [b.seeds[0].seed] };
        const tpl = gekisouRequest(session, JSON.parse(session.template(sid, battle.power, FPS)), sid, gekisou);
        const run = (perf) => JSON.parse(session.run(JSON.stringify({ ...tpl, performers: perf }))).score;
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
   * Browser: loads the replay engine and deck data named by music-data.json's `replay` pointer (URLs relative to
   * the music-data URL), cached with the Cache API under the manifest hash. Returns a ReplaySession.
   */
  async function loadReplay(musicDataUrl, pointer) {
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
      return new mod.ReplaySession(deck);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const api = { ORDERS, performers, gekisouRequest, orderScores, snapSkillRates, gekisouLevelFactors, loadReplay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Simulate = api;
})(typeof self !== "undefined" ? self : this);
