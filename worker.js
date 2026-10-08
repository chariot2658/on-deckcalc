// Runs the deck search and the live simulation off the main thread.
importScripts("engine.js", "simulate.js");

let master = null;
let perPower = null;
let lengths = null;
let skillWeights = null;
let battle = null; // Engine.battleFromMusicData: multiplayer lives with Gekisou
let replay = null; // {musicDataUrl, pointer}
let session = null; // Promise of a ReplaySession, loaded on the first simulation

// Decks go back without engine views.
const slim = Engine.plainDeck;

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
// measured first (on `pool`'s helpers, or helpers of its own).
async function engineInput(msg, pool = null) {
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
    input.comboBoost = await comboBoostOf(input, msg.id, pool);
  } catch (err) {
    session = null;
    console.warn("COMBO count-up shares unavailable", err);
  }
  return input;
}

// COMBO count-up shares (Simulate.comboBoosts) by "scoreId|rank:justRate", measured once per chart and key.
const comboShares = new Map();
// Engine search input `comboBoost` for a multiplayer live: {byScore, byMusic}, or null. Progress: stage "combo". The
// charts go to helpers (`pool`, or its own) when there are any.
async function comboBoostOf(input, id, pool = null) {
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
  const keyOf = (sid) => sid + "|" + bt.rank + ":" + bt.justRate;
  let done = 0;
  const measured = new Set();
  const finish = (sid, entry) => {
    comboShares.set(keyOf(sid), entry);
    measured.add(sid);
    self.postMessage({ type: "progress", id, stage: "combo", done: ++done, total: todo.length });
  };
  const own = pool ? null : helperPool(todo.length);
  const helpers = pool || own;
  try {
    if (helpers && todo.length) {
      await helpers.run(
        todo.map((sid) => {
          const entry = comboShares.get(keyOf(sid));
          const ctx = Simulate.comboContext(master, scope.keys.concat(entry ? [...entry.b.keys()] : []), scope.support, scope.idle);
          return { type: "combo", scoreId: sid, ctx, bt: { rank: bt.rank, justRate: bt.justRate }, keys: scope.keys, entry };
        }),
        (k, out) => finish(todo[k], out),
        () => {},
      );
    }
  } catch (err) {
    console.warn("COMBO count-up helpers failed", err);
  } finally {
    if (own) own.close();
  }
  const left = todo.filter((sid) => !measured.has(sid));
  const s = left.length ? await replaySession() : null;
  for (const sid of left) finish(sid, Simulate.comboBoosts(s, master, bt, sid, scope.keys, scope.support, scope.idle, comboShares.get(keyOf(sid))));
  for (const sid of scope.scoreIds) byScore.set(sid, comboShares.get(keyOf(sid)));
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
// goes to the page as {type: "progress", id, stage: "rates", done, total}. `pool`: helpers (helperPool) to measure on, or
// null for helpers of its own.
async function scoreInput(base, id, every, pool = null) {
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
    return { sid, have, pairs: scope.pairs.filter((p) => p.keys.some((k) => !have.has(k))) };
  });
  const work = todo.filter((t) => t.pairs.length).map((t) => {
    const b = gk && battle.byScore.get(t.sid);
    const gekisou = gk ? { ranks: [gk.rank, gk.rank, gk.rank], justRate: gk.justRate, justTypes: master.justTypes, seeds: b ? [b.seeds[0].seed] : [0] } : null;
    return { t, gekisou, jobs: Simulate.snapSkillJobs(master, t.pairs), done: 0 };
  });
  const total = work.reduce((a, w) => a + w.jobs.length, 0);
  let last = 0;
  const report = (w, n) => {
    w.done = n;
    const now = Date.now();
    if (now - last > 200) {
      last = now;
      self.postMessage({ type: "progress", id, stage: "rates", done: work.reduce((a, x) => a + x.done, 0), total });
    }
  };
  if (work.length) {
    const own = pool ? null : helperPool(work.length);
    const helpers = pool || own;
    try {
      if (helpers) {
        await helpers.run(
          work.map((w) => ({ type: "rates", scoreId: w.t.sid, jobs: w.jobs, gekisou: w.gekisou })),
          (k, out) => {
            for (const [key, v] of out) work[k].t.have.set(key, v);
            report(work[k], work[k].jobs.length);
          },
          (k, n) => report(work[k], n),
        );
      }
    } catch (err) {
      console.warn("snap skill rate helpers failed", err);
    } finally {
      if (own) own.close();
    }
    const left = work.filter((w) => w.t.pairs.some((p) => p.keys.some((k) => !w.t.have.has(k))));
    if (left.length) {
      const s = await replaySession();
      for (const w of left) {
        for (const [k, v] of Simulate.measureSnapJobs(s, w.t.sid, w.jobs, w.gekisou, (n) => report(w, n))) w.t.have.set(k, v);
      }
    }
  }
  const byScore = new Map(todo.map((t) => [t.sid, t.have]));
  return { input: { ...input, snapSkill: { byScore } }, approx };
}

// Helpers (simworker.js, a replay each) for snap skill rates and saved-deck simulations, a chart at a time each: the
// cores but one, at most 6. helperPool(n) starts up to n of them; null without workers here (Node) or for fewer than two.
const HELPERS = Math.max(1, Math.min(6, ((self.navigator && self.navigator.hardwareConcurrency) || 2) - 1));
function helperPool(n) {
  n = typeof Worker === "undefined" ? 0 : Math.min(HELPERS, n);
  if (n < 2) return null;
  const helpers = [];
  try {
    for (let i = 0; i < n; i++) helpers.push(new Worker("simworker.js"));
  } catch (err) {
    for (const h of helpers) h.terminate();
    console.warn("no helpers", err);
    return null;
  }
  return {
    // Sends each task (a simworker.js message) to the next free helper: onDone(k, out) with task k's reply,
    // onProgress(k, done) meanwhile. A helper's failure rejects, leaving the tasks not done to the caller.
    async run(tasks, onDone, onProgress) {
      let next = 0;
      let failed = false;
      await Promise.all(helpers.map(async (h) => {
        while (!failed && next < tasks.length) {
          const k = next++;
          try {
            const out = await new Promise((resolve, reject) => {
              h.onmessage = (e) => {
                const m = e.data;
                if (m.type === "progress") onProgress(k, m.done);
                else if (m.type === "done") resolve(m.out);
                else reject(new Error(m.message));
              };
              h.onerror = (e) => reject(new Error(e.message || "simworker.js failed"));
              h.postMessage({ ...tasks[k], replay });
            });
            onDone(k, out);
          } catch (err) {
            failed = true;
            throw err;
          }
        }
      }));
    },
    close() {
      for (const h of helpers) h.terminate();
    },
  };
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
  let helpers = null;
  try {
    const t0 = Date.now();
    helpers = replay ? helperPool(HELPERS) : null;
    let input = await engineInput(msg, helpers);
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
        ({ input } = await scoreInput(input, msg.id, true, helpers));
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
    const gkRun = gkOut ? { ranks: [gkOut.rank, gkOut.rank, gkOut.rank], justRate: gkOut.justRate, justTypes: master.justTypes } : null;
    const runners = new Map();
    const runnerOf = (sid) => {
      if (!runners.has(sid)) runners.set(sid, Simulate.chartRunner(sim, sid, gkRun));
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
    // Simulated means of per-song decks, reqs [{d, n, prev, from}]: over `n` runs (5 off LUCK charts), added to `prev`
    // (the deck's mean over `from` runs). On the helpers one task per chart (its runner built once), else here.
    const simulateAll = async (reqs) => {
      const items = reqs.map((r) => {
        const sid = r.d.chart.scoreId;
        const total = luckOf(sid) ? r.n : RANK_RUNS;
        const from = r.from || 0;
        return { ...r, sid, total, from, kept: r.prev !== undefined && from >= total };
      });
      const rest = new Array(items.length);
      const bySid = new Map();
      items.forEach((it, i) => {
        if (it.kept) return;
        if (!bySid.has(it.sid)) bySid.set(it.sid, []);
        bySid.get(it.sid).push(i);
      });
      const tasks = [...bySid];
      if (helpers && tasks.length) {
        const busy = new Array(tasks.length).fill(0);
        let last = 0;
        const report = () => {
          const now = Date.now();
          if (now - last > 200) {
            last = now;
            progress("simulate", runs + busy.reduce((a, b) => a + b, 0), runsTotal);
          }
        };
        try {
          await helpers.run(
            tasks.map(([sid, idx]) => ({
              type: "mean", scoreId: sid, gekisou: gkRun,
              items: idx.map((i) => ({ power: items[i].d.displayPower, perf: perfOf(items[i].d), seeds: seedsOf(sid), total: items[i].total, from: items[i].from })),
            })),
            (k, out) => {
              tasks[k][1].forEach((i, t) => (rest[i] = out[t]));
              busy[k] = 0;
              for (const i of tasks[k][1]) runs += items[i].total - items[i].from;
              report();
            },
            (k, n) => {
              busy[k] = n;
              report();
            },
          );
        } catch (err) {
          console.warn("simulation helpers failed", err);
        }
      }
      for (const [sid, idx] of tasks) {
        if (idx.every((i) => rest[i] !== undefined)) continue;
        const run = runnerOf(sid);
        const counted = (power, perf, order, seed) => {
          if (++runs % 25 === 0) progress("simulate", runs, runsTotal);
          return run(power, perf, order, seed);
        };
        for (const i of idx) {
          if (rest[i] === undefined) rest[i] = Simulate.meanScore(counted, items[i].d.displayPower, perfOf(items[i].d), seedsOf(sid), items[i].total, items[i].from);
        }
      }
      return items.map((it, i) => (it.kept ? it.prev : it.prev === undefined ? rest[i] : (it.prev * it.from + rest[i] * (it.total - it.from)) / it.total));
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

    // Rank each group's pool by the simulated mean over the group's songs (the estimate without the replay).
    const live = pools.filter((p) => p.pool.length);
    const first = sim ? await simulateAll(live.flatMap((p) => p.pool.flatMap((x) => x.perSong.map((d) => ({ d, n: RANK_RUNS }))))) : null;
    let q = 0;
    for (const p of live) {
      for (const x of p.pool) {
        x.sims = x.perSong.map(() => (sim ? first[q++] : null));
        x.vals = x.perSong.map((d, k) => (sim ? valueOf(d, x.sims[k]) : estOf(d)));
        x.mean = x.vals.reduce((a, v) => a + v.value, 0) / x.vals.length;
      }
      p.order = p.pool.slice().sort((a, b) => b.mean - a.mean);
    }
    // Then on SHOW_RUNS: the winners, each song's own best deck and one deck for every song, on the same seeds.
    const bests = live.flatMap((p) => p.order[0].perSong.map((d) => bestBySong.get(d.chart.musicId) || null));
    const allPer = allOut.results && allOut.results.length ? allOut.perSong[0] : [];
    const second = sim
      ? await simulateAll([
        ...live.flatMap((p) => p.order[0].perSong.map((d, k) => ({ d, n: SHOW_RUNS, prev: p.order[0].sims[k], from: RANK_RUNS }))),
        ...bests.filter(Boolean).map((d) => ({ d, n: SHOW_RUNS })),
        ...allPer.map((d) => ({ d, n: SHOW_RUNS })),
      ])
      : null;
    q = 0;
    const outGroups = pools.map((p) => {
      if (!p.pool.length) return { type: p.type, musicIds: p.musicIds, error: p.error };
      const order = p.order;
      const win = order[0];
      if (sim) {
        win.sims = win.perSong.map(() => second[q++]);
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
    const songs = [];
    let bi = 0;
    for (const g of outGroups) {
      for (const s of g.songs || []) {
        const best = bests[bi++];
        const b = best ? (sim ? valueOf(best, second[q++]) : estOf(best)) : null;
        songs.push({ musicId: s.musicId, type: g.type, saved: s.deck, best: best ? { ...slim(best), simPay: b } : null });
      }
    }
    let all = null;
    if (allPer.length) {
      const vals = allPer.map((d) => (sim ? valueOf(d, second[q++]) : estOf(d)));
      const bySong = new Map(allPer.map((d, k) => [d.chart.musicId, vals[k]]));
      for (const s of songs) s.all = bySong.get(s.musicId) || null;
      all = { deck: slim(allOut.results[0]), value: vals.reduce((a, v) => a + v.value, 0) / vals.length };
    }
    self.postMessage({
      type: "saved", id: msg.id, groups: outGroups, songs, all, gekisou: gkOut, simulated: !!sim, snapSkills: !!input.snapSkill, snapError,
      runs: { rank: RANK_RUNS, show: SHOW_RUNS }, stats: { ms: Date.now() - t0, runs },
    });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.stack) || err) });
  } finally {
    if (helpers) helpers.close();
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
