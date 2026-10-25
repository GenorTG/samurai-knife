#!/usr/bin/env python3
"""A tiny website for the Website check e2e (tests/functional/web_e2e.py): a redirect, headers with known gaps, a
cookie, robots.txt naming a sitemap, and HTML with known SEO and accessibility problems.
  python3 tests/site_fixture_server.py <port>
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
PAGE = b"""<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width"></head>
<body><h1>Fixture shop</h1><h3>Skipped a level</h3><a href="/x">click here</a><a href="/y"></a>
<form><input type="text" id="q"><label>Email <input type="email"></label></form><img src="a.png"></body></html>"""
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/old":
            self.send_response(301); self.send_header("Location", "/"); self.end_headers(); return
        if self.path == "/":
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("Server", "nginx/1.18.0")
            self.send_header("Set-Cookie", "session=SECRETVALUE123; Path=/; HttpOnly"); self.end_headers(); self.wfile.write(PAGE); return
        if self.path == "/robots.txt":
            self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers()
            self.wfile.write(b"User-agent: *\nDisallow: /admin\nSitemap: http://127.0.0.1:%d/sm.xml\n" % PORT); return
        if self.path == "/sm.xml":
            self.send_response(200); self.send_header("Content-Type", "application/xml"); self.end_headers()
            self.wfile.write(b"<urlset><url><loc>http://a/1</loc></url><url><loc>http://a/2</loc></url></urlset>"); return
        self.send_response(404); self.end_headers()
PORT = int(sys.argv[1])
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
