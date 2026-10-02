/*
 * Exact live score of a deck from ournotes-deck's whole-live simulation: the replay WASM that nnnotes publishes beside
 * music-data.json (`replay` pointer). It plays live skills and snap skills (Gekisou off, every judged note Perfect).
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
   * Replay performers of a deck: members [{id, skillLevel}], snaps [{id, rank} | null], slot by slot. Snap skill
   * levels follow the snap's rank (MasterSupportCardRank), as in ournotes-deck cards.rs.
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
      if (s && rk) {
        if (s._supportSkillId01) support.push([s._supportSkillId01, rk._supportSkill01Level]);
        if (s._supportSkillId02) support.push([s._supportSkillId02, rk._supportSkill02Level]);
      }
      return {
        liveSkill: c && c._liveSkillID ? [c._liveSkillID, Math.min(maxLv, Math.max(1, o.skillLevel || 1))] : null,
        supportSkills: support,
        bandId: ch ? ch._bandID : 0,
        characterId: c ? c._characterID : 0,
        cardType: c ? c._cardType : 0,
        tagIds: (c && c._bestMusicTagIDs) || [],
        liveSkillCategories: (live && live._skillCategories) || [],
        gekisouSkillCategories: [],
        gekisouMissionType: 0,
        gekisouSkill: null,
        gekisouSupportSkills: [],
      };
    });
  }

  /**
   * The score of every performance order of a deck on a chart at `power`: {base (no skills), scores (ascending, one
   * per order), mean, exact (whether the additive scores were confirmed)}. null when the replay data lacks the chart.
   */
  function orderScores(session, scoreId, power, perf) {
    let tpl;
    try {
      tpl = JSON.parse(session.template(scoreId, power, FPS));
    } catch (e) {
      return null;
    }
    const run = (ps, order) => JSON.parse(session.run(JSON.stringify({ ...tpl, performers: ps, skillOrder: order }))).score;
    const bare = (p) => ({ ...p, liveSkill: null, supportSkills: [] });
    const base = run(perf.map(bare), [0, 1, 2, 3, 4]);
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
    scores.sort((a, b) => a - b);
    return { base, scores, mean: scores.reduce((a, b) => a + b, 0) / scores.length, exact };
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

  const api = { ORDERS, performers, orderScores, loadReplay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Simulate = api;
})(typeof self !== "undefined" ? self : this);
