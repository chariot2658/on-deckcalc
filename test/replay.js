// Loads the replay engine and deck data that test/fetch-replay.js downloaded to ../data/replay, as its manifest names
// them. Resolves to a ReplaySession, or null when they are missing.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

module.exports = async function loadReplay() {
  const dir = path.join(__dirname, "..", "..", "data", "replay");
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const [js, wasm, deck] = [manifest.engine.js, manifest.engine.wasm, manifest.deckData].map((f) => path.join(dir, f.url));
  if (![js, wasm, deck].every((f) => fs.existsSync(f))) return null;
  const mod = await import(pathToFileURL(js).href);
  mod.initSync({ module: fs.readFileSync(wasm) });
  return new mod.ReplaySession(fs.readFileSync(deck, "utf8"));
};
