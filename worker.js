// Runs the deck search and the live simulation off the main thread.
importScripts("engine.js", "simulate.js");

let master = null;
let perPower = null;
let lengths = null;
let skillWeights = null;
let replay = null; // {musicDataUrl, pointer}
let session = null; // Promise of a ReplaySession, loaded on the first simulation

// A deck without engine views, for postMessage.
function slim(d) {
  return {
    members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank, skillLevel: v.liveSkillLevel })),
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
    baseScore: d.baseScore,
    scoreRate: d.scoreRate,
    accuracy: d.accuracy,
    rankChance: d.rankChance === undefined ? null : d.rankChance,
    rankDist: d.rankDist || null,
    minutes: d.minutes || null,
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      master = Engine.buildMaster(msg.raw, msg.lang);
      perPower = new Map(msg.perPower);
      lengths = new Map(msg.lengths || []);
      skillWeights = msg.skillWeights
        ? { kinds: msg.skillWeights.kinds, byScore: new Map(msg.skillWeights.byScore.map(([k, w]) => [k, Float64Array.from(w)])) }
        : null;
      replay = msg.replay || null;
      session = null;
      self.postMessage({ type: "ready" });
    } else if (msg.type === "search") {
      const event = master.events.get(msg.eventId);
      const out = Engine.search({ ...msg.input, master, event, perPowerByScore: perPower, skillWeights, lengthByScore: lengths, now: new Date(msg.now) });
      const results = out.results.map(slim);
      const songs = (out.songs || []).map(slim);
      self.postMessage({ type: "result", id: msg.id, error: out.error || null, results, songs, rate: out.rate, stats: out.stats });
    } else if (msg.type === "simulate") {
      simulate(msg);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
};

// msg.decks: [{scoreId, power, members: [{id, skillLevel}], snaps: [{id, rank} | null]}] -> the order scores of each.
async function simulate(msg) {
  try {
    if (!replay) throw new Error("music-data.json has no replay data");
    if (!session) session = Simulate.loadReplay(replay.musicDataUrl, replay.pointer);
    const s = await session;
    const out = msg.decks.map((d) => Simulate.orderScores(s, d.scoreId, d.power, Simulate.performers(master, d.members, d.snaps)));
    self.postMessage({ type: "sim", id: msg.id, out });
  } catch (err) {
    session = null;
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
}
