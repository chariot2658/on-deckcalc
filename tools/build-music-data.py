"""Builds music-data.json and the replay data the way nnnotes publishes them, from public inputs.

nnnotes' own build has failed since 2026-11-02 and its repository has had no commit since 10-27, so this runs its
exporter (nnnotes.musicdata.export, with all its checks) with the inputs it could not get elsewhere replaced:

  - charts: haneoka.org's intl release (tools/fetch-charts.py) instead of the game catalog. Through nnnotes' converter
    the same files (then from haneoka-gakuen/ournotes-charts, gone since 2026-11-10) gave the notes, skill events and
    fevers of all 372 charts published on 2026-10-30, exactly;
  - the deck model: the `ournotes-deck chart-stats` command instead of the Python extension, the same Rust code at the
    commit deck-model.json names, built with deck-model-tolerance.patch (the check that stopped nnnotes' builds);
  - a song's BGM length: its last note + 1 s. Only the replay's clock reads it: 192 cases of decks, charts and Gekisou
    on/off scored the same as with the real length.

    python -I build-music-data.py --out DIR --deck-bin ournotes-deck --engine ournotes-replay-wasm-vX.tar.gz \\
        --charts CHARTS --masterdata moenotes-masterdata/hk-tw-mo --nnnotes nnnotes/src

DIR gets music-data.json and replay/<sha256>/ (manifest.json, deck-data.json, engine/, and files only nnnotes' site
reads). A song whose charts haneoka.org does not have yet is left out and named. .github/workflows/pages.yml runs
this and deploys the result.
"""
import argparse
import dataclasses
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True, type=pathlib.Path)
ap.add_argument("--deck-bin", required=True)
ap.add_argument("--engine", required=True, help="the ournotes-replay-wasm release package of the model's version")
ap.add_argument("--charts", required=True, type=pathlib.Path, help="tools/fetch-charts.py's folder")
ap.add_argument("--masterdata", required=True, type=pathlib.Path, help="a moenotes-masterdata region directory")
ap.add_argument("--nnnotes", required=True, help="nnnotes' src directory")
ap.add_argument("--model", type=pathlib.Path, default=pathlib.Path(__file__).with_name("deck-model.json"), help="the deck model's identity")
ap.add_argument("--jobs", type=int, default=4)
args = ap.parse_args()

sys.path.insert(0, args.nnnotes)
from nnnotes import deckdata, musicdata  # noqa: E402

MODEL = json.loads(args.model.read_text(encoding="utf-8"))
ORIGINAL = args.charts / "intl" / "original"
# Tables the exporter reads and moenotes-masterdata leaves out (the published deck data has them with no rows).
EMPTY_TABLES = ("MasterArenaMusic",)


class Native:
    """What nnnotes.musicdata.Deck calls of the Python extension nnnotes._deck, by the command line tool."""

    @staticmethod
    def info():
        return MODEL

    @staticmethod
    def chart_stats(data, seeds, workers, aptitude=True):
        with tempfile.TemporaryDirectory() as tmp:
            deck, out = pathlib.Path(tmp) / "deck.json", pathlib.Path(tmp) / "stats.json"
            deck.write_text(data, encoding="utf-8")
            done = subprocess.run(
                [args.deck_bin, "chart-stats", "--data", str(deck), "--seeds", str(seeds), "--jobs", str(workers or args.jobs), "-o", str(out)],
                stderr=subprocess.PIPE, text=True,
            )
            if done.stderr.strip():
                print(done.stderr.strip(), file=sys.stderr)
            if done.returncode:
                raise ValueError(done.stderr.strip().splitlines()[-1] if done.stderr.strip() else "chart-stats failed")
            return out.read_text(encoding="utf-8")


def fetch(name):
    try:
        return (ORIGINAL / f"{name}.bytes").read_bytes()
    except FileNotFoundError:
        raise KeyError(name) from None


def main():
    src = deckdata.decoded_master(args.masterdata)
    blank = hashlib.sha256(b"").hexdigest()
    hashes = dict(src.hashes, **{f"{t}.bin": blank for t in EMPTY_TABLES if f"{t}.bin" not in src.hashes})

    # The song tables without the songs haneoka.org does not have yet.
    tables, _ = deckdata.read_master(dataclasses.replace(src, hashes=hashes, read=lambda names: {n: read_one(src, n) for n in names}),
                                     None, ("MasterLiveMusic", "MasterLiveMusicScore", "MasterSound", "MasterSoundCueSheet"))
    scores = {r["_id"]: r for r in tables["MasterLiveMusicScore"]}
    sounds = {r["_id"]: r for r in tables["MasterSound"]}
    sheets = {r["_id"]: r for r in tables["MasterSoundCueSheet"]}
    ready, waiting, length = set(), [], {}
    for m in tables["MasterLiveMusic"]:
        rows = [scores[m[f"_{d}ID"]] for d in musicdata.DIFFICULTIES if m.get(f"_{d}ID")]
        if not all((ORIGINAL / f"{r['_musicScoreTextFileName']}.bytes").is_file() for r in rows):
            waiting.append(m["_id"])
            continue
        ready.add(m["_id"])
        last = max(musicdata.chart_facts(r, deckdata.chart_key(r["_musicScoreTextFileName"]), fetch(r["_musicScoreTextFileName"]))["lastNoteMs"] for r in rows)
        snd = sounds[m["_musicSoundID"]]
        key = (sheets[snd["_soundCueSheetID"]]["_cueSheetName"], snd["_cueName"])
        length[key] = max(length.get(key, 0), last + 1000)
    if waiting:
        print("no charts yet:", ", ".join(map(str, waiting)))

    def read(names):
        out = {}
        for n in names:
            raw = read_one(src, n)
            if n == "MasterLiveMusic.json":
                doc = json.loads(raw)
                doc["_allData"] = [r for r in doc["_allData"] if r["_id"] in ready]
                raw = json.dumps(doc, ensure_ascii=False).encode("utf-8")
            out[n] = raw
        return out

    def bgm(sheet, cue):
        ms = length[(sheet, cue)]
        return {"lengthMs": ms}

    source = json.loads((args.charts / "manifest.json").read_text(encoding="utf-8"))["servers"]["intl"]
    r = musicdata.export(
        args.out / "music-data.json", dataclasses.replace(src, hashes=hashes, read=read), None, fetch, bgm,
        region="tw", client={}, catalog={"resourceVersion": source["version"], "sha256": source["sha256"]},
        deck=musicdata.Deck(seeds=musicdata.DECK_SEEDS, workers=args.jobs, module=Native),
        replay_dir=args.out / "replay", replay_engine=pathlib.Path(args.engine),
    )
    print(json.dumps(r, ensure_ascii=False))


def read_one(src, name):
    if name[:-5] in EMPTY_TABLES and not (args.masterdata / name).is_file():
        return b'{"_allData":[]}'
    return src.read([name])[name]


try:
    main()
except (deckdata.DeckDataError, musicdata.MusicDataError) as e:
    sys.exit(f"build-music-data: {e}")
