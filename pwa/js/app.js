// GCG Scanner: camera → card recognition → list → ExBurst CSV.

import { createEmbedder, DEFAULT_BACKEND } from "./embedder.js";
import { loadIndex, search, siblings, LOOK_ALIKE } from "./matcher.js";
import { Collection } from "./collection.js";
import { cardImage } from "./images.js";
import { ImageStore } from "./imagepack.js";
import { createDetector } from "./detector.js";
import { around, pickCard } from "./rectify.js";
import { setupMass } from "./mass.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const guide = $("guide");
const stats = $("stats");

const SEARCH_K = 5;
// Scanner timings, adjustable on the settings page (stored in localStorage):
// window: hits are averaged over this time so names and percentages do not jump every frame.
// stableFrames: a match counts as stable once it leads the smoothed ranking this many frames in a row.
// minShow: a shown hit stays at least this long, even if another card briefly matches better.
// clickLock: the buttons ignore taps this long after every change, so a tap never hits a card that
// just appeared.
const TIMING_KEY = "gcg-scanner-timing";
const DEFAULT_TIMING = { minShow: 700, clickLock: 400, window: 500, stableFrames: 3 };
const TIMING_LIMITS = { minShow: [0, 3000], clickLock: [0, 2000], window: [100, 2000], stableFrames: [1, 15] };
const TIMING_INPUTS = { minShow: "t-min-show", clickLock: "t-click-lock", window: "t-window", stableFrames: "t-stable" };
// Single failures (e.g. a frame that is not ready yet) are skipped; after this many in a row the
// scan stops with a message instead of freezing silently (e.g. lost WebGPU device).
const MAX_ERRORS = 5;
const LENS_KEY = "gcg-scanner-lens";
const BACKEND_KEY = "gcg-scanner-backend";
const INDEX_KEY = "gcg-scanner-index";
const RECTIFY_KEY = "gcg-scanner-rectify";
const SET_KEY = "gcg-scanner-set";
// The guide crop only has to stay sharp at the model's 224 px, so the detector can work on a small copy.
const DETECT_OPTIONS = { warpSide: 640 };
const LIST_HASH = "#liste";
const SCAN_HASH = "#scan";
const SETTINGS_HASH = "#einstellungen";
const MASS_HASH = "#masse";

let index, embedder, collection, detector = null;
let stream = null, track = null, generation = 0, cameraOn = false, resumeCamera = false;
// best: the hit shown (held for timing.minShow); lastBest/streak: the current leader of the smoothing.
let recent = [], best = null, lastBest = null, streak = 0, shownId = "", shownSince = 0;
let focusInfo = "", focusTimer = 0;
const siblingCache = new Map();
// Only cards of this set are matched ("" = all), e.g. while opening boosters. Cards marked as wrongly
// recognized are skipped until a card is taken, the camera stops or the list is opened.
let scanSet = "", allowed = null;
const excluded = new Set();
let timing = loadTiming();

async function boot() {
  showView();
  showTiming();
  const worker = await registerServiceWorker();
  navigator.storage?.persist?.().catch(() => {});

  const params = new URLSearchParams(location.search);
  let backend = params.get("backend");
  try { backend ??= localStorage.getItem(BACKEND_KEY); } catch {}
  backend ??= DEFAULT_BACKEND;
  const full = setting(INDEX_KEY) === "full";
  const rectify = setting(RECTIFY_KEY) !== "off";
  $("index-kind").value = full ? "full" : "compact";
  $("rectify").checked = rectify;

  try {
    status(worker ? "Lade Erkennung …" : "Lade Erkennung … (ohne Offline-Speicher)");
    [index, embedder] = await Promise.all([loadIndex({ full }), createEmbedder({ backend })]);
  } catch (error) {
    status(`Fehler beim Laden: ${error.message}`);
    return;
  }
  // OpenCV.js (~10 MB) loads in the worker in the background; until then the guide crop is used.
  if (rectify) detector = createDetector();
  $("backend").value = embedder.backend; // shows the wasm fallback if WebGPU failed
  status(`Bereit · ${index.variants.length} Varianten · ${embedder.backend} · Index ${index.full ? "voll" : "kompakt"}`);
  $("camera").disabled = false;

  fillSetList();
  collection = new Collection(index);
  setupMass({ index, collection, cardImage, toast });
  collection.onChange(() => { renderCount(); if (currentView === LIST_HASH) renderList(); });
  renderCount();
  // The view was shown before loading; now fill it (list) or start the camera (scanner).
  if (currentView === LIST_HASH) renderList();
  if (currentView === SCAN_HASH) startCamera();
  updateImages(); // in the background: new image packs since the last visit
}

// Loading state and errors, on the start page and in the scanner.
function status(text) {
  stats.textContent = text;
  $("home-status").textContent = text;
}

// ---- Service worker (offline use, image cache, update notice) ---------------------------------

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  // ?nosw: no service worker (testing; e.g. Claude's browser pane, where its requests never arrive).
  if (new URLSearchParams(location.search).has("nosw")) return null;
  let registration;
  try {
    registration = await navigator.serviceWorker.register("sw.js");
  } catch (error) {
    console.warn("Service Worker nicht registriert", error);
    return null;
  }
  // A new version is installed in the background; it takes over when the user reloads.
  const offerUpdate = (worker) => {
    $("update").hidden = false;
    $("reload").onclick = () => {
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
      worker.postMessage("skipWaiting");
    };
  };
  if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  });
  // On the very first visit, wait briefly until the worker controls the page, so the model and index
  // downloads already go through it and are kept for offline use.
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  return registration;
}

function setting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

$("index-kind").addEventListener("change", (event) => {
  try { localStorage.setItem(INDEX_KEY, event.target.value); } catch {}
  location.reload();
});
$("rectify").addEventListener("change", (event) => {
  try { localStorage.setItem(RECTIFY_KEY, event.target.checked ? "on" : "off"); } catch {}
  location.reload();
});

$("backend").addEventListener("change", (event) => {
  try { localStorage.setItem(BACKEND_KEY, event.target.value); } catch {}
  location.reload();
});

// ---- Views: start page, scanner (#scan), list (#liste), settings (#einstellungen) --------------
// Every view has its own history entry, so the Android back button goes back one view.

const VIEWS = { "": "home-view", [SCAN_HASH]: "scan-view", [LIST_HASH]: "list-view", [SETTINGS_HASH]: "settings-view", [MASS_HASH]: "mass-view" };
let currentView = null;

// Opens a view as a new history entry; `from` remembers where it was opened.
function go(hash) {
  history.pushState({ app: true, from: currentView }, "", hash || location.pathname + location.search);
  showView();
}

// Back inside the app. A view opened directly (reload, link) has no app entry before it, so it is
// replaced by the start page instead of leaving the app.
function goBack() {
  if (history.state?.app) {
    history.back();
  } else {
    history.replaceState(null, "", location.pathname + location.search);
    showView();
  }
}

$("go-scan").addEventListener("click", () => go(SCAN_HASH));
$("go-list").addEventListener("click", () => go(LIST_HASH));
$("go-settings").addEventListener("click", () => go(SETTINGS_HASH));
$("go-mass").addEventListener("click", () => go(MASS_HASH));
for (const id of ["scan-back", "back", "settings-back", "mass-back"]) $(id).addEventListener("click", goBack);
$("done").addEventListener("click", () => {
  clearExcluded();
  go(LIST_HASH);
});
// From the scanner: back to it. From the start page: the list entry becomes the scanner.
$("scan-more").addEventListener("click", () => {
  if (history.state?.from === SCAN_HASH) {
    history.back();
  } else {
    history.replaceState(history.state, "", SCAN_HASH);
    showView();
  }
});
window.addEventListener("popstate", showView);
window.addEventListener("hashchange", showView);

function showView() {
  const hash = location.hash in VIEWS ? location.hash : "";
  if (hash === currentView) return;
  currentView = hash;
  for (const [view, id] of Object.entries(VIEWS)) $(id).hidden = view !== hash;
  $("menu").hidden = true;
  showSet();
  resumeCamera = false;
  if (hash === SCAN_HASH) {
    if (embedder) startCamera(); // otherwise boot() starts it once the model is loaded
  } else if (cameraOn) {
    stopCamera();
  }
  if (hash === LIST_HASH && collection) renderList();
  if (hash === SETTINGS_HASH) renderStorage();
  window.scrollTo(0, 0);
}

// ---- Scanner timings (settings page) -----------------------------------------------------------

function loadTiming() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(TIMING_KEY)) ?? {}; } catch {}
  const result = { ...DEFAULT_TIMING };
  for (const key of Object.keys(result)) {
    const value = Number(saved[key]);
    if (saved[key] != null && Number.isFinite(value)) result[key] = clampTiming(key, value);
  }
  return result;
}

function clampTiming(key, value) {
  const [min, max] = TIMING_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function showTiming() {
  for (const [key, id] of Object.entries(TIMING_INPUTS)) $(id).value = timing[key];
}

// Applies at once, also to a running scan.
for (const [key, id] of Object.entries(TIMING_INPUTS)) {
  $(id).addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (event.target.value !== "" && Number.isFinite(value)) {
      timing = { ...timing, [key]: clampTiming(key, value) };
      try { localStorage.setItem(TIMING_KEY, JSON.stringify(timing)); } catch {}
    }
    showTiming();
  });
}
$("timing-reset").addEventListener("click", () => {
  timing = { ...DEFAULT_TIMING };
  try { localStorage.removeItem(TIMING_KEY); } catch {}
  showTiming();
});

// ---- Camera -----------------------------------------------------------------------------------

// cameraOn is set as soon as a start begins, so a second tap while waiting for the camera cancels it.
$("camera").addEventListener("click", () => (cameraOn ? stopCamera() : startCamera()));
$("lens").addEventListener("change", (event) => {
  try { localStorage.setItem(LENS_KEY, event.target.value); } catch {}
  startCamera();
});
// Free the camera when the app goes to the background; resume when it comes back.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && cameraOn) {
    resumeCamera = true;
    stopCamera();
  } else if (!document.hidden && resumeCamera && currentView === SCAN_HASH) {
    resumeCamera = false;
    startCamera();
  }
});

// Every start or stop bumps `generation`. A start that has been overtaken while awaiting must not
// touch the shared state: the newer start (or the stop) owns it.
async function startCamera() {
  stopCamera();
  const gen = ++generation;
  const isCurrent = () => gen === generation;
  cameraOn = true;
  $("camera").textContent = "Kamera stoppen";
  $("camera").classList.remove("primary");
  let lens = null;
  try { lens = localStorage.getItem(LENS_KEY); } catch {}
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let media = null;
  try {
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: lens ? { deviceId: { exact: lens }, ...size } : { facingMode: { ideal: "environment" }, ...size },
      });
    } catch (error) {
      if (!lens || !isCurrent()) throw error;
      // The saved lens is gone (other phone, camera unplugged): fall back to the default back camera.
      try { localStorage.removeItem(LENS_KEY); } catch {}
      media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...size } });
    }
    if (!isCurrent()) return media.getTracks().forEach((t) => t.stop());
    // From here on stopCamera() releases this stream, so an overtaken start can simply return.
    stream = media;
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play();
    if (!isCurrent()) return;
    await setupFocus();
    if (!isCurrent()) return;
    setupZoom();
    await fillLensList();
    if (!isCurrent()) return;
    loop(gen);
  } catch (error) {
    if (!isCurrent()) {
      // Overtaken: release a stream that never made it into the shared state, leave the rest alone.
      if (media && media !== stream) media.getTracks().forEach((t) => t.stop());
      return;
    }
    stopCamera();
    stats.textContent = `Kamera nicht verfügbar: ${error.message}`;
  }
}

function stopCamera() {
  generation++;
  cameraOn = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = track = null;
  video.srcObject = null;
  clearTimeout(focusTimer);
  excluded.clear();
  updateAllowed();
  resetHit();
  $("zoom-row").hidden = true;
  $("camera").textContent = "Kamera starten";
  $("camera").classList.add("primary");
}

async function fillLensList() {
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const select = $("lens");
  select.hidden = cameras.length < 2;
  select.replaceChildren(...cameras.map((camera, i) => new Option(camera.label || `Kamera ${i + 1}`, camera.deviceId)));
  select.value = track.getSettings().deviceId ?? "";
}

// Continuous autofocus if the camera supports it; tapping the picture refocuses on that spot.
async function setupFocus() {
  const modes = track.getCapabilities?.().focusMode ?? [];
  if (modes.includes("continuous")) {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }
  const mode = track.getSettings().focusMode;
  focusInfo = mode === "continuous" ? "AF kontinuierlich" : mode ? `AF ${mode}` : "AF nicht steuerbar";
}

$("viewer").addEventListener("click", async (event) => {
  if (!track || event.target.closest(".hud, .top, .zoom")) return;
  const viewer = $("viewer").getBoundingClientRect();
  const ring = document.createElement("div");
  ring.className = "focus-ring";
  ring.style.left = `${event.clientX - viewer.left}px`;
  ring.style.top = `${event.clientY - viewer.top}px`;
  $("viewer").append(ring);
  setTimeout(() => ring.remove(), 800);

  const modes = track.getCapabilities?.().focusMode ?? [];
  const [x, y] = toFrame(event.clientX, event.clientY);
  const point = { x: x / video.videoWidth, y: y / video.videoHeight };
  const focus = {};
  if (navigator.mediaDevices.getSupportedConstraints().pointsOfInterest) focus.pointsOfInterest = [point];
  if (modes.includes("single-shot")) focus.focusMode = "single-shot";
  else if (modes.includes("continuous")) focus.focusMode = "continuous";
  if (!Object.keys(focus).length) return;
  await track.applyConstraints({ advanced: [focus] }).catch(() => {});
  // After a single-shot focus, go back to tracking so the next card is sharp again.
  clearTimeout(focusTimer);
  if (focus.focusMode === "single-shot" && modes.includes("continuous")) {
    focusTimer = setTimeout(() => track?.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {}), 2500);
  }
});

// Optical/digital zoom lets you hold the phone further away, where the lens can focus.
function setupZoom() {
  const caps = track.getCapabilities?.() ?? {};
  if (!caps.zoom || caps.zoom.max <= caps.zoom.min) return;
  const input = $("zoom");
  Object.assign(input, { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: track.getSettings().zoom ?? caps.zoom.min });
  $("zoom-value").textContent = `${Number(input.value).toFixed(1)}×`;
  $("zoom-row").hidden = false;
  input.oninput = () => {
    $("zoom-value").textContent = `${Number(input.value).toFixed(1)}×`;
    track?.applyConstraints({ advanced: [{ zoom: Number(input.value) }] }).catch(() => {});
  };
}

// The video is drawn with object-fit: cover, so map screen points through that scale and crop.
function toFrame(clientX, clientY) {
  const v = video.getBoundingClientRect();
  const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
  const offsetX = (v.width - video.videoWidth * scale) / 2;
  const offsetY = (v.height - video.videoHeight * scale) / 2;
  return [(clientX - v.left - offsetX) / scale, (clientY - v.top - offsetY) / scale, scale];
}

// Maps the on-screen guide rectangle to pixels of the camera frame.
function guideRegion() {
  const g = guide.getBoundingClientRect();
  const [x, y, scale] = toFrame(g.left, g.top);
  return [x, y, g.width / scale, g.height / scale];
}

// ---- Recognition ------------------------------------------------------------------------------

// With the detector, the card's outline is searched around the guide and the straightened card is
// used (simulated frames: variant 95.7 → 99.3 %, hard 81 → 92 %); without an outline, the guide crop.
async function embedFrame() {
  const guideBox = guideRegion();
  if (detector) {
    try {
      const card = pickCard(await detector.detect(video, DETECT_OPTIONS, around(guideBox, video.videoWidth, video.videoHeight)), guideBox);
      if (card) return { vector: (await embedder.embedPixels([card.pixels]))[0], rectified: true };
    } catch (error) {
      // OpenCV could not be loaded (e.g. offline before the first download): go on without it.
      console.warn("Entzerren nicht möglich", error);
      detector.terminate();
      detector = null;
    }
  }
  return { vector: await embedder.embed(video, guideBox), rectified: false };
}

async function loop(gen) {
  let frames = 0, windowStart = performance.now(), inferenceMs = 0, errors = 0, rectified = 0;
  while (gen === generation) {
    const t0 = performance.now();
    let vector;
    try {
      const result = await embedFrame();
      vector = result.vector;
      rectified += result.rectified;
      errors = 0;
    } catch (error) {
      if (gen !== generation) break;
      console.error("Erkennung fehlgeschlagen", error);
      if (++errors >= MAX_ERRORS) {
        stopCamera();
        const hint = embedder.backend === "webgpu" ? " – ggf. unter Einstellungen auf WebAssembly umstellen." : "";
        stats.textContent = `Erkennung abgebrochen: ${error.message}${hint}`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const t1 = performance.now();
    if (gen !== generation) break;
    const matches = search(index, vector, SEARCH_K, allowed);
    const { top, scores } = matches.length ? smooth(t1, matches) : { top: null, scores: new Map() };
    inferenceMs += t1 - t0;
    frames++;

    streak = top && top.variant.id === lastBest ? streak + 1 : top ? 1 : 0;
    lastBest = top?.variant.id ?? null;
    if (!top) {
      best = null;
    } else if (best && top.variant.id !== best.variant.id && t1 - shownSince < timing.minShow && scores.has(best.variant.id)) {
      best = { variant: best.variant, score: scores.get(best.variant.id) }; // hold the shown hit a bit longer
    } else {
      if (top.variant.id !== best?.variant.id) shownSince = t1;
      best = top;
    }
    updateButtons(t1);
    renderHit();

    const elapsed = performance.now() - windowStart;
    if (elapsed > 1000) {
      const straight = detector ? ` · entzerrt ${Math.round((rectified / frames) * 100)} %` : "";
      stats.textContent = `${(frames * 1000 / elapsed).toFixed(1)} Bilder/s · ${(inferenceMs / frames).toFixed(0)} ms${straight} · ${embedder.backend} · ${focusInfo}`;
      frames = 0; inferenceMs = 0; rectified = 0; windowStart = performance.now();
    }
    await new Promise(requestAnimationFrame);
  }
}

// Averages the scores of the last timing.window ms. A variant missing from a frame's top list counts with
// that frame's lowest listed score (its real score is at most that), so one lucky frame cannot win.
function smooth(now, matches) {
  recent.push({ t: now, matches });
  while (recent[0].t < now - timing.window) recent.shift();
  const variants = new Map();
  for (const frame of recent) for (const m of frame.matches) variants.set(m.variant.id, m.variant);
  let top = null;
  const scores = new Map();
  for (const variant of variants.values()) {
    let sum = 0;
    for (const frame of recent) {
      const hit = frame.matches.find((m) => m.variant.id === variant.id);
      sum += hit ? hit.score : frame.matches[frame.matches.length - 1].score;
    }
    const score = sum / recent.length;
    scores.set(variant.id, score);
    if (!top || score > top.score) top = { variant, score };
  }
  return { top, scores };
}

// Stable (green) = the shown hit also leads the smoothing for a few frames. Taking needs that; both
// buttons also wait timing.clickLock ms after the shown hit changed.
const isStable = () => !!best && best.variant.id === lastBest && streak >= timing.stableFrames;
const isSettled = (now = performance.now()) => !!best && now - shownSince >= timing.clickLock;
function updateButtons(now) {
  const settled = isSettled(now);
  guide.classList.toggle("stable", isStable());
  $("take").disabled = !(isStable() && settled);
  $("exclude").disabled = !settled;
  $("hit").classList.toggle("locked", !settled);
}

function siblingsOf(variant) {
  if (!siblingCache.has(variant.id)) siblingCache.set(variant.id, siblings(index, variant));
  return siblingCache.get(variant.id);
}

// Rebuilds the tile only when the hit changes; otherwise just updates the numbers (no image flicker).
function renderHit() {
  const box = $("hit");
  $("hit-row").hidden = !best;
  if (!best) {
    shownId = "";
    return;
  }
  const { variant, score } = best;
  if (variant.id !== shownId) {
    shownId = variant.id;
    const lookAlikes = siblingsOf(variant).filter((s) => s.lookAlike).length;
    const text = document.createElement("div");
    text.innerHTML = `<b></b><span class="name"></span><span class="score"></span>${lookAlikes ? `<span class="alike"></span>` : ""}`;
    text.querySelector("b").textContent = variant.id;
    text.querySelector(".name").textContent = variant.name;
    if (lookAlikes) text.querySelector(".alike").textContent = `+${lookAlikes} gleich aussehende Variante${lookAlikes > 1 ? "n" : ""} – in der Liste prüfen`;
    box.replaceChildren(cardImage(variant), text);
  }
  box.classList.toggle("stable", isStable());
  box.querySelector(".score").textContent = `${variant.rarity} · ${(score * 100).toFixed(1)} %`;
}

// Tapping the hit tile or the button adds the card. A short lock prevents accidental double taps;
// a second copy of the same card is simply a second tap.
let takeLocked = false;
function take() {
  if (!isStable() || !isSettled() || takeLocked) return;
  const count = collection.add(best.variant);
  toast(`${best.variant.id} übernommen${count > 1 ? ` (${count}×)` : ""}`, best.variant);
  navigator.vibrate?.(30);
  clearExcluded();
  takeLocked = true;
  setTimeout(() => (takeLocked = false), 600);
}
$("take").addEventListener("click", take);
$("hit").addEventListener("click", take);

// ---- Excluding wrong hits and the set filter ---------------------------------------------------

// Starts the smoothing over, so the next hit is built from frames of the new search only.
function resetHit() {
  recent = []; best = null; lastBest = null; streak = 0;
  updateButtons();
  renderHit();
}

// One byte per variant for search(): the chosen set minus the excluded cards (null = everything).
function updateAllowed() {
  if (!index) return;
  if (!scanSet && !excluded.size) {
    allowed = null;
    return;
  }
  allowed = new Uint8Array(index.variants.length);
  index.variants.forEach((variant, row) => {
    const set = setOf(variant);
    allowed[row] = (!scanSet || set === scanSet || GENERAL_SETS.has(set)) && !excluded.has(variant.id) ? 1 : 0;
  });
}

function clearExcluded() {
  if (!excluded.size) return;
  excluded.clear();
  updateAllowed();
  resetHit();
}

// The wrong hit and its look-alike reprints (otherwise the reprint would simply show up next).
$("exclude").addEventListener("click", () => {
  if (!isSettled()) return;
  const { variant } = best;
  excluded.add(variant.id);
  for (const s of siblingsOf(variant)) if (s.score >= LOOK_ALIKE) excluded.add(s.variant.id);
  updateAllowed();
  resetHit();
  toast(`${variant.id} ausgeschlossen`, variant);
});

// Set = card number without its running number: GD01-001 → GD01, T-001 → T.
const setOf = (variant) => variant.cardNo.replace(/-[^-]*$/, "");
// Tokens, resources and EX base/resource cards come with every product: always matched, not listed.
const GENERAL_SETS = new Set(["T", "R", "RP", "EXB", "EXBP", "EXR", "EXRP"]);
const SET_ORDER = ["GD", "EB", "ST"];

function fillSetList() {
  const counts = new Map();
  for (const variant of index.variants) {
    const set = setOf(variant);
    if (!GENERAL_SETS.has(set)) counts.set(set, (counts.get(set) ?? 0) + 1);
  }
  const key = (set) => {
    const [, letters = set, number = ""] = set.match(/^([A-Z]+)(\d*)$/) ?? [];
    const group = SET_ORDER.indexOf(letters);
    return [group < 0 ? SET_ORDER.length : group, Number(number || 0)];
  };
  const sets = [...counts.keys()].sort((a, b) => {
    const [ga, na] = key(a), [gb, nb] = key(b);
    return ga - gb || na - nb || a.localeCompare(b);
  });
  $("scan-set").append(...sets.map((set) => new Option(`${set} (${counts.get(set)})`, set)));
  const saved = setting(SET_KEY) ?? "";
  scanSet = counts.has(saved) ? saved : "";
  $("scan-set").value = scanSet;
  showSet();
  updateAllowed();
}

function showSet() {
  const toggle = $("menu-toggle");
  const open = !$("menu").hidden;
  toggle.textContent = `${scanSet ? `${scanSet} ` : ""}${open ? "▴" : "▾"}`;
  toggle.classList.toggle("active", !!scanSet);
  toggle.setAttribute("aria-expanded", String(open));
}

$("menu-toggle").addEventListener("click", () => {
  $("menu").hidden = !$("menu").hidden;
  showSet();
});
$("scan-set").addEventListener("change", (event) => {
  scanSet = event.target.value;
  try { localStorage.setItem(SET_KEY, scanSet); } catch {}
  updateAllowed();
  resetHit();
  $("menu").hidden = true;
  showSet();
});

// ---- List -------------------------------------------------------------------------------------

function renderCount() {
  const total = collection.total;
  $("scan-count").textContent = total;
  $("list-count").textContent = total;
  $("home-count").textContent = total;
}

function renderList() {
  const entries = [...collection.entries.values()];
  $("empty").hidden = entries.length > 0;
  for (const id of ["share", "copy", "download"]) $(id).disabled = !entries.length;
  $("share").hidden = !canShareFiles();

  let toCheck = 0;
  $("items").replaceChildren(...entries.map((entry) => {
    const { variant, count, checked, unsure } = entry;
    const all = siblingsOf(variant);
    const lookAlikes = all.filter((s) => s.lookAlike).length;
    // unsure: from the mass scan, which reads only the number (any of its variants is possible).
    const needsCheck = (lookAlikes > 0 || (unsure && all.length > 1)) && !checked;
    toCheck += needsCheck;

    const row = document.createElement("div");
    row.className = "item";
    const thumb = document.createElement("button");
    thumb.className = "thumb";
    thumb.setAttribute("aria-label", "Variante wählen");
    thumb.append(cardImage(variant));
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<b></b><small></small>`;
    info.querySelector("b").textContent = variant.name;
    info.querySelector("small").textContent = `${variant.id} · ${variant.rarity}`;
    if (all.length > 1) {
      const pick = document.createElement("button");
      pick.className = "variant-btn" + (needsCheck ? " check" : "");
      pick.textContent = !needsCheck ? `${all.length} Varianten`
        : unsure ? `Variante prüfen (${all.length} Varianten, Massenscan)`
        : `Variante prüfen (${lookAlikes} gleich aussehend)`;
      pick.addEventListener("click", () => openVariants(variant));
      info.append(pick);
    }
    if (all.length > 1) thumb.addEventListener("click", () => openVariants(variant));
    const qty = document.createElement("div");
    qty.className = "qty";
    qty.innerHTML = `<button aria-label="Eins weniger">−</button><b></b><button aria-label="Eins mehr">+</button>`;
    qty.querySelector("b").textContent = count;
    const [minus, plus] = qty.querySelectorAll("button");
    minus.addEventListener("click", () => collection.add(variant, -1));
    plus.addEventListener("click", () => collection.add(variant, 1));
    row.append(thumb, info, qty);
    return row;
  }));

  $("check-hint").hidden = !toCheck;
  // Variant unclear: near-identical reprints, or cards from the mass scan (number only).
  $("check-hint").textContent = toCheck === 1
    ? "Bei 1 Karte ist die Variante unklar (Nachdruck oder Massenscan) – bitte prüfen."
    : `Bei ${toCheck} Karten ist die Variante unklar (Nachdrucke oder Massenscan) – bitte prüfen.`;
}

function openVariants(variant) {
  const dialog = $("variant-dialog");
  $("variant-title").textContent = `${variant.cardNo} · ${variant.name}`;
  $("variant-grid").replaceChildren(...siblingsOf(variant)
    .slice()
    .sort((a, b) => a.variant.id.localeCompare(b.variant.id, undefined, { numeric: true }))
    .map(({ variant: option, lookAlike }) => {
      const button = document.createElement("button");
      button.className = option.id === variant.id ? "current" : "";
      button.append(cardImage(option));
      const label = document.createElement("div");
      label.innerHTML = `<b></b><span></span>${lookAlike ? `<br><span class="alike">gleich aussehend</span>` : ""}`;
      label.querySelector("b").textContent = option.id;
      label.querySelector("span").textContent = option.rarity;
      button.append(label);
      button.addEventListener("click", () => {
        collection.replace(variant.id, option);
        dialog.close();
      });
      return button;
    }));
  dialog.showModal();
}

// ---- Export -----------------------------------------------------------------------------------

function csvFile() {
  return new File([collection.csv()], `gcg-scan-${new Date().toISOString().slice(0, 10)}.csv`, { type: "text/csv" });
}

function canShareFiles() {
  try { return !!navigator.canShare?.({ files: [new File([""], "x.csv", { type: "text/csv" })] }); } catch { return false; }
}

$("share").addEventListener("click", async () => {
  try {
    await navigator.share({ files: [csvFile()], title: "GCG Scan für ExBurst" });
  } catch (error) {
    if (error.name !== "AbortError") toast(`Teilen fehlgeschlagen: ${error.message}`);
  }
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(collection.csv());
    toast("CSV kopiert – jetzt ExBurst öffnen und beim Import einfügen");
  } catch (error) {
    toast(`Kopieren fehlgeschlagen: ${error.message}`);
  }
});

$("download").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(csvFile());
  link.download = csvFile().name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

$("clear").addEventListener("click", () => {
  if (confirm(`Alle ${collection.total} Karten aus der Liste löschen?`)) collection.clear();
});

async function renderStorage() {
  const parts = [];
  try {
    const { usage } = await navigator.storage.estimate();
    parts.push(`Offline gespeichert: ${(usage / 1e6).toFixed(0)} MB`);
    if (await navigator.storage.persisted?.()) parts.push("dauerhaft");
  } catch {}
  try {
    parts.push(`${(await images.status()).count} Kartenbilder`);
  } catch {}
  $("storage").textContent = parts.join(" · ");
}

// ---- Card images (encrypted packs, see imagepack.js) ------------------------------------------

const images = new ImageStore();

function imageProgress({ pack, done, total }) {
  const line = $("unlock-status");
  line.hidden = false;
  line.textContent = pack ? `Lade Kartenbilder … ${pack} (${done + 1}/${total})` : "Kartenbilder geladen.";
}

// Shows the unlock form when packs exist but this phone has no key yet, otherwise imports new packs.
async function updateImages() {
  let state;
  try {
    state = await images.status();
  } catch (error) {
    console.warn("Bildstatus unbekannt", error);
    return;
  }
  $("unlock").hidden = !state.available || state.unlocked;
  if (state.unlocked && state.pending) {
    try {
      const count = await images.sync(imageProgress);
      if (count) imagesChanged(`${count} neue Kartenbilder geladen`);
    } catch (error) {
      console.warn("Bildpakete nicht aktualisiert", error);
    }
  }
}

function imagesChanged(message) {
  if (message) toast(message);
  shownId = ""; // rebuild the hit tile with the image
  renderHit();
  if (currentView === LIST_HASH) renderList();
  if (currentView === SETTINGS_HASH) renderStorage();
}

$("unlock").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  const line = $("unlock-status");
  line.hidden = false;
  line.textContent = "Prüfe Passwort …";
  try {
    const count = await images.unlock($("passphrase").value, imageProgress);
    $("passphrase").value = "";
    $("unlock").hidden = true;
    imagesChanged(`${count} Kartenbilder freigeschaltet`);
  } catch (error) {
    line.textContent = error.message;
  }
  button.disabled = false;
});

$("forget-images").addEventListener("click", async () => {
  if (!confirm("Kartenbilder und Schlüssel vom Handy löschen? Danach ist das Passwort erneut nötig.")) return;
  await images.clear();
  imagesChanged("Kartenbilder gelöscht");
  updateImages();
});

// ---- Helpers ----------------------------------------------------------------------------------

let toastTimer = 0;
// variant (optional): shows its small card image next to the message.
function toast(message, variant) {
  const box = $("toast");
  const text = document.createElement("span");
  text.textContent = message;
  box.replaceChildren(...(variant ? [cardImage(variant)] : []), text);
  box.classList.toggle("with-card", !!variant);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 2200);
}

// Last, so every listener and module variable above exists before the app starts.
await boot();
