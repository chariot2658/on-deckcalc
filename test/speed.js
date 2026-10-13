// Saved-deck benchmark, including replay preparation and simulation; --helpers uses real Node worker threads.
// node test/speed.js [--all] [--score] [--fixed] [--breaks=2] [--repeat] [--helpers] [--quick] [--check-cache]
//   [--helper-count=6] [--changed] [--roster=path] [--engine=path] [--worker=path] [--simulate=path] [--simworker=path] [--out=path] [--compare=path]
// --fixture=path writes the init/request (tagged Map/Set JSON) for a browser test instead of running it.
// --out saves the complete result (without timings) for an exact before/after comparison.
// --changed also compares a recalculation at 98% Perfect (saved as <out>.changed); use node --cpu-prof for profiles.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const assert = require("assert");
const { Worker } = require("worker_threads");
const loadReplay = require("./replay.js");
const args = process.argv.slice(2);
const option = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const E = require(path.resolve(option("engine") || path.join(__dirname, "../engine.js")));
const S = require(path.resolve(option("simulate") || path.join(__dirname, "../simulate.js")));
const root = path.join(__dirname, "../..");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json"), "utf8"));
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json"), "utf8"));
const rosterFile = path.join(__dirname, "../presets/browser-roster-hk-tw-mo.json");
const roster = JSON.parse(fs.readFileSync(option("roster") || (fs.existsSync(rosterFile) ? rosterFile : path.join(__dirname, "../presets/my-roster.json")), "utf8"));
const master = E.buildMaster(raw, "_traditionalChinese");
const all = args.includes("--all");
const members = all ? master.t.MasterMemberCard.map((c) => {
  const L = E.memberLimits(master, c);
  return { id: c._id, level: L.limit(L.maxAwake), awake: L.maxAwake, rank: 1,
    skillLevel: master.liveSkillMaxLevel.get(c._liveSkillID) || 1, gekisouSkillLevel: 5 };
}) : roster.members;
const snaps = all ? master.t.MasterSupportCard.map((s) => ({ id: s._id, level: E.snapLimit(master, s, 5), rank: 5 })) : roster.snaps;

(async () => {
  const replay = await loadReplay();
  if (!replay) throw new Error("Missing replay: run node test/fetch-replay.js");
  let result;
  let stage;
  let stageStart;
  let pass = "first";
  const stages = {};
  const finishStage = () => {
    if (stageStart !== undefined) {
      stages[stage] = (stages[stage] || 0) + Date.now() - stageStart;
      stageStart = undefined;
    }
  };
  let failedSearch = false;
  const context = vm.createContext({
    Engine: { ...E, search(input) {
      const out = E.search(input);
      console.log("search", input.musicIds.length, "songs", input.multi.pickSong ? "individual" : "random", out.stats);
      return out;
    } },
    Simulate: { ...S, loadReplay: async () => replay },
    importScripts() {}, console,
    Worker: args.includes("--helpers") ? class {
      constructor() {
        this.worker = new Worker(path.join(__dirname, "speed-helper.js"), { workerData: {
          engine: option("engine"), simulate: option("simulate"), simworker: option("simworker"),
        } });
        this.worker.on("message", (data) => {
          if (data.type === "done" && this.query) {
            console.log("search", this.query, data.out.stats);
            this.query = null;
          }
          if (this.onmessage) this.onmessage({ data });
        });
        this.worker.on("error", (err) => this.onerror && this.onerror(err));
      }
      postMessage(msg) {
        if (msg.type === "search") this.query = `${msg.input.musicIds.length} songs ${msg.input.multi.pickSong ? "individual" : "random"}`;
        if (args.includes("--fail-search") && msg.type === "search" && !failedSearch) {
          failedSearch = true;
          throw new Error("injected search helper failure");
        }
        this.worker.postMessage(msg);
      }
      terminate() { this.worker.terminate(); }
    } : undefined,
    self: { navigator: { hardwareConcurrency: Number(option("helper-count") || 6) + 1 }, postMessage(msg) {
      if (msg.type === "error") throw new Error(msg.message);
      if (msg.type === "saved") {
        result = msg;
        finishStage();
        console.log("stages", pass, stages);
      }
      if (msg.type === "progress" && msg.stage !== stage) {
        finishStage();
        console.log("stage", stage = msg.stage);
        stageStart = Date.now();
      }
    } },
  });
  vm.runInContext(fs.readFileSync(option("worker") || path.join(__dirname, "../worker.js"), "utf8"), context);
  context.init = { type: "init", raw, lang: "_traditionalChinese", perPower: [...E.perPowerFromMusicData(md)],
    lengths: [...E.chartLengthsFromMusicData(md)], skillWeights: E.skillWeightsFromMusicData(md), battle: E.battleFromMusicData(md),
    replay: { musicDataUrl: "local", pointer: md.replay } };
  context.init.skillWeights.byScore = [...context.init.skillWeights.byScore];
  vm.runInContext("self.onmessage({data: init})", context);
  context.msg = { type: "saved", id: 1, eventId: 2, now: "2026-10-12T00:00:00Z", input: {
    mode: "normal", objective: args.includes("--score") ? "score" : "points", members, snaps, player: roster.player,
    maxLevel: 40, boosts: 3, difficulties: ["easy", "normal", "hard", "expert"],
    accuracy: { perfectRate: 1, breaks: Number(option("breaks") || 0) },
    multi: { players: 5, auto: !args.includes("--fixed"), othersScore: 4 * 5e6, gekisouRank: 3, justRate: 0.5 },
  } };
  if (args.includes("--quick")) {
    context.msg.input.members = members.slice(0, 14);
    context.msg.input.snaps = snaps.slice(0, 8);
    context.msg.input.musicIds = E.gekisouSongGroups({ ...context.msg.input, master, battle: context.init.battle,
      perPowerByScore: E.perPowerFromMusicData(md), now: new Date(context.msg.now) }).map((g) => g.musicIds[0]);
  }
  console.log("fixture", { node: process.version, members: context.msg.input.members.length, snaps: context.msg.input.snaps.length,
    objective: context.msg.input.objective, helpers: args.includes("--helpers") ? context.self.navigator.hardwareConcurrency - 1 : 0,
    master: crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    musicData: crypto.createHash("sha256").update(JSON.stringify(md)).digest("hex"),
    roster: crypto.createHash("sha256").update(JSON.stringify(roster)).digest("hex"), input: { ...context.msg.input, members: undefined, snaps: undefined, player: undefined } });
  if (option("fixture")) {
    fs.writeFileSync(option("fixture"), JSON.stringify({ init: context.init, msg: context.msg }, (_, v) =>
      v instanceof Map ? { mapEntries: [...v] } : v instanceof Set ? { setValues: [...v] } : ArrayBuffer.isView(v) ? [...v] : v));
    return;
  }
  const recalc = (label) => {
    pass = label;
    stage = "prepare";
    stageStart = Date.now();
    for (const k of Object.keys(stages)) delete stages[k];
    return vm.runInContext("savedDecks(msg)", context);
  };
  await recalc("first");
  if (!result || result.error) throw new Error(JSON.stringify(result));
  console.log("total", result.stats);
  const withoutStats = (out) => { const { stats, ...rest } = out; return JSON.stringify(rest); };
  const json = withoutStats(result);
  console.log("sha256", crypto.createHash("sha256").update(json).digest("hex"));
  if (option("out")) fs.writeFileSync(option("out"), json);
  if (option("compare")) assert.strictEqual(json, fs.readFileSync(option("compare"), "utf8"), "before/after output must be exactly identical");
  if (args.includes("--repeat") || args.includes("--check-cache")) {
    await recalc("repeat");
    console.log("repeat", result.stats);
    assert.strictEqual(withoutStats(result), json, "cached output must be exactly identical");
    assert.strictEqual(result.stats.runs, 0, "repeat must reuse every replay sample");
  }
  if (args.includes("--changed")) {
    context.msg.input.accuracy.perfectRate = 0.98;
    await recalc("changed accuracy");
    assert.ok(!result.stats.cached, "changed accuracy must recalculate");
    console.log("changed", result.stats);
    if (option("out")) fs.writeFileSync(option("out") + ".changed", withoutStats(result));
    if (option("compare")) assert.strictEqual(withoutStats(result), fs.readFileSync(option("compare") + ".changed", "utf8"));
    context.msg.input.accuracy.perfectRate = 1;
  }
  if (args.includes("--check-cache")) {
    const originalId = context.msg.id;
    const originalNow = context.msg.now;
    context.msg.id++;
    context.msg.now = new Date(new Date(originalNow).getTime() + 1000).toISOString();
    await recalc("cache clock");
    assert.strictEqual(result.id, context.msg.id, "cached replies must carry the new request ID");
    assert.ok(result.stats.cached, "a later click with the same playable charts must hit the result cache");
    context.msg.id = originalId;
    context.msg.now = originalNow;
    for (const [obj, key, other] of [[context.msg.input.multi, "justRate", 0.25], [context.msg.input.multi, "auto", false],
      [context.msg.input.player, "flatBonus", (context.msg.input.player.flatBonus || 0) + 1000]]) {
      const original = obj[key];
      obj[key] = other;
      await recalc(`changed ${key}`);
      assert.ok(result.stats.runs > 0, `${key} must invalidate affected samples`);
      obj[key] = original;
      await recalc(`restored ${key}`);
      assert.strictEqual(withoutStats(result), json, `${key} restored must reproduce the original`);
      assert.strictEqual(result.stats.runs, 0, `${key} restored must reuse samples`);
    }
    vm.runInContext("self.onmessage({data: init})", context);
    await recalc("reinitialised");
    assert.ok(result.stats.runs > 0, "master/replay init must clear cached samples");
    assert.strictEqual(withoutStats(result), json, "reinitialisation must reproduce the original");
    console.log("cache: new request ID/clock, Just rate, opponent assumptions, power, master/replay OK");
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
