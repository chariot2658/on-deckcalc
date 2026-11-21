// Prepares a build of tools/build-music-data.py for the public site: no notes and no game text.
//
//   node tools/publish-music-data.js --data DIR --charts CHARTS
//
// - Every chart is converted again with charts.js, the code the browser runs, and has to give the Python build's bytes;
//   otherwise this fails and the last deployment stays up.
// - deck-data.json loses its charts' notes (the browser downloads the chart files of the haneoka.org release
//   tools/fetch-charts.py put in CHARTS and rebuilds them, Charts.fullDeck); the per-chart files and snap labels go.
// - music-data.json loses the texts and master rows nothing here reads.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Charts = require("../charts.js");

const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0 || !process.argv[i + 1]) throw new Error("--" + name + " is required");
  return process.argv[i + 1];
};
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const SONG_TEXT = ["title", "ruby", "phonetic", "bandName", "lyricist", "composer", "arranger", "jacket", "bgm", "master"];
const TOP_TEXT = ["languages", "bands", "characters", "tags", "categories", "gekisouCatalog"];
const CHARTS_URL = "https://haneoka.org/assets/intl/Assets/AddressableResources/Live/MusicScore/";

(async () => {
  const data = arg("data"), charts = arg("charts");
  const original = path.join(charts, "intl", "original");
  const { release } = JSON.parse(fs.readFileSync(path.join(charts, "manifest.json"), "utf8")).servers.intl;
  if (!/^r-[0-9a-f]{20}$/.test(release || "")) throw new Error("the charts' manifest names no haneoka.org release");
  const replayRoot = path.join(data, "replay");
  const [oldName] = fs.readdirSync(replayRoot);
  const oldDir = path.join(replayRoot, oldName);
  const deckText = fs.readFileSync(path.join(oldDir, "deck-data.json"), "utf8");
  const deck = JSON.parse(deckText);

  const marker = ',"charts":[';
  const at = deckText.lastIndexOf(marker);
  if (at < 0) throw new Error("deck data without charts");
  const head = deckText.slice(0, at + marker.length);
  const records = [];
  for (const c of deck.charts) {
    const raw = fs.readFileSync(path.join(original, Charts.fileOf(c.asset.key)));
    const got = JSON.stringify(Charts.record(c.scoreId, c.asset.key, c.asset.sha256, await Charts.parseChart(new Uint8Array(raw))));
    if (got !== JSON.stringify(c)) throw new Error(`chart ${c.scoreId}: charts.js differs from the build`);
    records.push(got);
  }
  if (head + records.join(",") + "]}\n" !== deckText) throw new Error("the deck data does not end in its charts");

  const stripped = head + "]}\n";
  const manifest = JSON.parse(fs.readFileSync(path.join(oldDir, "manifest.json"), "utf8"));
  delete manifest.charts;
  delete manifest.snapLabels;
  manifest.deckData = { ...manifest.deckData, sha256: sha256(stripped), bytes: Buffer.byteLength(stripped) };
  manifest.chartSource = {
    url: CHARTS_URL, release, deckSha256: sha256(deckText),
    charts: deck.charts.map((c) => ({ scoreId: c.scoreId, key: c.asset.key, sha256: c.asset.sha256 })),
  };
  const manifestText = JSON.stringify(manifest) + "\n";
  const name = sha256(manifestText);

  fs.writeFileSync(path.join(oldDir, "deck-data.json"), stripped);
  fs.writeFileSync(path.join(oldDir, "manifest.json"), manifestText);
  fs.rmSync(path.join(oldDir, "charts"), { recursive: true, force: true });
  fs.rmSync(path.join(oldDir, "snap-labels.json"), { force: true });
  fs.renameSync(oldDir, path.join(replayRoot, name));

  const file = path.join(data, "music-data.json");
  const md = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of TOP_TEXT) delete md[k];
  for (const s of md.songs) for (const k of SONG_TEXT) delete s[k];
  md.replay = { ...md.replay, manifestUrl: `replay/${name}/manifest.json`, sha256: name };
  fs.writeFileSync(file, JSON.stringify(md));
  console.log(`${deck.charts.length} charts identical to the build; deck data ${deckText.length} -> ${stripped.length} bytes; charts of ${release}`);
})().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
