// Console helpers for experiments on the real mass-scan photos, on dev/mass-eval.html (needs its
// window.massContext with the reading templates):
//   const x = await import("/dev/mass-experiments.js");
//   await x.ready();
//   x.run([["Standard", {}], ["ohne Spalten", { columns: false }]]);   // runs in the background …
//   await x.wait();                  // … waits up to 38 s, then the result or "läuft: <photo>"
// Reading options as in the "Optionen" field (DEFAULTS, COLUMN_DEFAULTS, SET_DEFAULTS, OCR_DEFAULTS);
// a third entry rebuilds the templates first, e.g. ["dicker", {}, { strokes: [-1, 0, 1] }].
// In a hidden browser window the page only runs while a call like wait() keeps it busy.
import { readCorners } from "../js/mass-read.js";

const toCardNo = (id) => id.replace(/-ALT\d+$/i, "").toUpperCase();
export const photos = [];
let last = null;

// Waits until mass-eval.html has built its templates.
export async function ready() {
  while (!document.getElementById("status").textContent.startsWith("Bereit")) await new Promise((r) => setTimeout(r, 200));
  return loadPhotos();
}

export async function loadPhotos() {
  if (photos.length) return photos.length;
  for (const photo of await fetch("/api/mass-photos").then((r) => r.json())) {
    photos.push({ ...photo, bitmap: await createImageBitmap(await fetch(photo.url).then((r) => r.blob())) });
  }
  return photos.length;
}

// Reads all photos with the options; per photo the predictions and the missing cards are kept.
export async function evaluate(options = {}) {
  const context = window.massContext;
  context.options = options;
  let total = 0, correct = 0, wrong = 0, column = 0, columnOk = 0;
  const lines = [];
  const started = performance.now();
  for (const photo of photos) {
    progress = `${options === undefined ? "" : JSON.stringify(options)} ${photo.name}`;
    const predictions = await readCorners(photo.bitmap, context);
    const remaining = photo.truth.map(toCardNo);
    let ok = 0;
    const bad = [];
    for (const p of predictions) {
      if (p.column) column++;
      const at = p.cardNo ? remaining.indexOf(p.cardNo) : -1;
      if (at >= 0) { remaining.splice(at, 1); ok++; if (p.column) columnOk++; } else if (p.cardNo) bad.push(p.cardNo + (p.column ? "*" : ""));
    }
    Object.assign(photo, { predictions, missing: remaining });
    total += photo.truth.length; correct += ok; wrong += bad.length;
    lines.push(`${photo.name} ${ok}/${photo.truth.length}${bad.length ? ` falsch ${bad.join(", ")}` : ""}`);
  }
  const seconds = (performance.now() - started) / 1000;
  return `${correct}/${total} richtig, ${wrong} falsch (* aus Spalten), aus Spalten ${columnOk}/${column}, ${seconds.toFixed(1)} s\n${lines.join("\n")}`;
}

// Shows the photo area around every wrong read (and its neighbours) of the last evaluate().
export function showWrong(element) {
  element.replaceChildren();
  for (const photo of photos) {
    const truth = photo.truth.map(toCardNo);
    const counts = {};
    for (const p of photo.predictions ?? []) {
      if (!p.cardNo) continue;
      counts[p.cardNo] = (counts[p.cardNo] ?? 0) + 1;
      const allowed = truth.filter((t) => t === p.cardNo).length;
      if (counts[p.cardNo] <= allowed) continue;
      const xs = p.quad.map((q) => q[0]), ys = p.quad.map((q) => q[1]);
      const h = p.height ?? 20;
      const x0 = Math.min(...xs) - h * 4, y0 = Math.min(...ys) - h * 4;
      const w = Math.max(...xs) - Math.min(...xs) + h * 8, hh = Math.max(...ys) - Math.min(...ys) + h * 8;
      const canvas = document.createElement("canvas");
      const scale = Math.min(2, 500 / w);
      canvas.width = w * scale; canvas.height = hh * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(photo.bitmap, x0, y0, w, hh, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
      ctx.beginPath();
      p.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.strokeStyle = "#f00"; ctx.lineWidth = 2 / scale; ctx.stroke();
      const caption = document.createElement("div");
      caption.textContent = `${photo.name}: ${p.cardNo}${p.column ? " (Spalte)" : ""} Kosten ${p.cost.toFixed(2)}, gelesen „${p.text}“`;
      element.append(caption, canvas);
    }
  }
}

// Live mode without a camera: `frames` views of a photo (pan back and forth over the whole photo,
// slight turn and distance changes; each view drawn at frame size like a 4K video frame) are read and
// combined by LiveTracker. Compared with the photo's list like evaluate().
export async function evaluateLive(options = {}, { frames = 12, view = 0.65, frameWidth = 3840, tracker = {}, only = null } = {}) {
  const { LiveTracker } = await import("../js/mass-live.js");
  const context = window.massContext;
  context.options = options;
  let total = 0, correct = 0, wrong = 0, single = 0;
  const lines = [];
  const started = performance.now();
  for (const photo of photos) {
    if (only && !photo.name.startsWith(only)) continue;
    const live = new LiveTracker(tracker);
    const { width: W, height: H } = photo.bitmap;
    const fw = frameWidth, fh = Math.round(frameWidth * 9 / 16);
    // View size in photo pixels: `view` of the photo's long side, 16:9 like the frame (turned with the photo).
    const portrait = H > W;
    const vw = (portrait ? H : W) * view, vh = vw * 9 / 16;
    const canvas = new OffscreenCanvas(portrait ? fh : fw, portrait ? fw : fh);
    const ctx = canvas.getContext("2d");
    for (let f = 0; f < frames; f++) {
      progress = `${photo.name} Bild ${f + 1}`;
      const t = f / Math.max(1, frames - 1);
      const s = t < 0.5 ? t * 2 : 2 - t * 2; // there and back
      const zoom = 1 + 0.12 * Math.sin(t * 9); // distance changes
      const angle = 0.05 * Math.sin(t * 11);
      const w = (portrait ? vh : vw) / zoom, h = (portrait ? vw : vh) / zoom;
      // Pan there and back along the long side and 1.5 times over the short side (zigzag), so every
      // part of the photo is in view a few times, as when sweeping the camera over all columns.
      const across = 0.5 - 0.5 * Math.cos(t * 3 * Math.PI);
      const cx = Math.min(W - w / 2, Math.max(w / 2, portrait ? w / 2 + across * (W - w) : w / 2 + s * (W - w)));
      const cy = Math.min(H - h / 2, Math.max(h / 2, portrait ? h / 2 + s * (H - h) : h / 2 + across * (H - h)));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(angle);
      ctx.scale(canvas.width / w, canvas.width / w);
      ctx.drawImage(photo.bitmap, -cx, -cy);
      const frame = canvas.transferToImageBitmap();
      live.add(await readCorners(frame, context));
      frame.close();
    }
    const result = live.result();
    const remaining = photo.truth.map(toCardNo);
    let ok = 0;
    const bad = [];
    for (const { cardNo, count } of result.cards) {
      for (let k = 0; k < count; k++) {
        const at = remaining.indexOf(cardNo);
        if (at >= 0) { remaining.splice(at, 1); ok++; } else bad.push(cardNo);
      }
    }
    Object.assign(photo, { live: result, liveMissing: remaining });
    total += photo.truth.length; correct += ok; wrong += bad.length; single += result.unconfirmed;
    lines.push(`${photo.name} ${ok}/${photo.truth.length}${bad.length ? ` falsch ${bad.join(", ")}` : ""}${remaining.length ? ` fehlt ${remaining.join(", ")}` : ""} (${result.unconfirmed} einmal gesehen)`);
  }
  const seconds = (performance.now() - started) / 1000;
  return `Live ${frames} Bilder: ${correct}/${total} richtig, ${wrong} falsch, ${single} Spuren nur einmal gesehen, ${seconds.toFixed(0)} s\n${lines.join("\n")}`;
}

// Rebuilds the reading templates with other buildTemplates() options (e.g. { strokes: [-1, 0, 1] }).
export async function retemplate(build = {}) {
  const { buildTemplates } = await import("../js/mass-ocr.js");
  const { loadImage } = await import("../js/embedder.js");
  const context = window.massContext;
  context.templates = await buildTemplates(context.cv, context.variants, (v) => loadImage(`/ref-images/${v.file}`), {
    ...build, onProgress: (n) => (progress = `Vorlagen ${n}`),
  });
  return `${context.templates.used} Referenzbilder, ${context.templates.samples} Beispiele`;
}

// list: [[name, readOptions, buildOptions?]]; with buildOptions the templates are rebuilt first
// (and stay so for the following entries).
export function run(list) {
  last = null;
  (async () => {
    const out = [];
    for (const [name, options, build, live] of list) {
      const info = build ? `${await retemplate(build)}\n` : "";
      out.push(`${name}\n${info}${live ? await evaluateLive(options, live) : await evaluate(options)}`);
    }
    last = out.join("\n\n");
  })().catch((error) => (last = `Fehler: ${error.stack}`));
}

let progress = "";
export const result = () => last;
export const status = () => last ?? `läuft: ${progress}`;
// Waits up to `seconds` (keeps a hidden page busy, see CLAUDE.md) and returns the status.
export async function wait(seconds = 38) {
  const until = Date.now() + seconds * 1000;
  while (!last && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  return status();
}
