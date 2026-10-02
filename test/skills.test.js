// Live skills: the search's expected live skill score (music-data.json weights) and the replay simulation (live and
// snap skills, every performance order) against results/IMG_0044–0046 (夢現妄想世界 EXPERT, 378468, 2026-10-02).
// The simulation part needs ../data/replay (node test/fetch-replay.js) and is skipped without it.
// Run: node test/skills.test.js
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
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
const event = m.events.get(1);

// Every live skill row of the master data has a music-data kind.
for (const e of m.t.MasterLiveSkillEffect) assert.ok(E.skillKindOf(sw.kinds, e), "no kind for live skill effect " + e._id);

// IMG_0044: [member, snap, snap rank], leader in slot 2; skill levels 1.
const team = [[32, 56, 1], [59, 63, 1], [60, 60, 3], [11, 37, 1], [39, 61, 3]];
const scoreId = 10005403;
const power = 378468;
const views = team.map(([id]) => E.memberView(m, { id, level: 1 }, {}));
const base = Math.floor(power * perPower.get(scoreId));
const est = Math.floor(power * (perPower.get(scoreId) + E.liveSkillRate(m, views, scoreId, sw)));
console.log("no skills", base, "expected with live skills", est);

(async () => {
  const dir = path.join(root, "data", "replay");
  if (!fs.existsSync(path.join(dir, "deck-data.json"))) {
    console.log("skip simulation: run node test/fetch-replay.js");
  } else {
    const mod = await import(pathToFileURL(path.join(dir, "engine", "ournotes_replay.js")).href);
    mod.initSync({ module: fs.readFileSync(path.join(dir, "engine", "ournotes_replay_bg.wasm")) });
    const session = new mod.ReplaySession(fs.readFileSync(path.join(dir, "deck-data.json"), "utf8"));
    const members = team.map(([id]) => ({ id, skillLevel: 1 }));
    const snaps = team.map(([, id, rank]) => ({ id, rank }));
    const t0 = Date.now();
    const full = S.orderScores(session, scoreId, power, S.performers(m, members, snaps));
    const ms = Date.now() - t0;
    const noSnap = S.orderScores(session, scoreId, power, S.performers(m, members, snaps.map(() => null)));
    console.log(`simulated (${ms} ms): no skills ${full.base}; live skills mean ${Math.round(noSnap.mean)};`,
      `live + snap skills mean ${Math.round(full.mean)}, orders ${full.scores[0]}–${full.scores[119]}`);
    // The search's expectation is within 0.1% of the simulated live skills alone (music-data weights are linear).
    assert.ok(Math.abs(est / noSnap.mean - 1) < 0.001);
    // Every order checked against the additive scores once.
    const exact = S.ORDERS.map((o) => JSON.parse(session.run(JSON.stringify({
      ...JSON.parse(session.template(scoreId, power, 60)), performers: S.performers(m, members, snaps), skillOrder: o,
    }))).score).sort((a, b) => a - b);
    assert.deepStrictEqual(full.scores, exact);
    assert.strictEqual(Math.round(full.mean), 1767907);
    // IMG_0045: the high score 1767821 lies inside the deck's range; the live shown (1 Miss, 11 Great, 1 Good) scored
    // 1637627, 92.6% of the mean.
    assert.ok(full.scores[0] <= 1767821 && 1767821 <= full.scores[119]);
    console.log("IMG_0045 1637627 / mean =", (1637627 / full.mean).toFixed(4));

    // Combo breaks: the closed form (equal note weights) against a simulated Miss at a few notes, one order.
    const tpl = JSON.parse(session.template(scoreId, power, 60));
    const perf = S.performers(m, members, snaps);
    const judged = tpl.frames.flatMap((f) => f.judgements).filter((j) => j.judgement === 5).map((j) => j.noteId);
    const play = (miss) => JSON.parse(session.run(JSON.stringify({
      ...tpl, performers: perf, skillOrder: [0, 1, 2, 3, 4],
      frames: miss === null ? tpl.frames : tpl.frames.map((f) => ({ ...f, judgements: f.judgements.map((j) => (j.noteId === judged[miss] ? { ...j, judgement: 1 } : j)) })),
    }))).score;
    const g = E.comboBreakFactors(m, judged.length);
    assert.strictEqual(judged.length, m.musicScores.get(scoreId)._fullComboCount);
    const allPerfect = play(null);
    for (const at of [100, 331, 502, 700]) {
      const sim = play(at) / allPerfect;
      console.log(`  Miss at note ${at}: simulated ${sim.toFixed(4)}, closed form ${g[at].toFixed(4)}`);
      assert.ok(Math.abs(sim - g[at]) < 0.015);
    }
    // IMG_0045's play (820 Perfect of 833, one Miss) lies in the range the UI shows for that accuracy.
    const great = 1 - 0.2 * (1 - 820 / 833);
    const lo = full.scores[0] * great * Math.min(...g), hi = full.scores[119] * great;
    console.log(`  98.4% Perfect, 1 break: ${Math.round(lo)}–${Math.round(hi)}, expected`,
      Math.round(full.mean * E.accuracyFactor(m, scoreId, { perfectRate: 820 / 833, breaks: 1 })));
    assert.ok(lo <= 1637627 && 1637627 <= hi);
  }

  // The search with live skills and an accuracy: the song comparison still equals per-song searches.
  const input = {
    master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
    perPowerByScore: perPower, skillWeights: sw, accuracy: { perfectRate: 0.984, breaks: 1 }, maxLevel: 27, boosts: 3, topK: 3, cpValue: 22,
    now: new Date("2026-10-01T12:00:00+08:00"),
  };
  const t1 = Date.now();
  const out = E.search({ ...input, compareSongs: true });
  console.log(`search with live skills (${Date.now() - t1} ms)`);
  for (const d of out.results) {
    console.log(`  ${d.rankName} ${d.points}pt ${m.text(m.musics.get(d.chart.musicId)._titleTextID)} ${d.chart.difficulty} ${d.chart.level}`,
      `power ${d.displayPower}/${d.needDisplayPower} score ${d.estScore} (no skills ${d.baseScore})`);
  }
  // With a combo break the payoff is an expectation over the ranks a deck may reach.
  for (const d of out.results.concat(out.songs)) {
    assert.ok(d.rankDist && Math.abs(d.rankDist.reduce((x, r) => x + r.p, 0) - 1) < 1e-9);
  }
  assert.strictEqual(out.songs[0].score, out.results[0].score);
  for (const d of out.songs.filter((_, i) => i % 10 === 0)) {
    const one = E.search({ ...input, musicIds: [d.chart.musicId], topK: 1 }).results[0];
    assert.strictEqual(d.score, one.score, "song " + d.chart.musicId);
  }
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
