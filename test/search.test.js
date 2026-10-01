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
    powerCalibration: 1.023,
    calibration: 1.0,
    boosts: mode === "challenge" ? 200 : 3,
    topK: 5,
    now: new Date("2026-10-01T12:00:00+08:00"),
  });
  console.log(`== ${mode} (${Date.now() - t0} ms)`, out.error || "");
  for (const d of out.results) {
    console.log(
      `${d.rankName} ${d.points}pt ${d.items}items power ${d.displayPower} (need ${Math.ceil(d.needPower * 1.023)}) ` +
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
    maxLevel: 27, powerCalibration: 1.023, calibration: 1.0, boosts: 3, topK: 5, now: new Date("2026-10-01T12:00:00+08:00"),
  });
  console.log(`== plan (${Date.now() - t0} ms): 1 CP = ${plan.cpValue.toFixed(2)} pt`);
  for (const d of plan.normal.results) {
    const perBoost = (d.points + d.cpPoints) / 3;
    console.log(
      `${d.rankName} ${d.points}pt + ${d.cp}CP (= ${Math.round(d.cpPoints)}pt) -> ${Math.round(perBoost)} pt per boost; ` +
        `bonus +${d.pointBonus / 100}% ${m.text(m.musics.get(d.chart.musicId)._titleTextID)} ${d.chart.difficulty} ${d.chart.level} power ${d.displayPower}/${Math.ceil(d.needPower * 1.023)}`,
    );
    console.log("   ", d.members.map((v, i) => name(v) + (i === 2 ? "(L)" : "") + " <- " + name(d.snaps[i])).join(" | "));
  }
}
