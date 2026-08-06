#!/usr/bin/env python3
"""Static dev server for Topo Layers.

Same as `python3 -m http.server`, except it tells the browser not to cache
anything. Without that, an edited ES module keeps running from cache while the
page around it reloads, which looks exactly like a code change having no effect.

    python3 serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):          # quieter: errors only
        if not args or not str(args[0]).startswith(("GET", "HEAD")) or args[1] != "200":
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = partial(NoCacheHandler, directory=".")
    print(f"Topo Layers -> http://localhost:{port}  (ctrl-c to stop)")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
