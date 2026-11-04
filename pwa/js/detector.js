// Page side of the card detector: runs detector-worker.js (OpenCV.js, ~10 MB, loaded on first use)
// so finding and cutting out cards does not block the page.

export function createDetector() {
  const worker = new Worker(new URL("./detector-worker.js", import.meta.url));
  const pending = new Map();
  let nextId = 0, failed = null;

  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };
  worker.onerror = (event) => {
    // The worker is unusable from now on (e.g. OpenCV.js not loadable): fail this and every later call.
    failed = new Error(event.message || "Kartenerkennung konnte nicht geladen werden");
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
  };

  // source: video, canvas or image; region: [x, y, w, h] to search only there (default: everything).
  // Resolves to { cards: [{ quad, pixels, flipped }], ms }, quads in source pixels.
  async function detect(source, options, region) {
    if (failed) throw failed;
    const [x, y, w, h] = region?.map(Math.round) ?? [];
    const frame = region ? await createImageBitmap(source, x, y, w, h) : await createImageBitmap(source);
    const id = nextId++;
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, frame, options }, [frame]);
    });
    if (region) for (const card of result.cards) card.quad = card.quad.map(([qx, qy]) => [qx + x, qy + y]);
    return result;
  }

  return { detect, terminate: () => worker.terminate() };
}
