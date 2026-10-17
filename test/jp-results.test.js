// 2026-10-13 日服 results/IMG_0120–0132：依截圖重建隊伍，確認綜合力與實測分數範圍。
// 演出／激奏技能：52、56、60 為 Lv2（同步檔），32、44 為 Lv1（使用者確認）。
// 只有 IMG_0120 的三段第一可由最佳表現獎牌確認；其餘場次不假定實際區間名次。
// Run: node test/jp-results.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");

const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t,
  JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/jp", t + ".json"), "utf8")),
]));
const m = E.buildMaster(raw, "_japanese");
const player = {
  vipRank: 3,
  characterRanks: { 1: 9, 2: 10, 3: 5, 4: 5, 5: 5, 6: 8, 7: 7, 8: 12, 9: 5, 10: 11, 11: 13, 12: 8,
    13: 6, 14: 13, 15: 8, 16: 9, 17: 6, 18: 5, 19: 7, 20: 6, 21: 9, 22: 5, 23: 5, 24: 5, 25: 5 },
  bandItems: { 102: 1, 201: 1, 203: 1, 204: 1, 205: 1, 303: 1, 403: 1, 503: 1 },
};
const members = [
  { id: 52, level: 70, awake: 3, rank: 3, skillLevel: 2, gekisouSkillLevel: 2 },
  { id: 56, level: 70, awake: 3, rank: 1, skillLevel: 2, gekisouSkillLevel: 2 },
  { id: 60, level: 70, awake: 3, rank: 1, skillLevel: 2, gekisouSkillLevel: 2 },
  { id: 32, level: 60, awake: 3, rank: 1 },
  { id: 44, level: 40, awake: 1, rank: 1 },
];
const snaps = [
  { id: 55, level: 50, rank: 1 }, { id: 56, level: 60, rank: 2 }, { id: 58, level: 50, rank: 1 },
  { id: 33, level: 70, rank: 4 }, { id: 19, level: 40, rank: 2 },
];
const cases = [
  { musicId: 100075, power: 553265, members, snaps, soloScores: [2921928, 2935817],
    observedFirst: 8709017, observedOther: 7173186 },
  { musicId: 100005, power: 585723,
    members: members.map((o, i) => i === 4 ? { id: 45, level: 40, awake: 1, rank: 1 } : o),
    snaps: snaps.map((o, i) => i === 4 ? { id: 41, level: 40, rank: 1 } : o),
    soloScores: [3033402], observedOther: 7690084 },
];
const range = (s) => [Math.round(s.scores[0]), Math.round(s.mean), Math.round(s.scores.at(-1))];
const contains = (s, score) => s.scores[0] <= score && score <= s.scores.at(-1);

(async () => {
  const session = await loadReplay();
  for (const c of cases) {
    const mv = c.members.map((o) => E.memberView(m, o, player)), sv = c.snaps.map((o) => E.snapView(m, o));
    assert.strictEqual(E.deckPower(m, mv, sv, E.musicView(m, c.musicId),
      E.makeContext(m, player, null, mv, sv, "normal")), c.power);
    const sid = m.musics.get(c.musicId)._expertID;
    console.log(`${m.text(m.musics.get(c.musicId)._titleTextID)}：綜合力 ${c.power} 精確`);
    if (!session) continue;
    const perf = S.performers(m, c.members, c.snaps);
    const solo = S.orderScores(session, sid, c.power, perf);
    for (const score of c.soloScores) assert.ok(contains(solo, score), `一般分數 ${score} 應在模擬範圍內`);
    console.log("  一般分數 最低／平均／最高", range(solo));
    const gk = (rank) => S.orderScores(session, sid, c.power, perf,
      { ranks: [rank, rank, rank], justRate: 0.1, justTypes: m.justTypes });
    const first = gk(1), second = gk(2), third = gk(3);
    if (c.observedFirst) assert.ok(contains(first, c.observedFirst), "三段 COMBO 第一的實測應在模擬範圍內");
    // 其餘場次只展示「三段第二」是可行解釋，不把它當成截圖已確認的名次。
    console.log("  三段第一", range(first), "三段第二", range(second), "三段第三", range(third));
    console.log(`  其餘場實測 ${c.observedOther}；三段第二範圍可涵蓋：${contains(second, c.observedOther)}`);
    console.log("  同步設定 99% Perfect／斷 combo 2 次的平均保留率",
      E.accuracyFactor(m, sid, { perfectRate: 0.99, breaks: 2 }));
  }
  if (!session) console.log("略過分數模擬：先執行 node test/fetch-replay.js");
})().catch((e) => { console.error(e); process.exitCode = 1; });
