"""Copy third-party runtime files (onnxruntime-web, OpenCV.js) into pwa/vendor/.

Downloads each pinned npm tarball, checks it against the registry's sha512
integrity value and extracts only the files the app loads. Serving them from
our own origin keeps worker threads working (no cross-origin workers).

    python tools/vendor/fetch_vendor.py
"""

import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

PACKAGES = [
    {
        "name": "onnxruntime-web",
        "version": "1.30.0",
        "folder": "onnxruntime-web-1.30.0",
        "files": [
            # WebAssembly (CPU) backend
            "dist/ort.wasm.min.mjs",
            "dist/ort-wasm-simd-threaded.mjs",
            "dist/ort-wasm-simd-threaded.wasm",
            # WebGPU backend (since 1.2x it loads the asyncify build, not jsep)
            "dist/ort.webgpu.min.mjs",
            "dist/ort-wasm-simd-threaded.asyncify.mjs",
            "dist/ort-wasm-simd-threaded.asyncify.wasm",
        ],
    },
    {
        # Card outlines and perspective correction for the multi-card scanner (js/detector-worker.js)
        "name": "@techstark/opencv-js",
        "version": "4.12.0-release.1",
        "folder": "opencv-4.12.0",
        "files": ["dist/opencv.js", "LICENSE"],
    },
]

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDOR = REPO_ROOT / "pwa" / "vendor"


def fetch(package):
    with urllib.request.urlopen(f"https://registry.npmjs.org/{package['name']}/{package['version']}") as response:
        dist = json.load(response)["dist"]
    print(f"Downloading {dist['tarball']}")
    with urllib.request.urlopen(dist["tarball"]) as response:
        tarball = response.read()

    algorithm, expected = dist["integrity"].split("-", 1)
    actual = base64.b64encode(hashlib.new(algorithm, tarball).digest()).decode()
    if actual != expected:
        raise SystemExit(f"Integrity mismatch for {package['name']}: {algorithm}-{actual}")

    target = VENDOR / package["folder"]
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        for name in package["files"]:
            data = archive.extractfile(f"package/{name}").read()
            (target / Path(name).name).write_bytes(data)
            print(f"  {Path(name).name} ({len(data) // 1024} KB)")
    print(f"Wrote {len(package['files'])} files to {target}")


def main():
    for package in PACKAGES:
        fetch(package)


if __name__ == "__main__":
    main()
