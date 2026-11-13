// COMBO ranges ranked by mission pt: the pt against results/IMG_0177–0182, the timeline against the replay, the
// simulation's expected rank bonus, the search's factor against the simulation and the searches against brute forces.
// Run: node test/combo-rank.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const E = require("../engine.js");
const S = require("../simulate.js");
const loadReplay = require("./replay.js");
const root = path.join(__dirname, "../..");
const raw = Object.fromEntries(E.TABLES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata/hk-tw-mo", t + ".json"), "utf8"))]));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data/music-data.json"), "utf8"));
const battle = E.battleFromMusicData(md);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets/my-roster.json"), "utf8"));
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);

// What the worker gives a search (worker.js comboRankOf).
function comboRankOf(session, input) {
  const rs = E.comboRankScope(input);
  const ctx = S.comboContext(m, [...new Set(rs.pool.map((c) => c.key))], rs.support, rs.idle);
  const rows = rs.keys.length ? S.comboContext(m, rs.keys, rs.support, rs.idle).countRows : new Map();
  const byScore = new Map();
  for (const sid of rs.scoreIds) {
    const out = S.comboRankChart(session, ctx, sid, rs.pool);
    byScore.set(sid, { tl: { rows, ranges: out.tl.ranges }, ranges: out.ranges });
  }
  return { players: rs.players, byScore };
}

(async () => {
  // The rank chances.
  assert.deepStrictEqual(Array.from(E.rankChances(5, 0)), [1, 0, 0, 0, 0]);
  assert.deepStrictEqual(Array.from(E.rankChances(5, 1)), [0, 0, 0, 0, 1]);
  near(Array.from(E.rankChances(4, 0.3)).reduce((a, b) => a + b, 0), 1, 1e-12, "chances add up");
  near(E.rankChances(3, 0.5)[1], 0.5, 1e-12, "binomial");
  assert.strictEqual(E.aboveChance(100, 100, 300), 1);
  assert.strictEqual(E.aboveChance(300, 100, 300), 0);
  assert.strictEqual(E.aboveChance(50, 100, 300), 1);
  assert.strictEqual(E.aboveChance(200, 100, 300), 0.5);
  const row = [250, 190, 160, 100, 100];
  near(E.expectedPercent(row, 5, 0), 250, 1e-9, "first for sure");
  near(E.expectedPercent(row, 5, 1), 100, 1e-9, "last for sure");
  near(E.expectedPercent(row, 2, 0.25), 0.75 * 250 + 0.25 * 190, 1e-9, "two players");

  // scoreOf: a COMBO range's bonus by its combo, the others' mean over the ranks as before.
  const pcts = [row, row, row];
  const gk = S.gekisouPlay({ ranks: [1, 2, 3, 4, 5], justRate: 0 }, pcts, new Set(), [0], { players: 5, ranges: [{ i: 1, lo: 100, hi: 300 }] });
  const res = { score: 100000, ranges: [
    { startScore: 0, endScore: 1000, rankBonus: 2500, combo: 1 },
    { startScore: 1000, endScore: 3000, rankBonus: 5000, combo: 300 },
    { startScore: 3000, endScore: 4000, rankBonus: 2500, combo: 1 },
  ] };
  // Ranges 0 and 2: the mean of 2500, 1900, 1600, 1000, 1000 = 1600. Range 1: first for sure, 5000.
  assert.strictEqual(S.scoreOf(res, gk), 100000 + (1600 - 2500) + 0 + (1600 - 2500));
  assert.strictEqual(S.scoreOf({ ...res, ranges: res.ranges.map((x, i) => (i === 1 ? { ...x, combo: 100 } : x)) }, gk), 100000 - 900 + (2000 - 5000) - 900);
  console.log("rank chances, expected percent, scoreOf: ok");

  // results/IMG_0177–0182 (2026-11-08, 激奏舞台 all-COMBO, 顏 EXPERT): the 1st place's deck shows 943/1023/1495 pt.
  const probes = E.kindProbes(battle.kinds);
  const arena = await loadReplay(undefined, { missions: [1, 1, 1], probes });
  const sid = 10003103;
  const combosOf = (session, id, members, snaps) => {
    const tpl = JSON.parse(session.template(id, 830254, 60));
    const req = S.gekisouRequest(session, tpl, id, { ranks: [4, 4, 4], justRate: 0.05, justTypes: m.justTypes });
    return JSON.parse(session.run(JSON.stringify({ ...req, performers: S.performers(m, members, snaps), skillOrder: [0, 1, 2, 3, 4] }))).ranges.map((r) => r.combo);
  };
  const first = [73, 58, 60, 59, 57].map((id) => ({ id, gekisouSkillLevel: 4 }));
  const firstSnaps = [{ id: 76, rank: 1 }, { id: 34, rank: 4 }, { id: 53, rank: 3 }, { id: 78, rank: 5 }, { id: 33, rank: 5 }];
  const combo = combosOf(arena, sid, first, firstSnaps);
  assert.deepStrictEqual(combo.map((x) => x + E.MISSION_PT_OFFSET), [943, 1023, 1495], "IMG_0177–0182 mission pt");

  // Every card's COMBO count-up skills at random levels against the replay.
  const cards = [...m.memberCards.values()].filter((c) => c._gekisouSkillID && E.comboCountOf(m, c._gekisouSkillID, m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1));
  const keys = [...new Set(cards.flatMap((c) => [1, 2, 3, 4, 5].filter((l) => l <= (m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1)).map((l) => E.comboCountOf(m, c._gekisouSkillID, l))))].filter(Boolean);
  const support = [...m.gekisouSupportSkills.keys()].find((id) => E.gekisouSupportKind(m, id) === "combo");
  const idle = m.t.MasterGekisouSkill.find((g) => {
    const r = m.gekisouSkillEffects.get(g._id + ":1") || [];
    return r.length && r.every((e) => e._skillEffectType === 13000);
  })._id;
  const ctx = S.comboContext(m, keys, support, idle);
  const plain = await loadReplay();
  const withCombo = [...battle.byScore].filter(([, b]) => b.missions.includes(1)).map(([id]) => id);
  const jobs = [[arena, sid], ...Array.from({ length: 4 }, () => [plain, withCombo[Math.floor(rand() * withCombo.length)]])];
  const fillers = [7, 10, 8, 34, 35, 1, 2, 3];
  let worst = 0;
  let sets = 0;
  for (const [session, id] of jobs) {
    const out = S.comboRankChart(session, ctx, id, []);
    const tl = { rows: ctx.countRows, ranges: out.tl.ranges };
    for (let t = 0; t < 12; t++) {
      const pick = [];
      const chs = new Set();
      const want = 1 + Math.floor(rand() * 5);
      for (let a = 0; a < 50 && pick.length < want; a++) {
        const c = cards[Math.floor(rand() * cards.length)];
        if (chs.has(c._characterID)) continue;
        chs.add(c._characterID);
        pick.push({ id: c._id, gk: c._gekisouSkillID, gekisouSkillLevel: 1 + Math.floor(rand() * (m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1)) });
      }
      const mem = pick.map((p) => ({ id: p.id, gekisouSkillLevel: p.gekisouSkillLevel }));
      for (const f of fillers) {
        const ch = m.memberCards.get(f)._characterID;
        if (mem.length < 5 && !chs.has(ch)) {
          chs.add(ch);
          mem.push({ id: f });
        }
      }
      const replay = combosOf(session, id, mem, [null, null, null, null, null]);
      const got = E.comboRangeCounts(tl, pick.map((p) => E.comboCountOf(m, p.gk, p.gekisouSkillLevel)).filter(Boolean));
      out.ranges.forEach((r, j) => (worst = Math.max(worst, Math.abs(replay[r.i] - got[j]))));
      sets++;
    }
  }
  assert.ok(worst <= 4, `timeline vs replay: worst ${worst}`);
  console.log(`mission pt of IMG_0177–0182 exact; ${sets} sets on ${jobs.length} charts within ${worst} of the replay`);

  // Searches: a small roster holding COMBO count-up members beside stronger ones of the same characters.
  const allM = roster.members.filter((o) => E.memberView(m, o, roster.player));
  const isCombo = (o) => !!E.memberView(m, o, roster.player).comboCount;
  const power = (o) => E.memberView(m, o, roster.player).power.reduce((a, b) => a + b, 0);
  const strong = allM.slice().sort((a, b) => power(b) - power(a));
  const members = [...strong.filter(isCombo).slice(0, 4), ...strong.filter((o) => !isCombo(o)).slice(0, 8)];
  const snaps = roster.snaps.slice().sort((a, b) => b.level - a.level).slice(0, 6);
  const songs = (want) => md.songs.filter((s) => want(s.gekisouMissions || [])).map((s) => s.id);
  const all = songs((x) => x.join("") === "111").slice(0, 2);
  const mixed = songs((x) => x.includes(1) && x.join("") !== "111").slice(0, 1);
  const none = songs((x) => x.length && !x.includes(1)).slice(0, 1);
  const base = { master: m, event: null, mode: "normal", objective: "score", members, snaps, player: roster.player,
    perPowerByScore: E.perPowerFromMusicData(md), skillWeights: E.skillWeightsFromMusicData(md), battle, maxLevel: 30, difficulties: ["expert"],
    now: new Date("2026-11-08T00:00:00Z"), topK: 1 };
  const brute = (input, label) => {
    let best = -Infinity;
    let top = null;
    const pool = input.members;
    const go = (from, chosen) => {
      if (chosen.length === 5) {
        const out = E.search({ ...input, members: chosen });
        if (out.results.length && out.results[0].score > best) {
          best = out.results[0].score;
          top = out.results[0];
        }
        return;
      }
      for (let i = from; i < pool.length; i++) {
        const ch = m.memberCards.get(pool[i].id)._characterID;
        if (!chosen.some((o) => m.memberCards.get(o.id)._characterID === ch)) go(i + 1, chosen.concat([pool[i]]));
      }
    };
    go(0, []);
    const out = E.search(input);
    near(out.results[0].score, best, Math.abs(best) * 1e-9, `${label}: search vs brute force`);
    return { out, top };
  };
  const multi = { players: 5, othersScore: 0, auto: true, justRate: 0.05 };
  for (const [label, musicIds, pickSong] of [["random", [...all, ...mixed, ...none], false], ["pick", all.slice(0, 1), true], ["pick mixed", mixed, true]]) {
    const input0 = { ...base, musicIds, multi: { ...multi, pickSong } };
    const input = { ...input0, comboRank: comboRankOf(plain, input0) };
    const { out } = brute(input, label);
    const d = pickSong ? out.results[0] : out.perSong[0].find((x) => x.comboRank);
    assert.ok(d.comboRank && d.comboRank.length, `${label}: the deck carries its COMBO ranges`);
    console.log(`${label}: search = brute force, ${d.comboRank.map((r) => `pt ${r.pt} (+${Math.round(r.percent)}%)`).join(" ")}, K ${d.comboRankFactor.toFixed(3)}`);
  }

  // A search without input.comboRank is as before (no field, no factor); a room of known others ignores it.
  const input0 = { ...base, musicIds: all.slice(0, 1), multi: { ...multi, pickSong: true } };
  const comboRank = comboRankOf(plain, input0);
  assert.strictEqual(E.search(input0).results[0].comboRank, undefined);
  const known = { ...input0, multi: { players: 5, othersScore: 0, gekisouRank: 3, justRate: 0.05, pickSong: true } };
  assert.strictEqual(E.comboRankScope(known), null);
  assert.strictEqual(E.search({ ...known, comboRank }).results[0].comboRank, undefined);
  // Points are ranked as before: the rank model is the score objective's.
  assert.strictEqual(E.search({ ...input0, event: E.currentEvent(m, input0.now), objective: "points", comboRank }).results[0].comboRank, undefined);

  // The factor against the simulation: the rank model's score over the mean ranks' for decks of different combos.
  const scoreId = comboRank.byScore.keys().next().value;
  const b = battle.byScore.get(scoreId);
  const gkOut = { ranks: [1, 2, 3, 4, 5], justRate: 0.05 };
  const out = E.search({ ...input0, comboRank, topK: 8 });
  let worstK = 0;
  for (const d of out.results) {
    const perf = S.performers(m, d.members.map((v) => ({ id: v.id, skillLevel: v.liveSkillLevel, gekisouSkillLevel: v.gekisouSkillLevel })), d.snaps.map((x) => (x ? { id: x.id, rank: x.rank } : null)));
    const sim = (rank) => S.orderScores(plain, d.chart.scoreId, d.displayPower, perf, S.gekisouPlay(gkOut, b.percents, m.justTypes, [b.seeds[0].seed], rank)).mean;
    const ratio = sim(d.rankModel) / sim(null);
    worstK = Math.max(worstK, Math.abs(d.comboRankFactor / ratio - 1));
  }
  assert.ok(worstK < 0.03, `search factor vs simulation: ${worstK}`);
  console.log(`factor K within ${(worstK * 100).toFixed(2)}% of the simulation (${out.results.length} decks)`);

  // 激奏舞台: the opponents' cards are the league's band only.
  const band = 5;
  const arenaScope = E.comboRankScope({ ...input0, arena: { bandId: band, musicType: 99, missions: [1, 1, 1] } });
  assert.ok(arenaScope.pool.every((c) => m.characters.get(c.character)._bandID === band));
  assert.ok(arenaScope.pool.length < E.comboRankScope(input0).pool.length);

  // Coverage: every card's COMBO count-up skill compiles (a new shape must fail here, not leave a card out quietly).
  for (const c of cards) for (let l = 1; l <= (m.gekisouSkillMaxLevel.get(c._gekisouSkillID) || 1); l++) {
    const k = E.comboCountOf(m, c._gekisouSkillID, l);
    if (k) S.comboContext(m, [k], support, idle);
  }
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
