"""Serves this folder on http://localhost:8765/ and asks the browser to revalidate every file, so an edited
script is picked up on the next reload instead of an older cached copy."""
import functools
import http.server
import os


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler).serve_forever()
