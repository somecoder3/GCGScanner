// Service worker: makes the app work offline and keeps card images on the phone.
//
// Caches:
//   gcg-shell-<VERSION>  HTML/CSS/JS, replaced on every deploy (VERSION is set by the Pages workflow)
//   gcg-assets-v1        model, ONNX runtime and index data. Their URLs change when the content does
//                        (versioned folder, ?v=<hash>), so entries are used as they are.
//   gcg-card-images-v1   decrypted card images, written by the page (imagepack.js) after unlocking;
//                        served here under images/card/<file>. The encrypted packs are not cached.
//
// It also adds the cross-origin isolation headers that GitHub Pages cannot send, so multi-threaded
// WebAssembly works from the second visit on (only matters when WebGPU is not available).

const VERSION = "dev";
const DEV = VERSION === "dev";
const SHELL_CACHE = `gcg-shell-${VERSION}`;
const ASSET_CACHE = "gcg-assets-v1";
const IMAGE_CACHE = "gcg-card-images-v1";
// Caches of earlier versions that are no longer used.
const OBSOLETE_CACHES = ["gcg-images-v1"];

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "css/app.css",
  "js/app.js",
  "js/collection.js",
  "js/detector.js",
  "js/detector-worker.js",
  "js/embedder.js",
  "js/imagepack.js",
  "js/images.js",
  "js/matcher.js",
  "js/rectify.js",
  "js/mass.js",
  "js/mass-worker.js",
  "js/mass-read.js",
  "js/mass-ocr.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
// Asset paths in use by this version; anything else in ASSET_CACHE is an old version and removed.
const ASSET_PREFIXES = ["vendor/onnxruntime-web-1.30.0/", "vendor/opencv-4.12.0/", "model/mobilenetv2-features.onnx", "data/"];

const scope = new URL(self.registration.scope);
const local = (path) => new URL(path, scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((path) => new Request(local(path), { cache: "reload" })))));
  // The first install takes over right away; updates wait until the user reloads (see app.js).
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith("gcg-shell-") && name !== SHELL_CACHE) || OBSOLETE_CACHES.includes(name)) await caches.delete(name);
    }
    const assets = await caches.open(ASSET_CACHE);
    for (const request of await assets.keys()) {
      const path = request.url.slice(scope.href.length);
      if (!ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))) await assets.delete(request);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (!url.href.startsWith(scope.href)) return;
  const path = url.href.slice(scope.href.length).split(/[?#]/)[0];
  if (path.startsWith("dev/")) return; // dev pages talk to the dev server directly

  if (path.startsWith("images/card/")) {
    // Only on the phone after unlocking; the server has no such files.
    event.respondWith(caches.match(request, { cacheName: IMAGE_CACHE }).then((cached) => cached ?? new Response("", { status: 404 })));
    return;
  }
  if (path.startsWith("images/")) {
    // Encrypted packs and their index: straight from the network (imagepack.js keeps the result).
    return;
  }

  if (request.mode === "navigate") {
    // Every page of the app is index.html (the list view is just #liste).
    event.respondWith(isolated(DEV ? networkFirst(SHELL_CACHE, local("index.html")) : shellFirst(local("index.html"))));
  } else if (path === "data/index.json") {
    // Small and tells which data files are current: always ask the network, fall back offline.
    event.respondWith(isolated(networkFirst(ASSET_CACHE, request)));
  } else if (ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    event.respondWith(isolated(cacheFirst(ASSET_CACHE, request, path.startsWith("data/") ? path : null)));
  } else {
    event.respondWith(isolated(DEV ? networkFirst(SHELL_CACHE, request) : shellFirst(request)));
  }
});

// Cached copy if there is one, otherwise the network (and remember it). `replacePath` drops older
// versions of the same file (e.g. embeddings.bin?v=old) when a new one is stored.
async function cacheFirst(cacheName, request, replacePath = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type !== "opaque") {
    if (replacePath) {
      for (const old of await cache.keys()) {
        if (new URL(old.url).pathname === new URL(request.url).pathname) await cache.delete(old);
      }
    }
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

// App shell of this version: precached on install, so it works offline and stays consistent.
async function shellFirst(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true });
  return cached ?? fetch(request);
}

async function isolated(responsePromise) {
  const response = await responsePromise;
  if (response.type === "opaque" || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
