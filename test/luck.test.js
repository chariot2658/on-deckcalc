// LUCK gauge interactions against replay, plus search bounds against exhaustive formations.
// Run: node test/luck.test.js [--extended] (all LUCK/mixed EXPERT charts instead of four representative charts).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const E = require("../engine.js");
const S = require("../simulate.js");
const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json")))]));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json")));
const battle = E.battleFromMusicData(md);
const bt = E.battleRates(battle, 3, 0.2);
const member = (id, level = 5) => {
  const L = E.memberLimits(m, m.memberCards.get(id));
  return { id, level: L.limit(L.maxAwake), awake: L.maxAwake, rank: 1, skillLevel: 1, gekisouSkillLevel: level };
};
const snap = (id) => ({ id, rank: 5, level: E.snapLimit(m, m.snaps.get(id), 5) });

function searchAgainstBruteForce() {
  // Two versions of one character, old gauges, GK20 and the new GK21; both empty and occupied snap slots.
  const members = [2, 52, 54, 43, 68, 69, 61].map((id) => member(id, id === 43 ? 1 : 5));
  const snaps = [28, 51].map(snap);
  const input = { master: m, event: null, mode: "normal", objective: "score", members, snaps, player: {},
    battle, perPowerByScore: E.perPowerFromMusicData(md), skillWeights: E.skillWeightsFromMusicData(md),
    musicIds: [100003, 100017], difficulties: ["expert"], maxLevel: 40, chartCandidateMargin: 1,
    now: new Date("2026-10-18T00:00:00Z"), topK: 1, compareSongs: true,
    multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.2 } };
  const mv = members.map((o) => E.memberView(m, o, {})), sv = snaps.map((o) => E.snapView(m, o));
  const ctx = E.makeContext(m, {}, null, mv, sv, "normal");
  const sw = { kinds: battle.kinds, byScore: bt.weights };
  const charts = E.charts(m, bt.perPower, input);
  const bestBySong = new Map(input.musicIds.map((id) => [id, -Infinity]));
  let best = -Infinity, count = 0;
  const pick = (from, acc) => {
    if (acc.length < 5) {
      for (let i = from; i < mv.length; i++) if (!acc.some((v) => v.characterId === mv[i].characterId)) pick(i + 1, acc.concat(mv[i]));
      return;
    }
    for (let leader = 0; leader < 5; leader++) {
      const vs = acc.slice(); [vs[2], vs[leader]] = [vs[leader], vs[2]];
      for (let a = -1; a < 5; a++) for (let b = -1; b < 5; b++) {
        if (a >= 0 && a === b) continue;
        const ss = Array(5).fill(null);
        if (a >= 0) ss[a] = sv[0];
        if (b >= 0) ss[b] = sv[1];
        const bySong = new Map(input.musicIds.map((id) => [id, -Infinity]));
        for (const c of charts) {
          const boost = E.luckGaugeBoost(m, battle, bt, vs, c.scoreId);
          let rate = c.perPower + E.liveSkillRate(m, vs, c.scoreId, sw);
          vs.forEach((v, i) => {
            rate += E.gekisouSkillRate(m, battle, bt, v, c.scoreId);
            for (const [, x, kind] of ss[i] ? E.gekisouSupportTerms(m, battle, bt, v, ss[i], c.scoreId) : []) rate += x * (kind === "rush" ? 1 + boost : 1);
          });
          const score = E.deckPower(m, vs, ss, E.musicView(m, c.musicId), ctx) * rate;
          bySong.set(c.musicId, Math.max(bySong.get(c.musicId), score));
          bestBySong.set(c.musicId, Math.max(bestBySong.get(c.musicId), score));
        }
        best = Math.max(best, [...bySong.values()].reduce((a, b) => a + b, 0) / bySong.size);
        count++;
      }
    }
  };
  pick(0, []);
  for (const pickSong of [false, true]) {
    const out = E.search({ ...input, multi: { ...input.multi, pickSong } });
    assert.ok(!out.error);
    if (!pickSong) assert.ok(Math.abs(out.results[0].score / best - 1) < 1e-9, `random LUCK bounds: ${out.results[0].score} vs ${best}`);
    for (const d of out.songs) assert.ok(Math.abs(d.score / bestBySong.get(d.chart.musicId) - 1) < 1e-9, `LUCK chart bounds: ${d.score}`);
  }
  // Workers rebuild master indexes from cloned raw tables; the browser UMD path must agree.
  const browser = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../engine.js"), "utf8"), browser);
  const clone = structuredClone({ raw, battle, mv });
  const browserMaster = browser.self.Engine.buildMaster(clone.raw);
  const browserRates = browser.self.Engine.battleRates(clone.battle, 3, 0.2);
  assert.strictEqual(browser.self.Engine.luckGaugeBoost(browserMaster, clone.battle, browserRates, clone.mv, 10000303), E.luckGaugeBoost(m, battle, bt, mv, 10000303));
  assert.strictEqual(E.luckGaugeBoost(m, battle, bt, mv, 10000103), 0, "no LUCK range");
  assert.strictEqual(E.luckGaugeBoost(m, battle, bt, [], 10000303), 0, "no gauge skill");
  console.log(`${count} LUCK formations: public/private search and browser transport agree`);
}

async function replayInteractions() {
  const session = await require("./replay.js")();
  assert.ok(session, "Missing replay data; run node test/fetch-replay.js");
  const extended = process.argv.includes("--extended");
  const charts = extended
    ? md.songs.filter((s) => s.gekisouMissions.includes(2)).map((s) => s.charts.find((c) => c.difficulty === "expert").scoreId)
    : [10000302, 10000303, 10001702, 10001703];
  const cases = extended
    ? [[[21, 1]], [[21, 5]], [[9, 5], [21, 5]], [[9, 5], [9, 5], [9, 5], [21, 5]]]
    : [[], ...[7, 9, 20, 21].flatMap((id) => [1, 5].map((lv) => [[id, lv]])),
      [[9, 5], [21, 5]], [[20, 1], [21, 1]], [[9, 5], [9, 5], [9, 5], [21, 5]]];
  const P = 1e6, sn = snap(51), sv = E.snapView(m, sn);
  const hosts = [52, 60, 52, 60, 52]; // Matching and non-matching RUSH support conditions.
  const baseViews = hosts.map((id) => E.memberView(m, member(id), {}));
  const basePerf = S.performers(m, hosts.map((id) => member(id)), hosts.map(() => sn));
  let worst = 0, worstCase = "", total = 0;
  for (const sid of charts) {
    const seeds = S.luckSeeds(battle.byScore.get(sid).replaySeeds, 256);
    const run = S.chartRunner(session, sid, { ranks: [3, 3, 3], justRate: 0.2, justTypes: m.justTypes });
    for (const keys of cases) {
      const views = baseViews.map((v, i) => {
        const [id, lv] = keys[i] || [11, 5]; // JUST mission count: no score gain at the fixed ranks.
        const g = m.gekisouSkills.get(id);
        return { ...v, gekisouSkillId: id, gekisouSkillLevel: lv, gekisouSkillCategories: g._skillCategories,
          gekisouMissionType: g._gekisouMissionType, luckGauge: E.luckGaugeOf(m, id, lv) };
      });
      const perf = basePerf.map((p, i) => ({ ...p, liveSkill: null, supportSkills: [],
        gekisouSkill: [views[i].gekisouSkillId, views[i].gekisouSkillLevel],
        gekisouSkillCategories: views[i].gekisouSkillCategories, gekisouMissionType: views[i].gekisouMissionType }));
      const boost = E.luckGaugeBoost(m, battle, bt, views, sid);
      const rate = bt.perPower.get(sid) + views.reduce((sum, v) => sum + E.gekisouSkillRate(m, battle, bt, v, sid)
        + E.gekisouSupportRate(m, battle, bt, v, sv, sid) * (1 + boost), 0);
      const actual = S.meanScore(run, P, perf, seeds, seeds.length);
      const error = Math.abs(rate * P / actual - 1);
      const label = `${sid} ${keys.map((k) => k.join(":")).join("+") || "no gauge"}`;
      if (error > worst) { worst = error; worstCase = label; }
      total++;
      assert.ok(error < 0.06, `${label}: estimate ${Math.round(rate * P)}, replay ${Math.round(actual)}, error ${(error * 100).toFixed(2)}%`);
    }
    console.log(`LUCK replay ${sid}: ${cases.length} cases passed`);
  }
  console.log(`${total} LUCK replay cases, 256 seeds each: worst ${(worst * 100).toFixed(2)}% (${worstCase})`);
}

(async () => {
  searchAgainstBruteForce();
  await replayInteractions();
})().catch((e) => { console.error(e); process.exitCode = 1; });
