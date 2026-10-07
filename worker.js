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
    snapRough: !!d.snapRough,
    gekisouScore: d.gekisouScore === undefined ? null : d.gekisouScore,
    gekisouSupportScore: d.gekisouSupportScore || 0,
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
      supportFactors.clear();
      comboShares.clear();
      snapRates.clear();
      self.postMessage({ type: "ready" });
    } else if (msg.type === "search") {
      search(msg);
    } else if (msg.type === "saved") {
      savedDecks(msg);
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

// Level factors of member Gekisou skills and of snaps' Gekisou support skills, by rank and Just rate
// ("rank:justRate" -> Map), simulated once each.
const levelFactors = new Map();
const supportFactors = new Map();
async function gekisouLevels(input) {
  const multi = input.multi;
  if (!multi || !battle || !battle.power || !replay) return { levels: null, supportLevels: null };
  const rank = Math.min(multi.gekisouRank || 1, Math.max(1, multi.players));
  const bt = Engine.battleRates(battle, rank, multi.justRate);
  const key = bt.rank + ":" + bt.justRate;
  if (!levelFactors.has(key)) levelFactors.set(key, new Map());
  if (!supportFactors.has(key)) supportFactors.set(key, new Map());
  const known = levelFactors.get(key);
  const knownSupport = supportFactors.get(key);
  const pairs = [];
  for (const o of input.members) {
    const v = Engine.memberView(master, o, {});
    if (v && v.gekisouSkillId && !known.has(v.gekisouSkillId + ":" + v.gekisouSkillLevel)) pairs.push([v.gekisouSkillId, v.gekisouSkillLevel]);
  }
  // Support skills below the top level that Engine.gekisouSupportLevelRatio cannot scale, for either member match
  // (the per-Just score-ups are modelled instead).
  const triples = [];
  for (const o of input.snaps) {
    const s = Engine.snapView(master, o);
    for (const [id, level] of (s && s.gekisouSupportSkills) || []) {
      if (level >= (master.gekisouSupportSkillMaxLevel.get(id) || 1) || Engine.gekisouSupportLevelRatio(master, id, level) !== null) continue;
      for (const match of [0, 1]) {
        const k = id + ":" + level + ":" + match;
        if (Engine.gekisouSupportJustStack(master, id, level, match)) continue;
        if (!knownSupport.has(k) && !triples.some((t) => t.join(":") === k)) triples.push([id, level, match]);
      }
    }
  }
  if (pairs.length || triples.length) {
    const s = await replaySession();
    for (const [k, f] of Simulate.gekisouLevelFactors(s, master, battle, bt, pairs)) known.set(k, f);
    for (const [k, f] of Simulate.gekisouSupportLevelFactors(s, master, battle, bt, triples)) knownSupport.set(k, f);
    // A triple the simulation could not measure (no chart where it gains) stays at 0.
    for (const t of triples) if (!knownSupport.has(t.join(":"))) knownSupport.set(t.join(":"), 0);
  }
  return { levels: known, supportLevels: knownSupport };
}

// The engine input of a search or saved-deck message, with the Gekisou level factors and the COMBO count-up shares
// measured first.
async function engineInput(msg) {
  let levels = { levels: null, supportLevels: null };
  try {
    levels = await gekisouLevels(msg.input);
  } catch (err) {
    session = null;
    console.warn("Gekisou level factors unavailable", err);
  }
  const event = master.events.get(msg.eventId) || null;
  const input = {
    ...msg.input, master, event, perPowerByScore: perPower, skillWeights, battle, gekisouLevels: levels.levels,
    gekisouSupportLevels: levels.supportLevels, lengthByScore: lengths, now: new Date(msg.now),
  };
  try {
    input.comboBoost = await comboBoostOf(input, msg.id);
  } catch (err) {
    session = null;
    console.warn("COMBO count-up shares unavailable", err);
  }
  return input;
}

// COMBO count-up shares (Simulate.comboBoosts) by "scoreId|rank:justRate", measured once per chart and key.
const comboShares = new Map();
// Engine search input `comboBoost` for a multiplayer live: {byScore, byMusic}, or null. Progress: stage "combo".
async function comboBoostOf(input, id) {
  const multi = input.mode === "normal" && input.multi && input.multi.players >= 1 ? input.multi : null;
  if (!multi || !battle || !battle.power || !replay) return null;
  const scope = Engine.comboScope(input);
  if (!scope) return null;
  const bt = Engine.battleRates(battle, Math.min(multi.gekisouRank || 1, Math.max(1, multi.players)), multi.justRate);
  const byScore = new Map();
  const todo = scope.scoreIds.filter((sid) => {
    const e = comboShares.get(sid + "|" + bt.rank + ":" + bt.justRate);
    return !e || scope.keys.some((k) => !e.b.has(k));
  });
  const s = todo.length ? await replaySession() : null;
  let done = 0;
  for (const sid of scope.scoreIds) {
    const k = sid + "|" + bt.rank + ":" + bt.justRate;
    if (todo.includes(sid)) {
      comboShares.set(k, Simulate.comboBoosts(s, master, bt, sid, scope.keys, scope.support, scope.idle, comboShares.get(k)));
      self.postMessage({ type: "progress", id, stage: "combo", done: ++done, total: todo.length });
    }
    byScore.set(sid, comboShares.get(k));
  }
  return { byScore, byMusic: new Map([...scope.byMusic].map(([mid, sid]) => [mid, byScore.get(sid)])) };
}

// A public room's random song (multi without pickSong): decks by the mean over the songs.
const randomRoom = (input) => !!(input.mode === "normal" && input.multi && input.multi.players >= 1 && !input.multi.pickSong);

async function search(msg) {
  try {
    let input = await engineInput(msg);
    let approx = [];
    let snapError = null;
    if (input.objective === "score") {
      try {
        ({ input, approx } = await scoreInput(input, msg.id, randomRoom(input)));
      } catch (err) {
        session = null;
        snapError = String((err && err.message) || err);
        console.warn("snap skill rates unavailable", err);
      }
    }
    // With Gekisou, members' Gekisou skills and the snaps' Gekisou support skills interact (not pair by pair), so the
    // search only estimates them: a wider pool is simulated whole and ranked by the simulated mean (on its song; decks
    // for a random song keep the estimate, see savedDecks).
    const rerank = input.snapSkill && gekisouOn(input) && !randomRoom(input);
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

// Seeds a chart with a LUCK range is played on (Simulate.luckSeeds): the mean of a strong LUCK deck is then within about
// 1% (8 seeds: 3%), for about 0.5 s more per deck.
const LUCK_SEEDS = 64;

// Simulate.orderScores of one deck; gekisou ({rank, justRate}) plays with Gekisou on: a chart with a LUCK range on
// LUCK_SEEDS seeds, others on their first published seed (nothing else draws from the seed).
function simulateDeck(s, scoreId, power, members, snaps, gekisou) {
  let gk = null;
  if (gekisou) {
    const b = battle && battle.byScore.get(scoreId);
    const r = gekisou.rank;
    const seeds = !b ? [0] : b.luck ? Simulate.luckSeeds(b.seeds.map((x) => x.seed), LUCK_SEEDS) : [b.seeds[0].seed];
    gk = { ranks: [r, r, r], justRate: gekisou.justRate, justTypes: master.justTypes, seeds };
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
// the songs left unmeasured. `every`: every song is played (a public room's random song), on one chart each. Progress
// goes to the page as {type: "progress", id, stage: "rates", done, total}.
async function scoreInput(base, id, every) {
  if (!replay) return { input: base, approx: [] };
  let input = base;
  let approx = [];
  const multi = base.mode === "normal" && base.multi && base.multi.players >= 1 ? base.multi : null;
  const gk = multi && battle && battle.power ? Engine.battleRates(battle, Math.min(multi.gekisouRank || 1, Math.max(1, multi.players)), multi.justRate) : null;
  if (!every && base.mode !== "challenge" && !(base.musicIds && base.musicIds.length)) {
    const pre = Engine.search({ ...base, compareSongs: true, topK: 1 });
    if (pre.error || !pre.songs.length) return { input: base, approx: [] };
    // The live skill weights of the live played (with Gekisou, at its rank and Just rate).
    const sw = gk ? { kinds: battle.kinds, byScore: gk.weights } : skillWeights;
    const rough = new Map(pre.songs.map((d) => [d, d.score * (1 + (Engine.roughSnapRate(master, d.members, d.snaps, d.chart.scoreId, sw) * d.accuracy) / d.scoreRate)]));
    const ranked = pre.songs.slice().sort((a, b) => rough.get(b) - rough.get(a));
    const top = rough.get(ranked[0]);
    const picked = ranked.filter((d) => rough.get(d) >= top * SCORE_MARGIN).slice(0, SCORE_SONGS).map((d) => d.chart.musicId);
    input = { ...base, musicIds: picked };
    approx = pre.songs.filter((d) => !picked.includes(d.chart.musicId));
  }
  const gkKey = gk ? gk.rank + ":" + gk.justRate : "solo";
  const scope = Engine.scoreScope(input, every ? 0 : undefined);
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
          self.postMessage({ type: "progress", id, stage: "rates", done: done + n, total });
        }
      });
      for (const [k, v] of rates) t.have.set(k, v);
      done += t.pairs.length;
    }
  }
  const byScore = new Map(todo.map((t) => [t.sid, t.have]));
  return { input: { ...input, snapSkill: { byScore } }, approx };
}

// Saved decks for a public room (激奏 公開房). Its song is drawn at random, and the deck can still be switched for about
// 10 s after the draw: enough to pick a saved deck, not to build one (the game saves 50 decks, and a card may be in
// several). So one deck is found per Gekisou range type (Engine.gekisouSongGroups: all COMBO, all LUCK, all JUST, mixed)
// by the mean over that type's songs: the search's best decks within SAVED_MARGIN of its best estimate (at most
// SAVED_POOL) are simulated on every song of the type and ranked by the simulated mean. For comparison, each song's own
// best deck (the search's, by its estimate) and the best deck for every song alike are simulated too.
const SAVED_POOL = 8;
const SAVED_MARGIN = 0.95;
// Runs per deck and chart (Simulate.meanScore): five put every member at every position once. A chart with a LUCK range
// plays a new seed each run, the same seeds for every deck: one deck varies 10% from seed to seed but two decks' paired
// difference 0.3%, so RANK_RUNS rank them, and the scores shown take SHOW_RUNS (±3% on one song).
const RANK_RUNS = 5;
const SHOW_RUNS = 10;

async function savedDecks(msg) {
  try {
    const t0 = Date.now();
    let input = await engineInput(msg);
    input = { ...input, multi: { ...input.multi, pickSong: false } };
    const scoreMode = input.objective === "score";
    const groups = Engine.gekisouSongGroups(input);
    if (!groups.length) {
      self.postMessage({ type: "saved", id: msg.id, error: "no-charts" });
      return;
    }
    let snapError = null;
    if (scoreMode) {
      try {
        ({ input } = await scoreInput(input, msg.id, true));
      } catch (err) {
        session = null;
        snapError = String((err && err.message) || err);
        console.warn("snap skill rates unavailable", err);
      }
    }
    const progress = (stage, done, total) => self.postMessage({ type: "progress", id: msg.id, stage, done, total });
    progress("search", 0, groups.length + 2);
    const pools = groups.map((g, i) => {
      const out = Engine.search({ ...input, musicIds: g.musicIds, compareSongs: false, topK: SAVED_POOL });
      progress("search", i + 1, groups.length + 2);
      if (out.error || !out.results.length) return { ...g, error: out.error || "no-results", pool: [] };
      const top = out.results[0].score;
      const pool = out.results.map((deck, k) => ({ deck, perSong: out.perSong[k] })).filter((x) => x.deck.score >= top * SAVED_MARGIN);
      return { ...g, pool, gekisou: out.gekisou };
    });
    const allIds = groups.flatMap((g) => g.musicIds);
    const allOut = Engine.search({ ...input, musicIds: allIds, compareSongs: false, topK: 1 });
    progress("search", groups.length + 1, groups.length + 2);
    const bestOut = Engine.search({ ...input, musicIds: allIds, multi: { ...input.multi, pickSong: true }, compareSongs: true, topK: 1 });
    progress("search", groups.length + 2, groups.length + 2);
    const bestBySong = new Map();
    for (const d of bestOut.songs || []) {
      const cur = bestBySong.get(d.chart.musicId);
      if (!cur || d.score > cur.score) bestBySong.set(d.chart.musicId, d);
    }
    const gkOut = allOut.gekisou || (pools.find((p) => p.gekisou) || {}).gekisou || null;

    // Simulation: the payoff of a deck on one song from its simulated mean (score: times the play's share; points: the
    // room's rank chances, Engine.roomPayoff).
    const sim = replay && gkOut ? await replaySession() : null;
    const runners = new Map();
    const runnerOf = (sid) => {
      if (!runners.has(sid)) {
        const r = gkOut.rank;
        runners.set(sid, Simulate.chartRunner(sim, sid, { ranks: [r, r, r], justRate: gkOut.justRate, justTypes: master.justTypes }));
      }
      return runners.get(sid);
    };
    const luckOf = (sid) => !!(battle.byScore.get(sid) || {}).luck;
    const seedsOf = (sid) => {
      const b = battle.byScore.get(sid);
      return !b ? [0] : b.luck ? Simulate.luckSeeds(b.seeds.map((x) => x.seed), SHOW_RUNS) : [b.seeds[0].seed];
    };
    const perfOf = (d) => Simulate.performers(
      master,
      d.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })),
      d.snaps.map((x) => (x ? { id: x.id, rank: x.rank } : null)),
    );
    let runs = 0;
    let runsTotal = 0;
    const tick = () => {
      if (++runs % 25 === 0) progress("simulate", runs, runsTotal);
    };
    // A per-song deck's simulated mean over `n` runs (5 off LUCK charts), adding to `prev` (its mean over `from` runs).
    const simulateOn = (d, n, prev, from) => {
      const sid = d.chart.scoreId;
      const total = luckOf(sid) ? n : RANK_RUNS;
      if (prev !== undefined && from >= total) return prev;
      const run = runnerOf(sid);
      const counted = (power, perf, order, seed) => {
        tick();
        return run(power, perf, order, seed);
      };
      const rest = Simulate.meanScore(counted, d.displayPower, perfOf(d), seedsOf(sid), total, from || 0);
      return prev === undefined ? rest : (prev * from + rest * (total - from)) / total;
    };
    const valueOf = (d, score) => {
      if (scoreMode) return { value: score * d.accuracy, score };
      const p = Engine.roomPayoff(input, d.chart, score, d.pointBonus, d.itemBonus);
      return { value: p.sc, score, points: p.points, items: p.items, cp: p.cp, rankDist: p.rankDist };
    };
    const runsFor = (sid, n) => (luckOf(sid) ? n : RANK_RUNS);
    // Without the replay: the search's estimate (all Perfect for `score`).
    const estOf = (d) => ({ value: d.score, score: d.estScore / (d.accuracy || 1), points: d.points, items: d.items, cp: d.cp });
    if (sim) {
      for (const p of pools) for (const x of p.pool) for (const d of x.perSong) runsTotal += runsFor(d.chart.scoreId, RANK_RUNS);
      for (const p of pools) for (const d of (p.pool[0] || { perSong: [] }).perSong) runsTotal += runsFor(d.chart.scoreId, SHOW_RUNS) - runsFor(d.chart.scoreId, RANK_RUNS);
      for (const d of bestBySong.values()) runsTotal += runsFor(d.chart.scoreId, SHOW_RUNS);
      for (const d of (allOut.perSong && allOut.perSong[0]) || []) runsTotal += runsFor(d.chart.scoreId, SHOW_RUNS);
    }

    const outGroups = pools.map((p) => {
      if (!p.pool.length) return { type: p.type, musicIds: p.musicIds, error: p.error };
      // Rank the pool by the simulated mean over the group's songs (the estimate without the replay).
      for (const x of p.pool) {
        x.sims = x.perSong.map((d) => (sim ? simulateOn(d, RANK_RUNS) : null));
        x.vals = x.perSong.map((d, k) => (sim ? valueOf(d, x.sims[k]) : estOf(d)));
        x.mean = x.vals.reduce((a, v) => a + v.value, 0) / x.vals.length;
      }
      const order = p.pool.slice().sort((a, b) => b.mean - a.mean);
      const win = order[0];
      if (sim) {
        win.sims = win.perSong.map((d, k) => simulateOn(d, SHOW_RUNS, win.sims[k], RANK_RUNS));
        win.vals = win.perSong.map((d, k) => valueOf(d, win.sims[k]));
        win.mean = win.vals.reduce((a, v) => a + v.value, 0) / win.vals.length;
      }
      const songs = win.perSong.map((d, k) => ({ musicId: d.chart.musicId, deck: { ...slim(d), simPay: win.vals[k] } }));
      const meanOf = (f) => win.vals.reduce((a, v) => a + (f(v) || 0), 0) / win.vals.length;
      return {
        type: p.type,
        musicIds: p.musicIds,
        deck: {
          ...slim(win.deck),
          simPay: { value: win.mean, score: meanOf((v) => v.score), points: meanOf((v) => v.points), items: meanOf((v) => v.items), cp: meanOf((v) => v.cp) },
        },
        songs,
        pool: order.map((x) => ({ members: x.deck.members.map((v) => v.id), snaps: x.deck.snaps.map((s) => s && s.id), est: x.deck.score, sim: sim ? x.mean : null })),
      };
    });
    // Each song's own best deck, and one deck for every song, on the same seeds.
    const songs = [];
    for (const g of outGroups) {
      for (const s of g.songs || []) {
        const best = bestBySong.get(s.musicId);
        const b = best ? (sim ? valueOf(best, simulateOn(best, SHOW_RUNS)) : estOf(best)) : null;
        songs.push({ musicId: s.musicId, type: g.type, saved: s.deck, best: best ? { ...slim(best), simPay: b } : null });
      }
    }
    let all = null;
    if (allOut.results && allOut.results.length) {
      const per = allOut.perSong[0];
      const vals = per.map((d) => (sim ? valueOf(d, simulateOn(d, SHOW_RUNS)) : estOf(d)));
      const bySong = new Map(per.map((d, k) => [d.chart.musicId, vals[k]]));
      for (const s of songs) s.all = bySong.get(s.musicId) || null;
      all = { deck: slim(allOut.results[0]), value: vals.reduce((a, v) => a + v.value, 0) / vals.length };
    }
    self.postMessage({
      type: "saved", id: msg.id, groups: outGroups, songs, all, gekisou: gkOut, simulated: !!sim, snapSkills: !!input.snapSkill, snapError,
      runs: { rank: RANK_RUNS, show: SHOW_RUNS }, stats: { ms: Date.now() - t0, runs },
    });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  }
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
