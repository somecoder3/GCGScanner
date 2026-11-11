// Mass scan, step 3: reads the card number in a row found by mass-read.js (findCorners).
//
// The number uses one fixed, narrow font. Character templates come from the official reference images
// (their number is known), so no general OCR is needed: the row is cut out of the full-resolution
// photo, straightened and scaled to TEXT px text height, split into characters (filled boxes for
// LK/SP, rarity and year mark are skipped, touching characters are split by width), every character is
// compared with the templates (normalised cross-correlation), and the sequence is aligned with every
// known card number (edit distance with the template scores as substitution cost). Only a clear winner
// counts; false hits from card art practically never align with a real number.

const TEXT = 26; // text height in strip pixels
const GW = 12, GH = 20; // template size
const STRIP = { left: 3, right: 1.6, top: 0.45, bottom: 0.45 }; // strip margins around a row, × row height

export const OCR_DEFAULTS = {
  sharpness: 25, // softmax over the template correlations of one character: p = exp(k·s) / Σ exp(k·s)
  maxCost: 0.3, // mean −log p per character of the best number (LDA: right ~0.15, wrong ~1.2)
  minMargin: 0.1, // mean cost gap to the second best card number
  shortKey: 5, // numbers up to this many characters (T-030, R-011, RP-025) are easily found in art …
  shortMaxCost: 0.15, // … so they need a closer match
  gapCost: 3, // a missing or extra character (≈ −log 0.05)
  binarize: ["otsu", "adaptive"], // see characters()
  classifier: "lda", // "lda" or "correlation" (templates.chars)
  ldaScale: 0.15, // LDA scores are log-likelihoods of a far too confident model: soften them
  cutBoxes: false, // stop at the rarity box (else the whole line is read and decode() skips around the number)
  maxLead: 4, // free characters before the number (LK/SP box, edge)
  maxTrail: 6, // free characters after it (rarity box, year mark, edge)
  minCoverage: 0.38, // the number must be at least this share of the read line
};

// "GD06-089" → "GD06089": dashes are too short to be found as characters and carry no information.
export const keyOf = (cardNo) => cardNo.replace(/-/g, "");

// ---- strips ------------------------------------------------------------------------------------

// Grey strip (CV_8U, text bright) of the photo area around a row quad [TL, TR, BR, BL].
// flip: the card lies upside down, turn the strip by 180°.
function stripFromQuad(cv, bitmap, quad, invert, flip) {
  const [tl, tr, , bl] = quad;
  const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const u = [(tr[0] - tl[0]) / w, (tr[1] - tl[1]) / w];
  const v = [(bl[0] - tl[0]) / h, (bl[1] - tl[1]) / h];
  const scale = TEXT / h;
  const left = STRIP.left * h, right = STRIP.right * h, top = STRIP.top * h, bottom = STRIP.bottom * h;
  const origin = [tl[0] - u[0] * left - v[0] * top, tl[1] - u[1] * left - v[1] * top];
  const W = w + left + right, H = h + top + bottom;
  const corners = [origin, [origin[0] + u[0] * W, origin[1] + u[1] * W], [origin[0] + v[0] * H, origin[1] + v[1] * H]];
  return warpStrip(cv, bitmap, corners, Math.round(W * scale), Math.round(H * scale), invert, flip);
}

// Strip of an axis-aligned rectangle (reference images: the known corner).
function stripFromRect(cv, image, [x, y, w, h], textHeight, invert) {
  const scale = TEXT / textHeight;
  return warpStrip(cv, image, [[x, y], [x + w, y], [x, y + h]], Math.round(w * scale), Math.round(h * scale), invert, false);
}

// corners: photo points that become the strip's top left, top right and bottom left.
function warpStrip(cv, source, corners, sw, sh, invert, flip) {
  const xs = corners.flatMap(([x]) => [x]).concat(corners[1][0] + corners[2][0] - corners[0][0]);
  const ys = corners.flatMap(([, y]) => [y]).concat(corners[1][1] + corners[2][1] - corners[0][1]);
  const sw0 = source.width, sh0 = source.height;
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2), by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const bw = Math.min(sw0, Math.ceil(Math.max(...xs)) + 2) - bx, bh = Math.min(sh0, Math.ceil(Math.max(...ys)) + 2) - by;
  if (bw < 4 || bh < 4 || sw < 8 || sh < 8) return null;
  const ctx = new OffscreenCanvas(bw, bh).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, bx, by, bw, bh, 0, 0, bw, bh);
  const rgba = cv.matFromImageData(ctx.getImageData(0, 0, bw, bh));
  const gray = new cv.Mat(), out = new cv.Mat();
  const src = cv.matFromArray(3, 1, cv.CV_32FC2, corners.flatMap(([x, y]) => [x - bx, y - by]));
  const dst = cv.matFromArray(3, 1, cv.CV_32FC2, flip ? [sw, sh, 0, sh, sw, 0] : [0, 0, sw, 0, 0, sh]);
  const m = cv.getAffineTransform(src, dst);
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.warpAffine(gray, out, m, new cv.Size(sw, sh), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    if (invert) cv.bitwise_not(out, out);
    return out;
  } catch (error) {
    out.delete();
    throw error;
  } finally {
    [rgba, gray, src, dst, m].forEach((mat) => mat.delete());
  }
}

// ---- characters --------------------------------------------------------------------------------

// Candidate character sequences of a strip (text bright), best line first: [[{ x, y, w, h }], ...].
// binarize: "otsu" (global; clean references, dark tabs) or "adaptive" (brighter than the local
// surrounding; grey foil tabs, where a global threshold separates tab and surrounding instead).
// cutBoxes: stop at filled boxes (clean reference images); when reading photos the whole line is
// split, because touching digits look like filled boxes there, and decode() skips what is around the
// number anyway.
function characters(cv, strip, binarize = "otsu", maxLines = 3, cutBoxes = false) {
  const bin = new cv.Mat(), labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
  try {
    if (binarize === "adaptive") {
      const block = 2 * Math.round(TEXT * 1.2) + 1;
      cv.adaptiveThreshold(strip, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, -8);
    } else {
      cv.threshold(strip, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    }
    const n = cv.connectedComponentsWithStats(bin, labels, stats, centroids, 8, cv.CV_32S);
    const s = stats.data32S;
    const parts = [];
    for (let i = 1; i < n; i++) {
      const [x, y, w, h, area] = [s[i * 5], s[i * 5 + 1], s[i * 5 + 2], s[i * 5 + 3], s[i * 5 + 4]];
      if (h < TEXT * 0.3 || h > TEXT * 1.6) continue;
      parts.push({ x, y, w, h, fill: area / (w * h) });
    }
    // Text lines: parts of about the same height at the same vertical position (the row box from
    // findCorners is not always centred on the number, and art next to it can form a line too).
    const centreOf = (p) => p.y + p.h / 2;
    const sameLine = (p, q) => Math.abs(centreOf(q) - centreOf(p)) < p.h * 0.35 && q.h > p.h * 0.6 && q.h < p.h * 1.6;
    const lines = [];
    const taken = new Set();
    const anchors = parts.map((p) => ({ p, members: parts.filter((q) => sameLine(p, q)) })).sort((a, b) => b.members.length - a.members.length);
    for (const { p, members } of anchors) {
      if (taken.has(p) || members.length < 2) continue;
      members.forEach((q) => taken.add(q));
      const chars = splitLine(members.sort((a, b) => a.x - b.x), cutBoxes);
      if (chars.length >= 3) lines.push(chars);
      if (lines.length >= maxLines) break;
    }
    return lines;
  } finally {
    [bin, labels, stats, centroids].forEach((m) => m.delete());
  }
}

// One line of parts → characters (of the number only, if cutBoxes).
function splitLine(parts, cutBoxes) {
  const heights = parts.map((p) => p.h).sort((a, b) => a - b);
  const textH = heights[Math.floor(heights.length / 2)] || TEXT;
  const pitch = textH * 0.62;
  // Filled boxes (LK/SP before the number, rarity and year mark after it) end or precede the number.
  const isBox = (p) => p.fill > 0.62 && p.w > textH * 0.7;
  const chars = [];
  for (const p of parts) {
    if (cutBoxes && isBox(p)) {
      if (chars.length >= 3) break;
      chars.length = 0; // a prefix box (or junk before it): the number starts after it
      continue;
    }
    if (p.w < textH * 0.12 || p.h < textH * 0.7) continue;
    // Touching characters: split by the usual character pitch.
    const count = Math.max(1, Math.round((p.w + textH * 0.1) / pitch));
    for (let k = 0; k < count; k++) chars.push({ x: p.x + (p.w * k) / count, y: p.y, w: p.w / count, h: p.h });
  }
  return chars;
}

// Character image → zero-mean, unit-length vector of GW × GH. The box keeps the character's
// proportions: a fixed width of 0.6 × height around its centre (stretching a narrow "1" to full
// width made it look like a "T").
export const CROP = { width: 0.6 }; // crop width around a character, × its height (see vectorOf)
function vectorOf(cv, strip, { x, y, w, h }) {
  const bw = Math.max(w, h * CROP.width);
  const left = Math.max(0, Math.floor(x + w / 2 - bw / 2)), top = Math.max(0, Math.floor(y));
  const rect = new cv.Rect(left, top,
    Math.max(1, Math.min(strip.cols - left, Math.ceil(bw))), Math.max(1, Math.min(strip.rows - top, Math.ceil(h))));
  const roi = strip.roi(rect), small = new cv.Mat();
  try {
    cv.resize(roi, small, new cv.Size(GW, GH), 0, 0, cv.INTER_AREA);
    const v = Float32Array.from(small.data);
    let mean = 0;
    for (const value of v) mean += value;
    mean /= v.length;
    let norm = 0;
    for (let i = 0; i < v.length; i++) { v[i] -= mean; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  } finally {
    roi.delete();
    small.delete();
  }
}

// ---- templates from the reference images --------------------------------------------------------

// Reference corner: the number starts after x ≈ 430 and sits in y ≈ 10–34 of the 600 × 838 image.
const REF_RECT = [380, 0, 220, 46];
const REF_TEXT = 14;

// Character models from reference images with a dark tab (bright text). Every character is
// sampled several times (blur and small shifts of its box, so the clean references look more like
// photos). Returns { chars: mean vector per character (correlation templates), lda: linear
// discriminant per character, counts, used, skipped }.
export async function buildTemplates(cv, variants, loadImage, { limit = 400, blurs = [0.6, 1.2, 2], shifts = [-1.5, 0, 1.5], shrink = 0.2, onProgress } = {}) {
  const samples = []; // { ch, v }
  let used = 0, skipped = 0;
  const pool = variants.filter((v) => /^[A-Z]+\d*-\d+$/.test(v.cardNo));
  // Spread over all sets, deterministic.
  const step = Math.max(1, Math.floor(pool.length / limit));
  for (let i = 0; i < pool.length && used + skipped < limit; i += step) {
    const variant = pool[i];
    const image = await loadImage(variant);
    const strip = stripFromRect(cv, image, REF_RECT, REF_TEXT, false);
    if (!strip) { skipped++; continue; }
    const soft = new cv.Mat();
    try {
      // Dark tab with bright text only: the text must be brighter than its surrounding.
      if (cv.mean(strip)[0] > 110) { skipped++; continue; }
      const key = keyOf(variant.cardNo);
      const chars = characters(cv, strip, "otsu", 1, true)[0] ?? [];
      if (chars.length !== key.length) { skipped++; continue; }
      for (const blur of blurs) {
        cv.GaussianBlur(strip, soft, new cv.Size(0, 0), blur);
        chars.forEach((box, k) => {
          for (const dx of shifts) samples.push({ ch: key[k], v: vectorOf(cv, soft, { ...box, x: box.x + dx }) });
        });
      }
      used++;
    } finally {
      strip.delete();
      soft.delete();
    }
    onProgress?.(used + skipped);
  }
  return { ...modelsOf(samples, shrink), used, skipped, referenceSamples: samples, shrink };
}

// Templates retrained with extra samples (e.g. characters of confidently read photo rows, from
// photoSamples()), together with the reference samples of `base`.
export function retrain(base, extra) {
  const models = modelsOf(base.referenceSamples.concat(extra), base.shrink);
  return { ...base, ...models };
}

// Character samples [{ ch, v }] of photo rows whose number is known (with the strip settings of the
// read: { invert, flip }), when the row splits into exactly the characters of the number.
export function photoSamples(cv, bitmap, row, cardNo, { invert, flip }) {
  const key = keyOf(cardNo);
  const strip = stripFromQuad(cv, bitmap, row.quad, invert, flip);
  if (!strip) return [];
  try {
    for (const chars of characters(cv, strip, "otsu", 3, true)) {
      if (chars.length === key.length) return chars.map((box, k) => ({ ch: key[k], v: vectorOf(cv, strip, box) }));
    }
    return [];
  } finally {
    strip.delete();
  }
}

// Mean vectors and a linear discriminant analysis (pooled covariance with shrinkage) from samples.
function modelsOf(samples, shrink) {
  const d = GW * GH;
  const labels = [...new Set(samples.map((s) => s.ch))].sort();
  const means = {}, counts = {};
  for (const ch of labels) { means[ch] = new Float64Array(d); counts[ch] = 0; }
  for (const { ch, v } of samples) { const m = means[ch]; for (let j = 0; j < d; j++) m[j] += v[j]; counts[ch]++; }
  for (const ch of labels) for (let j = 0; j < d; j++) means[ch][j] /= counts[ch];

  // Pooled within-class covariance (upper triangle, then mirrored).
  const cov = new Float64Array(d * d);
  const diff = new Float64Array(d);
  for (const { ch, v } of samples) {
    const m = means[ch];
    for (let j = 0; j < d; j++) diff[j] = v[j] - m[j];
    for (let a = 0; a < d; a++) {
      const da = diff[a];
      if (da === 0) continue;
      const row = a * d;
      for (let b = a; b < d; b++) cov[row + b] += da * diff[b];
    }
  }
  let trace = 0;
  for (let a = 0; a < d; a++) {
    for (let b = a; b < d; b++) { cov[a * d + b] /= samples.length; cov[b * d + a] = cov[a * d + b]; }
    trace += cov[a * d + a];
  }
  const ridge = (trace / d) * shrink;
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) cov[a * d + b] = cov[a * d + b] * (1 - shrink) + (a === b ? ridge : 0);

  // Cholesky: cov = L·Lᵀ, then W_c = cov⁻¹ μ_c and b_c = −½ μ_c·W_c.
  const L = new Float64Array(d * d);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = cov[i * d + j];
      for (let k = 0; k < j; k++) sum -= L[i * d + k] * L[j * d + k];
      L[i * d + j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / L[j * d + j];
    }
  }
  const solve = (rhs) => {
    const y = new Float64Array(d), x = new Float64Array(d);
    for (let i = 0; i < d; i++) { let sum = rhs[i]; for (let k = 0; k < i; k++) sum -= L[i * d + k] * y[k]; y[i] = sum / L[i * d + i]; }
    for (let i = d - 1; i >= 0; i--) { let sum = y[i]; for (let k = i + 1; k < d; k++) sum -= L[k * d + i] * x[k]; x[i] = sum / L[i * d + i]; }
    return x;
  };
  const chars = {}, lda = {};
  for (const ch of labels) {
    const w = solve(means[ch]);
    let bias = 0;
    for (let j = 0; j < d; j++) bias -= 0.5 * means[ch][j] * w[j];
    lda[ch] = { w: Float32Array.from(w), b: bias };
    let norm = 0;
    for (const value of means[ch]) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    chars[ch] = Float32Array.from(means[ch], (value) => value / norm);
  }
  return { chars, lda, counts, samples: samples.length };
}

// ---- reading -------------------------------------------------------------------------------------

// Vocabulary for decode(): card numbers grouped by key length.
export function vocabulary(cardNumbers) {
  const list = [...cardNumbers].map((cardNo) => ({ cardNo, key: keyOf(cardNo) }));
  return { list };
}

// Reads one row. Returns { cardNo, text, cost, margin } or null.
export function readRow(cv, bitmap, row, templates, vocab, options = {}) {
  const o = { ...OCR_DEFAULTS, ...options };
  row = straighten(cv, bitmap, row);
  // Both text polarities (the finder's guess is not always right) and both orientations.
  const attempts = [[row.polarity === "dunkel", false], [row.polarity === "dunkel", true], [row.polarity !== "dunkel", false], [row.polarity !== "dunkel", true]];
  let best = null;
  for (const [invert, flip] of attempts) {
    const strip = stripFromQuad(cv, bitmap, row.quad, invert, flip);
    if (!strip) continue;
    try {
      for (const binarize of o.binarize) {
        for (const chars of characters(cv, strip, binarize, 3, o.cutBoxes)) {
          if (chars.length > 20) continue;
          // Per character: LDA scores (log-likelihood up to a constant) or template correlations
          // (times sharpness), turned into costs by the softmax below.
          const useLda = o.classifier === "lda" && templates.lda;
          const correlations = chars.map((box) => {
            const v = vectorOf(cv, strip, box);
            const result = {};
            for (const [ch, t] of Object.entries(useLda ? templates.lda : templates.chars)) {
              const w = useLda ? t.w : t;
              let dot = useLda ? t.b : 0;
              for (let j = 0; j < v.length; j++) dot += v[j] * w[j];
              result[ch] = useLda ? dot * o.ldaScale : dot * o.sharpness;
            }
            return result;
          });
          const text = correlations.map((s) => Object.entries(s).sort((a, b) => b[1] - a[1])[0][0]).join("");
          // Cost of reading a character as ch: −log of its softmax probability. (Separate softmaxes
          // for letters and digits were tried: same number of correct reads, but false hits decoded
          // far more easily.)
          const scores = correlations.map((s) => {
            const max = Math.max(...Object.values(s));
            let sum = 0;
            for (const value of Object.values(s)) sum += Math.exp(value - max);
            const cost = {};
            for (const [ch, value] of Object.entries(s)) cost[ch] = -(value - max) + Math.log(sum);
            return cost;
          });
          const decoded = decode(scores, vocab, o);
          if (o.trace) o.trace.push({ invert, flip, binarize, text, ...decoded });
          if (decoded && (!best || decoded.cost < best.cost)) best = { ...decoded, text, flip, invert, binarize };
        }
      }
    } finally {
      strip.delete();
    }
  }
  return best;
}

// The row box from findCorners can be tilted more or less than the text (rarity box and year mark
// pull it): measure the slope of the character bottoms in a first strip and turn the box to match.
function straighten(cv, bitmap, row) {
  for (const invert of [row.polarity === "dunkel", row.polarity !== "dunkel"]) {
    const strip = stripFromQuad(cv, bitmap, row.quad, invert, false);
    if (!strip) return row;
    let chars;
    try {
      chars = characters(cv, strip, "otsu", 1)[0];
    } finally {
      strip.delete();
    }
    if (!chars || chars.length < 4) continue;
    // Least squares through the bottoms of the characters (strip pixels).
    const xs = chars.map((c) => c.x + c.w / 2), ys = chars.map((c) => c.y + c.h);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const angle = Math.atan2(sxy, sxx || 1);
    if (Math.abs(angle) < 0.015) return row;
    // Turn the quad around its centre by the angle (strip x runs along the quad's top edge).
    const cx = row.quad.reduce((a, q) => a + q[0], 0) / 4, cy = row.quad.reduce((a, q) => a + q[1], 0) / 4;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const quad = row.quad.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
    return { ...row, quad };
  }
  return row;
}

// Aligns the character scores with every card number (edit distance, substitution cost from the
// template correlation). The number may sit anywhere in the read line: characters before it (LK/SP
// box, art) and after it (rarity box, year mark) are free, gaps inside it cost gapCost.
// Returns the best { cardNo, cost, margin } or null.
function decode(scores, vocab, o) {
  const n = scores.length;
  let best = null, second = null;
  for (const { cardNo, key } of vocab.list) {
    const L = key.length;
    if (L > n + 2 || L < n * o.minCoverage) continue;
    // d[i][j]: cost of key[0..j) aligned so that it ends at read character i; the start is free.
    let prev = new Float32Array(L + 1);
    for (let j = 1; j <= L; j++) prev[j] = j * o.gapCost;
    let end = n <= o.maxTrail ? prev[L] : Infinity;
    for (let i = 1; i <= n; i++) {
      const cur = new Float32Array(L + 1);
      cur[0] = i <= o.maxLead ? 0 : i * o.gapCost; // skipping a few characters before the number is free
      const s = scores[i - 1];
      for (let j = 1; j <= L; j++) {
        const sub = prev[j - 1] + Math.min(s[key[j - 1]] ?? o.gapCost * 2, o.gapCost * 2);
        cur[j] = Math.min(sub, prev[j] + o.gapCost, cur[j - 1] + o.gapCost);
      }
      if (n - i <= o.maxTrail && cur[L] < end) end = cur[L]; // a few characters after it are free too
      prev = cur;
    }
    const cost = end / L;
    if (!best || cost < best.cost) { second = best; best = { cardNo, cost }; }
    else if (!second || cost < second.cost) second = { cardNo, cost };
  }
  if (!best) return null;
  const margin = second ? second.cost - best.cost : 1;
  const limit = keyOf(best.cardNo).length <= o.shortKey ? Math.min(o.maxCost, o.shortMaxCost) : o.maxCost;
  if (best.cost > limit || margin < o.minMargin) return { cardNo: null, cost: best.cost, margin, guess: best.cardNo };
  return { cardNo: best.cardNo, cost: best.cost, margin };
}

// For dev/mass-eval.html: the strip of a row as ImageData plus its character boxes (both orientations).
export function inspectRow(cv, bitmap, row) {
  return [false, true].map((flip) => {
    const strip = stripFromQuad(cv, bitmap, row.quad, row.polarity === "dunkel", flip);
    if (!strip) return null;
    try {
      const rgba = new cv.Mat();
      cv.cvtColor(strip, rgba, cv.COLOR_GRAY2RGBA);
      const image = new ImageData(new Uint8ClampedArray(rgba.data), strip.cols, strip.rows);
      rgba.delete();
      return { image, chars: characters(cv, strip, "otsu", 1)[0] ?? [], flip };
    } finally {
      strip.delete();
    }
  });
}

// ---- learning from photos -------------------------------------------------------------------------

// Character samples of a row whose number is known (e.g. read with high confidence): adds them to
// `sums`/`counts` when the row splits into exactly as many characters as the number has.
export function addSamples(cv, bitmap, row, cardNo, { invert, flip }, sums, counts) {
  const key = keyOf(cardNo);
  const strip = stripFromQuad(cv, bitmap, row.quad, invert, flip);
  if (!strip) return false;
  try {
    const chars = characters(cv, strip, "otsu", 1, true)[0] ?? [];
    if (chars.length !== key.length) return false;
    chars.forEach((box, k) => {
      const v = vectorOf(cv, strip, box);
      sums[key[k]] ??= new Float32Array(GW * GH);
      for (let j = 0; j < v.length; j++) sums[key[k]][j] += v[j];
      counts[key[k]] = (counts[key[k]] ?? 0) + 1;
    });
    return true;
  } finally {
    strip.delete();
  }
}

// Templates = normalised mix of the reference templates and the photo samples (weight per sample).
export function mergeTemplates(base, sums, counts, referenceWeight = 20) {
  const chars = {}, merged = {};
  for (const ch of new Set([...Object.keys(base.chars), ...Object.keys(sums)])) {
    const v = new Float32Array(GW * GH);
    if (base.chars[ch]) for (let j = 0; j < v.length; j++) v[j] += base.chars[ch][j] * referenceWeight;
    if (sums[ch]) for (let j = 0; j < v.length; j++) v[j] += sums[ch][j];
    let norm = 0;
    for (const value of v) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    chars[ch] = v.map((value) => value / norm);
    merged[ch] = (base.counts[ch] ?? 0) + (counts[ch] ?? 0);
  }
  return { ...base, chars, counts: merged };
}

// Internals for experiments in the console (dev/mass-eval.html).
export const _internals = { characters, stripFromQuad, splitLine, vectorOf };
