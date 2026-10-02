"""Serves this folder on http://localhost:8765/ and asks the browser to revalidate every file, so an edited
script is picked up on the next reload instead of an older cached copy.

POST /api/roster saves the roster sent by the page (設定 → 同步到檔案) to presets/browser-roster-{profileId}.json
(presets/browser-roster.json when the page sends no profile), so tools outside the browser can read what the browser
holds. Only same-origin JSON requests are accepted: a page on another
site cannot send application/json here without a CORS preflight, which this server never approves."""
import functools
import http.server
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
PRESETS = os.path.join(ROOT, "presets")
PROFILE_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")
MAX_BODY = 4 * 1024 * 1024
ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}", f"http://[::1]:{PORT}"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/roster":
            return self.reply(404, {"error": "not found"})
        if self.headers.get("Origin") not in ORIGINS:
            return self.reply(403, {"error": "origin not allowed"})
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.reply(415, {"error": "expected application/json"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {"error": "bad length"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            return self.reply(400, {"error": f"bad json: {e}"})
        if not isinstance(data, dict) or data.get("format") != "deckcalc-roster/1":
            return self.reply(400, {"error": "not a deckcalc roster"})
        profile = data.get("profileId")
        if profile is None:
            name = "browser-roster.json"
        elif isinstance(profile, str) and PROFILE_ID.fullmatch(profile):
            name = f"browser-roster-{profile}.json"
        else:
            return self.reply(400, {"error": "bad profile id"})
        target = os.path.join(PRESETS, name)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, target)
        self.reply(200, {"saved": os.path.relpath(target, ROOT).replace(os.sep, "/")})


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
