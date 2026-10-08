// A helper of worker.js with a replay of its own, so that several charts run at once. Tasks (one chart each):
//   {type: "rates", scoreId, jobs, gekisou}: snap skill rates (Simulate.measureSnapJobs) -> [[key, rate]]
//   {type: "mean", scoreId, gekisou, items: [{power, perf, seeds, total, from}]}: Simulate.meanScore of each -> [mean]
//   {type: "combo", scoreId, ctx, bt: {rank, justRate}, keys, entry}: COMBO count-up shares (Simulate.comboBoostsWith)
// Replies {type: "done", out}, {type: "progress", done} (jobs or runs) meanwhile, or {type: "error", message}.
importScripts("simulate.js");

let session = null; // Promise of a ReplaySession
const runners = new Map(); // scoreId and Gekisou -> Simulate.chartRunner

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (!session) session = Simulate.loadReplay(msg.replay.musicDataUrl, msg.replay.pointer);
    const s = await session;
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
    } else if (msg.type === "mean") {
      const g = msg.gekisou;
      const key = msg.scoreId + "|" + (g ? g.ranks.join(",") + ":" + g.justRate : "");
      if (!runners.has(key)) runners.set(key, Simulate.chartRunner(s, msg.scoreId, g));
      const run = runners.get(key);
      let runs = 0;
      const counted = (power, perf, order, seed) => {
        progress(++runs);
        return run(power, perf, order, seed);
      };
      self.postMessage({ type: "done", out: msg.items.map((it) => Simulate.meanScore(counted, it.power, it.perf, it.seeds, it.total, it.from)) });
    } else if (msg.type === "combo") {
      self.postMessage({ type: "done", out: Simulate.comboBoostsWith(s, msg.ctx, msg.bt, msg.scoreId, msg.keys, msg.entry) });
    }
  } catch (err) {
    session = null;
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
