// Checks the deck power model against teams read from in-game screenshots (TW server, event 1, song 焚音打).
// Run: node test/power.test.js [path to moenotes-masterdata/hk-tw-mo]
const fs = require("fs");
const path = require("path");
const E = require("../engine.js");

const dir = process.argv[2] || path.join(__dirname, "..", "..", "moenotes-masterdata", "hk-tw-mo");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(dir, t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");
const event = m.events.get(1);

function power(team, player = {}, musicId = 100015, mode = "normal") {
  const members = team.map(([id, level]) => E.memberView(m, { id, level, awake: 1, rank: 1 }, player));
  const snaps = team.map(([, , sid, slv, srank]) => (sid ? E.snapView(m, { id: sid, level: slv, rank: srank || 1 }) : null));
  const ctx = E.makeContext(m, player, event._id, members, snaps.filter(Boolean), mode);
  return E.deckPower(m, members, snaps, E.musicView(m, musicId), ctx);
}

// Character ranks of 2026-10-02 (my_screenshots/my_player_ranks), as in presets/my-roster.json.
const ranks20261002 = {
  1: 9, 2: 6, 3: 6, 4: 6, 5: 5, 6: 7, 7: 7, 8: 7, 9: 7, 10: 9, 11: 8, 12: 6, 13: 8, 14: 7, 15: 6,
  16: 9, 17: 5, 18: 6, 19: 5, 20: 5, 21: 10, 22: 8, 23: 8, 24: 7, 25: 7,
};

// Exact: with character ranks and T.G.W CARD (VIP) rank 4 the model equals the game (results/IMG_0038, 夢現妄想世界).
{
  const team = [[32, 40, 56, 50], [59, 50, 63, 50], [60, 50, 60, 70, 3], [11, 30, 37, 40], [39, 40, 61, 70, 3]];
  const p = power(team, { vipRank: 4, characterRanks: ranks20261002 }, 100054);
  console.log("IMG_0038 (378423) model", p, "(exact)");
  require("assert").strictEqual(p, 378423);
}

// Exact: the same team after characters 9, 11 and 12 ranked up (results/IMG_0044, 378468; total rank 174 -> 177).
{
  const team = [[32, 40, 56, 50], [59, 50, 63, 50], [60, 50, 60, 70, 3], [11, 30, 37, 40], [39, 40, 61, 70, 3]];
  const p = power(team, { vipRank: 4, characterRanks: { ...ranks20261002, 9: 8, 11: 9, 12: 7 } }, 100054);
  console.log("IMG_0044 (378468) model", p, "(exact)");
  require("assert").strictEqual(p, 378468);
}

// Exact: a challenge live adds the event parameter bonus (type 2) to the power, which normal lives do not
// (results/IMG_0041, 夢我夢中 challenge deck, 244053; character ranks as synced from the browser on 2026-10-02).
{
  const ranks = { ...ranks20261002, 9: 8, 11: 9, 12: 7 };
  const team = [[11, 30, 61, 70, 3], [12, 30, 56, 50], [39, 40, 63, 50], [13, 30, 13, 50, 3], [15, 30, 37, 40]];
  const player = { vipRank: 4, characterRanks: ranks };
  const p = power(team, player, 100109, "challenge");
  console.log("IMG_0041 (244053) model", p, "(exact, challenge)", "without the parameter bonus", power(team, player, 100109));
  require("assert").strictEqual(p, 244053);
}

// Older screenshots, taken with lower character ranks than recorded; no account bonuses, so the ratio is the gap.
// [member id, level, snap id, snap level, snap rank]; slot 2 (index 2) is the leader.
const cases = [
  {
    name: "IMG_0017 (107679)",
    shown: 107679,
    team: [[12, 1, 32, 40], [11, 1, 46, 40], [39, 40, 37, 40], [13, 1, 60, 50], [15, 1, 54, 50]],
  },
  {
    name: "IMG_0020 (135778)",
    shown: 135778,
    team: [[12, 30, 14, 1], [11, 30, 61, 1], [39, 40, 37, 40], [13, 30, 36, 1], [15, 30, 54, 50]],
  },
];
for (const c of cases) {
  const p = power(c.team);
  console.log(c.name, "model", p, "shown", c.shown, "ratio", (c.shown / p).toFixed(4));
}
