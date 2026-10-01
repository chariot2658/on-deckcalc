// Runs the deck search off the main thread.
importScripts("engine.js");

let master = null;
let perPower = null;
let lengths = null;

// A deck without engine views, for postMessage.
function slim(d) {
  return {
    members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank })),
    snaps: d.snaps.map((s) => (s ? { id: s.id, level: s.level, rank: s.rank } : null)),
    power: d.power,
    displayPower: d.displayPower,
    rank: d.rank,
    rankName: d.rankName,
    chart: d.chart,
    needDisplayPower: d.needDisplayPower,
    nextRankName: d.nextRankName || null,
    nextNeedDisplayPower: d.nextNeedDisplayPower || null,
    pointBonus: d.pointBonus,
    itemBonus: d.itemBonus,
    points: d.points,
    items: d.items,
    cp: d.cp,
    cpPoints: d.cpPoints,
    estScore: d.estScore,
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      master = Engine.buildMaster(msg.raw, msg.lang);
      perPower = new Map(msg.perPower);
      lengths = new Map(msg.lengths || []);
      self.postMessage({ type: "ready" });
    } else if (msg.type === "search") {
      const event = master.events.get(msg.eventId);
      const out = Engine.search({ ...msg.input, master, event, perPowerByScore: perPower, lengthByScore: lengths, now: new Date(msg.now) });
      const results = out.results.map(slim);
      const songs = (out.songs || []).map(slim);
      self.postMessage({ type: "result", id: msg.id, error: out.error || null, results, songs, rate: out.rate, stats: out.stats });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
};
