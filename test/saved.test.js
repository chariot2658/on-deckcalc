// Saved-deck candidate selection: real engine chart/top-k contracts and controlled replay counterexamples.
// node test/saved.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const E = require("../engine.js");
const S = require("../simulate.js");
const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json")))]));
const master = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json")));
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets/my-roster.json")));
const base = {
  master, event: master.events.get(1), mode: "normal", objective: "score", members: roster.members.slice(0, 14),
  snaps: [], player: roster.player, perPowerByScore: E.perPowerFromMusicData(md), skillWeights: E.skillWeightsFromMusicData(md),
  musicIds: [100003, 100094, 100087], difficulties: ["hard", "expert"], maxLevel: 27,
  accuracy: { perfectRate: 0.98, breaks: 2 }, topK: 4, songTopK: 4, compareSongs: true, chartCandidateMargin: 1,
};
const formation = (d) => d.members.map((m, i) => m.id + ":" + (d.snaps[i] && d.snaps[i].id)).join(",");
const checkCharts = (d) => {
  assert.ok(d.chartCandidates.length >= 1);
  assert.ok(d.chartCandidates.some((c) => c.chart.scoreId === d.chart.scoreId), "retain the original chart");
  for (const c of d.chartCandidates) {
    assert.strictEqual(formation(c), formation(d), "chart selection must not move cards or the leader");
    assert.strictEqual(c.power, d.power);
    assert.strictEqual(c.chart.musicId, d.chart.musicId);
    assert.ok(base.difficulties.includes(c.chart.difficulty) && c.chart.level <= base.maxLevel);
    assert.strictEqual(c.accuracy, E.accuracyFactor(master, c.chart.scoreId, base.accuracy));
    assert.ok(Number.isFinite(c.score) && Number.isFinite(c.estScore));
  }
};
for (const objective of ["score", "points"]) {
  const input = { ...base, objective, boosts: 3 };
  const out = E.search(input);
  for (const id of base.musicIds) {
    const candidates = out.songCandidates.filter((d) => d.chart.musicId === id);
    const own = E.search({ ...input, musicIds: [id] });
    assert.deepStrictEqual(candidates.map((d) => d.score), own.results.map((d) => d.score), "per-song top-k must agree with a single-song search on this unpruned roster");
    candidates.forEach(checkCharts);
  }
  const random = E.search({ ...input, multi: { players: 5, auto: true } });
  random.perSong.flat().forEach(checkCharts);
}
console.log("engine: per-song top-k, fixed formations, three historical songs, level/difficulty limits and accuracy OK");

// The estimated winner loses in replay, and a lower difficulty can win. In payoff mode the highest raw score can
// still lose to an easier room-rank threshold. Exercise the actual savedDecks pipeline without depending on a future
// replay version preserving a particular model error.
async function pipeline(objective, withReplay = true) {
  const musicIds = base.musicIds;
  const charts = musicIds.flatMap((musicId) => [2, 3].map((diff) => ({ musicId, scoreId: musicId * 100 + diff, difficulty: diff === 2 ? "hard" : "expert" })));
  const deck = (id, c) => ({
    members: Array.from({ length: 5 }, (_, i) => ({ id: id * 10 + i })), snaps: Array(5).fill(null),
    chart: c, power: 1, displayPower: 1, pointBonus: 0, itemBonus: 0, accuracy: 1,
    score: id === 1 ? 100 : id === 2 ? 95 : 96, estScore: 100,
  });
  const perSong = (id) => musicIds.map((musicId) => {
    const cs = charts.filter((c) => c.musicId === musicId).map((c) => deck(id, c));
    return { ...cs[1], chartCandidates: cs };
  });
  const grouped = (ids) => ({ results: ids.map((id) => deck(id, null)), perSong: ids.map(perSong), gekisou: { rank: 3, justRate: 0.5 } });
  let result;
  const played = new Map();
  const context = vm.createContext({
    console, importScripts() {}, prepared: { ...base, objective, multi: { players: 5, auto: true } },
    Engine: {
      plainDeck: (d) => d, charts: () => charts, gekisouSongGroups: () => [{ type: "luck", musicIds }],
      search: (input) => input.multi.pickSong ? { songCandidates: [...perSong(1), ...perSong(3)] } : grouped(input.topK === 1 ? [1] : [1, 2]),
      roomPayoff: (_input, chart, score) => {
        const points = chart.difficulty === "expert" ? 200 : score >= 125 ? 500 : 100;
        return { sc: points, points, items: points * 2, cp: points / 10, rankDist: [] };
      },
    },
    Simulate: {
      ...S, loadReplay: async () => ({}), gekisouPlay: () => ({}), performers: (_m, members) => members,
      chartRunner: (_s, sid) => (_power, perf, order, seed) => {
        const key = sid + ":" + perf[0].id;
        if (!played.has(key)) played.set(key, []);
        played.get(key).push([order.slice(), seed]);
        const id = perf[0].id / 10;
        return (id === 1 ? 100 : id === 2 ? 110 : 115) + (sid % 100 === 2 ? id * 5 : 0);
      },
    },
    self: { postMessage: (m) => { if (m.type === "error") throw new Error(m.message); if (m.type === "saved") result = m; } },
    fakeBattle: { byScore: new Map(charts.map((c) => [c.scoreId, { luck: true, replaySeeds: [7, 8], seeds: [{ seed: 7 }] }])) },
    withReplay,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../worker.js"), "utf8"), context);
  vm.runInContext(`master = {justTypes: []}; perPower = new Map(); battle = fakeBattle; replay = withReplay ? {} : null;
    engineInput = async () => prepared; scoreInput = async (input) => ({input});
    msg = {id: 1, input: prepared, eventId: 1, now: "2026-10-18T00:00:00Z"};`, context);
  await vm.runInContext("savedDecks(msg)", context);
  assert.strictEqual(result.simulated, withReplay);
  for (const row of result.songs) {
    assert.ok(row.best.simPay.value >= row.saved.simPay.value);
    assert.ok(row.best.simPay.value >= row.all.value);
    if (withReplay) {
      assert.strictEqual(row.best.members[0].id, 30, "replay must replace the estimated first-place team");
      assert.strictEqual(row.best.chart.difficulty, "hard", "replay must replace the estimated difficulty");
      assert.strictEqual(row.saved.chart.difficulty, objective === "score" ? "hard" : "expert", "chart choice must use the requested objective");
      assert.strictEqual(row.saved.members[0].id, objective === "score" ? 20 : 10);
    }
  }
  if (withReplay) {
    const sequences = [...played.values()].filter((v) => v.length === 10);
    assert.ok(sequences.length > 1);
    for (const v of sequences) assert.strictEqual(JSON.stringify(v), JSON.stringify(sequences[0]), "final candidates must use identical orders and seeds");
    const original = JSON.stringify(result.songs);
    await vm.runInContext("savedDecks({...msg, id: 2})", context);
    assert.strictEqual(result.id, 2);
    assert.strictEqual(result.stats.runs, 0);
    assert.strictEqual(JSON.stringify(result.songs), original);
  }
}
(async () => {
  for (const objective of ["score", "points"]) {
    await pipeline(objective);
    await pipeline(objective, false);
  }
  console.log("worker: replay selects teams/charts by objective, best >= saved/universal, matched samples, cache and estimate fallback OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
