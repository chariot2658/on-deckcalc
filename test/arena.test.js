// 激奏舞台 (撃奏アリーナ): the day's rule, the league's songs and members, the arena pt table, and the charts measured
// with the day's missions on a patched replay (Simulate.patchDeck, Simulate.measureBattleChart). Measured with a
// chart's own missions they reproduce music-data's Gekisou data (without a LUCK range exactly, the live skill weights
// within 0.1%; with one, the seed mean is within 0.5% of music-data's expectation of the no-skill score), and the
// search's estimate on arena charts is the simulation's within 2%. The event's payoff of an arena live is checked
// against results/IMG_0153.
// Needs ../data/replay (node test/fetch-replay.js) for the replay parts.
// Run: node test/arena.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");

const root = path.join(__dirname, "..", "..");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata", "hk-tw-mo", t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const battle = E.battleFromMusicData(md);
const perPower = E.perPowerFromMusicData(md);
const skillWeights = E.skillWeightsFromMusicData(md);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
// Season 1's first day (master times are read as local time, as Engine.parseTime does).
const now = new Date(2026, 9, 28, 21);

// The rules of 2026-10-28 (MasterArenaLeagueRegulation): every type, and per league one mission in all three ranges.
const want = { 1: [1, "222"], 2: [2, "111"], 3: [3, "333"], 4: [4, "111"], 5: [5, "222"] };
for (const [league, [band, missions]] of Object.entries(want)) {
  const rule = E.arenaRule(m, Number(league), now);
  assert.ok(rule, `league ${league}: no rule`);
  assert.strictEqual(rule.bandId, band);
  assert.strictEqual(rule.musicType, 99);
  assert.strictEqual(rule.missions.join(""), missions);
  const songs = E.arenaSongs(m, band, now);
  assert.ok(songs.length >= 10, `band ${band}: ${songs.length} songs`);
  assert.ok(songs.every((id) => m.musics.get(id)._bandIDs.includes(band)));
}
assert.strictEqual(E.arenaRule(m, 1, new Date(2026, 9, 27, 12)), null, "before the season");
// Arena pt by place: 新手 5 players, 白金 5 players (the last places lose pt).
assert.deepStrictEqual(E.arenaPlacePoints(m, 1, 5), [40, 25, 15, 10, 5]);
assert.deepStrictEqual(E.arenaPlacePoints(m, 5, 5), [120, 70, 35, -5, -40]);
// The rank bonus percents of a song's missions are music-data's for every chart.
let charts = 0;
for (const s of md.songs) {
  for (const c of s.charts) {
    const b = battle.byScore.get(c.scoreId);
    if (!b) continue;
    assert.deepStrictEqual(E.rankBonusPercents(m, s.gekisouMissions), b.percents, `${c.scoreId}`);
    charts++;
  }
}
console.log(`rules of 2026-10-28, arena pt, rank bonus percents of ${charts} charts: ok`);

// The search input: the band's members only, its songs, a random song scored by the Gekisou score; the day's type.
const arenaOf = (league) => {
  const r = E.arenaRule(m, league, now);
  return { bandId: r.bandId, musicType: r.musicType, missions: r.missions };
};
const base = {
  master: m, event: m.events.get(4), mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
  perPowerByScore: perPower, skillWeights, maxLevel: 27, topK: 1, objective: "points", now,
  multi: { players: 5, justRate: 0.5 }, arena: arenaOf(2),
};
const ai = E.arenaInput(base);
const bandOf = (id) => m.characters.get(m.memberCards.get(id)._characterID)._bandID;
assert.ok(ai.members.length >= 5 && ai.members.every((o) => bandOf(o.id) === 2), "Ave Mujica members only");
assert.ok(roster.members.some((o) => bandOf(o.id) !== 2));
assert.deepStrictEqual(ai.musicIds, E.arenaSongs(m, 2, now));
assert.strictEqual(ai.objective, "score");
assert.ok(ai.multi.auto && !ai.multi.pickSong && ai.multi.players === 5);
assert.strictEqual(E.musicView(m, ai.musicIds[0], 99).musicType, 99);
console.log("arena input: ok");

// The event pays an arena live by the room's rank (results/IMG_0143–0153, 2026-10-29, 4 playing, room B, 10 boosts):
// the deck's bonuses are the game's +147% / +90%, and the payoff 4322 pt / 3990 items / 250 CP.
{
  const ev = m.events.get(4);
  const mem = [[6, 70, 5, 5], [32, 60, 3, 2], [58, 80, 4, 1], [59, 80, 4, 1], [60, 80, 4, 1]].map(([id, level, awake, rank]) => E.memberView(m, { id, level, awake, rank }, roster.player));
  const sn = [[23, 70, 5], [67, 80, 5], [34, 80, 5], [58, 50, 1], [53, 70, 3]].map(([id, level, rank]) => E.snapView(m, { id, level, rank }));
  const b = E.deckEventBonus(m, ev, roster.player, mem, sn, new Date(2026, 9, 29, 1));
  assert.deepStrictEqual(b, { point: 14700, item: 9000 });
  assert.strictEqual(E.deckEventBonus(m, ev, roster.player, mem, sn, new Date(2027, 0, 1)), null, "after the event");
  const pay = E.payoff(m, ev, "normal");
  const B = 4;
  assert.ok(31149649 >= E.battleRequiredScore(E.battleThresholds(m, 100040).find(([r]) => r === B)[1], 4));
  assert.strictEqual(Math.trunc(((b.point + 10000) * 50 * pay.points.get(B)) / 10000), 4322);
  assert.strictEqual(Math.trunc((pay.items.get(B) * (b.item + 10000) * 50) / 10000), 3990);
  assert.strictEqual(pay.cp.get(B) * 50, 250);
  console.log("arena event payoff (IMG_0153): ok");
}

(async () => {
  const probes = E.kindProbes(battle.kinds);
  assert.strictEqual(probes.length, battle.kinds.length);
  const sessions = new Map();
  const sessionOf = async (missions) => {
    const k = missions.join("");
    if (!sessions.has(k)) sessions.set(k, await loadReplay(undefined, { missions, probes }));
    return sessions.get(k);
  };
  if (!(await loadReplay())) {
    console.log("skip the replay parts: run node test/fetch-replay.js");
    return;
  }

  // A chart measured with its own missions is music-data's: battleRates over the room's ranks at Just rate 0.5.
  const rel = (a, b) => (b === 0 ? Math.abs(a) : Math.abs(a / b - 1));
  for (const missions of [[1, 1, 1], [3, 3, 3], [2, 2, 2]]) {
    const song = md.songs.find((s) => s.gekisouMissions.join("") === missions.join("") && s.charts[3] && battle.byScore.has(s.charts[3].scoreId));
    const sid = song.charts[3].scoreId;
    const session = await sessionOf(missions);
    assert.deepStrictEqual(JSON.parse(session.describeChart(sid)).missions, missions);
    const luck = missions.includes(2);
    const spec = S.battleSpec(m, battle, missions, { percents: E.rankBonusPercents(m, missions), probes, seeds: luck ? S.luckSeeds([], 8) : [0], kindSeeds: 4 });
    const got = S.measureBattleChart(session, sid, spec);
    const rG = E.battleRates({ ...battle, byScore: new Map([[sid, got]]) }, [1, 2, 3, 4, 5], 0.5);
    const rR = E.battleRates({ ...battle, byScore: new Map([[sid, battle.byScore.get(sid)]]) }, [1, 2, 3, 4, 5], 0.5);
    const errs = { perPower: rel(rG.perPower.get(sid), rR.perPower.get(sid)), weights: 0, apt: 0, support: 0 };
    rR.weights.get(sid).forEach((w, q) => (errs.weights = Math.max(errs.weights, rel(rG.weights.get(sid)[q], w))));
    const tot = (g) => g.tail + g.ranges.reduce((a, x) => a + x, 0);
    for (const [shape, g] of rR.apt.get(sid)) {
      const h = rG.apt.get(sid).get(shape);
      errs.apt = Math.max(errs.apt, h ? rel(tot(h), tot(g)) : Math.abs(tot(g)));
    }
    for (const [key, v] of rR.aptSupport.get(sid)) errs.support = Math.max(errs.support, rel(rG.aptSupport.get(sid).get(key) || 0, v));
    console.log(`${sid} measured with its missions ${missions.join("")}: ${Object.entries(errs).map(([k, e]) => `${k} ${(e * 100).toFixed(4)}%`).join(", ")}`);
    if (luck) {
      // The seed mean against music-data's expectation over the lotteries: the score and the live skill weights.
      assert.ok(errs.perPower < 0.005 && errs.weights < 0.01);
    } else {
      // The weights within 0.1%: each probe plays its kind at the largest value, and note scores are rounded.
      for (const [k, e] of Object.entries(errs)) assert.ok(e < (k === "weights" ? 1e-3 : 1e-6), `${sid} ${k}: ${e}`);
    }
  }

  // A search on arena charts (league 2 on 2026-10-28: all COMBO, every type; three songs measured), without snaps so
  // that the estimate has no snap skill rates to miss: per song the estimate is the simulation's within 2%.
  const missions = ai.arena.missions;
  const session = await sessionOf(missions);
  const top = new Map();
  for (const c of E.charts(m, perPower, { maxLevel: 27, musicIds: ai.musicIds, now })) {
    if (!top.has(c.musicId) || c.level > top.get(c.musicId).level) top.set(c.musicId, c);
  }
  const sids = [...top.values()].slice(0, 3).map((c) => c.scoreId);
  const spec = S.battleSpec(m, battle, missions, { percents: E.rankBonusPercents(m, missions), probes, seeds: [0] });
  const ab = { ...battle, byScore: new Map(sids.map((sid) => [sid, S.measureBattleChart(session, sid, spec)])) };
  const input = E.arenaInput({ ...base, snaps: [], battle: ab, musicIds: sids.map((sid) => top.get([...top.keys()].find((k) => top.get(k).scoreId === sid)).musicId) });
  // As the worker does: the members' Gekisou skills below their top level, scaled by simulated factors on these charts.
  const bt = E.battleRates(ab, E.gekisouRanks(input.multi), input.multi.justRate);
  const pairs = input.members.map((o) => E.memberView(m, o, {})).filter((v) => v.gekisouSkillId).map((v) => [v.gekisouSkillId, v.gekisouSkillLevel]);
  input.gekisouLevels = S.gekisouLevelFactors(session, m, ab, bt, pairs);
  const out = E.search(input);
  assert.ok(!out.error && out.results.length, out.error);
  const d = out.results[0];
  assert.ok(d.members.every((v) => bandOf(v.id) === 2));
  for (const x of out.perSong[0]) {
    const b = ab.byScore.get(x.chart.scoreId);
    const perf = S.performers(m, x.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })), [null, null, null, null, null]);
    const sim = S.orderScores(session, x.chart.scoreId, x.displayPower, perf, S.gekisouPlay(out.gekisou, b.percents, m.justTypes, [0])).mean;
    const est = x.estScore / (x.accuracy || 1);
    console.log(`  ${x.chart.scoreId}: estimate ${Math.round(est)}, simulated ${Math.round(sim)} (${((est / sim - 1) * 100).toFixed(2)}%)`);
    assert.ok(Math.abs(est / sim - 1) < 0.02);
  }
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
