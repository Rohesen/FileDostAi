// Runs the background remover's model off the page's thread, so the page stays smooth.
// Module worker: ONNX Runtime Web (WebAssembly only) and the "silueta" model (a small U²-Net),
// both served from /static/vendor/bg-remove/. Nothing leaves the device.

import * as ort from "/static/vendor/bg-remove/ort.wasm.min.mjs";

const BASE = "/static/vendor/bg-remove/";
// The 44 MB model is stored in two parts so every file stays small enough for GitHub and copying.
const MODEL_PARTS = [`${BASE}silueta.onnx.part0`, `${BASE}silueta.onnx.part1`];
const MODEL_BYTES = 44173029;
const SIZE = 320;                     // the model looks at a 320×320 copy of the picture
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

ort.env.wasm.wasmPaths = BASE;
ort.env.wasm.numThreads = 1;          // threads need cross-origin isolation, which the site doesn't use
ort.env.wasm.proxy = false;

let session = null;

async function download() {
  const out = new Uint8Array(MODEL_BYTES);
  let got = 0, last = 0;
  for (const url of MODEL_PARTS) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed (${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) throw new Error("model download was longer than expected");
      out.set(value, got);
      got += value.length;
      if (got - last > 512 * 1024) { last = got; postMessage({ type: "progress", received: got, total: MODEL_BYTES }); }
    }
  }
  if (got !== MODEL_BYTES) throw new Error("model download was cut short");
  return out;
}

async function load() {
  if (!session) {
    const bytes = await download();
    postMessage({ type: "progress", received: 1, total: 1, preparing: true });
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  return session;
}

/** rgba: SIZE×SIZE pixels. Returns a SIZE×SIZE Uint8Array mask (255 = keep). */
async function mask(rgba) {
  const s = await load();
  const n = SIZE * SIZE;
  let max = 1;
  for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
  const x = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) x[c * n + p] = (rgba[p * 4 + c] / max - MEAN[c]) / STD[c];
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, SIZE, SIZE]) });
  const y = out[s.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
  const m = new Uint8Array(n);
  if (hi - lo > 1e-4) for (let i = 0; i < n; i++) m[i] = Math.round(((y[i] - lo) / (hi - lo)) * 255);
  for (const t of Object.values(out)) t.dispose && t.dispose();
  return m;
}

onmessage = async (e) => {
  const { id, type, rgba } = e.data;
  try {
    if (type === "load") { await load(); postMessage({ id, type: "ready" }); return; }
    const m = await mask(new Uint8ClampedArray(rgba));
    postMessage({ id, type: "mask", mask: m.buffer }, [m.buffer]);
  } catch (err) {
    postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};
