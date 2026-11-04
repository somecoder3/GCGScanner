// Removing the "SAMPLE" watermark of the official card images (dev pages only: watermark.html,
// build-index.html, eval.html). The watermark comes in a few fixed variants (size, position, stroke);
// masks.json holds one mask per variant, found by watermark.html over all reference images.
// Each image gets the variant whose mask lies on its brightest thin lines, and the masked pixels
// are filled from their surroundings (OpenCV inpainting).

export const W = 600, H = 838;
const BLUR_RADIUS = 3;

// Bright thin lines that run diagonally. The watermark is written at an angle, so all its strokes
// are diagonal (except tiny bits of curves, covered by widening the mask); the card frame, text
// boxes and text lines are horizontal or vertical and would otherwise dominate.
export function diagonalLines(imageData) {
  const lines = highpass(imageData);
  const { data } = imageData;
  const lum = (p) => data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (!lines[p]) continue;
      const gx = lum(p - W + 1) + 2 * lum(p + 1) + lum(p + W + 1) - lum(p - W - 1) - 2 * lum(p - 1) - lum(p + W - 1);
      const gy = lum(p + W - 1) + 2 * lum(p + W) + lum(p + W + 1) - lum(p - W - 1) - 2 * lum(p - W) - lum(p - W + 1);
      // |sin 2θ| of the gradient direction: 0 on horizontal/vertical lines, 1 on 45° lines.
      const magnitude = gx * gx + gy * gy;
      if (!magnitude || Math.abs(2 * gx * gy) / magnitude < 0.5) lines[p] = 0;
    }
  }
  return lines;
}

// Bright thin lines: luminance minus its local mean (box of 2r+1), negative values cut off.
export function highpass({ data }) {
  const lum = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) lum[p] = (data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2]) / 3;
  // integral image
  const sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += lum[y * W + x];
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - BLUR_RADIUS), y1 = Math.min(H, y + BLUR_RADIUS + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - BLUR_RADIUS), x1 = Math.min(W, x + BLUR_RADIUS + 1);
      const box = sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0];
      out[y * W + x] = Math.max(0, lum[y * W + x] - box / ((x1 - x0) * (y1 - y0)));
    }
  }
  return out;
}

export async function loadMasks() {
  const { width, height, masks } = await fetch(new URL("watermark/masks.json", import.meta.url), { cache: "no-cache" }).then((r) => r.json());
  if (width !== W || height !== H) throw new Error("masks.json passt nicht zur Bildgröße");
  return masks.map((runs) => {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < runs.length; i += 2) mask.fill(255, runs[i], runs[i] + runs[i + 1]);
    return mask;
  });
}

// The variant whose mask has the most line brightness relative to the whole image.
export function assignMask(imageData, masks) {
  const lines = diagonalLines(imageData);
  let all = 0;
  for (const v of lines) all += v;
  all = all / lines.length + 1;
  const scores = masks.map((mask) => {
    let s = 0, n = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p]) { s += lines[p]; n++; }
    return s / n / all;
  });
  const index = scores.indexOf(Math.max(...scores));
  return { index, scores };
}

// ImageData (W × H) → new ImageData with the watermark of its variant filled in. Works at half size
// (300 × 419): plenty for the model's 224 px input and about four times faster than full size.
export function cleanImage(imageData, masks, cv, { grow = 5, method = cv.INPAINT_TELEA } = {}) {
  const { index } = assignMask(imageData, masks);
  const w = W / 2, h = Math.round(H / 2);
  const rgba = cv.matFromImageData(imageData);
  const rgb = new cv.Mat(), small = new cv.Mat(), mask = new cv.Mat(), smallMask = new cv.Mat(), filled = new cv.Mat();
  const kernel = cv.Mat.ones(grow, grow, cv.CV_8U);
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.resize(rgb, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    mask.create(H, W, cv.CV_8UC1);
    mask.data.set(masks[index]);
    // Also cover the soft edge next to the stroke and the non-diagonal bits of the curves.
    cv.dilate(mask, mask, kernel);
    cv.resize(mask, smallMask, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    cv.threshold(smallMask, smallMask, 0, 255, cv.THRESH_BINARY);
    cv.inpaint(small, smallMask, filled, 2, method);
    const out = new ImageData(w, h);
    for (let p = 0; p < w * h; p++) {
      out.data[p * 4] = filled.data[p * 3];
      out.data[p * 4 + 1] = filled.data[p * 3 + 1];
      out.data[p * 4 + 2] = filled.data[p * 3 + 2];
      out.data[p * 4 + 3] = 255;
    }
    // Keep the transparent rounded corners of the original.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data[(y * w + x) * 4 + 3] = imageData.data[((y * 2) * W + x * 2) * 4 + 3];
    return out;
  } finally {
    [rgba, rgb, small, mask, smallMask, filled, kernel].forEach((m) => m.delete());
  }
}

// Image element → canvas of the card without its watermark (half size, see cleanImage).
const source = new OffscreenCanvas(W, H);
const sourceCtx = source.getContext("2d", { willReadFrequently: true });
export function withoutWatermark(image, masks, cv, options) {
  sourceCtx.clearRect(0, 0, W, H);
  sourceCtx.drawImage(image, 0, 0, W, H);
  const cleaned = cleanImage(sourceCtx.getImageData(0, 0, W, H), masks, cv, options);
  const out = new OffscreenCanvas(cleaned.width, cleaned.height);
  out.getContext("2d").putImageData(cleaned, 0, 0);
  return out;
}

// Page side of watermark-worker.js: clean(url, options) → canvas of the cleaned card (half size).
// options.method is the name of the OpenCV constant, e.g. "INPAINT_NS".
export function createCleaner() {
  const worker = new Worker(new URL("./watermark-worker.js", import.meta.url));
  const pending = new Map();
  let nextId = 0;
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.image);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "SAMPLE-Entfernung konnte nicht geladen werden");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  async function clean(url, options) {
    const id = nextId++;
    const image = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, url: new URL(url, location.href).href, options });
    });
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d").putImageData(image, 0, 0);
    return canvas;
  }
  return { clean, terminate: () => worker.terminate() };
}

// OpenCV.js loaded by a <script> tag on the page (or importScripts in a worker), once it is ready.
// The Emscripten module has its own then(), which resolves with the module itself: returning it from
// an async function (or awaiting it) makes the promise adopt it again and again, an endless loop
// that froze build-index.html at 100 % CPU. Wait for it explicitly and remove then() first.
export async function openCv() {
  const cv = self.cv;
  if (!cv.Mat) await new Promise((resolve) => (cv.onRuntimeInitialized = resolve));
  if (typeof cv.then === "function") delete cv.then;
  return cv;
}
