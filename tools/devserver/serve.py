"""Dev server for the PWA in pwa/ (Python standard library only).

    python tools/devserver/serve.py            # http://localhost:8000  (PC, camera works on localhost)
    python tools/devserver/serve.py --https    # https://<LAN-IP>:8443  (phone; self-signed certificate)

Serves pwa/ like GitHub Pages does, plus routes for the dev pages in pwa/dev/:
  GET  /api/variants        card variants exported live from data/cards.db
  GET  /ref-images/<file>   card images from build/carddb-cache/images
  POST /api/index           stores the index from dev/build-index.html together with the variant list
                            it was built from (pwa/data/variants.json + embeddings.*)
  POST /api/eval-result     stores the last dev/eval.html result in build/eval-result.json
"""

import argparse
import hashlib
import http.server
import json
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PWA_DIR = REPO_ROOT / "pwa"
DATA_DIR = PWA_DIR / "data"
CARDS_DB = REPO_ROOT / "data" / "cards.db"
IMAGE_DIR = REPO_ROOT / "build" / "carddb-cache" / "images"
CERT_DIR = REPO_ROOT / "build" / "cert"
EVAL_RESULT = REPO_ROOT / "build" / "eval-result.json"


def export_variants() -> bytes:
    """Variant list as compact JSON. Deterministic, so the index page can hash exactly these bytes."""
    db = sqlite3.connect(CARDS_DB)
    rows = db.execute(
        """SELECT v.exburst_id, v.card_no, c.name, v.rarity, v.official_id || '.webp'
           FROM variant v JOIN card c ON c.card_no = v.card_no
           ORDER BY v.exburst_id"""
    ).fetchall()
    db.close()
    keys = ["id", "cardNo", "name", "rarity", "file"]
    variants = [dict(zip(keys, row)) for row in rows]
    return json.dumps(variants, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def lan_ips():
    ips = {ip for *_, (ip, *_) in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    return sorted(ip for ip in ips if not ip.startswith("127."))


def find_openssl():
    # Git for Windows ships openssl, but only Git\cmd is usually on PATH.
    found = shutil.which("openssl")
    if found:
        return found
    git = shutil.which("git")
    roots = [Path(git).resolve().parent.parent] if git else []
    roots.append(Path(r"C:\Program Files\Git"))
    for root in roots:
        for sub in ("mingw64/bin", "usr/bin"):
            candidate = root / sub / "openssl.exe"
            if candidate.exists():
                return str(candidate)
    sys.exit("openssl not found. Install Git for Windows or put openssl on PATH.")


def ensure_certificate(ips):
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if not (cert.exists() and key.exists()):
        CERT_DIR.mkdir(parents=True, exist_ok=True)
        san = ",".join(["DNS:localhost", "IP:127.0.0.1"] + [f"IP:{ip}" for ip in ips])
        subprocess.run(
            [find_openssl(), "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
             "-keyout", str(key), "-out", str(cert), "-subj", "/CN=GCGScanner dev",
             "-addext", f"subjectAltName={san}"],
            check=True,
        )
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
        ".webmanifest": "application/manifest+json",
        ".webp": "image/webp",  # not in the Windows registry everywhere
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PWA_DIR), **kwargs)

    def setup(self):
        # The TLS handshake runs here, in the request thread, so a silent client cannot block
        # the accept loop and failures show up in the log instead of being dropped.
        self.handshake_failed = False
        if isinstance(self.request, ssl.SSLSocket):
            self.request.settimeout(10)
            try:
                self.request.do_handshake()
            except OSError as error:
                self.log_message("TLS handshake failed: %s", error)
                self.handshake_failed = True
        super().setup()

    def handle(self):
        if not self.handshake_failed:
            super().handle()

    def end_headers(self):
        # Same isolation headers the service worker adds on GitHub Pages (multi-threaded wasm).
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        if path.startswith("/ref-images/"):
            return str(IMAGE_DIR / Path(path.split("?")[0]).name)
        return super().translate_path(path)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/variants":
            self.reply(200, export_variants(), "application/json; charset=utf-8")
            return
        super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if route == "/api/eval-result":
            EVAL_RESULT.parent.mkdir(parents=True, exist_ok=True)
            EVAL_RESULT.write_bytes(body)
            self.reply(204)
        elif route == "/api/index":
            self.store_index(body)
        else:
            self.send_error(404)

    def store_index(self, body: bytes):
        # Body: int8 vectors (count x dim) followed by one float32 scale per vector.
        variants_json = export_variants()
        if hashlib.sha256(variants_json).hexdigest() != self.headers.get("X-Variants-Hash"):
            self.send_error(409, "card database changed while building the index, please run it again")
            return
        count = len(json.loads(variants_json))
        dim = int(self.headers["X-Dim"])
        if len(body) != count * dim + count * 4:
            self.send_error(400, "index size does not match the variant count")
            return
        DATA_DIR.mkdir(exist_ok=True)
        (DATA_DIR / "variants.json").write_bytes(variants_json)
        (DATA_DIR / "embeddings.bin").write_bytes(body)
        meta = {
            "format": "int8-scaled",
            "count": count,
            "dim": dim,
            "variants": hashlib.sha256(variants_json).hexdigest()[:16],
            "embeddings": hashlib.sha256(body).hexdigest()[:16],
        }
        (DATA_DIR / "index.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self.log_message("Stored index: %d variants x %d dims", count, dim)
        self.reply(204)

    def reply(self, status, body=b"", content_type=None):
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--https", action="store_true", help="serve on all interfaces with TLS (for phones)")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    if args.https:
        ips = lan_ips()
        server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port or 8443), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(*ensure_certificate(ips))
        server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        for ip in ips:
            print(f"Open on your phone: https://{ip}:{server.server_port}/")
    else:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port or 8000), Handler)
        print(f"Open: http://localhost:{server.server_port}/")
    print(f"Build the index: http://localhost:{server.server_port}/dev/build-index.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
