"""Copy the onnxruntime-web runtime files into pwa-spike/vendor/.

Downloads the pinned npm tarball, checks it against the registry's sha512
integrity value and extracts only the files the scanner loads. Serving them from
our own origin keeps ORT's worker threads working (no cross-origin workers).

    python tools/vendor/fetch_ort.py
"""

import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

PACKAGE = "onnxruntime-web"
VERSION = "1.30.0"
FILES = [
    # WebAssembly (CPU) backend
    "ort.wasm.min.mjs",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    # WebGPU backend
    "ort.webgpu.min.mjs",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
]

REPO_ROOT = Path(__file__).resolve().parents[2]
TARGET = REPO_ROOT / "pwa-spike" / "vendor" / f"{PACKAGE}-{VERSION}"


def main():
    with urllib.request.urlopen(f"https://registry.npmjs.org/{PACKAGE}/{VERSION}") as response:
        dist = json.load(response)["dist"]
    print(f"Downloading {dist['tarball']}")
    with urllib.request.urlopen(dist["tarball"]) as response:
        tarball = response.read()

    algorithm, expected = dist["integrity"].split("-", 1)
    actual = base64.b64encode(hashlib.new(algorithm, tarball).digest()).decode()
    if actual != expected:
        raise SystemExit(f"Integrity mismatch: {algorithm}-{actual}")

    TARGET.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        for name in FILES:
            data = archive.extractfile(f"package/dist/{name}").read()
            (TARGET / name).write_bytes(data)
            print(f"  {name} ({len(data) // 1024} KB)")
    print(f"Wrote {len(FILES)} files to {TARGET}")


if __name__ == "__main__":
    main()
