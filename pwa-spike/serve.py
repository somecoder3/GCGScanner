"""Dev server for the PWA spike (Python standard library only).

    python pwa-spike/serve.py            # http://localhost:8000  (PC, camera works on localhost)
    python pwa-spike/serve.py --https    # https://<LAN-IP>:8443  (phone; self-signed certificate)

On start it exports data/cards.db to pwa-spike/data/variants.json. Extra routes:
  GET  /ref-images/<file>   card images from build/carddb-cache/images (for build-index/eval)
  POST /api/index           stores the reference embeddings computed by build-index.html
  POST /api/eval-result     stores the last eval.html result in build/eval-result.json
"""

import argparse
import functools
import http.server
import json
import socket
import sqlite3
import ssl
import subprocess
import sys
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent
REPO_ROOT = SPIKE_DIR.parent
CARDS_DB = REPO_ROOT / "data" / "cards.db"
IMAGE_DIR = REPO_ROOT / "build" / "carddb-cache" / "images"
CERT_DIR = REPO_ROOT / "build" / "cert"
DATA_DIR = SPIKE_DIR / "data"
EVAL_RESULT = REPO_ROOT / "build" / "eval-result.json"


def export_variants():
    db = sqlite3.connect(CARDS_DB)
    rows = db.execute(
        """SELECT v.exburst_id, v.card_no, c.name, v.rarity, v.image_file, v.image_url
           FROM variant v JOIN card c ON c.card_no = v.card_no
           ORDER BY v.exburst_id"""
    ).fetchall()
    keys = ["id", "cardNo", "name", "rarity", "file", "url"]
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "variants.json").write_text(
        json.dumps([dict(zip(keys, row)) for row in rows], ensure_ascii=False), encoding="utf-8"
    )
    return [row[0] for row in rows]


def lan_ips():
    ips = {ip for *_, (ip, *_) in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    return sorted(ip for ip in ips if not ip.startswith("127."))


def ensure_certificate(ips):
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if not cert.exists():
        CERT_DIR.mkdir(parents=True, exist_ok=True)
        san = ",".join(["DNS:localhost", "IP:127.0.0.1"] + [f"IP:{ip}" for ip in ips])
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
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
    }

    def __init__(self, *args, variant_ids, **kwargs):
        self.variant_ids = variant_ids
        super().__init__(*args, directory=str(SPIKE_DIR), **kwargs)

    def end_headers(self):
        # Cross-origin isolation enables multi-threaded WebAssembly; "credentialless" still
        # lets <img> load card pictures from the official site.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        if path.startswith("/ref-images/"):
            return str(IMAGE_DIR / Path(path.split("?")[0]).name)
        return super().translate_path(path)

    def do_POST(self):
        route = self.path.split("?")[0]
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if route == "/api/eval-result":
            EVAL_RESULT.parent.mkdir(parents=True, exist_ok=True)
            EVAL_RESULT.write_bytes(body)
            self.send_response(204)
            self.end_headers()
            return
        if route != "/api/index":
            self.send_error(404)
            return
        dim = len(body) // 4 // len(self.variant_ids)
        if dim * 4 * len(self.variant_ids) != len(body):
            self.send_error(400, "embedding size does not match variant count")
            return
        (DATA_DIR / "embeddings.bin").write_bytes(body)
        (DATA_DIR / "embeddings.json").write_text(
            json.dumps({"dim": dim, "ids": self.variant_ids}), encoding="utf-8"
        )
        self.send_response(204)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--https", action="store_true", help="serve on all interfaces with TLS (for phones)")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    variant_ids = export_variants()
    print(f"Exported {len(variant_ids)} variants to {DATA_DIR / 'variants.json'}")

    handler = functools.partial(Handler, variant_ids=variant_ids)
    if args.https:
        ips = lan_ips()
        server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port or 8443), handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(*ensure_certificate(ips))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        for ip in ips:
            print(f"Open on your phone: https://{ip}:{server.server_port}/")
    else:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port or 8000), handler)
        print(f"Open: http://localhost:{server.server_port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
