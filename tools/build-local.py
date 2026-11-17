"""Builds the newest music-data on this computer in the form the deployed site has, for the local site and the tests.

    python -I deckcalc/tools/build-local.py [--force]

Run it from anywhere in the workspace layout (CLAUDE.md): it reads ../moenotes-masterdata/hk-tw-mo and ../nnnotes, and
keeps what it downloads in ../data/build (the charts of haneoka.org's current release, tools/fetch-charts.py; the
replay engine; and the `ournotes-deck` tool built once for the versions in build-pins.env; needs git, cargo, node and
numpy). The result goes through tools/publish-music-data.js like the deployment's, so the browser rebuilds the notes
from haneoka.org here too. It is written to music-data/ beside the site, which data.js prefers over the deployment's, and to ../data for the
tests (with the deck data whole, as test/fetch-replay.js leaves it). Then press 「更新資料」 in the site. It stops early
when the masterdata, the charts and these tools are as the last time.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request

TOOLS = pathlib.Path(__file__).resolve().parent
SITE = TOOLS.parent
ROOT = SITE.parent
BUILD = ROOT / "data" / "build"
DECK_URL = "https://github.com/empty-sekai/ournotes-deck.git"
# Applied to ournotes-deck in this order (tools/build-music-data.py says why).
PATCHES = ("deck-model-tolerance.patch", "deck-gekisou-levels.patch")


def remove(path):
    """Removes a directory, git's read-only files included."""
    def writable(func, p, _):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if path.exists():
        shutil.rmtree(path, onerror=writable)


def run(*cmd, cwd=None, env=None):
    subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, check=True)


def output(*cmd):
    return subprocess.run([str(c) for c in cmd], check=True, capture_output=True, text=True).stdout.strip()


def sha256(*files):
    h = hashlib.sha256()
    for f in files:
        h.update(pathlib.Path(f).read_bytes())
    return h.hexdigest()


def update_charts():
    charts = BUILD / "charts"
    run(sys.executable, "-I", TOOLS / "fetch-charts.py", "--out", charts)
    return charts


def engine_package(pins):
    name = f"ournotes-replay-wasm-{pins['DECK_TAG']}.tar.gz"
    file = BUILD / name
    if not file.is_file() or sha256(file) != pins["ENGINE_SHA256"]:
        print("下載模擬引擎…", flush=True)
        url = f"https://github.com/empty-sekai/ournotes-deck/releases/download/{pins['DECK_TAG']}/{name}"
        with urllib.request.urlopen(url) as r:
            file.write_bytes(r.read())
        if sha256(file) != pins["ENGINE_SHA256"]:
            file.unlink()
            sys.exit(f"{name} 的 SHA-256 不符")
    return file


def deck_tool(pins):
    patches = [TOOLS / n for n in PATCHES]
    exe = BUILD / f"ournotes-deck-{pins['DECK_COMMIT'][:12]}-{sha256(*patches)[:12]}{'.exe' if os.name == 'nt' else ''}"
    if exe.is_file():
        return exe
    print("第一次要編譯 ournotes-deck（幾分鐘）…", flush=True)
    src, target = BUILD / "deck-src", BUILD / "deck-target"
    remove(src)
    run("git", "clone", "-q", "-c", "core.autocrlf=false", "--filter=blob:none", DECK_URL, src)
    run("git", "-C", src, "checkout", "-q", pins["DECK_COMMIT"])
    for patch in patches:
        run("git", "-C", src, "apply", patch)
    run("cargo", "build", "--release", "-p", "ournotes-search", "--bin", "ournotes-deck", cwd=src, env={**os.environ, "CARGO_TARGET_DIR": str(target)})
    shutil.copy2(target / "release" / ("ournotes-deck.exe" if os.name == "nt" else "ournotes-deck"), exe)
    remove(src)
    remove(target)
    return exe


def install(out, whole_deck):
    """music-data/ for the site, ../data for the tests (test/fetch-replay.js's layout, the deck data whole)."""
    replay = next((out / "replay").iterdir())
    data = ROOT / "data"
    tests = data / "replay"
    remove(tests)
    (tests / "engine").mkdir(parents=True)
    shutil.copy2(out / "music-data.json", data / "music-data.json")
    shutil.copy2(out / "gekisou-levels.json", data / "gekisou-levels.json")
    shutil.copy2(replay / "manifest.json", tests / "manifest.json")
    shutil.copy2(whole_deck, tests / "deck-data.json")
    for f in (replay / "engine").iterdir():
        shutil.copy2(f, tests / "engine" / f.name)

    site = SITE / "music-data"
    remove(site)
    out.rename(site)
    return replay.name


def main():
    ap = argparse.ArgumentParser(description="在本機建最新的 music-data")
    ap.add_argument("--force", action="store_true", help="輸入沒變也重建")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()

    pins = dict(line.strip().split("=", 1) for line in (TOOLS / "build-pins.env").read_text(encoding="utf-8").splitlines() if "=" in line)
    BUILD.mkdir(parents=True, exist_ok=True)
    masterdata = ROOT / "moenotes-masterdata" / "hk-tw-mo"
    nnnotes = ROOT / "nnnotes" / "src"
    have = output("git", "-C", ROOT / "nnnotes", "rev-parse", "HEAD")
    if have != pins["NNNOTES_COMMIT"]:
        print(f"注意：nnnotes 是 {have[:8]}，部署用的是 {pins['NNNOTES_COMMIT'][:8]}", flush=True)

    charts = update_charts()
    tools = [TOOLS / n for n in ("build-music-data.py", "publish-music-data.js", "fetch-charts.py", "build-pins.env", "deck-model.json", *PATCHES)] + [SITE / "charts.js"]
    version = json.loads((ROOT / "moenotes-masterdata" / "current_version.json").read_text(encoding="utf-8"))["regions"]["hk-tw-mo"]["version"]
    charts_sha = json.loads((charts / "manifest.json").read_text(encoding="utf-8"))["servers"]["intl"]["sha256"]
    stamp = f"{version} {charts_sha} {sha256(*tools)}"
    done = BUILD / "last-build.txt"
    if not args.force and done.is_file() and done.read_text(encoding="utf-8") == stamp and (SITE / "music-data" / "music-data.json").is_file():
        print(f"已經是最新的（masterdata {version}）。")
        return

    engine = engine_package(pins)
    tool = deck_tool(pins)
    out = BUILD / "music-data.new"
    remove(out)
    print(f"建 music-data（masterdata {version}，約 5 分鐘）…", flush=True)
    run(sys.executable, "-I", TOOLS / "build-music-data.py", "--out", out, "--deck-bin", tool, "--engine", engine, "--charts", charts,
        "--masterdata", masterdata, "--nnnotes", nnnotes, "--jobs", args.jobs)
    with tarfile.open(engine) as t:
        for name in ("LICENSE-MIT", "LICENSE-APACHE"):
            member = f"ournotes-replay-wasm-{pins['DECK_TAG']}/{name}"
            (next((out / "replay").iterdir()) / "engine" / name).write_bytes(t.extractfile(member).read())
    whole_deck = BUILD / "deck-data.whole.json"
    shutil.copy2(next((out / "replay").iterdir()) / "deck-data.json", whole_deck)
    run("node", TOOLS / "publish-music-data.js", "--data", out, "--charts", charts)
    install(out, whole_deck)
    whole_deck.unlink()
    done.write_text(stamp, encoding="utf-8")
    print("完成。到網站按「更新資料」就會用新的資料。")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(errors="replace")
    except AttributeError:
        pass
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(f"失敗：{e}")
