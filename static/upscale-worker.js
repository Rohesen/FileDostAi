// Runs the Image Upscaler's model off the page's thread. Module worker.
// Real-ESRGAN general x4 v3 (BSD-3-Clause, 4.9 MB) on ONNX Runtime Web (the WebAssembly copy the
// background remover also uses). The page sends tiles; each comes back 4× larger.

import * as ort from "/static/vendor/bg-remove/ort.wasm.min.mjs";

ort.env.wasm.wasmPaths = "/static/vendor/bg-remove/";
ort.env.wasm.numThreads = 1;          // threads need cross-origin isolation, which the site doesn't use
ort.env.wasm.proxy = false;

const MODEL = "/static/vendor/upscale/realesr-general-x4v3.onnx";
let session = null;

async function load() {
  if (!session) {
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error(`model download failed (${res.status})`);
    session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  return session;
}

/** rgba: w×h tile. Returns the 4w×4h tile as RGBA (alpha 255). */
async function upscale(rgba, w, h) {
  const s = await load();
  const n = w * h;
  const x = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    x[p] = rgba[p * 4] / 255;
    x[n + p] = rgba[p * 4 + 1] / 255;
    x[2 * n + p] = rgba[p * 4 + 2] / 255;
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, h, w]) });
  const y = out[s.outputNames[0]].data;
  const W = w * 4, N = W * h * 4;
  const px = new Uint8ClampedArray(N * 4);
  for (let p = 0; p < N; p++) {
    px[p * 4] = y[p] * 255 + 0.5;
    px[p * 4 + 1] = y[N + p] * 255 + 0.5;
    px[p * 4 + 2] = y[2 * N + p] * 255 + 0.5;
    px[p * 4 + 3] = 255;
  }
  for (const t of Object.values(out)) t.dispose && t.dispose();
  return px;
}

onmessage = async (e) => {
  const { id, type, rgba, w, h } = e.data;
  try {
    if (type === "load") { await load(); postMessage({ id, type: "ready" }); return; }
    const px = await upscale(new Uint8ClampedArray(rgba), w, h);
    postMessage({ id, type: "tile", rgba: px.buffer }, [px.buffer]);
  } catch (err) {
    postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};
