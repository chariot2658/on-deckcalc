// Multiplayer lives with Gekisou: the search's Gekisou score (music-data seeds, the rank bonus formula, the Just rate,
// members' Gekisou skills, snaps' Gekisou support skills, the LUCK gauge and COMBO count-up interactions) against the
// replay simulation, the room rank of results/IMG_0030–31, public rooms (one deck for every song in points and in the
// score objective against brute forces, the Gekisou range types of saved decks) and Simulate.meanScore.
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
  // Engine.roomPayoff (the payoff of a simulated score) gives a per-song deck's points at its estimated score.
  for (const d of out.songs.slice(0, 10)) {
    const p = E.roomPayoff({ ...base, master: m }, d.chart, d.estScore / d.accuracy, d.pointBonus, d.itemBonus);
    assert.strictEqual(p.points, d.points);
  }
}

// Saved decks for public rooms are one per Gekisou range type: every song with Gekisou data falls in one group.
{
  const groups = E.gekisouSongGroups({ ...input, musicIds: undefined, difficulties: undefined, maxLevel: 40, multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.1 } });
  const types = new Map(md.songs.map((s) => [s.id, E.gekisouSongType(s.gekisouMissions)]));
  assert.deepStrictEqual(groups.map((g) => g.type), [1, 2, 3, 0]);
  for (const g of groups) for (const id of g.musicIds) assert.strictEqual(types.get(id), g.type);
  console.log(`Gekisou range types: ${groups.map((g) => `${["mixed", "COMBO", "LUCK", "JUST"][g.type]} ${g.musicIds.length}`).join(", ")}`);
}

// Interactions between members' Gekisou skills and snaps' Gekisou support skills: LUCK gauge members (11001, the LIFE
// version 11003 by its chance) raise LUCKY RUSH 分數UP, COMBO count-up members (12000) the COMBO-stacking support skills.
assert.strictEqual(E.luckGaugeOf(m, 7, 1), 1);
assert.strictEqual(E.luckGaugeOf(m, 9, 5), 1);
assert.ok(Math.abs(E.luckGaugeOf(m, 20, 1) - 0.42) < 1e-9 && Math.abs(E.luckGaugeOf(m, 20, 5) - 1.3) < 1e-9);
assert.strictEqual(E.luckGaugeOf(m, 4, 1), 0);
assert.strictEqual(E.comboCountOf(m, 6, 1), "6:1");
assert.strictEqual(E.comboCountOf(m, 1, 1), null);
assert.deepStrictEqual([41, 27, 1, 86].map((id) => E.gekisouSupportKind(m, id)), ["rush", "combo", null, null]);
assert.ok(Math.abs(E.comboCountBoost({ s: [1, 2], b: new Map([["6:1", [0.5, 0.5]], ["4:1", [0.5, 0.5]]]) }, ["6:1", "4:1"], 0) - 0.75) < 1e-12);

// Score objective in a public room: the best deck by the mean expected score over the songs (one chart each), with
// Gekisou support skills and the LUCK gauge's share, against a brute force over member sets, leaders and the placements
// of a LUCKY RUSH and a COMBO-stacking snap.
{
  const few = roster.members.slice(0, 10);
  const two = roster.snaps.filter((s) => s.id === 51 || s.id === 53);
  const songIds = ["222", "222", "213", "111"].map((p, i, a) => md.songs.filter((s) => s.gekisouMissions.join("") === p)[a.slice(0, i).filter((x) => x === p).length].id);
  const multi = { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.2 };
  const base = {
    master: m, event: null, mode: "normal", objective: "score", members: few, snaps: two, player: roster.player, perPowerByScore: perPower,
    skillWeights: sw, battle, maxLevel: 40, difficulties: ["expert"], musicIds: songIds, topK: 3, multi, now: input.now, compareSongs: true,
  };
  const out = E.search(base);
  const bt = E.battleRates(battle, 3, 0.2);
  const swG = { kinds: battle.kinds, byScore: bt.weights };
  const mv = few.map((o) => E.memberView(m, o, roster.player));
  const sv = two.map((o) => E.snapView(m, o));
  const ctx = E.makeContext(m, roster.player, null, mv, sv, "normal");
  const charts = songIds.map((id) => E.charts(m, bt.perPower, { musicIds: [id], difficulties: ["expert"], maxLevel: 40, now: input.now })[0]);
  const valueOf = (order, sn) => {
    const gauge = Math.max(...order.map((v) => v.luckGauge));
    let sum = 0;
    for (const c of charts) {
      let r = c.perPower;
      order.forEach((v, i) => {
        r += E.liveSkillRate(m, [v], c.scoreId, swG) + E.gekisouSkillRate(m, battle, bt, v, c.scoreId, null);
        for (const [, x, kind] of sn[i] ? E.gekisouSupportTerms(m, battle, bt, v, sn[i], c.scoreId, null) : []) {
          r += x * (kind === "rush" ? 1 + E.luckGaugeBoost(battle, gauge, c.scoreId) : 1);
        }
      });
      sum += E.deckPower(m, order, sn, E.musicView(m, c.musicId), ctx) * r;
    }
    return sum / charts.length;
  };
  const places = [];
  for (let a = -1; a < 5; a++) for (let b = -1; b < 5; b++) if (a < 0 || a !== b) places.push([a, b]);
  let best = -Infinity;
  const pick = (from, acc) => {
    if (acc.length === 5) {
      for (let L = 0; L < 5; L++) {
        const order = acc.slice();
        [order[L], order[2]] = [order[2], order[L]];
        for (const [a, b] of places) {
          const sn = [null, null, null, null, null];
          if (a >= 0) sn[a] = sv[0];
          if (b >= 0) sn[b] = sv[1];
          best = Math.max(best, valueOf(order, sn));
        }
      }
      return;
    }
    for (let i = from; i < mv.length; i++) if (!acc.some((v) => v.characterId === mv[i].characterId)) pick(i + 1, acc.concat([mv[i]]));
  };
  pick(0, []);
  const top = out.results[0];
  console.log(`random song, score objective: ${out.stats.songs} songs, best mean ${Math.round(top.score)} (brute force ${Math.round(best)}),`,
    `members ${top.members.map((v) => v.id).join(",")} snaps ${top.snaps.map((s) => s && s.id).join(",")}`);
  assert.ok(top.random && !top.chart && out.songs.length === songIds.length);
  assert.ok(Math.abs(top.score - best) < 1e-9 * best, `${top.score} vs ${best}`);
  assert.ok(Math.abs(out.songs.reduce((a, d) => a + d.score, 0) / out.songs.length - top.score) < 1e-6 * top.score);
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

  // Snaps' Gekisou support skills: music-data's shapes (at the top level) are what the simulation adds beside a member
  // whose Gekisou skill is of another mission, matching the member condition or not (charts without luck ranges, where
  // the seed does not matter); levels whose rows only scale a value (LUCKY RUSH 分數UP, the COMBO range's cumulative
  // score-up) take the value ratio, the others a simulated factor.
  {
    const bt1 = E.battleRates(battle, 3, 1);
    const empty1 = () => S.performers(m, [{ id: -1 }], [null])[0];
    const hostOf = (id, match) => {
      const mission = m.gekisouSupportSkills.get(id)._gekisouMissionType;
      const gkRow = m.t.MasterGekisouSkill.find((g) => g._gekisouMissionType !== mission);
      let band = 0;
      for (const e of m.gekisouSupportSkillEffects.get(id + ":5")) {
        for (const cs of m.conditionSets.get(e._skillConditionGroup) || []) {
          for (const cid of cs._conditionIds) {
            const c = m.skillConditions.get(cid);
            if (c._conditionType === 5000) band = m.skillTargets.get(c._conditionTargetIDs[0])._bandID;
          }
        }
      }
      return { ...empty1(), gekisouSkill: [gkRow._id, 1], gekisouMissionType: gkRow._gekisouMissionType, bandId: match ? band : 0 };
    };
    const inc = (sid, id, level, match) => {
      const host = hostOf(id, match);
      const perf = (sup) => [{ ...host, gekisouSupportSkills: sup }].concat([1, 2, 3, 4].map(empty1));
      return S.orderScores(session, sid, P, perf([[id, level]]), gk(sid, 3, 1)).base - S.orderScores(session, sid, P, perf([]), gk(sid, 3, 1)).base;
    };
    assert.strictEqual(E.gekisouSupportLevelRatio(m, 41, 1), 4000 / 7000);
    assert.strictEqual(E.gekisouSupportLevelRatio(m, 16, 2), 50 / 200);
    assert.strictEqual(E.gekisouSupportLevelRatio(m, 1, 2), null); // same value, a lower cap
    const supportLevels = S.gekisouSupportLevelFactors(session, m, battle, bt1, [[1, 2, 0], [1, 2, 1]]);
    for (const [missions, ids] of [["333", [1, 13]], ["111", [16, 27]]]) {
      const sid = md.songs.find((s) => s.gekisouMissions.join("") === missions).charts[2].scoreId;
      for (const id of ids) {
        for (const match of [0, 1]) {
          const shape = battle.supportShapes.get(id + ":5");
          const est = bt1.aptSupport.get(sid).get(shape + ":" + match) * P;
          const sim = inc(sid, id, 5, match);
          console.log(`  ${sid} Gekisou support skill ${id} Lv5 ${match ? "band" : "other"}: search ${Math.round(est)}, simulated ${sim}`);
          assert.ok(Math.abs(est - sim) <= 3);
        }
      }
    }
    // The Just-count range's score-up per Just up to a cap (support skills 1–15) depends on the Just rate and the cap
    // (the level) out of proportion: the stack model (Engine.justStackShare) against the simulation.
    assert.deepStrictEqual(E.gekisouSupportJustStack(m, 1, 2, 1), { value: 300, cap: 500, per: 1, steps: 999999 });
    assert.strictEqual(E.gekisouSupportJustStack(m, 16, 5, 1), null); // per 10 combo
    for (const missions of ["333", "231"]) {
      const sid = md.songs.find((s) => s.gekisouMissions.join("") === missions).charts[3].scoreId;
      for (const justRate of [1, 0.5, 0.2]) {
        const btj = E.battleRates(battle, 3, justRate);
        for (const match of [0, 1]) {
          const v = E.memberView(m, { id: match ? 1 : 11, level: 1 }, {}); // 燈 (MyGO!!!!!, skill 1's band) or 阿拉蕾
          for (const rank of [1, 2, 5]) {
            const s = E.snapView(m, { id: 3, level: 1, rank }); // support skill 1 at the snap's rank
            const est = E.gekisouSupportRate(m, battle, btj, v, s, sid, supportLevels) * P;
            const host = hostOf(1, E.gekisouSupportMatch(m, v, 1, 5) ? 1 : 0);
            const perf = (sup) => [{ ...host, gekisouSupportSkills: sup }].concat([1, 2, 3, 4].map(empty1));
            const sim = S.orderScores(session, sid, P, perf(s.gekisouSupportSkills), gk(sid, 3, justRate)).base - S.orderScores(session, sid, P, perf([]), gk(sid, 3, justRate)).base;
            console.log(`  ${sid} Gekisou support skill 1 Lv${rank} ${match ? "band" : "other"} Just ${justRate}: search ${Math.round(est)}, simulated ${sim}`);
            assert.ok(Math.abs(est / sim - 1) < (justRate < 0.5 ? 0.15 : 0.05));
          }
        }
      }
    }
  }

  // Live skill weights were measured on the Just play: at a lower Just rate each range's part is scaled by its score
  // (a Just note scores 230%), within 3% of the simulation (it was 60% high at Just rate 20% on all-Just charts).
  {
    const ids = [1, 12, 13, 14, 15];
    const views = ids.map((id) => E.memberView(m, roster.members.find((o) => o.id === id) || { id }, roster.player));
    const perf = S.performers(m, ids.map((id) => ({ id })), [null, null, null, null, null]).map((p) => ({ ...p, gekisouSkill: null, gekisouSupportSkills: [] }));
    for (const missions of ["333", "231", "312"]) {
      const sid = md.songs.find((s) => s.gekisouMissions.join("") === missions).charts[3].scoreId;
      for (const [rank, justRate] of [[5, 0.2], [3, 0.5]]) {
        const btj = E.battleRates(battle, rank, justRate);
        const est = E.liveSkillRate(m, views, sid, { kinds: battle.kinds, byScore: btj.weights }) * P;
        const o = S.orderScores(session, sid, P, perf, gk(sid, rank, justRate, battle.byScore.get(sid).luck ? undefined : [battle.byScore.get(sid).seeds[0].seed]));
        console.log(`  ${sid} live skills rank ${rank} Just ${justRate}: search ${Math.round(est)}, simulated ${Math.round(o.mean - o.base)}`);
        assert.ok(Math.abs(est / (o.mean - o.base) - 1) < 0.03);
      }
    }
  }

  // The best multiplayer deck of the roster on its best song: the simulation (snap skills, Gekisou support skills, all
  // 120 orders) against the search's estimate (Gekisou support skills, and the snap skills' rough estimate).
  const all = E.search({ ...input, musicIds: undefined, difficulties: undefined, gekisouLevels: levels, multi: { players: 5, othersScore: 4 * 4.9e6, gekisouRank: 3, justRate: 1 } });
  const best = all.songs[0];
  const members = best.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel }));
  const snaps = best.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null));
  const sid = best.chart.scoreId;
  const t0 = Date.now();
  const sim = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps), gk(sid, 3, 1));
  const gkOnly = S.orderScores(session, sid, best.displayPower, S.performers(m, members, snaps).map((p) => ({ ...p, supportSkills: [] })), gk(sid, 3, 1));
  console.log(`best deck on ${m.text(m.musics.get(best.chart.musicId)._titleTextID)} ${best.chart.difficulty}: search ${best.estScore}`,
    `(Gekisou skills +${best.gekisouScore}, snaps' +${best.gekisouSupportScore}, snap skills roughly +${best.snapScore}); simulated with the snaps' Gekisou skills only ${Math.round(gkOnly.mean)},`,
    `with all snap skills ${Math.round(sim.mean)} (orders ${sim.scores[0]}–${sim.scores[119]}, ${Date.now() - t0} ms)`);
  assert.ok(sim.gekisou && sim.exact);
  assert.ok(best.snapRough && best.snapScore > 0);
  assert.ok(Math.abs(sim.mean / best.estScore - 1) < 0.02);

  // Simulate.meanScore: five whole runs in a Latin square of orders give the mean over the 120 orders (members' gains
  // add up off LUCK ranges); a LUCK chart's seeds are drawn run by run.
  {
    const sidC = md.songs.find((s) => s.gekisouMissions.join("") === "111").charts[3].scoreId;
    const perf = S.performers(m, best.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })), best.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null)));
    const g = gk(sidC, 3, 1, [battle.byScore.get(sidC).seeds[0].seed]);
    const full = S.orderScores(session, sidC, best.displayPower, perf, g);
    const run = S.chartRunner(session, sidC, g);
    const latin = S.meanScore(run, best.displayPower, perf, g.seeds, 5);
    console.log(`meanScore ${sidC}: 5 runs ${Math.round(latin)}, 120 orders ${Math.round(full.mean)} (exact ${full.exact})`);
    assert.ok(full.exact && Math.abs(latin - full.mean) < 1e-6 * full.mean);
  }

  // COMBO count-up members (若麥 GK6, 睦 GK18) make the COMBO-stacking snaps (support skills 18, 22, 27) stack sooner:
  // Simulate.comboBoosts measures the share per chart; the search's estimate of their deck is then near the simulation,
  // and without it far below.
  {
    const ownedOf = (id) => {
      const c = m.memberCards.get(id);
      const L = E.memberLimits(m, c);
      return { id, level: L.limit(L.maxAwake), awake: L.maxAwake, rank: 1, skillLevel: 1, gekisouSkillLevel: 1 };
    };
    const members = [32, 59, 58, 60, 62].map(ownedOf);
    const snaps = [13, 61, 34, 53, 62].map((id) => ({ id, level: E.snapLimit(m, m.snaps.get(id), 1), rank: 1 }));
    const song = md.songs.find((s) => s.gekisouMissions.join("") === "111");
    const base = {
      master: m, event: null, mode: "normal", objective: "score", members, snaps, player: roster.player, perPowerByScore: perPower, skillWeights: sw,
      battle, maxLevel: 40, difficulties: ["expert"], musicIds: [song.id], topK: 1, now: input.now,
      multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.1, pickSong: true },
    };
    const scope = E.comboScope(base);
    assert.deepStrictEqual(scope.keys, ["18:1", "6:1"]);
    const bt3 = E.battleRates(battle, 3, 0.1);
    const sid = scope.scoreIds[0];
    const entry = S.comboBoosts(session, m, bt3, sid, scope.keys, scope.support, scope.idle);
    const comboBoost = { byScore: new Map([[sid, entry]]), byMusic: new Map() };
    // As the worker: the Lv1 Gekisou skills' level factors and the snap skill rates measured first.
    const lv = S.gekisouLevelFactors(session, m, battle, bt3, members.map((o) => E.memberView(m, o, {})).filter((v) => v.gekisouSkillId).map((v) => [v.gekisouSkillId, v.gekisouSkillLevel]));
    const scopeS = E.scoreScope(base);
    const rates = S.snapSkillRates(session, m, sid, scopeS.pairs, gk(sid, 3, 0.1, [battle.byScore.get(sid).seeds[0].seed]));
    const measured = { ...base, gekisouLevels: lv, snapSkill: { byScore: new Map([[sid, rates]]) } };
    const d = E.search({ ...measured, comboBoost }).results[0];
    const without = E.search(measured).results[0];
    const perf = S.performers(m, d.members.map((v) => ({ id: v.id, skillLevel: 1, gekisouSkillLevel: 1 })), d.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null)));
    const sim = S.orderScores(session, sid, d.displayPower, perf, gk(sid, 3, 0.1, [battle.byScore.get(sid).seeds[0].seed]));
    console.log(`COMBO count-up ${sid}: shares ${[...entry.b].map(([k, b]) => `${k} ${b.map((x) => Math.round(x * 100) + "%").join("/")}`).join(", ")},`,
      `saturation ${entry.s.map((x) => Math.round(x * 100) + "%").join("/")}; estimate ${d.estScore} (without the shares ${without.estScore}), simulated ${Math.round(sim.mean)}`);
    assert.ok(entry.b.get("6:1")[0] > 0.3 && entry.s[0] >= entry.b.get("6:1")[0]);
    assert.ok(Math.abs(d.estScore / sim.mean - 1) < 0.03);
    assert.ok(without.estScore / sim.mean < 0.95);
  }

  // 「愛素 LUCK 隊」: on an all-LUCK chart with every card owned, the score objective pairs LUCKY RUSH 分數UP snaps with
  // members of their band and keeps 愛音★4 and 爽世★4 (LUCK gauge +300%). The estimate adds pairs up; the simulation (64
  // seeds) plays the gauge skills' extra rushes too.
  {
    const allMembers = m.t.MasterMemberCard.map((c) => {
      const L = E.memberLimits(m, c);
      return { id: c._id, level: L.limit(L.maxAwake), awake: L.maxAwake, rank: 1, skillLevel: m.liveSkillMaxLevel.get(c._liveSkillID) || 1, gekisouSkillLevel: 5 };
    });
    const allSnaps = m.t.MasterSupportCard.map((s) => ({ id: s._id, level: E.snapLimit(m, s, 5), rank: 5 }));
    const luck = md.songs.find((s) => s.gekisouMissions.join("") === "222");
    const sidL = luck.charts.find((c) => c.difficulty === "expert").scoreId;
    const t1 = Date.now();
    const out = E.search({
      master: m, event: null, mode: "normal", objective: "score", members: allMembers, snaps: allSnaps, player: roster.player, perPowerByScore: perPower,
      skillWeights: sw, battle, maxLevel: 40, difficulties: ["expert"], musicIds: [luck.id], topK: 1, now: input.now,
      multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.2, pickSong: true },
    });
    const d = out.results[0];
    const ids = d.members.map((v) => v.id);
    const rush = d.snaps.filter((s, i) => s && s.gekisouSupportSkills.length && E.gekisouSupportMatch(m, d.members[i], s.gekisouSupportSkills[0][0], 5) &&
      m.gekisouSupportSkills.get(s.gekisouSupportSkills[0][0])._gekisouMissionType === 2);
    const t2 = Date.now();
    const seeds = S.luckSeeds(battle.byScore.get(sidL).seeds.map((x) => x.seed), 64);
    const perfL = S.performers(m, d.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: 5 })), d.snaps.map((s) => (s ? { id: s.id, rank: s.rank } : null)));
    const gkL = { ranks: [3, 3, 3], justRate: 0.2, justTypes: m.justTypes, seeds };
    const simL = S.orderScores(session, sidL, d.power, perfL, gkL);
    const simG = S.orderScores(session, sidL, d.power, perfL.map((p) => ({ ...p, supportSkills: [] })), gkL);
    console.log(`all-LUCK ${sidL}: members ${ids.join(",")} snaps ${d.snaps.map((s) => s && s.id).join(",")}, ${rush.length} band-matched LUCK snaps;`,
      `search ${d.estScore} (snaps' Gekisou skills +${d.gekisouSupportScore}, ${t2 - t1} ms), simulated ${Math.round(simL.mean)}, without the snap skills ${Math.round(simG.mean)} (${Date.now() - t2} ms)`);
    assert.ok(ids.includes(52) && ids.includes(54));
    assert.ok(rush.length >= 3);
    assert.ok(d.gekisouSupportScore > 0.3 * d.estScore);
    // The score objective has no snap skills without measured rates. The gauge members bring more rushes, which every
    // LUCKY RUSH 分數UP acts in: the search adds LUCK_GAUGE_BOOST's mean share (17% on all-LUCK charts), 6–7 points more
    // than this chart's (it was 4% low without it); the worker ranks a pool of decks by the simulation.
    assert.ok(Math.abs(d.estScore / simG.mean - 1) < 0.06);
  }
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
