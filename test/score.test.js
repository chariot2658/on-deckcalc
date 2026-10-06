// Score objective with snap skills: the search's best deck against ournotes-deck's proven best (its `recommend` with
// metric score: whole-live simulation with snap skills, mean over the 120 performance orders) for presets/my-roster.json,
// on the three challenge songs of event 1 (event parameter bonus) and three free lives; and the snap skill rates the
// replay measures (five copies in one run = the mean over positions; one rate per pairing key).
// Needs ../data/replay (node test/fetch-replay.js); skipped without it.
// Run: node test/score.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");

const root = path.join(__dirname, "..", "..");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata", "hk-tw-mo", t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const perPower = E.perPowerFromMusicData(md);
const sw = E.skillWeightsFromMusicData(md);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
const now = new Date("2026-10-06T12:00:00+08:00");

// ournotes-deck v0.0.3 (31d7448), recommend {execution: live theoreticalBest, scenario: challenge row / free, metric:
// score, strategy: branchAndBound} on deck data 0947498b with this roster: Complete, proven. The best deck as
// [leader, [member, snap] pairs], its power and expected score x 120.
const REF = [
  { mode: "challenge", musicId: 100109, scoreId: 10010903, leader: 58, pairs: [[32, 37], [39, 56], [58, 63], [59, 61], [60, 53]], power: 597530, sum: 358858224 },
  { mode: "challenge", musicId: 100056, scoreId: 10005603, leader: 58, pairs: [[32, 37], [39, 56], [58, 63], [59, 61], [60, 53]], power: 597530, sum: 366742512 },
  { mode: "challenge", musicId: 100063, scoreId: 10006303, leader: 58, pairs: [[32, 37], [39, 56], [58, 63], [59, 61], [60, 53]], power: 597530, sum: 353197224 },
  { mode: "normal", musicId: 100109, scoreId: 10010903, leader: 58, pairs: [[32, 51], [39, 56], [58, 53], [59, 61], [60, 60]], power: 479945, sum: 288321384 },
  { mode: "normal", musicId: 100054, scoreId: 10005403, leader: 58, pairs: [[32, 51], [39, 56], [58, 53], [59, 61], [60, 60]], power: 472565, sum: 280145040 },
  { mode: "normal", musicId: 100094, scoreId: 10009403, leader: 58, pairs: [[32, 51], [39, 56], [58, 53], [59, 61], [60, 60]], power: 479945, sum: 279067608 },
];

(async () => {
  const session = await loadReplay();
  if (!session) {
    console.log("skip: run node test/fetch-replay.js");
    return;
  }
  const rates = new Map(); // scoreId -> Map key -> rate
  for (const ref of REF) {
    const input = {
      master: m, event: ref.mode === "challenge" ? m.events.get(1) : null, mode: ref.mode, objective: "score",
      members: roster.members, snaps: roster.snaps, player: roster.player, perPowerByScore: perPower, skillWeights: sw,
      maxLevel: 40, difficulties: ["expert"], musicIds: [ref.musicId], topK: 3, now,
    };
    const scope = E.scoreScope(input);
    assert.deepStrictEqual(scope.scoreIds, [ref.scoreId]);
    if (!rates.has(ref.scoreId)) rates.set(ref.scoreId, new Map());
    const have = rates.get(ref.scoreId);
    const t0 = Date.now();
    const todo = scope.pairs.filter((p) => !have.has(p.key));
    for (const [k, v] of S.snapSkillRates(session, m, ref.scoreId, todo, null)) have.set(k, v);
    const t1 = Date.now();
    const out = E.search({ ...input, snapSkill: { byScore: new Map([[ref.scoreId, have]]) } });
    const d = out.results[0];
    const pairs = d.members.map((v, i) => [v.id, d.snaps[i] ? d.snaps[i].id : null]).sort((a, b) => a[0] - b[0]);
    assert.strictEqual(d.members[2].id, ref.leader, `${ref.mode} ${ref.scoreId} leader`);
    assert.deepStrictEqual(pairs, ref.pairs, `${ref.mode} ${ref.scoreId} pairs`);
    assert.strictEqual(d.power, ref.power);
    const sim = S.orderScores(session, ref.scoreId, d.power, S.performers(m, d.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel })), d.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null))));
    assert.ok(Math.abs(sim.mean * 120 - ref.sum) < 1e-3, `${ref.mode} ${ref.scoreId} simulated ${sim.mean * 120} vs ${ref.sum}`);
    // The search's estimate: music-data's live skill weights and the measured snap rates, linear in power.
    assert.ok(Math.abs(d.estScore / sim.mean - 1) < 5e-4, `estimate ${d.estScore} vs simulated ${sim.mean}`);
    console.log(`${ref.mode} ${ref.scoreId}: ${d.estScore} (simulated ${Math.round(sim.mean)} = ournotes-deck), snap skills +${d.snapScore};` +
      ` ${todo.length} pairings measured in ${t1 - t0} ms, search ${Date.now() - t1} ms`);
  }

  // Five copies in one run = the mean of the pairing alone at each position; pairings of one key score alike.
  const sid = 10010903;
  const P = 1e6;
  const tpl = JSON.parse(session.template(sid, P, 60));
  const run = (ps, order) => JSON.parse(session.run(JSON.stringify({ ...tpl, performers: ps, skillOrder: order || [0, 1, 2, 3, 4] }))).score;
  const views = roster.members.map((o) => [o, E.memberView(m, o, roster.player)]);
  const snaps = roster.snaps.map((o) => [o, E.snapView(m, o)]);
  const byKey = new Map();
  for (const [mo, v] of views) for (const [so, s] of snaps) {
    const k = E.snapSkillKey(m, v, s);
    if (k) byKey.set(k, (byKey.get(k) || []).concat([{ key: k, member: mo, snap: so }]));
  }
  const measured = rates.get(sid);
  let checked = 0;
  for (const list of [...byKey.values()].filter((l) => l.length > 1).slice(0, 6)) {
    const other = list[list.length - 1];
    const r = S.snapSkillRates(session, m, sid, [other], null).get(other.key);
    assert.ok(Math.abs(r - measured.get(other.key)) < 1e-9, `key ${other.key}: ${r} vs ${measured.get(other.key)}`);
    const p = S.performers(m, [other.member], [other.snap])[0];
    const bare = (q) => ({ ...q, liveSkill: null, supportSkills: [] });
    let sum = 0;
    for (let k = 0; k < 5; k++) {
      const alone = (q) => [0, 1, 2, 3, 4].map((j) => (j === k ? q : bare(q)));
      sum += run(alone(p)) - run(alone({ ...p, supportSkills: [] }));
    }
    assert.ok(Math.abs(sum / 5 / P - r) < 1e-9, `positions ${sum / 5 / P} vs five copies ${r}`);
    checked++;
  }
  assert.ok(checked >= 3);
  console.log(`${checked} pairing keys: same rate for another pairing of the key, five copies = mean over positions`);
  console.log("ok");
})();
