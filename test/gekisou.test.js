// Multiplayer lives with Gekisou: the search's Gekisou score (music-data seeds, the rank bonus formula, the Just rate,
// members' Gekisou skills) against the replay simulation, and the room rank of results/IMG_0030–31.
// The simulation part needs ../data/replay (node test/fetch-replay.js) and is skipped without it.
// Run: node test/gekisou.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");
const E = require("../engine.js");
const S = require("../simulate.js");

const root = path.join(__dirname, "..", "..");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata", "hk-tw-mo", t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const perPower = E.perPowerFromMusicData(md);
const sw = E.skillWeightsFromMusicData(md);
const battle = E.battleFromMusicData(md);
const P = battle.power;
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
const event = m.events.get(1);

// At rank 1 with every Just-count note Just, the rate is music-data's seed mean (its rank 1 play).
const top = E.battleRates(battle, 1, 1);
for (const [sid, b] of battle.byScore) {
  const mean = b.seeds.reduce((a, s) => a + s.score, 0) / b.seeds.length;
  assert.ok(Math.abs(top.perPower.get(sid) * P - mean) < 1e-6, "chart " + sid);
}
console.log(`${battle.byScore.size} charts with Gekisou data, ${battle.shapes.size} member Gekisou skills measured`);

// IMG_0030–31: TearJerker EXPERT, own score 1152964 (C) — the score without Gekisou — while the room reached B. The
// room's B threshold for 5 players is 20638445; with Gekisou the own score per unit of power is much higher.
const input = {
  master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
  perPowerByScore: perPower, skillWeights: sw, battle, maxLevel: 27, boosts: 3, topK: 1, musicIds: [100094], difficulties: ["expert"],
  now: new Date("2026-10-01T12:00:00+08:00"),
};
const solo = E.search({ ...input, multi: { players: 5, othersScore: 4 * 4.9e6 }, battle: null }).results[0];
const room = E.search({ ...input, multi: { players: 5, othersScore: 4 * 4.9e6, gekisouRank: 3, justRate: 0.5 } });
const d = room.results[0];
console.log(`TearJerker: score per power without Gekisou ${solo.scoreRate.toFixed(3)}, with Gekisou (rank 3) ${d.scoreRate.toFixed(3)};`,
  `deck ${d.displayPower}: ${d.estScore}`,
  `(live skills +${d.estScore - d.baseScore - d.gekisouScore}, Gekisou skills +${d.gekisouScore}); room ${d.rankName}`);
assert.strictEqual(d.rankName, "B");
assert.ok(d.scoreRate > 1.5 * solo.scoreRate);
assert.deepStrictEqual(room.gekisou, { rank: 3, justRate: 0.5 });
// The assumed rank is at most the room size.
assert.strictEqual(E.search({ ...input, multi: { players: 2, othersScore: 0, gekisouRank: 5 } }).gekisou.rank, 2);

(async () => {
  const dir = path.join(root, "data", "replay");
  if (!fs.existsSync(path.join(dir, "deck-data.json"))) {
    console.log("skip simulation: run node test/fetch-replay.js");
    console.log("ok");
    return;
  }
  const mod = await import(pathToFileURL(path.join(dir, "engine", "ournotes_replay.js")).href);
  mod.initSync({ module: fs.readFileSync(path.join(dir, "engine", "ournotes_replay_bg.wasm")) });
  const session = new mod.ReplaySession(fs.readFileSync(path.join(dir, "deck-data.json"), "utf8"));
  const gk = (sid, rank, justRate, seeds) => ({
    ranks: [rank, rank, rank], justRate, justTypes: m.justTypes, seeds: seeds || battle.byScore.get(sid).seeds.map((x) => x.seed),
  });
  const empty = S.performers(m, [0, 0, 0, 0, 0].map(() => ({ id: -1 })), [null, null, null, null, null]);

  // No skills: the simulation equals the rates at any rank (the rank bonus is linear in each range's score) and at
  // Just rate 0 or 1, on luck charts too (seed mean); between them the linear Just rate is within 0.5%.
  for (const missions of ["111", "333", "231", "222"]) {
    const song = md.songs.find((s) => s.gekisouMissions.join("") === missions);
    const sid = song.charts[3].scoreId;
    for (const [rank, j] of [[1, 1], [3, 1], [3, 0], [5, 0], [3, 0.5], [4, 0.7]]) {
      const model = E.battleRates(battle, rank, j).perPower.get(sid) * P;
      const sim = S.orderScores(session, sid, P, empty, gk(sid, rank, j)).base;
      if (j === 0 || j === 1) assert.ok(Math.abs(sim - model) < 1e-6, `${sid} rank ${rank} Just ${j}: ${sim} vs ${model}`);
      else assert.ok(Math.abs(sim / model - 1) < 0.005, `${sid} rank ${rank} Just ${j}: ${sim} vs ${model}`);
    }
  }

  // A member's Gekisou skill alone at the top level adds what music-data measured (charts without luck ranges, where
  // the seed does not matter); a lower level is the measured gain times its simulated level factor.
  const bt = E.battleRates(battle, 3, 1);
  const cards = m.t.MasterMemberCard.filter((c, i, a) => a.findIndex((x) => x._gekisouSkillID === c._gekisouSkillID) === i);
  const pairs = cards.flatMap((c) => [1, 3].map((l) => [c._gekisouSkillID, l]));
  const levels = S.gekisouLevelFactors(session, m, battle, bt, pairs);
  for (const missions of ["111", "333"]) {
    const song = md.songs.find((s) => s.gekisouMissions.join("") === missions);
    const sid = song.charts[2].scoreId;
    const base = S.orderScores(session, sid, P, empty, gk(sid, 3, 1)).base;
    for (const c of cards) {
      for (const lv of [5, 1, 3]) {
        const v = E.memberView(m, { id: c._id, level: 1, gekisouSkillLevel: lv }, {});
        const est = E.gekisouSkillRate(m, battle, bt, v, sid, levels) * P;
        const perf = empty.slice();
        perf[0] = { ...S.performers(m, [{ id: c._id, gekisouSkillLevel: lv }], [null])[0], liveSkill: null };
        const inc = S.orderScores(session, sid, P, perf, gk(sid, 3, 1)).base - base;
        if (!est && !inc) continue;
        console.log(`  ${sid} Gekisou skill ${c._gekisouSkillID} Lv${lv}: search ${Math.round(est)}, simulated ${inc}`);
        if (lv === 5) assert.ok(Math.abs(est - inc) <= 3);
        else assert.ok(Math.abs(est / inc - 1) < 0.35);
      }
    }
  }

  // The best multiplayer deck of the roster: the simulation (snap skills, Gekisou support skills, all 120 orders)
  // against the search's estimate.
  const all = E.search({ ...input, musicIds: undefined, difficulties: undefined, gekisouLevels: levels, multi: { players: 5, othersScore: 4 * 4.9e6, gekisouRank: 3, justRate: 1 } });
  const best = all.results[0];
  const members = best.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel }));
  const snaps = best.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null));
  const sid = best.chart.scoreId;
  const t0 = Date.now();
  const sim = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps), gk(sid, 3, 1));
  const noSnap = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps.map(() => null)), gk(sid, 3, 1));
  console.log(`best deck on ${m.text(m.musics.get(best.chart.musicId)._titleTextID)} ${best.chart.difficulty}: search ${best.estScore}`,
    `(Gekisou skills +${best.gekisouScore}); simulated without snaps ${Math.round(noSnap.mean)}, with snaps ${Math.round(sim.mean)}`,
    `(orders ${sim.scores[0]}–${sim.scores[119]}, ${Date.now() - t0} ms)`);
  assert.ok(sim.gekisou && sim.exact);
  assert.ok(Math.abs(noSnap.mean / best.estScore - 1) < 0.05);
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
