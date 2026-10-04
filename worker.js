// Runs the deck search and the live simulation off the main thread.
importScripts("engine.js", "simulate.js");

let master = null;
let perPower = null;
let lengths = null;
let skillWeights = null;
let battle = null; // Engine.battleFromMusicData: multiplayer lives with Gekisou
let replay = null; // {musicDataUrl, pointer}
let session = null; // Promise of a ReplaySession, loaded on the first simulation

// A deck without engine views, for postMessage.
function slim(d) {
  return {
    members: d.members.map((v) => ({ id: v.id, level: v.level, awake: v.awake, rank: v.rank, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })),
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
    gekisouScore: d.gekisouScore === undefined ? null : d.gekisouScore,
    scoreRate: d.scoreRate,
    accuracy: d.accuracy,
    rankChance: d.rankChance === undefined ? null : d.rankChance,
    rankDist: d.rankDist || null,
    minutes: d.minutes || null,
    random: !!d.random,
    songCount: d.songCount || null,
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
      battle = msg.battle || null;
      replay = msg.replay || null;
      session = null;
      levelFactors.clear();
      self.postMessage({ type: "ready" });
    } else if (msg.type === "search") {
      search(msg);
    } else if (msg.type === "simulate") {
      simulate(msg);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
};

const replaySession = () => {
  if (!replay) throw new Error("music-data.json has no replay data");
  if (!session) session = Simulate.loadReplay(replay.musicDataUrl, replay.pointer);
  return session;
};

// Level factors of member Gekisou skills, by rank and Just rate ("rank:justRate" -> Map), simulated once each.
const levelFactors = new Map();
async function gekisouLevels(input) {
  const multi = input.multi;
  if (!multi || !battle || !battle.power || !replay) return null;
  const rank = Math.min(multi.gekisouRank || 1, Math.max(1, multi.players));
  const bt = Engine.battleRates(battle, rank, multi.justRate);
  const key = bt.rank + ":" + bt.justRate;
  if (!levelFactors.has(key)) levelFactors.set(key, new Map());
  const known = levelFactors.get(key);
  const pairs = [];
  for (const o of input.members) {
    const v = Engine.memberView(master, o, {});
    if (v && v.gekisouSkillId && !known.has(v.gekisouSkillId + ":" + v.gekisouSkillLevel)) pairs.push([v.gekisouSkillId, v.gekisouSkillLevel]);
  }
  if (pairs.length) {
    const s = await replaySession();
    for (const [k, f] of Simulate.gekisouLevelFactors(s, master, battle, bt, pairs)) known.set(k, f);
  }
  return known;
}

async function search(msg) {
  try {
    let levels = null;
    try {
      levels = await gekisouLevels(msg.input);
    } catch (err) {
      session = null;
      console.warn("Gekisou level factors unavailable", err);
    }
    const event = master.events.get(msg.eventId);
    const out = Engine.search({
      ...msg.input, master, event, perPowerByScore: perPower, skillWeights, battle, gekisouLevels: levels, lengthByScore: lengths, now: new Date(msg.now),
    });
    const results = out.results.map(slim);
    const songs = (out.songs || []).map(slim);
    self.postMessage({ type: "result", id: msg.id, error: out.error || null, results, songs, rate: out.rate, gekisou: out.gekisou, random: !!out.random, stats: out.stats });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
}

// msg.decks: [{scoreId, power, members: [{id, skillLevel, gekisouSkillLevel}], snaps: [{id, rank} | null], gekisou}] ->
// the order scores of each; gekisou ({rank, justRate}, multiplayer lives) plays with Gekisou on.
async function simulate(msg) {
  try {
    const s = await replaySession();
    const gekisouOf = (d) => {
      if (!d.gekisou) return null;
      const b = battle && battle.byScore.get(d.scoreId);
      const r = d.gekisou.rank;
      return { ranks: [r, r, r], justRate: d.gekisou.justRate, justTypes: master.justTypes, seeds: b ? b.seeds.map((x) => x.seed) : [0] };
    };
    const out = msg.decks.map((d) => Simulate.orderScores(s, d.scoreId, d.power, Simulate.performers(master, d.members, d.snaps), gekisouOf(d)));
    self.postMessage({ type: "sim", id: msg.id, out });
  } catch (err) {
    session = null;
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
}
