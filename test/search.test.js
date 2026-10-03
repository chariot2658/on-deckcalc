// Runs the deck search on the preset roster and checks it against the in-game results of 2026-10-01.
// Run: node test/search.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");

const root = path.join(__dirname, "..", "..");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata", "hk-tw-mo", t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const perPower = E.perPowerFromMusicData(md);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "my-roster.json"), "utf8"));
const event = m.events.get(1);

// Event point and item formulas against the result screens (3 boosts, rank C).
const pay = E.payoff(m, event, "normal");
const rate = E.boostRate(m, "normal", 3);
assert.strictEqual(rate, 15);
assert.strictEqual(E.eventPoints(12000, rate, pay.points.get(3)), 825);
assert.strictEqual(E.eventItems(pay.items.get(3), 4000, rate), 630);
assert.strictEqual(E.eventItems(pay.items.get(3), 10000, rate), 900);
// Challenge points of the same live: rank C row (4) × boost rate, no card bonus (IMG_0022 shows 60).
assert.strictEqual(pay.cp.get(3) * rate, 60);
// A multiplayer (激奏) live pays by the room's rank, not the player's own score rank: IMG_0031 scored 1152964 (C) on
// TearJerker but the room reached B, giving 1050 pt / 1738 items / 75 CP at +100% / +176%.
assert.strictEqual(E.eventPoints(10000, rate, pay.points.get(4)), 1050);
assert.strictEqual(E.eventItems(pay.items.get(4), 17600, rate), 1738);
assert.strictEqual(pay.cp.get(4) * rate, 75);
// Solo B on 夢現妄想世界 EXPERT at +80% / +150% (results/IMG_0040): 945 pt / 1575 items / 75 CP.
assert.strictEqual(E.eventPoints(8000, rate, pay.points.get(4)), 945);
assert.strictEqual(E.eventItems(pay.items.get(4), 15000, rate), 1575);
// Room thresholds for 5 players are 5 × base; TearJerker B needs a room total of 20638445.
assert.strictEqual(E.battleRequiredScore(4127689, 5), 20638445);
{
  const input = {
    master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
    perPowerByScore: perPower, maxLevel: 27, powerCalibration: 1.0, boosts: 3, topK: 1, musicIds: [100094],
    now: new Date("2026-10-01T12:00:00+08:00"),
  };
  const solo = E.search(input).results[0];
  const room = E.search({ ...input, multi: { players: 5, othersScore: 4 * 4.9e6 } }).results[0];
  assert.strictEqual(solo.rankName, "C");
  assert.strictEqual(room.rankName, "B");
  assert.deepStrictEqual([room.points, room.items, room.cp], [1050, 1738, 75]);
  // Challenge lives are solo: the multi input is ignored there.
  const ch = { ...input, mode: "challenge", boosts: 200, musicIds: undefined };
  assert.strictEqual(E.search({ ...ch, multi: { players: 5, othersScore: 1e9 } }).results[0].score, E.search(ch).results[0].score);
}

const name = (v) => (v ? m.text(v.kind === "member" ? m.memberCards.get(v.id)._nameTextID : m.snaps.get(v.id)._nameTextID) + "#" + v.id : "-");

for (const mode of ["normal", "challenge"]) {
  const t0 = Date.now();
  const out = E.search({
    master: m,
    event,
    mode,
    members: roster.members,
    snaps: roster.snaps,
    player: roster.player,
    perPowerByScore: perPower,
    maxLevel: 27,
    powerCalibration: 1.0,
    calibration: 1.0,
    boosts: mode === "challenge" ? 200 : 3,
    topK: 5,
    now: new Date("2026-10-01T12:00:00+08:00"),
  });
  console.log(`== ${mode} (${Date.now() - t0} ms)`, out.error || "");
  for (const d of out.results) {
    console.log(
      `${d.rankName} ${d.points}pt ${d.items}items power ${d.displayPower} (need ${d.needDisplayPower}) ` +
        `bonus +${d.pointBonus / 100}%/+${d.itemBonus / 100}% ${m.text(m.musics.get(d.chart.musicId)._titleTextID)} ${d.chart.difficulty} ${d.chart.level}`,
    );
    console.log("   ", d.members.map((v, i) => name(v) + (i === 2 ? "(L)" : "") + " <- " + name(d.snaps[i])).join(" | "));
  }
}

// Plan: challenge deck first, then normal decks valuing the CP they earn.
{
  const t0 = Date.now();
  const plan = E.planEvent({
    master: m, event, members: roster.members, snaps: roster.snaps, player: roster.player, perPowerByScore: perPower,
    maxLevel: 27, powerCalibration: 1.0, calibration: 1.0, boosts: 3, topK: 5, now: new Date("2026-10-01T12:00:00+08:00"),
  });
  console.log(`== plan (${Date.now() - t0} ms): 1 CP = ${plan.cpValue.toFixed(2)} pt`);
  for (const d of plan.normal.results) {
    const perBoost = (d.points + d.cpPoints) / 3;
    console.log(
      `${d.rankName} ${d.points}pt + ${d.cp}CP (= ${Math.round(d.cpPoints)}pt) -> ${Math.round(perBoost)} pt per boost; ` +
        `bonus +${d.pointBonus / 100}% ${m.text(m.musics.get(d.chart.musicId)._titleTextID)} ${d.chart.difficulty} ${d.chart.level} power ${d.displayPower}/${d.needDisplayPower}`,
    );
    console.log("   ", d.members.map((v, i) => name(v) + (i === 2 ? "(L)" : "") + " <- " + name(d.snaps[i])).join(" | "));
  }
}

// Song comparison: the best deck of every song must equal a search restricted to that song, and the overall best must
// be among them.
{
  const t0 = Date.now();
  const input = {
    master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
    perPowerByScore: perPower, lengthByScore: E.chartLengthsFromMusicData(md), maxLevel: 27, powerCalibration: 1.0,
    calibration: 1.0, boosts: 3, topK: 5, cpValue: 22, now: new Date("2026-10-01T12:00:00+08:00"),
  };
  const out = E.search({ ...input, compareSongs: true });
  const ms = Date.now() - t0;
  assert.strictEqual(new Set(out.songs.map((d) => d.chart.musicId)).size, out.songs.length);
  assert.strictEqual(out.songs[0].score, out.results[0].score);
  for (const d of out.songs.filter((_, i) => i % 10 === 0)) {
    const one = E.search({ ...input, musicIds: [d.chart.musicId], topK: 1 }).results[0];
    assert.strictEqual(d.score, one.score, "song " + d.chart.musicId);
  }
  console.log(`== songs (${ms} ms): ${out.songs.length} songs`);
  for (const d of out.songs.slice(0, 5)) {
    console.log(
      `${d.rankName} ${d.points}pt + ${d.cp}CP ${m.text(m.musics.get(d.chart.musicId)._titleTextID)} ${d.chart.difficulty} ${d.chart.level} ` +
        `${Math.round(d.chart.lengthSec)} s power ${d.displayPower}/${d.needDisplayPower}`,
    );
  }
}

// Per minute: the chart and rank paying the most per (length + overhead). The best deck must be the best song's,
// a song restricted search must agree, and it must pay at least as much per minute as the per-live pick.
{
  const lengths = E.chartLengthsFromMusicData(md);
  const input = {
    master: m, event, mode: "normal", members: roster.members, snaps: roster.snaps, player: roster.player,
    perPowerByScore: perPower, lengthByScore: lengths, maxLevel: 27, powerCalibration: 1.0,
    calibration: 1.0, boosts: 3, topK: 5, cpValue: 22, now: new Date("2026-10-01T12:00:00+08:00"),
  };
  const perLive = E.search(input).results[0];
  const out = E.search({ ...input, perMinute: { overhead: 40 }, compareSongs: true });
  const best = out.results[0];
  const pm = (d) => (d.points + d.cp * 22) / (((d.chart.lengthSec || 0) + 40) / 60);
  assert.ok(Math.abs(best.score / 1e6 - pm(best)) < 1e-6 * pm(best));
  assert.ok(Math.abs(best.minutes - (best.chart.lengthSec + 40) / 60) < 1e-9);
  assert.ok(pm(best) >= pm(perLive) - 1e-9, `per minute ${pm(best)} < per-live pick ${pm(perLive)}`);
  assert.strictEqual(out.songs[0].score, best.score);
  const one = E.search({ ...input, perMinute: { overhead: 40 }, musicIds: [best.chart.musicId], topK: 1 }).results[0];
  assert.strictEqual(one.score, best.score);
  const title = (d) => m.text(m.musics.get(d.chart.musicId)._titleTextID);
  console.log(`== per minute: per live ${title(perLive)} ${perLive.rankName} ${Math.round(perLive.chart.lengthSec)} s ${Math.round(pm(perLive))}/min` +
    ` -> ${title(best)} ${best.chart.difficulty} ${best.rankName} ${Math.round(best.chart.lengthSec)} s ${Math.round(pm(best))}/min`);
}

// Score mode: no event, decks ranked by expected score. Exhaustive check on a small roster (7 characters, 5 snaps),
// and the song comparison equals per-song searches on the full roster.
{
  const sw = E.skillWeightsFromMusicData(md);
  const acc = { perfectRate: 0.98, breaks: 1 };
  const now = new Date("2026-10-01T12:00:00+08:00");
  const views = roster.members.map((o) => [o, E.memberView(m, o, roster.player)]).filter((x) => x[1]);
  const chars = [...new Set(views.map((x) => x[1].characterId))].slice(3, 10);
  const mem = views.filter((x) => chars.includes(x[1].characterId)).map((x) => x[0]);
  const sn = roster.snaps.slice(4, 9);
  const opts = { maxLevel: 40, difficulties: ["expert", "hard"], musicIds: [100094], now };
  const d = E.search({
    master: m, event: null, mode: "score", members: mem, snaps: sn, player: roster.player, perPowerByScore: perPower,
    skillWeights: sw, accuracy: acc, topK: 1, ...opts,
  }).results[0];
  const mv = mem.map((o) => E.memberView(m, o, roster.player));
  const svs = sn.map((o) => E.snapView(m, o));
  const ctx = E.makeContext(m, roster.player, null, mv, svs, "score");
  const cs = E.charts(m, perPower, opts);
  const music = E.musicView(m, 100094);
  const byChar = new Map();
  for (const v of mv) byChar.set(v.characterId, (byChar.get(v.characterId) || []).concat([v]));
  const C = [...byChar.values()];
  function* comb(n, k, s = 0, p = []) {
    if (p.length === k) yield p;
    else for (let i = s; i <= n - (k - p.length); i++) yield* comb(n, k, i + 1, p.concat([i]));
  }
  function* prod(lists, i = 0, p = []) {
    if (i === lists.length) yield p;
    else for (const x of lists[i]) yield* prod(lists, i + 1, p.concat([x]));
  }
  function* perms(a, k) {
    if (k === 0) yield [];
    else for (let i = 0; i < a.length; i++) for (const r of perms(a.slice(0, i).concat(a.slice(i + 1)), k - 1)) yield [a[i], ...r];
  }
  const snapPerms = [...perms(svs, 5)];
  let best = -1;
  for (const cc of comb(C.length, 5)) {
    for (const set of prod(cc.map((i) => C[i]))) {
      const rate = Math.max(...cs.map((c) => (c.perPower + E.liveSkillRate(m, set, c.scoreId, sw)) * E.accuracyFactor(m, c.scoreId, acc)));
      for (let L = 0; L < 5; L++) {
        const order = set.slice();
        [order[L], order[2]] = [order[2], order[L]];
        for (const sp of snapPerms) best = Math.max(best, E.deckPower(m, order, sp, music, ctx) * rate);
      }
    }
  }
  assert.ok(Math.abs(d.score - best) < 1e-6 * best, `score mode ${d.score} vs exhaustive ${best}`);
  assert.strictEqual(d.estScore, Math.floor(d.score));
  assert.strictEqual(d.rank, E.scoreRankOf(d.chart.thresholds, d.score));

  const input = {
    master: m, event: null, mode: "score", members: roster.members, snaps: roster.snaps, player: roster.player,
    perPowerByScore: perPower, skillWeights: sw, accuracy: acc, maxLevel: 27, topK: 3, now,
  };
  const t0 = Date.now();
  const out = E.search({ ...input, compareSongs: true });
  const ms = Date.now() - t0;
  assert.strictEqual(out.songs[0].score, out.results[0].score);
  for (const s of out.songs.filter((_, i) => i % 10 === 0)) {
    assert.strictEqual(s.score, E.search({ ...input, musicIds: [s.chart.musicId], topK: 1 }).results[0].score, "song " + s.chart.musicId);
  }
  const top = out.results[0];
  console.log(`== score (${ms} ms): ${top.rankName} ${top.estScore} ${m.text(m.musics.get(top.chart.musicId)._titleTextID)} ${top.chart.difficulty} ${top.chart.level} power ${top.displayPower}`);
}
