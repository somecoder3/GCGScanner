// Finds card outlines in a camera frame and cuts each card out, perspective-corrected, as a
// 224 x 224 RGBA image (the embedder's input, same stretch as the reference images).
// Classic worker because OpenCV.js is a UMD script; see detector.js for the page side.
//
// Request:  { id, frame: ImageBitmap, options?: { low, high } }   (bitmap is transferred and closed;
//           low/high are the Canny thresholds, for experiments on the dev page)
// Response: { id, cards: [{ quad: [[x, y] × 4], pixels: ArrayBuffer, flipped: ArrayBuffer }], ms }
//           quad in frame pixels, clockwise from the card's top left (card upright, portrait).
//           flipped is the same card rotated by 180°: the card might lie upside down.

importScripts("../vendor/opencv-4.12.0/opencv.js");

const SIZE = 224;
// Detection runs on a small copy; cutting out uses a larger one so 224 px stay sharp.
const DETECT_SIDE = 640;
const WARP_SIDE = 1280;
const CARD_RATIO = 63 / 88;
// Share of a dividing line that must lie on edges to split a shape into several cards.
const SPLIT_SUPPORT = 0.6;
// Share of each side (minimum) and of all sides (mean) of a card outline that must lie on edges.
const OUTLINE_MIN = 0;
const OUTLINE_MEAN = 0;

let cv = null;
const ready = (async () => {
  let module = self.cv;
  if (module instanceof Promise) module = await module;
  else if (!module.Mat) await new Promise((resolve) => (module.onRuntimeInitialized = resolve));
  cv = module;
})();

self.onmessage = async ({ data }) => {
  const { id, frame, options = {} } = data;
  try {
    await ready;
    const t0 = performance.now();
    const { cards, debug } = detect(frame, options);
    frame.close();
    const transfer = cards.flatMap((c) => [c.pixels, c.flipped]);
    self.postMessage({ id, cards, debug, ms: performance.now() - t0 }, transfer);
  } catch (error) {
    frame.close?.();
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
};

function detect(frame, options) {
  const warpScale = Math.min(1, (options.warpSide ?? WARP_SIDE) / Math.max(frame.width, frame.height));
  const ww = Math.round(frame.width * warpScale), wh = Math.round(frame.height * warpScale);
  const canvas = new OffscreenCanvas(ww, wh);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, ww, wh);
  const big = cv.matFromImageData(ctx.getImageData(0, 0, ww, wh));
  const mats = [big];
  const track = (mat) => (mats.push(mat), mat);
  try {
    const detectScale = Math.min(1, DETECT_SIDE / Math.max(ww, wh));
    const small = track(new cv.Mat());
    cv.resize(big, small, new cv.Size(Math.round(ww * detectScale), Math.round(wh * detectScale)), 0, 0, cv.INTER_AREA);
    const { quads, debug } = findQuads(small, track, options);
    // small → frame pixels
    const toFrame = 1 / (detectScale * warpScale);
    const cards = quads.map((quad) => {
      const inWarp = quad.map(([x, y]) => [x / detectScale, y / detectScale]);
      const [pixels, flipped] = cutOut(big, inWarp, track);
      return { quad: quad.map(([x, y]) => [x * toFrame, y * toFrame]), pixels, flipped };
    });
    if (debug) debug.candidates = debug.candidates.map((quad) => quad.map(([x, y]) => [x * toFrame, y * toFrame]));
    return { cards, debug };
  } finally {
    for (const mat of mats) mat.delete();
  }
}

// Edges → filled outlines → four-cornered shapes → split into cards.
//  - Every outline of the edge image is filled, then thin parts are cut away (opening): lines of
//    table texture or a few edge pixels joining two cards no longer hold the shapes together.
//  - A shape can be several touching cards (a 3 × 3 grid even has the card's aspect ratio). It is
//    split into a grid of card-shaped cells if there are edges along all the dividing lines.
//  - The outlines themselves (incl. holes) are candidates, too; overlaps are sorted out in suppress().
function findQuads(rgba, track, options) {
  const side = Math.max(rgba.cols, rgba.rows);
  const imageArea = rgba.cols * rgba.rows;
  const gray = track(new cv.Mat());
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = track(new cv.Mat());
  cv.Canny(gray, edges, options.low ?? 30, options.high ?? 90);
  const white = new cv.Scalar(255);
  const hierarchy = track(new cv.Mat());
  const filled = track(cv.Mat.zeros(rgba.rows, rgba.cols, cv.CV_8U));
  let outlines = null;
  if (options.method !== "density") {
    cv.dilate(edges, edges, track(cv.Mat.ones(3, 3, cv.CV_8U)));
    outlines = track(new cv.MatVector());
    cv.findContours(edges, outlines, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    // One by one: drawn together, outlines and their holes cancel out.
    for (let i = 0; i < outlines.size(); i++) cv.drawContours(filled, outlines, i, white, cv.FILLED);
  } else {
    // Edge density: artwork is full of edges, table and gaps between cards are not.
    const w = Math.max(3, Math.round(side * (options.window ?? 0.02))) | 1;
    const density = track(new cv.Mat());
    cv.boxFilter(edges, density, -1, new cv.Size(w, w));
    cv.threshold(density, density, (options.density ?? 0.1) * 255, 255, cv.THRESH_BINARY);
    // Flat parts of the artwork (sky, text box) leave holes: fill each region completely.
    const regions = track(new cv.MatVector());
    cv.findContours(density, regions, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < regions.size(); i++) cv.drawContours(filled, regions, i, white, cv.FILLED);
    // The averaging window grows each region by about half its size; take that back.
    cv.erode(filled, filled, track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.round(w * (options.shrink ?? 0.5)) | 1, Math.round(w * (options.shrink ?? 0.5)) | 1))));
    cv.dilate(edges, edges, track(cv.Mat.ones(3, 3, cv.CV_8U)));
  }
  const k = Math.max(3, Math.round(side * (options.open ?? 0.015))) | 1;
  cv.morphologyEx(filled, filled, cv.MORPH_OPEN, track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k))));
  const blobs = track(new cv.MatVector());
  cv.findContours(filled, blobs, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const candidates = [];
  const minArea = imageArea * 0.004;
  if (options.blobs) forEachHull(blobs, (hull, area) => {
    if (area < minArea) return;
    const shape = toShape(hull, area);
    if (!shape) return;
    const quads = options.split ? splitGrid(shape, edges) : cardShaped(shape) ? [shape] : [];
    for (const quad of quads) candidates.push({ quad, area: polygonArea(quad) });
  });
  if (outlines && options.outlines !== false) {
    forEachHull(outlines, (hull, area) => {
      if (area < minArea || area > imageArea * 0.9) return;
      const quad = toShape(hull, area);
      if (quad && cardShaped(quad)) candidates.push({ quad, area });
    });
  }
  // A real card has edges along its outline; a hull around table texture or artwork does not.
  const outlined = candidates.filter(({ quad }) => {
    const support = quad.map((p, k) => edgeSupport(edges, p, quad[(k + 1) % 4]));
    return Math.min(...support) >= (options.outlineMin ?? OUTLINE_MIN) && support.reduce((a, b) => a + b) / 4 >= (options.outlineMean ?? OUTLINE_MEAN);
  });
  const quads = suppress(outlined).map((c) => upright(c.quad));
  // Dev page only: the filled shapes and all candidates before suppression.
  const debug = options.debug && { width: filled.cols, height: filled.rows, lines: filled.data.slice(), candidates: candidates.map((c) => c.quad) };
  return { quads, debug };
}

function forEachHull(contours, callback) {
  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const hull = new cv.Mat();
    try {
      cv.convexHull(contour, hull);
      callback(hull, cv.contourArea(hull));
    } finally {
      contour.delete();
      hull.delete();
    }
  }
}

// Four corners of a convex shape: it simplifies to four corners, or it fills its minimum-area
// rectangle almost completely (rounded corners). Clockwise from the top left (in the image).
function toShape(hull, area) {
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(hull, approx, 0.03 * cv.arcLength(hull, true), true);
    let points;
    if (approx.rows === 4) {
      points = [...Array(4)].map((_, k) => [approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
    } else {
      const rect = cv.minAreaRect(hull);
      if (area / (rect.size.width * rect.size.height) < 0.88) return null;
      points = cv.RotatedRect.points(rect).map((p) => [p.x, p.y]);
    }
    const quad = clockwise(points);
    const sides = quad.map((p, k) => distance(p, quad[(k + 1) % 4]));
    // Perspective makes opposite sides differ a little, not much.
    if (Math.min(sides[0], sides[2]) / Math.max(sides[0], sides[2]) < 0.7) return null;
    if (Math.min(sides[1], sides[3]) / Math.max(sides[1], sides[3]) < 0.7) return null;
    return quad;
  } finally {
    approx.delete();
  }
}

function aspectOk(width, height) {
  const ratio = Math.min(width, height) / Math.max(width, height);
  return ratio > CARD_RATIO * 0.8 && ratio < Math.min(0.95, CARD_RATIO * 1.25);
}

function cardShaped(quad) {
  return aspectOk((distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2, (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2);
}

// Splits a shape into cols × rows card-shaped cells if every dividing line runs along edges.
// The most cells win; a shape without such a split must be a single card.
function splitGrid(quad, edges) {
  const at = (s, t) => lerp(lerp(quad[0], quad[1], s), lerp(quad[3], quad[2], s), t);
  const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  let best = null;
  for (let cols = 1; cols <= 4; cols++) {
    for (let rows = 1; rows <= 4; rows++) {
      if (!aspectOk(width / cols, height / rows)) continue;
      let support = 1;
      for (let i = 1; i < cols; i++) support = Math.min(support, edgeSupport(edges, at(i / cols, 0), at(i / cols, 1)));
      for (let j = 1; j < rows; j++) support = Math.min(support, edgeSupport(edges, at(0, j / rows), at(1, j / rows)));
      if (support >= SPLIT_SUPPORT && (!best || cols * rows > best.cols * best.rows)) best = { cols, rows };
    }
  }
  if (!best) return [];
  const cells = [];
  for (let i = 0; i < best.cols; i++) {
    for (let j = 0; j < best.rows; j++) {
      const s0 = i / best.cols, s1 = (i + 1) / best.cols, t0 = j / best.rows, t1 = (j + 1) / best.rows;
      cells.push([at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)]);
    }
  }
  return cells;
}

// Share of points on the line (without its ends) that lie on an edge.
function edgeSupport(edges, from, to) {
  const samples = 40;
  let hits = 0;
  for (let n = 0; n < samples; n++) {
    const [x, y] = lerp(from, to, 0.08 + (0.84 * n) / (samples - 1));
    const xi = Math.round(x), yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < edges.cols && yi < edges.rows) hits += edges.data[yi * edges.cols + xi] > 0;
  }
  return hits / samples;
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const polygonArea = (q) => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0)) / 2;

// Outlines of the same card show up several times (both sides of the line, inner frames).
// Larger shapes go first and win over shapes centred inside them, unless a shape contains two or
// more smaller card shapes: then it is the outline of a group of touching cards (a 3 × 3 grid has
// the card's aspect ratio, too).
function suppress(candidates) {
  candidates.sort((a, b) => b.area - a.area);
  const centers = candidates.map((c) => center(c.quad));
  const kept = [];
  candidates.forEach((candidate, i) => {
    const parts = candidates.filter((other, j) =>
      other.area > candidate.area * 0.06 && other.area < candidate.area * 0.75 && contains(candidate.quad, centers[j]));
    if (parts.length >= 2) return;
    if (kept.some((k) => contains(k.quad, centers[i]))) return;
    kept.push(candidate);
  });
  return kept;
}

function center(quad) {
  return [quad.reduce((s, p) => s + p[0], 0) / 4, quad.reduce((s, p) => s + p[1], 0) / 4];
}

function contains(quad, [x, y]) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = quad[i], [xj, yj] = quad[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Clockwise order (on screen) starting with the corner nearest the image's top left.
function clockwise(points) {
  const [cx, cy] = center(points);
  const sorted = points.slice().sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
  let start = 0;
  sorted.forEach((p, k) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = k; });
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

// Clockwise from the top-left corner of the upright (portrait) card. Which short side is the top
// cannot be told from the outline, hence the extra 180° cut-out.
function upright(points) {
  const quad = clockwise(points);
  // Card lies sideways: rotate so that the first edge is a short one.
  return distance(quad[0], quad[1]) > distance(quad[1], quad[2]) ? [quad[3], quad[0], quad[1], quad[2]] : quad;
}

function cutOut(rgba, quad, track) {
  const src = track(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat()));
  const dst = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, SIZE, 0, SIZE, SIZE, 0, SIZE]));
  const matrix = track(cv.getPerspectiveTransform(src, dst));
  const card = track(new cv.Mat());
  cv.warpPerspective(rgba, card, matrix, new cv.Size(SIZE, SIZE), cv.INTER_AREA, cv.BORDER_REPLICATE);
  const flipped = track(new cv.Mat());
  cv.rotate(card, flipped, cv.ROTATE_180);
  return [card.data.slice().buffer, flipped.data.slice().buffer];
}
