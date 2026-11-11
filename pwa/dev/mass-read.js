// Mass scan: finds the card-number corners in a photo and reads them (dev/mass-eval.html measures it).
// Step 2 of the plan: find the corners (classic, OpenCV). Reading the number (step 3) is still open,
// so every corner comes back with text "" and cardNo null.
//
// The number is a row of thin characters ("GD06-046", rarity box, year hexagon): bright on a dark tab
// on normal cards, dark on a light tab on silver/gold ones. A white top-hat (bright strokes) and a
// black-hat (dark strokes) keep strokes thinner than the kernel; thresholded at a few levels, every
// stroke shaped like a character is a glyph, and neighbouring glyphs of similar height on one line
// are chained into a row (text-line grouping). Card edges, colour bars and art are not shaped like
// characters, so unlike a morphological closing they never get glued to a row. Finally, all numbers in
// one photo have about the same height, so rows far from the median height are dropped.

export const METHOD = "Ecken finden: Top-/Black-Hat + Textzeilen (Schritt 2, liest noch nicht)";

export const DEFAULTS = {
  workSide: 2000, // the photo is scaled to this long side first (the number is then ~10–17 px high)
  tophat: 13, // kernel of top-/black-hat in work pixels: wider than a stroke, narrower than the tab
  threshold: 45, // minimum top-hat response of a stroke
  otsu: true, // let Otsu raise the threshold per photo
  levels: [1, 0.7, 0.5], // passes with the threshold times these factors (weak tabs only show at lower ones)
  dark: true, // also look for dark text on light tabs (silver/gold cards)
  minHeight: 5, // glyph height in work pixels
  maxHeight: 40,
  maxGlyphAspect: 8, // part width / height: at work scale the characters of a number often touch
  charWidth: 0.62, // a wide part counts as width / (charWidth × height) characters
  minGlyphFill: 0.12, // glyph pixels / bounding box
  lineTolerance: 0.4, // vertical centre offset between neighbours, relative to their height
  maxGap: 1.0, // horizontal gap between neighbours, relative to their height
  heightRatio: 1.7, // neighbours may differ this much in height (rarity box vs. digits)
  minGlyphs: 5, // characters in a row ("T-030" has 5)
  minParts: 2, // separate parts in a row (number, rarity box, year hexagon), so one stripe is no row
  minAspect: 3, // row width / height
  maxAngle: 25, // degrees from horizontal (cards may also lie upside down)
  heightBand: [0.5, 2], // allowed row height relative to the median of all rows; null = off
};

// bitmap: the photo. context: { cv, cardNumbers, options }.
// Returns [{ quad: [[x, y] × 4] in photo pixels (top left, top right, bottom right, bottom left),
// text, cardNo, height, glyphs, polarity }].
export async function readCorners(bitmap, context) {
  return findCorners(bitmap, context.cv, context.options).map((corner) => ({ ...corner, text: "", cardNo: null }));
}

export function findCorners(bitmap, cv, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const scale = Math.min(1, o.workSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);

  const mats = [];
  const keep = (mat) => (mats.push(mat), mat);
  try {
    const rgba = keep(cv.matFromImageData(ctx.getImageData(0, 0, w, h)));
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const kHat = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(o.tophat, o.tophat)));

    let rows = rowsOf(cv, gray, cv.MORPH_TOPHAT, kHat, o).map((r) => ({ ...r, polarity: "hell" }));
    if (o.dark) rows = rows.concat(rowsOf(cv, gray, cv.MORPH_BLACKHAT, kHat, o).map((r) => ({ ...r, polarity: "dunkel" })));
    rows = dedupe(rows);
    if (o.heightBand && rows.length >= 5) {
      const heights = rows.map((r) => r.h).sort((a, b) => a - b);
      const median = heights[Math.floor(heights.length / 2)];
      rows = rows.filter((r) => r.h >= median * o.heightBand[0] && r.h <= median * o.heightBand[1]);
    }
    return rows.map((r) => ({
      quad: order(r.points.map(([x, y]) => [x / scale, y / scale])),
      height: r.h / scale,
      glyphs: r.glyphs,
      polarity: r.polarity,
    }));
  } finally {
    mats.forEach((mat) => mat.delete());
  }
}

// Rows of thin strokes of one polarity (MORPH_TOPHAT: bright, MORPH_BLACKHAT: dark), in work pixels.
function rowsOf(cv, gray, op, kHat, o) {
  const hat = new cv.Mat(), strokes = new cv.Mat();
  try {
    cv.morphologyEx(gray, hat, op, kHat);
    const otsu = o.otsu ? cv.threshold(hat, strokes, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU) : 0;
    const base = Math.max(o.threshold, otsu);
    return o.levels.flatMap((level) => {
      cv.threshold(hat, strokes, base * level, 255, cv.THRESH_BINARY);
      return linesOf(cv, glyphsOf(cv, strokes, o), o);
    });
  } finally {
    hat.delete();
    strokes.delete();
  }
}

// Connected strokes shaped like characters: { x, y, w, h, cx, cy }.
function glyphsOf(cv, strokes, o) {
  const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
  try {
    const n = cv.connectedComponentsWithStats(strokes, labels, stats, centroids, 8, cv.CV_32S);
    const glyphs = [];
    const s = stats.data32S;
    for (let i = 1; i < n; i++) {
      const x = s[i * 5], y = s[i * 5 + 1], w = s[i * 5 + 2], h = s[i * 5 + 3], area = s[i * 5 + 4];
      if (h < o.minHeight || h > o.maxHeight) continue;
      if (w > h * o.maxGlyphAspect || w < 1) continue;
      if (area < w * h * o.minGlyphFill) continue;
      glyphs.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, chars: Math.max(1, Math.round(w / (o.charWidth * h))) });
    }
    return glyphs;
  } finally {
    [labels, stats, centroids].forEach((m) => m.delete());
  }
}

// Chains neighbouring glyphs into lines (union-find over left-to-right neighbours), returns rows with
// at least minGlyphs characters as rotated rectangles.
function linesOf(cv, glyphs, o) {
  glyphs.sort((a, b) => a.x - b.x);
  const parent = glyphs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < glyphs.length; i++) {
    const a = glyphs[i];
    const reach = a.x + a.w + o.maxGap * a.h * o.heightRatio;
    for (let j = i + 1; j < glyphs.length && glyphs[j].x <= reach; j++) {
      const b = glyphs[j];
      const size = Math.max(a.h, b.h);
      if (size / Math.min(a.h, b.h) > o.heightRatio) continue;
      if (Math.abs(a.cy - b.cy) > o.lineTolerance * size) continue;
      const gap = b.x - (a.x + a.w);
      if (gap > o.maxGap * size || gap < -0.3 * size) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  glyphs.forEach((g, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(g);
  });

  const rows = [];
  for (const members of groups.values()) {
    const chars = members.reduce((sum, g) => sum + g.chars, 0);
    if (members.length < o.minParts || chars < o.minGlyphs) continue;
    const corners = members.flatMap((g) => [g.x, g.y, g.x + g.w, g.y, g.x + g.w, g.y + g.h, g.x, g.y + g.h]);
    const points = cv.matFromArray(corners.length / 2, 1, cv.CV_32FC2, corners);
    try {
      const rect = cv.minAreaRect(points);
      let { width: rw, height: rh } = rect.size;
      let angle = rect.angle;
      if (rh > rw) { [rw, rh] = [rh, rw]; angle += 90; }
      angle = ((angle % 180) + 180) % 180;
      if (rw / rh < o.minAspect) continue;
      if (Math.min(angle, 180 - angle) > o.maxAngle) continue;
      rows.push({
        points: cv.RotatedRect.points(rect).map((p) => [p.x, p.y]),
        h: rh, w: rw, cx: rect.center.x, cy: rect.center.y, glyphs: chars,
      });
    } finally {
      points.delete();
    }
  }
  return rows;
}

// The same row found as bright and as dark text or at several levels: keep the one with more glyphs.
function dedupe(rows) {
  rows.sort((a, b) => b.glyphs - a.glyphs || b.w - a.w);
  const kept = [];
  for (const row of rows) {
    if (!kept.some((k) => Math.abs(k.cy - row.cy) < k.h * 0.6 && Math.abs(k.cx - row.cx) < k.w * 0.5)) kept.push(row);
  }
  return kept;
}

// Corners as top left, top right, bottom right, bottom left (by position in the photo).
function order(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / 4, cy = points.reduce((s, p) => s + p[1], 0) / 4;
  const byAngle = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const first = byAngle.reduce((best, p, i) => (p[0] + p[1] < byAngle[best][0] + byAngle[best][1] ? i : best), 0);
  return [...byAngle.slice(first), ...byAngle.slice(0, first)];
}
