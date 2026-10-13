// Compact replay requests must reproduce the complete template's results, including the explicit 60 Hz clock.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");
const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json")))]));
const master = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json")));
const battle = E.battleFromMusicData(md);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets/my-roster.json")));

(async () => {
  const session = await loadReplay();
  if (!session) throw new Error("Missing replay: run node test/fetch-replay.js");
  const perf = S.performers(master, roster.members.slice(0, 5), roster.snaps.slice(0, 5));
  const songs = ["111", "222", "333", "213"].map((kind) => md.songs.find((s) => s.gekisouMissions.join("") === kind));
  let checked = 0;
  for (const song of songs) {
    const sid = song.charts.find((c) => c.difficulty === "expert").scoreId;
    const b = battle.byScore.get(sid);
    const modes = [null, S.gekisouPlay({ rank: 3, justRate: 0.5 }, b.percents, master.justTypes),
      S.gekisouPlay({ ranks: [1, 2, 3, 4, 5], justRate: 0.25 }, b.percents, master.justTypes, [12345])];
    for (const g of modes) {
      let compact;
      let result;
      const observed = {
        template: (...args) => session.template(...args),
        describeChart: (...args) => session.describeChart(...args),
        run: (json) => {
          compact = JSON.parse(json);
          const out = session.run(json);
          result = JSON.parse(out);
          return out;
        },
      };
      const run = S.chartRunner(observed, sid, g);
      for (const power of [0, 378468, 1000000]) for (const seed of [0, -1234567]) {
        const order = [4, 0, 1, 2, 3];
        const score = run(power, perf, order, seed);
        let tpl = JSON.parse(session.template(sid, power, 60));
        if (g) tpl = S.gekisouRequest(session, tpl, sid, g);
        assert.deepStrictEqual(compact.frames.map((f) => [f.timeMs, Math.fround(f.deltaSeconds), f.judgements || [], f.liveFinished || false]),
          tpl.frames.map((f) => [f.timeMs, Math.fround(f.deltaSeconds), f.judgements, f.liveFinished]), "clock and judgements must be unchanged");
        const expected = JSON.parse(session.run(JSON.stringify({ ...tpl, performers: perf, skillOrder: order, seed })));
        assert.deepStrictEqual(result, expected, `complete replay result ${sid}, power ${power}, seed ${seed}`);
        assert.strictEqual(score, S.scoreOf(expected, g));
        checked++;
      }
      // The rate measurement's default seed must still be the first supplied seed, rather than zero.
      const scope = E.scoreScope({ master, members: roster.members, snaps: roster.snaps, player: roster.player,
        mode: "normal", objective: "score", perPowerByScore: E.perPowerFromMusicData(md), musicIds: [song.id],
        difficulties: ["expert"], now: new Date("2026-10-12T00:00:00Z") });
      const jobs = S.snapSkillJobs(master, scope.pairs.slice(0, 3));
      let tpl = JSON.parse(session.template(sid, 1e6, 60));
      if (g) tpl = S.gekisouRequest(session, tpl, sid, g);
      const reference = (p) => S.scoreOf(JSON.parse(session.run(JSON.stringify({ ...tpl, performers: [p, p, p, p, p] }))), g);
      const measured = S.measureSnapJobs(session, sid, jobs, g);
      for (const job of jobs) for (const key of job.keys) {
        assert.strictEqual(measured.get(key), (reference(job.p) - reference(job.bare)) / 5 / 1e6, `pair rate ${sid} ${key}`);
      }
    }
  }
  console.log(`${checked} compact/full replay results identical; pair rates and first supplied seeds identical`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
