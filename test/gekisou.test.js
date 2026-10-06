// Multiplayer lives with Gekisou: the search's Gekisou score (music-data seeds, the rank bonus formula, the Just rate,
// members' Gekisou skills) against the replay simulation, and the room rank of results/IMG_0030–31.
// The simulation part needs ../data/replay (node test/fetch-replay.js) and is skipped without it.
// Run: node test/gekisou.test.js
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
const perPower = E.perPowerFromMusicData(md);
const sw = E.skillWeightsFromMusicData(md);
const battle = E.battleFromMusicData(md);
const P = battle.power;
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
const event = m.events.get(1);

// At rank 1 with every Just-count note Just, the rate is music-data's seed mean (its rank 1 play).
const top = E.battleRates(battle, 1, 1);
for (const [sid, b] of battle.byScore) {
  const mean = b.seeds.reduce((a, s) => a + s.score, 0) / b.seeds.length;
  assert.ok(Math.abs(top.perPower.get(sid) * P - mean) < 1e-6, "chart " + sid);
}
console.log(`${battle.byScore.size} charts with Gekisou data, ${battle.shapes.size} member Gekisou skills measured`);

// IMG_0030–31: TearJerker EXPERT, own score 1152964 (C) — the score without Gekisou — while the room reached B. The
// room's B threshold for 5 players is 20638445; with Gekisou the own score per unit of power is much higher.
const input = {
  master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
  perPowerByScore: perPower, skillWeights: sw, battle, maxLevel: 27, boosts: 3, topK: 1, musicIds: [100094], difficulties: ["expert"],
  now: new Date("2026-10-01T12:00:00+08:00"), compareSongs: true,
};
// A room's song is random: `results` are decks by the mean over the songs, `songs` the best one on each song.
const solo = E.search({ ...input, multi: { players: 5, othersScore: 4 * 4.9e6 }, battle: null }).songs[0];
const room = E.search({ ...input, multi: { players: 5, othersScore: 4 * 4.9e6, gekisouRank: 3, justRate: 0.5 } });
const d = room.songs[0];
assert.ok(room.results[0].random && room.results[0].rankName === "B" && room.results[0].points === d.points);
console.log(`TearJerker: score per power without Gekisou ${solo.scoreRate.toFixed(3)}, with Gekisou (rank 3) ${d.scoreRate.toFixed(3)};`,
  `deck ${d.displayPower}: ${d.estScore}`,
  `(live skills +${d.estScore - d.baseScore - d.gekisouScore}, Gekisou skills +${d.gekisouScore}); room ${d.rankName}`);
assert.strictEqual(d.rankName, "B");
assert.ok(d.scoreRate > 1.5 * solo.scoreRate);
assert.deepStrictEqual(room.gekisou, { rank: 3, justRate: 0.5 });
// The assumed rank is at most the room size.
assert.strictEqual(E.search({ ...input, multi: { players: 2, othersScore: 0, gekisouRank: 5 } }).gekisou.rank, 2);

// Random song: the best deck by the mean payoff over every song (each on its best chart) against a brute force over
// member sets, leaders and the placements of two snaps (no skills, all Perfect), with others' scores that leave some
// songs' ranks to the deck.
{
  const few = roster.members.slice(0, 14);
  const two = roster.snaps.filter((s) => E.snapView(m, s)).slice(0, 2);
  const multi = { players: 5, othersScore: 4 * 1.2e6 };
  const base = {
    master: m, event, mode: "normal", members: few, snaps: two, player: roster.player, perPowerByScore: perPower,
    maxLevel: 27, boosts: 3, topK: 3, multi, now: input.now, compareSongs: true,
  };
  const out = E.search(base);
  const mv = few.map((o) => E.memberView(m, o, roster.player));
  const sv = two.map((o) => E.snapView(m, o));
  const ctx = E.makeContext(m, roster.player, event._id, mv, sv, "normal");
  const pay = E.payoff(m, event, "normal");
  const rate = E.boostRate(m, "normal", 3);
  const songs = new Map();
  for (const c of E.charts(m, perPower, { maxLevel: 27, now: input.now })) {
    if (!songs.has(c.musicId)) songs.set(c.musicId, []);
    songs.get(c.musicId).push(c);
  }
  const music = new Map([...songs.keys()].map((id) => [id, E.musicView(m, id)]));
  const rankOn = (list, power) => {
    let best = 0;
    for (const c of list) {
      const own = c.battle.map(([r, b]) => [Math.max(r, 2), Math.max(0, E.battleRequiredScore(b, 5) - multi.othersScore)]);
      best = Math.max(best, E.scoreRankOf(own, power * c.perPower));
    }
    return best;
  };
  const value = (sum, points, rank) => E.eventPoints(points, rate, pay.points.get(rank) || 0) * 1e6 + E.eventItems(pay.items.get(rank) || 0, sum.it, rate);
  // Snap placements: each snap in one slot or unused.
  const places = [];
  for (let a = -1; a < 5; a++) for (let b = -1; b < 5; b++) if (a < 0 || a !== b) places.push([a, b]);
  let best = -Infinity;
  const pick = (k, from, acc) => {
    if (acc.length === 5) {
      for (let L = 0; L < 5; L++) {
        const order = acc.slice();
        [order[L], order[2]] = [order[2], order[L]];
        for (const [a, b] of places) {
          const sn = [null, null, null, null, null];
          if (a >= 0) sn[a] = sv[0];
          if (b >= 0) sn[b] = sv[1];
          const pt = order.reduce((x, v) => x + ctx.memberBonus.get(v).point, 0) + sn.reduce((x, s) => x + (s ? ctx.snapBonus.get(s).point : 0), 0);
          const it = order.reduce((x, v) => x + ctx.memberBonus.get(v).item, 0) + sn.reduce((x, s) => x + (s ? ctx.snapBonus.get(s).item : 0), 0);
          let sum = 0;
          for (const [id, list] of songs) sum += value({ it }, pt, rankOn(list, E.deckPower(m, order, sn, music.get(id), ctx)));
          best = Math.max(best, sum / songs.size);
        }
      }
      return;
    }
    for (let i = from; i < mv.length; i++) {
      if (acc.some((v) => v.characterId === mv[i].characterId)) continue;
      pick(k, i + 1, acc.concat([mv[i]]));
    }
  };
  pick(0, 0, []);
  const top = out.results[0];
  console.log(`random song: ${out.stats.songs} songs, best mean ${(top.score / 1e6).toFixed(2)} pt (brute force ${(best / 1e6).toFixed(2)}),`,
    `ranks ${top.rankDist.map((x) => `${x.rankName} ${Math.round(x.p * 100)}%`).join(" ")}`);
  assert.ok(Math.abs(top.score - best) < 1e-6 * best, `${top.score} vs ${best}`);
  assert.ok(top.rankDist.length > 1);
  assert.strictEqual(out.songs.length, songs.size);
  // The per-song decks are the same deck, and their mean is the deck's.
  assert.ok(Math.abs(out.songs.reduce((a, d) => a + d.score, 0) / songs.size - top.score) < 1e-6 * top.score);
  for (const d of out.songs) assert.deepStrictEqual(d.members.map((v) => v.id), top.members.map((v) => v.id));
  // A private room picks its song: the best deck on the best song pays at least the random song's mean.
  const picked = E.search({ ...base, multi: { ...multi, pickSong: true } });
  assert.ok(!picked.random && picked.results[0].chart && picked.results[0].score >= top.score);
}

(async () => {
  const session = await loadReplay();
  if (!session) {
    console.log("skip simulation: run node test/fetch-replay.js");
    console.log("ok");
    return;
  }
  const gk = (sid, rank, justRate, seeds) => ({
    ranks: [rank, rank, rank], justRate, justTypes: m.justTypes, seeds: seeds || battle.byScore.get(sid).seeds.map((x) => x.seed),
  });
  const empty = S.performers(m, [0, 0, 0, 0, 0].map(() => ({ id: -1 })), [null, null, null, null, null]);

  // No skills: the simulation equals the rates at any rank (the rank bonus is linear in each range's score) and at
  // Just rate 0 or 1, on luck charts too (seed mean); between them the linear Just rate is within 0.5%.
  for (const missions of ["111", "333", "231", "222"]) {
    const song = md.songs.find((s) => s.gekisouMissions.join("") === missions);
    const sid = song.charts[3].scoreId;
    for (const [rank, j] of [[1, 1], [3, 1], [3, 0], [5, 0], [3, 0.5], [4, 0.7]]) {
      const model = E.battleRates(battle, rank, j).perPower.get(sid) * P;
      const sim = S.orderScores(session, sid, P, empty, gk(sid, rank, j)).base;
      if (j === 0 || j === 1) assert.ok(Math.abs(sim - model) < 1e-6, `${sid} rank ${rank} Just ${j}: ${sim} vs ${model}`);
      else assert.ok(Math.abs(sim / model - 1) < 0.005, `${sid} rank ${rank} Just ${j}: ${sim} vs ${model}`);
    }
  }

  // A member's Gekisou skill alone at the top level adds what music-data measured (charts without luck ranges, where
  // the seed does not matter); a lower level is the measured gain times its simulated level factor.
  const bt = E.battleRates(battle, 3, 1);
  const cards = m.t.MasterMemberCard.filter((c, i, a) => a.findIndex((x) => x._gekisouSkillID === c._gekisouSkillID) === i);
  const pairs = cards.flatMap((c) => [1, 3].map((l) => [c._gekisouSkillID, l]));
  const levels = S.gekisouLevelFactors(session, m, battle, bt, pairs);
  for (const missions of ["111", "333"]) {
    const song = md.songs.find((s) => s.gekisouMissions.join("") === missions);
    const sid = song.charts[2].scoreId;
    const base = S.orderScores(session, sid, P, empty, gk(sid, 3, 1)).base;
    for (const c of cards) {
      for (const lv of [5, 1, 3]) {
        const v = E.memberView(m, { id: c._id, level: 1, gekisouSkillLevel: lv }, {});
        const est = E.gekisouSkillRate(m, battle, bt, v, sid, levels) * P;
        const perf = empty.slice();
        perf[0] = { ...S.performers(m, [{ id: c._id, gekisouSkillLevel: lv }], [null])[0], liveSkill: null };
        const inc = S.orderScores(session, sid, P, perf, gk(sid, 3, 1)).base - base;
        if (!est && !inc) continue;
        console.log(`  ${sid} Gekisou skill ${c._gekisouSkillID} Lv${lv}: search ${Math.round(est)}, simulated ${inc}`);
        if (lv === 5) assert.ok(Math.abs(est - inc) <= 3);
        else assert.ok(Math.abs(est / inc - 1) < 0.35);
      }
    }
  }

  // The best multiplayer deck of the roster on its best song: the simulation (snap skills, Gekisou support skills, all
  // 120 orders) against the search's estimate.
  const all = E.search({ ...input, musicIds: undefined, difficulties: undefined, gekisouLevels: levels, multi: { players: 5, othersScore: 4 * 4.9e6, gekisouRank: 3, justRate: 1 } });
  const best = all.songs[0];
  const members = best.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel }));
  const snaps = best.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null));
  const sid = best.chart.scoreId;
  const t0 = Date.now();
  const sim = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps), gk(sid, 3, 1));
  const noSnap = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps.map(() => null)), gk(sid, 3, 1));
  console.log(`best deck on ${m.text(m.musics.get(best.chart.musicId)._titleTextID)} ${best.chart.difficulty}: search ${best.estScore}`,
    `(Gekisou skills +${best.gekisouScore}); simulated without snaps ${Math.round(noSnap.mean)}, with snaps ${Math.round(sim.mean)}`,
    `(orders ${sim.scores[0]}–${sim.scores[119]}, ${Date.now() - t0} ms)`);
  assert.ok(sim.gekisou && sim.exact);
  assert.ok(Math.abs(noSnap.mean / best.estScore - 1) < 0.05);
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
