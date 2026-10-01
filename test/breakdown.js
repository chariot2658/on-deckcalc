// Prints every power term of a team, for debugging the model against in-game numbers.
const fs = require("fs");
const path = require("path");
const E = require("../engine.js");

const dir = path.join(__dirname, "..", "..", "moenotes-masterdata", "hk-tw-mo");
const raw = {};
for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(dir, t + ".json"), "utf8"));
const m = E.buildMaster(raw, "_traditionalChinese");

const team = [[12, 1, 32, 40], [11, 1, 46, 40], [39, 40, 37, 40], [13, 1, 60, 50], [15, 1, 54, 50]];
const mem = team.map(([id, level]) => E.memberView(m, { id, level }, {}));
const sn = team.map(([, , id, level]) => E.snapView(m, { id, level }));
const ctx = E.makeContext(m, {}, 1, mem, sn);
mem.forEach((v, i) =>
  console.log(v.id, v.power, JSON.stringify(ctx.memberBonus.get(v)), "snap", sn[i].id, sn[i].pct,
    JSON.stringify(ctx.snapBonus.get(sn[i])), "link", sn[i].typeLinkRate),
);
console.log("leader pct", JSON.stringify(E.leaderBonuses(m, mem, 2, E.musicView(m, 100015))));
console.log("leader rows", m.leaderEffects.get(mem[2].leaderSkillId + ":" + mem[2].leaderSkillLevel));
console.log("vip", ctx.vipPct, "totalRank", ctx.totalRank, "bases", m.musicTypeBase, m.musicTagBase, m.typeLinkBase);
