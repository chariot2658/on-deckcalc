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
    snapScore: d.snapScore || 0,
    gekisouScore: d.gekisouScore === undefined ? null : d.gekisouScore,
    scoreRate: d.scoreRate,
    accuracy: d.accuracy,
    rankChance: d.rankChance === undefined ? null : d.rankChance,
    rankDist: d.rankDist || null,
    minutes: d.minutes || null,
    random: !!d.random,
    songCount: d.songCount || null,
    sim: d.sim || null,
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
      snapRates.clear();
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
    const event = master.events.get(msg.eventId) || null;
    let input = {
      ...msg.input, master, event, perPowerByScore: perPower, skillWeights, battle, gekisouLevels: levels, lengthByScore: lengths, now: new Date(msg.now),
    };
    let approx = [];
    let snapError = null;
    if (input.objective === "score") {
      try {
        ({ input, approx } = await scoreInput(input, msg.id));
      } catch (err) {
        session = null;
        snapError = String((err && err.message) || err);
        console.warn("snap skill rates unavailable", err);
      }
    }
    // With Gekisou, members' Gekisou skills and the snaps' Gekisou support skills interact (not pair by pair), so the
    // search only estimates them: a wider pool is simulated whole and ranked by the simulated mean.
    const rerank = input.snapSkill && gekisouOn(input);
    const out = Engine.search(rerank ? { ...input, topK: Math.max(GEKISOU_POOL, input.topK || 5) } : input);
    if (rerank && out.results.length) {
      const s = await replaySession();
      for (const d of out.results) {
        const members = d.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel }));
        d.sim = simulateDeck(s, d.chart.scoreId, d.displayPower, members, d.snaps.map((x) => (x ? { id: x.id, rank: x.rank } : null)), out.gekisou);
      }
      const mean = (d) => (d.sim ? d.sim.mean * d.accuracy : d.estScore);
      out.results.sort((a, b) => mean(b) - mean(a));
      out.results.length = Math.min(out.results.length, input.topK || 5);
    }
    const results = out.results.map(slim);
    const songs = (out.songs || []).map(slim).concat(approx.map((d) => ({ ...slim(d), approx: true })));
    self.postMessage({
      type: "result", id: msg.id, error: out.error || null, results, songs, rate: out.rate, gekisou: out.gekisou, random: !!out.random, stats: out.stats,
      snapSkills: !!input.snapSkill, snapError, measuredSongs: input.snapSkill ? input.musicIds || null : null,
    });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
}

// Decks simulated whole to rank a multiplayer score search (Gekisou on).
const GEKISOU_POOL = 15;
const gekisouOn = (input) => !!(input.mode === "normal" && input.multi && input.multi.players >= 1 && battle && battle.power);

// Simulate.orderScores of one deck; gekisou ({rank, justRate}) plays with Gekisou on, on every published seed.
function simulateDeck(s, scoreId, power, members, snaps, gekisou) {
  let gk = null;
  if (gekisou) {
    const b = battle && battle.byScore.get(scoreId);
    const r = gekisou.rank;
    gk = { ranks: [r, r, r], justRate: gekisou.justRate, justTypes: master.justTypes, seeds: b ? b.seeds.map((x) => x.seed) : [0] };
  }
  return Simulate.orderScores(s, scoreId, power, Simulate.performers(master, members, snaps), gk);
}

// Snap skill rates measured on the replay, "scoreId|gekisou" -> Map(Engine.snapSkillKey -> rate). Pairing keys do not
// depend on the roster, so they stay valid until the data is reloaded.
const snapRates = new Map();
// With every song allowed, a search without snap skills ranks the songs, each with a rough snap skill estimate for its
// best deck (Engine.roughSnapRate), and only those within SCORE_MARGIN of the best (at most SCORE_SONGS) are measured;
// the other songs keep that search's estimate. Snap skills add 6–9% and the songs' best scores are often within 1%.
const SCORE_SONGS = 10;
const SCORE_MARGIN = 0.97;

// The score objective's input with snap skill rates (Simulate.snapSkillRates on the charts Engine.scoreScope names), and
// the songs left unmeasured. Progress goes to the page as {type: "progress", id, done, total}.
async function scoreInput(base, id) {
  if (!replay) return { input: base, approx: [] };
  let input = base;
  let approx = [];
  if (base.mode !== "challenge" && !(base.musicIds && base.musicIds.length)) {
    const pre = Engine.search({ ...base, compareSongs: true, topK: 1 });
    if (pre.error || !pre.songs.length) return { input: base, approx: [] };
    const rough = new Map(pre.songs.map((d) => [d, d.score * (1 + (Engine.roughSnapRate(master, d.members, d.snaps, d.chart.scoreId, skillWeights) * d.accuracy) / d.scoreRate)]));
    const ranked = pre.songs.slice().sort((a, b) => rough.get(b) - rough.get(a));
    const top = rough.get(ranked[0]);
    const picked = ranked.filter((d) => rough.get(d) >= top * SCORE_MARGIN).slice(0, SCORE_SONGS).map((d) => d.chart.musicId);
    input = { ...base, musicIds: picked };
    approx = pre.songs.filter((d) => !picked.includes(d.chart.musicId));
  }
  const multi = input.mode === "normal" && input.multi && input.multi.players >= 1 ? input.multi : null;
  const gk = multi && battle && battle.power ? Engine.battleRates(battle, Math.min(multi.gekisouRank || 1, Math.max(1, multi.players)), multi.justRate) : null;
  const gkKey = gk ? gk.rank + ":" + gk.justRate : "solo";
  const scope = Engine.scoreScope(input);
  const todo = scope.scoreIds.map((sid) => {
    const k = sid + "|" + gkKey;
    if (!snapRates.has(k)) snapRates.set(k, new Map());
    const have = snapRates.get(k);
    return { sid, have, pairs: scope.pairs.filter((p) => !have.has(p.key)) };
  });
  const total = todo.reduce((a, t) => a + t.pairs.length, 0);
  let done = 0;
  if (total) {
    const s = await replaySession();
    let last = 0;
    for (const t of todo) {
      if (!t.pairs.length) continue;
      const b = gk && battle.byScore.get(t.sid);
      const gekisou = gk ? { ranks: [gk.rank, gk.rank, gk.rank], justRate: gk.justRate, justTypes: master.justTypes, seeds: b ? [b.seeds[0].seed] : [0] } : null;
      const rates = Simulate.snapSkillRates(s, master, t.sid, t.pairs, gekisou, (n) => {
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          self.postMessage({ type: "progress", id, done: done + n, total });
        }
      });
      for (const [k, v] of rates) t.have.set(k, v);
      done += t.pairs.length;
    }
  }
  const byScore = new Map(todo.map((t) => [t.sid, t.have]));
  return { input: { ...input, snapSkill: { byScore } }, approx };
}

// msg.decks: [{scoreId, power, members: [{id, skillLevel, gekisouSkillLevel}], snaps: [{id, rank} | null], gekisou}] ->
// the order scores of each; gekisou ({rank, justRate}, multiplayer lives) plays with Gekisou on.
async function simulate(msg) {
  try {
    const s = await replaySession();
    const out = msg.decks.map((d) => simulateDeck(s, d.scoreId, d.power, d.members, d.snaps, d.gekisou));
    self.postMessage({ type: "sim", id: msg.id, out });
  } catch (err) {
    session = null;
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
}
