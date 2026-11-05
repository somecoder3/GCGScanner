// Reference index: variant list + one normalized feature vector per variant, and nearest-neighbour
// search over it (cosine similarity, brute force).
//
// data/index.json names the current files by content hash, so the service worker can cache the large
// embeddings.bin forever and still pick up a rebuilt index. embeddings.bin holds int8 vectors
// (count x dim) followed by one float32 scale per vector: vector = int8 * scale.

const DATA = new URL("../data/", import.meta.url);

export async function loadIndex({ full = false } = {}) {
  const meta = await fetch(new URL("index.json", DATA), { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error("Kein Referenz-Index gefunden. Bitte zuerst dev/build-index.html ausführen.");
    return r.json();
  });
  if (meta.format !== "int8-scaled") throw new Error(`Unbekanntes Index-Format: ${meta.format}`);
  full &&= !!meta.full;
  const [variants, buffer] = await Promise.all([
    fetch(new URL(`variants.json?v=${meta.variants}`, DATA)).then((r) => r.json()),
    fetch(new URL(full ? `embeddings-full.bin?v=${meta.full}` : `embeddings.bin?v=${meta.embeddings}`, DATA)).then((r) => r.arrayBuffer()),
  ]);
  const { count, dim } = meta;
  const byId = new Map(variants.map((v, i) => [v.id, i]));
  if (full) {
    if (variants.length !== count || buffer.byteLength !== count * dim * 4) {
      throw new Error("Voller Index passt nicht zur Kartenliste. Bitte dev/build-index.html erneut ausführen.");
    }
    return { variants, dim, vectors: new Float32Array(buffer), byId, full };
  }
  if (variants.length !== count || buffer.byteLength !== count * dim + count * 4) {
    throw new Error("Referenz-Index passt nicht zur Kartenliste. Bitte dev/build-index.html erneut ausführen.");
  }
  const codes = new Int8Array(buffer, 0, count * dim);
  const scales = new Float32Array(buffer.slice(count * dim));
  const vectors = new Float32Array(count * dim);
  for (let row = 0; row < count; row++) {
    const scale = scales[row];
    for (let i = row * dim, end = i + dim; i < end; i++) vectors[i] = codes[i] * scale;
  }
  return { variants, dim, vectors, byId, full };
}

// Symmetric int8 quantization per vector, the inverse of the decoding in loadIndex().
export function quantize(vectors, count, dim) {
  const out = new Uint8Array(count * dim + count * 4);
  const codes = new Int8Array(out.buffer, 0, count * dim);
  const scales = new Float32Array(count);
  for (let row = 0; row < count; row++) {
    let max = 0;
    for (let i = row * dim; i < (row + 1) * dim; i++) max = Math.max(max, Math.abs(vectors[i]));
    const scale = max / 127 || 1;
    scales[row] = scale;
    for (let i = row * dim; i < (row + 1) * dim; i++) codes[i] = Math.round(vectors[i] / scale);
  }
  out.set(new Uint8Array(scales.buffer), count * dim);
  return out;
}

// Returns the k best variants as [{ variant, index, score }], best first. allowed (optional): one byte
// per variant, 0 = skip it (set filter, excluded cards).
export function search(index, query, k = 5, allowed = null) {
  const { variants, dim, vectors } = index;
  const best = [];
  for (let row = 0; row < variants.length; row++) {
    if (allowed && !allowed[row]) continue;
    let score = 0;
    const offset = row * dim;
    for (let i = 0; i < dim; i++) score += vectors[offset + i] * query[i];
    if (best.length < k || score > best[best.length - 1].score) {
      best.push({ variant: variants[row], index: row, score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

export function similarity({ dim, vectors }, rowA, rowB) {
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += vectors[rowA * dim + i] * vectors[rowB * dim + i];
  return dot;
}

// Reprints of the same artwork (Deck Build Box, Edition Beta, promos) differ only in tiny marks and
// cannot be told apart by the camera.
export const LOOK_ALIKE = 0.95;

// All variants with the same card number, best visual match to `variant` first, each flagged lookAlike.
export function siblings(index, variant) {
  const row = index.byId.get(variant.id);
  return index.variants
    .filter((other) => other.cardNo === variant.cardNo)
    .map((other) => {
      const score = similarity(index, row, index.byId.get(other.id));
      return { variant: other, score, lookAlike: other.id !== variant.id && score >= LOOK_ALIKE };
    })
    .sort((a, b) => b.score - a.score);
}
