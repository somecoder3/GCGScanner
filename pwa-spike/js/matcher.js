// Nearest-neighbour search over the reference embeddings (cosine similarity, brute force).

export async function loadIndex() {
  const base = new URL("../data/", import.meta.url);
  const [variants, meta, buffer] = await Promise.all([
    fetch(new URL("variants.json", base)).then((r) => r.json()),
    fetch(new URL("embeddings.json", base)).then((r) => {
      if (!r.ok) throw new Error("Kein Referenz-Index gefunden. Bitte zuerst build-index.html ausführen.");
      return r.json();
    }),
    fetch(new URL("embeddings.bin", base)).then((r) => r.arrayBuffer()),
  ]);
  if (meta.ids.length !== variants.length || meta.ids.some((id, i) => id !== variants[i].id)) {
    throw new Error("Referenz-Index passt nicht zur Kartenliste. Bitte build-index.html erneut ausführen.");
  }
  return { variants, dim: meta.dim, vectors: new Float32Array(buffer) };
}

// Returns the k best variants as [{ variant, index, score }], best first.
export function search(index, query, k = 5) {
  const { variants, dim, vectors } = index;
  const best = [];
  for (let row = 0; row < variants.length; row++) {
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
