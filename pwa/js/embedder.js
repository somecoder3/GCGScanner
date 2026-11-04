// Turns an image region into a normalized 1280-dim feature vector (MobileNetV2 without classifier).
// Reference index, eval and scanner all go through this one function, so preprocessing is identical.

const ORT_DIR = new URL("../vendor/onnxruntime-web-1.30.0/", import.meta.url).href;
const MODEL_URL = new URL("../model/mobilenetv2-features.onnx", import.meta.url).href;

export const INPUT_SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Reference images have transparent rounded corners; fill them the same way for every input.
const BACKGROUND = "#808080";

// WebGPU was about twice as fast as wasm on the test phone, so it is the default wherever available.
export const DEFAULT_BACKEND = self.navigator?.gpu ? "webgpu" : "wasm";

async function createSession(backend) {
  const ort = await import(ORT_DIR + (backend === "webgpu" ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
  ort.env.wasm.wasmPaths = ORT_DIR;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [backend] });
  return { ort, session };
}

export async function createEmbedder({ backend = DEFAULT_BACKEND } = {}) {
  let ort, session;
  try {
    ({ ort, session } = await createSession(backend));
  } catch (error) {
    // No usable GPU (old browser, blocklisted driver): fall back to the CPU backend instead of failing.
    if (backend !== "webgpu") throw error;
    console.warn("WebGPU nicht verfügbar, nutze wasm", error);
    backend = "wasm";
    ({ ort, session } = await createSession(backend));
  }

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;

  // RGBA pixels (INPUT_SIZE²) → normalized model input at `offset` in `target`.
  function fill(target, offset, data) {
    for (let i = 0; i < plane; i++) {
      target[offset + i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
      target[offset + plane + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      target[offset + 2 * plane + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
  }

  async function run(data, count) {
    const tensor = new ort.Tensor("float32", data, [count, 3, INPUT_SIZE, INPUT_SIZE]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const all = output[session.outputNames[0]].data;
    const dim = all.length / count;
    return [...Array(count)].map((_, n) => {
      const vector = Float32Array.from(all.subarray(n * dim, (n + 1) * dim));
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
      return vector;
    });
  }

  // source: anything drawImage accepts; region: [x, y, w, h] in source pixels (default: whole source)
  async function embed(source, region) {
    const [sx, sy, sw, sh] = region ?? [0, 0, source.width ?? source.videoWidth, source.height ?? source.videoHeight];
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, INPUT_SIZE, INPUT_SIZE);
    fill(input, 0, ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data);
    return (await run(input, 1))[0];
  }

  // Several ready cut-outs (RGBA ArrayBuffers of INPUT_SIZE², e.g. from the detector) in one model run.
  async function embedPixels(buffers) {
    if (!buffers.length) return [];
    const batch = new Float32Array(buffers.length * 3 * plane);
    buffers.forEach((buffer, n) => fill(batch, n * 3 * plane, new Uint8ClampedArray(buffer)));
    return run(batch, buffers.length);
  }

  return { embed, embedPixels, backend, threads: ort.env.wasm.numThreads };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot load ${url}`));
    image.src = url;
  });
}
