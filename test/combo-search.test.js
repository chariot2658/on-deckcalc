// COMBO timelines through the real search: chart coverage, browser transport, bounds and snap assignment.
// Run: node test/combo-search.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");
const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json"), "utf8"))]));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json"), "utf8"));
const battle = E.battleFromMusicData(md);

(async () => {
  const session = await loadReplay();
  assert.ok(session, "Missing local replay data");
  const members = [5, 27, 53, 57, 59, 65, 66].map((id) => {
    const L = E.memberLimits(m, m.memberCards.get(id));
    return { id, level: L.limit(L.maxAwake), awake: L.maxAwake, rank: 1, skillLevel: 1, gekisouSkillLevel: id % 2 ? 1 : 5 };
  });
  const snaps = [5, 53].map((id) => ({ id, rank: 5, level: E.snapLimit(m, m.snaps.get(id), 5) }));
  const input = { master: m, event: null, mode: "normal", objective: "score", members, snaps, player: {},
    perPowerByScore: E.perPowerFromMusicData(md), skillWeights: E.skillWeightsFromMusicData(md), battle,
    maxLevel: 40, difficulties: ["hard", "expert"], musicIds: [100001, 100017], now: new Date("2026-10-18T00:00:00Z"),
    multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.5 }, topK: 1, compareSongs: true, chartCandidateMargin: 1 };
  const scope = E.comboScope(input);
  assert.deepStrictEqual(scope.scoreIds.slice().sort(), [10000102, 10000103, 10001702, 10001703]);
  assert.strictEqual(scope.byMusic.size, 0, "must not reuse another difficulty's timeline");
  const bt = E.battleRates(battle, 3, 0.5);
  const comboBoost = { byScore: new Map(), byMusic: new Map() };
  for (const sid of scope.scoreIds) comboBoost.byScore.set(sid, S.comboBoosts(session, m,
    { rank: 3, justRate: 0.5, percents: battle.byScore.get(sid).percents }, sid, scope.keys, scope.support, scope.idle));

  // Execute the browser UMD path (no require/module) and structured clone the same messages helpers receive.
  const browser = vm.createContext({ self: {} });
  for (const file of ["engine.js", "simulate.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), browser);
  const sid = scope.scoreIds[0], ctx = S.comboContext(m, scope.keys, scope.support, scope.idle);
  const btChart = { rank: 3, justRate: 0.5, percents: battle.byScore.get(sid).percents };
  const clone = structuredClone(browser.self.Simulate.comboBoostsWith(session, structuredClone(ctx), btChart, sid, scope.keys));
  for (const match of [0, 1]) assert.strictEqual(E.comboCountBoost(clone, scope.keys.slice(0, 3), match), E.comboCountBoost(comboBoost.byScore.get(sid), scope.keys.slice(0, 3), match));

  const base = { ...input, comboBoost };
  const mv = members.map((o) => E.memberView(m, o, {})), sv = snaps.map((o) => E.snapView(m, o));
  const powerCtx = E.makeContext(m, {}, null, mv, sv, "normal");
  const sw = { kinds: battle.kinds, byScore: bt.weights };
  const charts = E.charts(m, bt.perPower, { ...input });
  const bestChart = new Map(charts.map((c) => [c.scoreId, -Infinity]));
  let best = -Infinity, visited = 0;
  const pick = (from, acc) => {
    if (acc.length < 5) {
      for (let i = from; i < mv.length; i++) if (!acc.some((v) => v.characterId === mv[i].characterId)) pick(i + 1, acc.concat(mv[i]));
      return;
    }
    const keys = acc.map((v) => v.comboCount).filter(Boolean);
    for (let leader = 0; leader < 5; leader++) {
      const order = acc.slice(); [order[2], order[leader]] = [order[leader], order[2]];
      for (let a = -1; a < 5; a++) for (let b = -1; b < 5; b++) {
        if (a >= 0 && a === b) continue;
        const sn = Array(5).fill(null); if (a >= 0) sn[a] = sv[0]; if (b >= 0) sn[b] = sv[1];
        const bySong = new Map();
        for (const c of charts) {
          let rate = c.perPower;
          order.forEach((v, i) => {
            rate += E.liveSkillRate(m, [v], c.scoreId, sw) + E.gekisouSkillRate(m, battle, bt, v, c.scoreId, null);
            for (const [, gain, kind, match] of sn[i] ? E.gekisouSupportTerms(m, battle, bt, v, sn[i], c.scoreId, null) : []) {
              rate += gain * (kind === "combo" ? 1 + E.comboCountBoost(comboBoost.byScore.get(c.scoreId), keys, match) : 1);
            }
          });
          const score = E.deckPower(m, order, sn, E.musicView(m, c.musicId), powerCtx) * rate;
          bySong.set(c.musicId, Math.max(bySong.get(c.musicId) || 0, score));
          bestChart.set(c.scoreId, Math.max(bestChart.get(c.scoreId), score));
        }
        best = Math.max(best, [...bySong.values()].reduce((a, b) => a + b, 0) / input.musicIds.length);
        visited++;
      }
    }
  };
  pick(0, []);
  const random = E.search(base);
  assert.ok(Math.abs(random.results[0].score / best - 1) < 1e-9, `random search ${random.results[0].score} vs exhaustive ${best}`);
  const individual = E.search({ ...base, multi: { ...base.multi, pickSong: true } });
  assert.strictEqual(individual.songs.length, charts.length);
  for (const d of individual.songs) assert.ok(Math.abs(d.score / bestChart.get(d.chart.scoreId) - 1) < 1e-9, `individual search ${d.chart.scoreId}: ${d.score} vs ${bestChart.get(d.chart.scoreId)}`);
  console.log(`${visited} real-card member/leader/snap assignments: random and per-song COMBO bounds match exhaustive search; all difficulties and browser cloning checked`);
  session.free();
})().catch((e) => { console.error(e); process.exitCode = 1; });
