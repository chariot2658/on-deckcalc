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

function power(team, player = {}) {
  const members = team.map(([id, level]) => E.memberView(m, { id, level, awake: 1, rank: 1 }, player));
  const snaps = team.map(([, , sid, slv]) => (sid ? E.snapView(m, { id: sid, level: slv, rank: 1 }) : null));
  const ctx = E.makeContext(m, player, event._id, members, snaps.filter(Boolean));
  return E.deckPower(m, members, snaps, E.musicView(m, 100015), ctx);
}

// [member id, level, snap id, snap level]; slot 2 (index 2) is the leader.
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
