// Mass scan in the background: finds and reads the card numbers in one photo (mass-read.js,
// mass-ocr.js). Classic worker because OpenCV.js is a UMD script; the modules come in by import().
//
// Requests:  { id, type: "init", model, cardNumbers }   model = data/ocr-model.json
//            { id, type: "read", photo: ImageBitmap }     (transferred and closed)
// Responses: { id, cards: [{ quad, cardNo, cost, text, flip }], ms } (flip: the card lies upside down in the picture) or { id, error }

importScripts("../vendor/opencv-4.12.0/opencv.js");

let context = null;

// OpenCV.js is ready once the runtime has started. Never return or await the module itself: it has
// a then() that resolves with itself, which would loop forever (see CLAUDE.md).
const cvReady = new Promise((resolve) => {
  const module = self.cv;
  if (module.Mat) resolve();
  else module.onRuntimeInitialized = resolve;
});
const modules = Promise.all([import("./mass-read.js"), import("./mass-ocr.js")]);

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await cvReady;
    const [read, ocr] = await modules;
    if (type === "init") {
      context = {
        cv: self.cv,
        templates: ocr.importModel(data.model),
        vocab: ocr.vocabulary(new Set(data.cardNumbers)),
        options: {},
      };
      self.postMessage({ id });
    } else if (type === "read") {
      if (!context) throw new Error("Massenscan nicht initialisiert");
      const t0 = performance.now();
      const corners = await read.readCorners(data.photo, context);
      data.photo.close();
      const cards = corners.map(({ quad, cardNo, cost, text, flip }) => ({ quad, cardNo, cost, text, flip: !!flip }));
      self.postMessage({ id, cards, ms: performance.now() - t0 });
    }
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
