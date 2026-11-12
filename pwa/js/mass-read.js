// Mass scan: finds the card-number corners in a photo and reads them (dev/mass-eval.html measures it).
// findCorners() finds the number rows (classic, OpenCV), readRow() in mass-ocr.js reads them, and
// fillColumns() reads again where the column layout says a card is missing.
//
// The number is a row of thin characters ("GD06-046", rarity box, year hexagon): bright on a dark tab
// on normal cards, dark on a light tab on silver/gold ones. A white top-hat (bright strokes) and a
// black-hat (dark strokes) keep strokes thinner than the kernel; thresholded at a few levels, every
// stroke shaped like a character is a glyph, and neighbouring glyphs of similar height on one line
// are chained into a row (text-line grouping). Card edges, colour bars and art are not shaped like
// characters, so unlike a morphological closing they never get glued to a row. Finally, all numbers in
// one photo have about the same height, so rows far from the median height are dropped.

import { readRow, redecode, grayImage, OCR_DEFAULTS } from "./mass-ocr.js";

export const METHOD = "Top-/Black-Hat + Textzeilen, Lesen mit Zeichenvorlagen, Spalten (12. Nov.)";

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

// bitmap: the photo. context: { cv, options, templates, vocab } (templates/vocab from mass-ocr.js;
// without them nothing is read). Returns [{ quad: [[x, y] × 4] in photo pixels (top left, top right,
// bottom right, bottom left), text, cardNo, cost, margin, height, glyphs, polarity }].
// Rows that cannot be read as a card number are dropped unless options.keepUnread is set.
export async function readCorners(photo, context) {
  const { cv, templates, vocab } = context;
  const options = context.options ?? {};
  if (!templates) return findCorners(photo, cv, options).map((row) => ({ ...row, text: "", cardNo: null }));
  const all = findCorners(photo, cv, { ...options, heightBand: null });
  // All strips are cut from one grey copy (fast also for GPU-backed video frames).
  const bitmap = grayImage(cv, photo);
  try {
    return readRows(cv, bitmap, all, templates, vocab, options);
  } finally {
    bitmap.gray.delete();
  }
}

function readRows(cv, bitmap, all, templates, vocab, options) {
  // Height filter in two stages: rows near the median height of all found rows first; then the
  // remaining rows near the median height of the rows that were read. (On a busy play mat most found
  // rows are texture, their median is far too small, and all number rows were dropped.)
  const band = options.heightBand === undefined ? DEFAULTS.heightBand : options.heightBand;
  const near = (h, median) => h >= median * band[0] && h <= median * band[1];
  const medianOf = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const first = band && all.length >= 5 ? all.filter((r) => near(r.height, medianOf(all.map((x) => x.height)))) : all;
  const readAll = (rows) => rows.map((row) => ({ ...row, text: "", cardNo: null, ...readRow(cv, bitmap, row, templates, vocab, options) }));
  const read = readAll(first);
  if (first !== all) {
    const heights = read.filter((r) => r.cardNo).map((r) => r.height);
    if (heights.length) {
      const median = medianOf(heights);
      read.push(...readAll(all.filter((r) => !first.includes(r) && near(r.height, median))));
    }
  }
  // Sets on the photo (off by default, options.photoSets): rows read so far name them; rows not read
  // are decoded again against the numbers of these sets only. Tried 12 Nov.: +2 cards but more false
  // reads (a looser read takes the place of a tab the columns would have read right).
  const setVocab = options.photoSets ? photoVocabulary(read, vocab, options) : null;
  if (setVocab) {
    for (const r of read) {
      if (r.cardNo || !r.lines) continue;
      const again = redecode(r, setVocab, { ...options, ...(options.setRead ?? SET_DEFAULTS.setRead) });
      if (again?.cardNo) Object.assign(r, again, { bySet: true });
    }
  }
  const accepted = read.filter((r) => r.cardNo);
  // One read per tab: the best one.
  accepted.sort((a, b) => a.cost - b.cost);
  const kept = [];
  for (const r of accepted) {
    // Another read at the same place (same tab at another threshold level, a worse reading of it, or
    // a box next to the tab whose strip still reached its number): compared where the read line lies.
    const { centre: [x, y] } = geometryOf(r);
    const twin = kept.some((k) => {
      const g = geometryOf(k);
      const dx = x - g.centre[0], dy = y - g.centre[1];
      return Math.abs(dx * g.u[0] + dy * g.u[1]) < g.h * 3 && Math.abs(dx * g.v[0] + dy * g.v[1]) < g.h * 0.8;
    });
    if (!twin) kept.push(r);
  }
  if (options.columns !== false) {
    const passes = options.passes ?? COLUMN_DEFAULTS.passes;
    for (let pass = 0; pass < passes; pass++) {
      const more = fillColumns(cv, bitmap, kept, templates, vocab, options, setVocab);
      if (!more.length) break;
      kept.push(...more);
    }
  }
  return options.keepUnread ? kept.concat(read.filter((r) => !r.cardNo)) : kept;
}

// "GD06-003" → "GD06", "T-030" → "T", "EXRP-001" → "EXRP".
const setOf = (cardNo) => cardNo.slice(0, cardNo.lastIndexOf("-"));

export const SET_DEFAULTS = {
  setMin: 3, // a set counts as on the photo with at least this many reads …
  setShare: 0.1, // … and this share of all reads
  setRead: {}, // reading options against the photo's sets (e.g. a higher maxCost, OCR_DEFAULTS)
};

// Vocabulary of the sets on the photo, or null (no set clear enough, or all sets anyway).
function photoVocabulary(reads, vocab, options) {
  const o = { ...SET_DEFAULTS, ...options };
  const counts = new Map();
  const accepted = reads.filter((r) => r.cardNo);
  for (const r of accepted) counts.set(setOf(r.cardNo), (counts.get(setOf(r.cardNo)) ?? 0) + 1);
  const sets = new Set([...counts].filter(([, n]) => n >= o.setMin && n >= accepted.length * o.setShare).map(([set]) => set));
  if (!sets.size) return null;
  const list = vocab.list.filter((v) => sets.has(setOf(v.cardNo)));
  return list.length < vocab.list.length ? { list, sets } : null;
}

// ---- columns ----------------------------------------------------------------------------------
//
// The cards lie in columns, each card a little further down than the one it covers, so the number
// tabs of one column sit on a line, all with the same direction and text height, at roughly regular
// distances. The rows read so far (reliable: false reads are rare) give the columns; where the gap
// between two reads is a multiple of the usual distance, cards are missing there, and the number is
// read again at the expected place, with the column's direction, orientation and text height
// (the row finder may have missed the tab, or boxed it badly).

export const COLUMN_DEFAULTS = {
  columnAngle: 10, // degrees: reads of one column point the same way …
  columnOffset: 2.5, // … and their centres lie on one line across, within this many text heights
  maxMissing: 6, // at most this many missing cards in one gap
  extend: 2, // also look this many steps before the first and after the last read of a column
  shifts: [0, -0.22, 0.22], // try these offsets along the column, × step (the cards lie by hand)
  rowWidth: 7, // candidate row width, × text height (like a found row: number plus boxes)
  minSpacing: 1.6, // distances below this many text heights are not two cards
  columnRead: {}, // reading options at the expected places (OCR_DEFAULTS in mass-ocr.js)
  passes: 2, // repeat with the new reads (they split long gaps more evenly)
};

// Geometry of a read row: centre of the read line, reading direction u, "down the card" v, height h.
function geometryOf(r) {
  const [tl, tr, , bl] = r.quad;
  const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const ax = [(tr[0] - tl[0]) / w, (tr[1] - tl[1]) / w];
  const down = [(bl[0] - tl[0]) / h, (bl[1] - tl[1]) / h];
  const cx = (tl[0] + tr[0] + bl[0] + r.quad[2][0]) / 4, cy = (tl[1] + tr[1] + bl[1] + r.quad[2][1]) / 4;
  const off = (r.offset ?? 0) * h;
  const centre = [cx + down[0] * off, cy + down[1] * off];
  const u = r.flip ? [-ax[0], -ax[1]] : ax;
  return { centre, u, v: [-u[1], u[0]], h };
}

function fillColumns(cv, bitmap, reads, templates, vocab, options, setVocab) {
  const o = { ...COLUMN_DEFAULTS, ...options };
  const items = reads.map((r) => ({ r, ...geometryOf(r) }));
  // Group into columns (union-find).
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cosMax = Math.cos((o.columnAngle * Math.PI) / 180);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.u[0] * b.u[0] + a.u[1] * b.u[1] < cosMax) continue;
      const h = Math.max(a.h, b.h);
      // Offset across the column: along the reading direction.
      const dx = b.centre[0] - a.centre[0], dy = b.centre[1] - a.centre[1];
      if (Math.abs(dx * a.u[0] + dy * a.u[1]) > o.columnOffset * h) continue;
      parent[find(j)] = find(i);
    }
  }
  const columns = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!columns.has(root)) columns.set(root, []);
    columns.get(root).push(item);
  });

  const found = [];
  const taken = reads.map((r) => geometryOf(r).centre);
  for (const members of columns.values()) {
    if (members.length < 2) continue;
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const h = median(members.map((m) => m.h));
    // Column axes: mean direction; positions along (t) and across (s) the column.
    let ux = 0, uy = 0;
    for (const m of members) { ux += m.u[0]; uy += m.u[1]; }
    const n = Math.hypot(ux, uy);
    const u = [ux / n, uy / n], v = [-u[1], u[0]];
    const origin = members[0].centre;
    const at = (p) => ({ s: (p[0] - origin[0]) * u[0] + (p[1] - origin[1]) * u[1], t: (p[0] - origin[0]) * v[0] + (p[1] - origin[1]) * v[1] });
    const pts = members.map((m) => at(m.centre)).sort((a, b) => a.t - b.t);
    // s as a linear function of t (the columns are not always straight across the photo).
    const mt = pts.reduce((sum, p) => sum + p.t, 0) / pts.length, ms = pts.reduce((sum, p) => sum + p.s, 0) / pts.length;
    let stt = 0, sts = 0;
    for (const p of pts) { stt += (p.t - mt) ** 2; sts += (p.t - mt) * (p.s - ms); }
    const slope = stt > 0 ? Math.max(-0.2, Math.min(0.2, sts / stt)) : 0;
    const sAt = (t) => ms + slope * (t - mt);
    // Usual distance between neighbouring cards: the typical small gap.
    const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t).filter((g) => g > o.minSpacing * h);
    if (!gaps.length) continue;
    const sorted = [...gaps].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.25)];
    const step = median(sorted.filter((g) => g >= low * 0.75 && g <= low * 1.45));

    const targets = [];
    for (let i = 1; i < pts.length; i++) {
      const gap = pts[i].t - pts[i - 1].t;
      const count = Math.round(gap / step);
      if (count < 2 || count > o.maxMissing + 1) continue;
      for (let k = 1; k < count; k++) targets.push({ t: pts[i - 1].t + (gap * k) / count, step: gap / count });
    }
    for (let k = 1; k <= o.extend; k++) {
      targets.push({ t: pts[0].t - k * step, step, end: true });
      targets.push({ t: pts.at(-1).t + k * step, step, end: true });
    }

    for (const target of targets) {
      let best = null;
      for (const shift of o.shifts) {
        const t = target.t + shift * target.step;
        const s = sAt(t);
        const centre = [origin[0] + u[0] * s + v[0] * t, origin[1] + u[1] * s + v[1] * t];
        const quad = rowQuad(centre, u, v, h, o.rowWidth);
        if (quad.some(([x, y]) => x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height)) continue;
        const row = { quad, height: h, polarity: "hell" };
        let r = readRow(cv, bitmap, row, templates, vocab, { ...options, flips: [false], ...o.columnRead });
        if (r && !r.cardNo && setVocab) r = redecode(r, setVocab, { ...options, ...o.columnRead, ...(options.setRead ?? SET_DEFAULTS.setRead) }) ?? r;
        if (r?.cardNo && (!best || r.cost < best.cost)) best = { ...row, glyphs: 0, ...r, column: true };
      }
      if (!best) continue;
      // Not a tab that is already read (the shifted strip can reach the neighbour's number).
      const c = geometryOf(best).centre;
      if (taken.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.max(o.minSpacing * h, target.step * 0.5))) continue;
      taken.push(c);
      found.push(best);
    }
  }
  return found;
}

// A row quad (TL, TR, BR, BL in reading direction) around a centre.
function rowQuad([cx, cy], u, v, h, width) {
  const hw = (width * h) / 2, hh = h / 2;
  const p = (a, b) => [cx + u[0] * a + v[0] * b, cy + u[1] * a + v[1] * b];
  return [p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, hh)];
}

export { OCR_DEFAULTS };

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
