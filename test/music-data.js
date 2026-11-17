// music-data.json for the tests, with the gekisou-levels.json beside it attached as Data.loadMusicData attaches it
// (tools/build-local.py writes both to ../data; Engine.battleFromMusicData uses it only when it was built with that
// music-data). Without it the search falls back to the sampled level factors, which the tests then check instead.
const fs = require("fs");
const path = require("path");

module.exports = function loadMusicData(root) {
  const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
  const levels = path.join(root, "data", "gekisou-levels.json");
  if (fs.existsSync(levels)) md.gekisouLevels = JSON.parse(fs.readFileSync(levels, "utf8"));
  return md;
};
