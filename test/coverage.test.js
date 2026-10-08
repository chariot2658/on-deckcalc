// Skill coverage: every member card and snap of every region has only skills the calculator models (Engine.skillGaps
// finds none), and skillGaps flags each kind of skill it leaves out (made-up cards and skills).
// When a new card fails this, model its skill (or note why it does nothing) before relying on the results.
// Run: node test/coverage.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../engine.js");

const root = path.join(__dirname, "..", "..");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const data = { skillWeights: E.skillWeightsFromMusicData(md), battle: E.battleFromMusicData(md) };
const load = (region) => {
  const raw = {};
  for (const t of E.TABLES) raw[t] = JSON.parse(fs.readFileSync(path.join(root, "moenotes-masterdata", region, t + ".json"), "utf8"));
  return E.buildMaster(raw, "_traditionalChinese");
};

// Every card of every region.
for (const region of ["hk-tw-mo", "jp", "en", "kr"]) {
  const m = load(region);
  const gaps = [];
  for (const id of m.memberCards.keys()) for (const g of E.skillGaps(m, "member", id, data)) gaps.push({ kind: "member", id, ...g });
  for (const id of m.snaps.keys()) for (const g of E.skillGaps(m, "snap", id, data)) gaps.push({ kind: "snap", id, ...g });
  assert.deepStrictEqual(gaps, [], `${region}: skills the calculator leaves out`);
  console.log(`${region}: ${m.memberCards.size} member cards and ${m.snaps.size} snaps, every skill modelled`);
}

// Each kind of gap, on made-up cards of the TW tables.
const m = load("hk-tw-mo");
const member = m.memberCards.values().next().value;
const snap = m.snaps.values().next().value;
const kinds = (kind, id, d = data) => E.skillGaps(m, kind, id, d).map((g) => `${g.part}:${g.effectType}:${g.why}`);
const rowsOf = (map, skillId) => [...map].filter(([k]) => k.startsWith(skillId + ":"));
const copySkill = (map, from, to, change) => {
  for (const [k, rows] of rowsOf(map, from)) map.set(to + k.slice(k.indexOf(":")), rows.map((e) => ({ ...e, ...change })));
};

// Snap skill 16 (score-up triggered by condition 8000), used by no card yet: the simulation never fires it.
m.snaps.set(-1, { ...snap, _supportSkillId01: 16, _supportSkillId02: 0 });
assert.deepStrictEqual(kinds("snap", -1), ["snap:2000:never"]);
// The same score-up without the condition: the score objective measures it, the points estimate leaves it out.
copySkill(m.supportSkillEffects, 16, -16, { _skillTriggerConditionGroup: 0 });
m.snaps.set(-2, { ...snap, _supportSkillId01: -16, _supportSkillId02: 0 });
assert.deepStrictEqual(kinds("snap", -2), ["snap:2000:rough"]);
// An effect type of no known kind.
copySkill(m.supportSkillEffects, snap._supportSkillId01, -17, { _skillEffectType: 99999 });
m.snaps.set(-3, { ...snap, _supportSkillId01: -17, _supportSkillId02: 0 });
assert.deepStrictEqual(kinds("snap", -3), ["snap:99999:unknown"]);
// Heal, guard and Great to Perfect do nothing to an all-Perfect play: no gap.
m.snaps.set(-4, { ...snap, _supportSkillId01: 31, _supportSkillId02: 61 });
assert.deepStrictEqual(kinds("snap", -4), []);
// A Gekisou support skill music-data has not measured (only flagged with Gekisou data).
const noShapes = { ...data, battle: { ...data.battle, shapes: new Map(), supportShapes: new Map() } };
assert.ok(snap._gekisouSupportSkillId01, "the first snap has a Gekisou support skill");
assert.ok(kinds("snap", snap._id, noShapes).includes("gekisouSupport:null:unmeasured"));
assert.deepStrictEqual(kinds("snap", snap._id, { skillWeights: data.skillWeights }), []);

// A leader skill of an effect type power does not read, and one with an unknown formation condition.
copySkill(m.leaderEffects, member._leaderSkillID, -21, { _skillEffectType: 1004 });
m.memberCards.set(-1, { ...member, _leaderSkillID: -21 });
assert.ok(kinds("member", -1).includes("leader:1004:unknown"));
const condGroup = Math.max(...m.conditionSets.keys()) + 1;
m.conditionSets.set(condGroup, [{ _id: -1, _group: condGroup, _conditionIds: [-1] }]);
m.skillConditions.set(-1, { _id: -1, _conditionType: 9999, _conditionValues: [], _isPositive: true, _conditionTargetIDs: [] });
copySkill(m.leaderEffects, member._leaderSkillID, -22, { _skillConditionGroup: condGroup });
m.memberCards.set(-2, { ...member, _leaderSkillID: -22 });
assert.ok(kinds("member", -2).some((k) => k.startsWith("leader:") && k.endsWith(":unknown")));
// A live skill row music-data has no kind for (another activation time).
copySkill(m.liveSkillEffects, member._liveSkillID, -23, { _activationTimeSecond: 123 });
m.memberCards.set(-3, { ...member, _liveSkillID: -23 });
assert.ok(kinds("member", -3).some((k) => k.startsWith("live:") && k.endsWith(":unmeasured")));
assert.deepStrictEqual(kinds("member", -3, {}), []);
// A Gekisou skill music-data has not measured.
assert.ok(member._gekisouSkillID, "the first member card has a Gekisou skill");
assert.deepStrictEqual(kinds("member", member._id, noShapes), ["gekisou:null:unmeasured"]);
console.log("made-up skills: each gap flagged");
