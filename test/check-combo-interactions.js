// COMBO interaction regression against the independent full replay, with an optional detailed report.
// Run: node test/check-combo-interactions.js [--json] [--extended]
// Requires the local replay engine; synthetic hosts isolate the support interaction from other score errors.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");

async function main() {
  const root = path.join(__dirname, "..", "..");
  const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json"), "utf8"))]));
  const m = E.buildMaster(raw, "_traditionalChinese");
  const session = await loadReplay();
  assert.ok(session, "Missing replay data; run node test/fetch-replay.js first");
  const extended = process.argv.includes("--extended");
  const keys = [4, 5, 6, 12, 13, 18, 19].flatMap((id) => (extended ? [1, 2, 3, 4, 5] : [1, 5]).map((lv) => `${id}:${lv}`));
  for (const k of keys) assert.strictEqual(E.comboCountOf(m, ...k.split(":").map(Number)), k);
  const support = Number((process.argv.find((s) => s.startsWith("--support=")) || "--support=16").split("=")[1]);
  const ctx = S.comboContext(m, keys, support, 1);
  const battle = E.battleFromMusicData(JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json"), "utf8")));
  const combos = new Map();
  const add = (ks) => { const sorted = ks.slice().sort(); combos.set(sorted.join("+"), sorted); };
  for (const id of [12, 13]) for (const other of [4, 5, 6, 12, 13, 18, 19]) {
    if (id === other) continue;
    for (const lv of [1, 5]) for (const lv2 of [1, 5]) add([`${id}:${lv}`, `${other}:${lv2}`]);
  }
  for (const lv of [1, 5]) add([`4:${lv}`, `12:${lv}`, `13:${lv}`]);
  if (extended) {
    add(["12:2", "6:3"]); add(["13:4", "4:2"]); add(["12:3", "13:2", "5:4"]);
    add(["12:5", "12:5", "13:1", "6:3", "19:4"]);
    add(["4:1", "5:3", "6:4", "18:2", "19:5"]);
  }
  const rows = [], scope = [];
  for (const sid of extended ? [10000100, 10000101, 10000102, 10000103, 10001303, 10001403, 10001703, 10002003, 10003803] : [10000103, 10001303, 10001403]) {
    assert.ok(JSON.parse(session.describeChart(sid)).missions.includes(1));
    const bt = { rank: 3, justRate: 0.1, percents: battle.byScore.get(sid).percents };
    if (extended) bt.ranks = [1, 2, 3, 4, 5];
    const cb = S.comboBoostsWith(session, ctx, bt, sid, keys);
    const run = S.chartRunner(session, sid, S.gekisouPlay(bt, bt.percents, m.justTypes));
    const cache = new Map();
    const score = (ks, match, support) => {
      const ck = [ks.join("+"), match, support].join("|");
      if (!cache.has(ck)) {
        const hosts = Array.from({ length: 5 }, (_, i) => {
          const gk = (ks[i] || "1:1").split(":").map(Number);
          const row = m.gekisouSkills.get(gk[0]);
          return {
            liveSkill: null, supportSkills: [], cardType: 0, tagIds: [], liveSkillCategories: [],
            bandId: match ? ctx.bandId : 0, characterId: match ? ctx.characterId : 0,
            gekisouSkill: gk, gekisouMissionType: row._gekisouMissionType,
            gekisouSkillCategories: row._skillCategories || [],
            gekisouSupportSkills: support ? [[ctx.support, ctx.top]] : [],
          };
        });
        cache.set(ck, run(1e6, hosts, [0, 1, 2, 3, 4], 0));
      }
      return cache.get(ck);
    };
    for (const match of [0, 1]) {
      const baselineGain = score([], match, true) - score([], match, false);
      assert.ok(baselineGain > 0);
      // The direct replay and measurement API must agree for every individually measured skill.
      for (const k of keys) {
        const share = (score([k], match, true) - score([k], match, false)) / baselineGain - 1;
        assert.ok(Math.abs(share - E.comboCountBoost(cb, [k], match)) < 1e-10, `${sid} ${k} match=${match}`);
      }
      for (const [combo, ks] of combos) {
        const without = score(ks, match, false), actualTotal = score(ks, match, true);
        const actualGain = actualTotal - without;
        const predictedShare = E.comboCountBoost(cb, ks, match);
        const predictedGain = baselineGain * (1 + predictedShare);
        assert.ok(predictedShare <= cb.s[match] + 1e-10, "search bound must cover the combination");
        assert.strictEqual(E.comboCountBoost(cb, ks.slice().reverse(), match), predictedShare, "member order must not affect the combination");
        rows.push({ sid, match, combo, predictedShare, actualShare: actualGain / baselineGain - 1,
          supportErrorPct: 100 * (predictedGain / actualGain - 1),
          // Exact member-only score + approximate support contribution; not the full search's total error.
          totalErrorPct: 100 * ((without + predictedGain) / actualTotal - 1),
          predictedTotal: without + predictedGain, actualTotal });
      }
    }
    const pair = ["4:1", "12:1"];
    const small = S.comboBoosts(session, m, bt, sid, pair, support, 1);
    for (const match of [0, 1]) {
      assert.strictEqual(E.comboCountBoost(small, pair, match), E.comboCountBoost(cb, pair, match), "unrelated owned skills must not affect the estimate");
      assert.strictEqual(small.s[match], cb.s[match], "roster-independent bound");
    }
    const before = [0, 1].map((match) => E.comboCountBoost(small, pair, match));
    const grown = S.comboBoosts(session, m, bt, sid, keys, support, 1, structuredClone(small));
    for (const match of [0, 1]) {
      assert.strictEqual(E.comboCountBoost(grown, pair, match), before[match], "warming/extending the cache must not change the same deck");
    }
    scope.push({ sid,
      small: [0, 1].map((match) => E.comboCountBoost(small, pair, match)),
      full: [0, 1].map((match) => E.comboCountBoost(cb, pair, match)) });
  }
  for (const r of rows) {
    assert.ok(Math.abs(r.supportErrorPct) < 1, `support accuracy ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.totalErrorPct) < 0.5, `total accuracy ${JSON.stringify(r)}`);
  }
  const result = { settings: { power: 1e6, rank: extended ? "mean 1-5" : 3, justRate: 0.1, support, supportLevel: ctx.top, keys },
    cases: rows.length, underestimated: rows.filter((r) => r.supportErrorPct < -1e-6).length,
    supportErrorRangePct: [Math.min(...rows.map((r) => r.supportErrorPct)), Math.max(...rows.map((r) => r.supportErrorPct))],
    totalErrorRangePct: [Math.min(...rows.map((r) => r.totalErrorPct)), Math.max(...rows.map((r) => r.totalErrorPct))],
    scope, rows };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    const display = (r) => ({ chart: r.sid, sameBand: r.match, combo: r.combo,
      predicted: (100 * r.predictedShare).toFixed(2) + "%", replay: (100 * r.actualShare).toFixed(2) + "%",
      supportError: r.supportErrorPct.toFixed(3) + "%", isolatedTotalError: r.totalErrorPct.toFixed(3) + "%" });
    console.table(rows.filter((r) => ["12:1+4:1", "13:1+4:1"].includes(r.combo)).map(display));
    console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
    console.log("Largest absolute support errors (all within 1%; isolated total within 0.5%):");
    console.table(rows.slice().sort((a, b) => Math.abs(b.supportErrorPct) - Math.abs(a.supportErrorPct)).slice(0, 5).map(display));
  }
  session.free();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
