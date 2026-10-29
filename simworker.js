// A helper of worker.js with a replay of its own, so that several charts run at once. Tasks (one chart each):
//   {type: "rates", scoreId, jobs, gekisou}: snap skill rates (Simulate.measureSnapJobs) -> [[key, rate]]
//   {type: "mean", scoreId, gekisou, items: [{power, perf, seeds, total, from}]}: Simulate.meanScore of each -> [mean]
//   {type: "samples", ...same as mean}: individual run scores of each -> [[score]]
//   {type: "combo", scoreId, ctx, bt: {rank, justRate}, keys, entry}: COMBO count-up shares (Simulate.comboBoostsWith)
//   {type: "search", master: {raw, lang}, input}: one complete Engine.search (no song splitting)
//   {type: "arena", scoreId, spec}: a chart measured with 激奏舞台's missions (Simulate.measureBattleChart) -> entry
// A task with `patch` (Simulate.patchDeck: 激奏舞台's missions) plays on a replay of the patched deck data.
// Replies {type: "done", out}, {type: "progress", done} (jobs or runs) meanwhile, or {type: "error", message}.
importScripts("engine.js", "simulate.js");

const sessions = new Map(); // the patch's missions ("" without) -> Promise of a ReplaySession
let master = null; // lazily indexed for whole-scope searches
const runners = new Map(); // missions, scoreId and Gekisou -> Simulate.chartRunner

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "search") {
      if (!master) {
        master = Engine.buildMaster(msg.master.raw, msg.master.lang);
      }
      const { ctx, payoff, ...out } = Engine.search({ ...msg.input, master });
      self.postMessage({ type: "done", out });
      return;
    }
    const sk = msg.patch ? msg.patch.missions.join("") : "";
    if (!sessions.has(sk)) sessions.set(sk, Simulate.loadReplay(msg.replay.musicDataUrl, msg.replay.pointer, msg.patch || undefined));
    const s = await sessions.get(sk);
    let last = 0;
    const progress = (n) => {
      const now = Date.now();
      if (now - last > 200) {
        last = now;
        self.postMessage({ type: "progress", done: n });
      }
    };
    if (msg.type === "rates") {
      const out = Simulate.measureSnapJobs(s, msg.scoreId, msg.jobs, msg.gekisou, progress);
      self.postMessage({ type: "done", out: [...out] });
    } else if (msg.type === "mean" || msg.type === "samples") {
      const g = msg.gekisou;
      const key = sk + "|" + msg.scoreId + "|" + (g ? g.ranks.join(",") + ":" + g.justRate + (g.mean ? ":" + JSON.stringify(g.mean) : "") : "");
      if (!runners.has(key)) runners.set(key, Simulate.chartRunner(s, msg.scoreId, g));
      const run = runners.get(key);
      let runs = 0;
      const counted = (power, perf, order, seed) => {
        progress(++runs);
        return run(power, perf, order, seed);
      };
      const measure = msg.type === "samples" ? Simulate.sampleScores : Simulate.meanScore;
      self.postMessage({ type: "done", out: msg.items.map((it) => measure(counted, it.power, it.perf, it.seeds, it.total, it.from)) });
    } else if (msg.type === "combo") {
      self.postMessage({ type: "done", out: Simulate.comboBoostsWith(s, msg.ctx, msg.bt, msg.scoreId, msg.keys, msg.entry) });
    } else if (msg.type === "arena") {
      self.postMessage({ type: "done", out: Simulate.measureBattleChart(s, msg.scoreId, msg.spec, progress) });
    }
  } catch (err) {
    sessions.clear();
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
