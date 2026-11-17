"""Downloads the game's chart files from haneoka.org's current intl release, for build-music-data.py.

    python -I fetch-charts.py --out DIR [--force]

haneoka-gakuen/ournotes-charts, which was exported from these releases, went away on 2026-11-10. haneoka.org serves the
same files (the same SHA-256) at /assets/intl/<source path>, with CORS, and `?release=<id>` pins a release (the
response is then immutable), so the browser downloads them from there too (charts.js, tools/publish-music-data.js).

DIR gets intl/original/<name>.bytes as ournotes-charts had them and manifest.json:
{"servers": {"intl": {"version": id, "release": id, "sha256": over the sorted "name sha256" lines, "files": n}}}.
When DIR already holds the current release, nothing is downloaded.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys
import time
import urllib.error
import urllib.request

API = "https://haneoka.org"
ROOT = "Assets/AddressableResources/Live/MusicScore/"
HEADERS = {"User-Agent": "deckcalc-build"}


def request(url, method="GET"):
    """The response body and headers, after up to five tries (a 429's Retry-After honoured)."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method=method, headers=HEADERS), timeout=60) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 404 or attempt == 4:
                raise
            wait = float(e.headers.get("Retry-After") or 2 ** attempt) if e.code == 429 else 2 ** attempt
        except (urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
            wait = 2 ** attempt
        time.sleep(wait)


def chart_names(tree):
    node = tree["Assets"]["AddressableResources"]["Live"]["MusicScore"]
    out = []
    for k, v in node.items():
        if isinstance(v, dict):
            out += [f"{k}/{f}" for f in v if f.endswith(".bytes")]
        elif k.endswith(".bytes"):
            out.append(k)
    return sorted(out)


def remove(path):
    def writable(func, p, _):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if path.exists():
        shutil.rmtree(path, onerror=writable)


def main():
    ap = argparse.ArgumentParser(description="從 haneoka.org 下載譜面")
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--jobs", type=int, default=16)
    args = ap.parse_args()

    _, h = request(f"{API}/api/v1/servers/intl/release", "HEAD")
    release = h["X-Haneoka-Release-Id"]
    if not release or not release.startswith("r-"):
        sys.exit("haneoka.org 沒有回傳 release")
    old = args.out / "manifest.json"
    if not args.force and old.is_file() and json.loads(old.read_text(encoding="utf-8"))["servers"]["intl"].get("release") == release:
        print(f"譜面已是 {release}")
        return

    body, _ = request(f"{API}/api/v1/servers/intl/sources/tree?release={release}")
    names = chart_names(json.loads(body))
    new = args.out.with_name(args.out.name + ".new")
    remove(new)

    def get(name):
        data, h = request(f"{API}/assets/intl/{ROOT}{name}?release={release}")
        if h["X-Haneoka-Release-Id"] != release:
            raise RuntimeError(f"{name}: haneoka.org 給了 {h['X-Haneoka-Release-Id']}，不是 {release}，請再跑一次")
        file = new / "intl" / "original" / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return f"{name} {hashlib.sha256(data).hexdigest()}\n"

    print(f"下載 {len(names)} 個譜面（{release}）…", flush=True)
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        lines = list(pool.map(get, names))
    listing = "".join(lines).encode("utf-8")
    manifest = {"source": f"{API}/assets/intl/{ROOT}", "servers": {"intl": {
        "version": release, "release": release, "sha256": hashlib.sha256(listing).hexdigest(), "files": len(names)}}}
    (new / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (new / "files.txt").write_bytes(listing)
    remove(args.out)
    new.rename(args.out)
    print(f"譜面：{len(names)} 個，{release}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(errors="replace")
    except AttributeError:
        pass
    main()
