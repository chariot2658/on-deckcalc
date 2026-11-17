// Downloads the replay engine and deck data named by ../data/music-data.json's `replay` pointer into ../data/replay/
// for test/skills.test.js. Run again after refreshing music-data.json.
// Run: node test/fetch-replay.js
const fs = require("fs");
const path = require("path");
const Charts = require("../charts.js");

const MUSIC_DATA_URL = "https://chariot2658.github.io/on-deckcalc/music-data/music-data.json";
const dataDir = path.join(__dirname, "..", "..", "data");
const out = path.join(dataDir, "replay");

(async () => {
  const md = JSON.parse(fs.readFileSync(path.join(dataDir, "music-data.json"), "utf8"));
  if (!md.replay) throw new Error("music-data.json has no replay pointer");
  const manifestUrl = new URL(md.replay.manifestUrl, MUSIC_DATA_URL).href;
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ": HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  };
  const manifestBuf = await get(manifestUrl);
  const manifest = JSON.parse(manifestBuf.toString("utf8"));
  fs.mkdirSync(path.join(out, "engine"), { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), manifestBuf);
  for (const f of [manifest.engine.js, manifest.engine.wasm, manifest.engine.build, manifest.deckData]) {
    fs.writeFileSync(path.join(out, f.url), await get(new URL(f.url, manifestUrl).href));
    console.log(f.url, f.bytes, "bytes");
  }
  // The site publishes the deck data without notes; the tests need it whole, as the browser makes it.
  if (manifest.chartSource) {
    const file = path.join(out, manifest.deckData.url);
    const whole = await Charts.fullDeck(fs.readFileSync(file, "utf8"), manifest.chartSource);
    fs.writeFileSync(file, whole);
    console.log(manifest.deckData.url, Buffer.byteLength(whole), "bytes with", manifest.chartSource.charts.length, "charts");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
