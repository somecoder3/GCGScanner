// Removes the "SAMPLE" watermark off the page's main thread (build-index.html, eval.html). OpenCV.js on
// the main thread froze the page ("Page Unresponsive") for long runs; here only the worker is busy.
// Message in:  { id, url, options }  (options: see cleanImage in watermark.js)
// Message out: { id, image: ImageData } or { id, error }
importScripts("../vendor/opencv-4.12.0/opencv.js");

const ready = (async () => {
  const { loadMasks, cleanImage, openCv, W, H } = await import("./watermark.js");
  const [cv, masks] = await Promise.all([openCv(), loadMasks()]);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return { cv, masks, cleanImage, canvas, ctx, W, H };
})();

async function fetchBitmap(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return await createImageBitmap(await response.blob());
    } catch (error) {
      // The dev server occasionally drops a request under load; try again.
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

self.onmessage = async ({ data: { id, url, options } }) => {
  try {
    const { cv, masks, cleanImage, ctx, W, H } = await ready;
    const bitmap = await fetchBitmap(url);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close();
    const methodName = options?.method;
    const image = cleanImage(ctx.getImageData(0, 0, W, H), masks, cv, {
      ...options,
      method: methodName ? cv[methodName] : undefined,
    });
    self.postMessage({ id, image }, [image.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
