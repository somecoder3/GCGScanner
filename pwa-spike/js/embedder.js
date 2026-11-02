// Turns an image region into a normalized 1280-dim feature vector (MobileNetV2 without classifier).
// Reference index, eval and scanner all go through this one function, so preprocessing is identical.

const ORT_DIR = new URL("../vendor/onnxruntime-web-1.30.0/", import.meta.url).href;
const MODEL_URL = new URL("../model/mobilenetv2-features.onnx", import.meta.url).href;

export const INPUT_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Reference images have transparent rounded corners; fill them the same way for every input.
const BACKGROUND = "#808080";

export async function createEmbedder({ backend = "wasm" } = {}) {
  const ort = await import(ORT_DIR + (backend === "webgpu" ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
  ort.env.wasm.wasmPaths = ORT_DIR;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [backend] });

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;

  // source: anything drawImage accepts; region: [x, y, w, h] in source pixels (default: whole source)
  async function embed(source, region) {
    const [sx, sy, sw, sh] = region ?? [0, 0, source.width ?? source.videoWidth, source.height ?? source.videoHeight];
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, INPUT_SIZE, INPUT_SIZE);
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    for (let i = 0; i < plane; i++) {
      input[i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
      input[plane + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      input[2 * plane + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    const tensor = new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const vector = Float32Array.from(output[session.outputNames[0]].data);
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }

  return { embed, backend, threads: ort.env.wasm.numThreads };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot load ${url}`));
    image.src = url;
  });
}
