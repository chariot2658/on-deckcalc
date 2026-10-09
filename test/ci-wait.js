// CI (.github/workflows/data-check.yml): whether to wait for music-data before testing. nnnotes rebuilds music-data
// after each masterdata update, which takes 1.5–2 hours; until then new skills are unmeasured and the tests fail for
// nothing but the wait. Writes wait=true to $GITHUB_OUTPUT while music-data was built from another TW masterdata
// version than the current one and the masterdata commit is under 6 hours old (later the tests run and fail, so a
// rebuild that never comes shows). FORCE=true never waits.
// Run: node test/ci-wait.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..", "..");
const md = JSON.parse(fs.readFileSync(path.join(root, "data", "music-data.json"), "utf8"));
const dir = path.join(root, "moenotes-masterdata");
const current = JSON.parse(fs.readFileSync(path.join(dir, "current_version.json"), "utf8")).regions["hk-tw-mo"].version;
const built = String((md.provenance && md.provenance.master && md.provenance.master.version) || "");
const committed = Number(execFileSync("git", ["-C", dir, "log", "-1", "--format=%ct"], { encoding: "utf8" }));
const hours = (Date.now() / 1000 - committed) / 3600;
const wait = built !== current && hours < 6 && process.env.FORCE !== "true";
if (built !== current) {
  console.log(`::notice::music-data 是用 masterdata ${built.slice(0, 8)} 建的，最新的是 ${current.slice(0, 8)}` +
    `（${hours.toFixed(1)} 小時前更新）${wait ? "：等 nnnotes 重建完再測" : ""}`);
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `wait=${wait}\n`);
else console.log("wait =", wait);
