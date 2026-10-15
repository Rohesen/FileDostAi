// Finds faces for Blur Faces, off the page's thread. Module worker.
// UltraFace RFB-640 (MIT, 1.6 MB) on ONNX Runtime Web (the copy the background remover uses).

import * as ort from "/static/vendor/bg-remove/ort.wasm.min.mjs";

ort.env.wasm.wasmPaths = "/static/vendor/bg-remove/";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const MODEL = "/static/vendor/faces/ultraface-640.onnx";
const W = 640, H = 480;
let session = null;

async function load() {
  if (!session) {
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error(`model download failed (${res.status})`);
    session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"] });
  }
  return session;
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter || 1);
}

/** rgba: a 640×480 copy of the picture. Returns [{ box: [x0, y0, x1, y1] as 0-1 fractions, score }]. */
async function faces(rgba, threshold) {
  const s = await load();
  const n = W * H;
  const x = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    x[p] = (rgba[p * 4] - 127) / 128;
    x[n + p] = (rgba[p * 4 + 1] - 127) / 128;
    x[2 * n + p] = (rgba[p * 4 + 2] - 127) / 128;
  }
  const out = await s.run({ input: new ort.Tensor("float32", x, [1, 3, H, W]) });
  const scores = out.scores.data, boxes = out.boxes.data;
  const found = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const sc = scores[i * 2 + 1];
    if (sc >= threshold) found.push({ score: sc, box: Array.from(boxes.subarray(i * 4, i * 4 + 4)) });
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of found) if (keep.every((k) => iou(k.box, f.box) < 0.3)) keep.push(f);
  return keep.map((f) => ({ score: f.score, box: f.box.map((v) => Math.min(1, Math.max(0, v))) }));
}

onmessage = async (e) => {
  const { id, rgba, threshold } = e.data;
  try {
    postMessage({ id, type: "faces", faces: await faces(new Uint8ClampedArray(rgba), threshold || 0.7) });
  } catch (err) {
    postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};
