// Runs the background remover's model off the page's thread, so the page stays smooth.
// Module worker: ONNX Runtime Web (WebAssembly only) and two models (U²-Net "silueta" and ISNet),
// all served from /static/vendor/bg-remove/. Nothing leaves the device.

import * as ort from "/static/vendor/bg-remove/ort.wasm.min.mjs";

const BASE = "/static/vendor/bg-remove/";
// Two models. "silueta" (a small U²-Net, 44 MB) looks at a 320×320 copy and is good at the whole
// shape; ISNet (46 MB, weights stored as 8-bit) looks at 1024×1024 and is good at telling the
// subject from things behind it. Each is stored in two parts so every file stays under 30 MB.
const MODELS = {
  silueta: { parts: [`${BASE}silueta.onnx.part0`, `${BASE}silueta.onnx.part1`], bytes: 44173029 },
  isnet: { parts: [`${BASE}isnet.onnx.part0`, `${BASE}isnet.onnx.part1`], bytes: 46734856 },
};
const SMALL = 320, BIG = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

ort.env.wasm.wasmPaths = BASE;
ort.env.wasm.numThreads = 1;          // threads need cross-origin isolation, which the site doesn't use
ort.env.wasm.proxy = false;

const sessions = {};

async function download(names) {
  const total = names.reduce((n, k) => n + MODELS[k].bytes, 0);
  let got = 0, last = 0;
  const out = {};
  for (const k of names) {
    const buf = new Uint8Array(MODELS[k].bytes);
    let at = 0;
    for (const url of MODELS[k].parts) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`model download failed (${res.status})`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > buf.length) throw new Error("model download was longer than expected");
        buf.set(value, at);
        at += value.length; got += value.length;
        if (got - last > 512 * 1024) { last = got; postMessage({ type: "progress", received: got, total }); }
      }
    }
    if (at !== buf.length) throw new Error("model download was cut short");
    out[k] = buf;
  }
  return out;
}

async function load(names) {
  const need = names.filter((k) => !sessions[k]);
  if (need.length) {
    const bytes = await download(need);
    postMessage({ type: "progress", received: 1, total: 1, preparing: true });
    for (const k of need) {
      sessions[k] = await ort.InferenceSession.create(bytes[k], { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      delete bytes[k];
    }
  }
}

/** Runs one model on a size×size picture; returns its answer scaled to 0..1. */
async function infer(name, rgba, size, mean, std) {
  const s = sessions[name];
  const n = size * size;
  let max = 1;
  for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
  const x = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) x[c * n + p] = (rgba[p * 4 + c] / max - mean[c]) / std[c];
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, size, size]) });
  const y = out[s.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
  const m = new Float32Array(n);
  if (hi - lo > 1e-4) for (let i = 0; i < n; i++) m[i] = (y[i] - lo) / (hi - lo);
  for (const t of Object.values(out)) t.dispose && t.dispose();
  return m;
}

/** Bilinear resize of a square 0..1 map. */
function upscale(m, from, to) {
  const out = new Float32Array(to * to), r = (from - 1) / (to - 1);
  for (let y = 0; y < to; y++) {
    const fy = y * r, y0 = Math.floor(fy), y1 = Math.min(from - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < to; x++) {
      const fx = x * r, x0 = Math.floor(fx), x1 = Math.min(from - 1, x0 + 1), wx = fx - x0;
      const a = m[y0 * from + x0] * (1 - wx) + m[y0 * from + x1] * wx;
      const b = m[y1 * from + x0] * (1 - wx) + m[y1 * from + x1] * wx;
      out[y * to + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

/** Drops loose specks: keeps only solid areas at least 4% the size of the biggest one. */
function dropSpecks(m, size) {
  const n = size * size, label = new Int32Array(n), areas = [0];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (m[i] < 0.5 || label[i]) continue;
    const id = areas.length;
    let top = 0, area = 0;
    stack[top++] = i; label[i] = id;
    while (top) {
      const p = stack[--top]; area++;
      const x = p % size, y = (p - x) / size;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const q = ny * size + nx;
        if (!label[q] && m[q] >= 0.5) { label[q] = id; stack[top++] = q; }
      }
    }
    areas.push(area);
  }
  const big = areas.reduce((a, b) => Math.max(a, b), 0);
  if (!big) return m;
  const keep = areas.map((a) => a >= big * 0.04);
  // Pixels next to a kept area keep their soft edge; everything else that is loose goes.
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (label[i] && keep[label[i]]) near[i] = 1;
  for (let pass = 0; pass < 3; pass++) {
    const prev = near.slice();
    for (let i = 0; i < n; i++) {
      if (prev[i]) continue;
      const x = i % size;
      if ((x > 0 && prev[i - 1]) || (x < size - 1 && prev[i + 1]) || (i >= size && prev[i - size]) || (i < n - size && prev[i + size])) near[i] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (!near[i]) m[i] = 0;
  return m;
}

/** small: 320×320 pixels, big: 1024×1024 pixels (or null for the quick mode).
    Returns a Uint8Array mask (255 = keep) and its side. */
async function mask(small, big) {
  const names = big ? ["silueta", "isnet"] : ["silueta"];
  await load(names);
  const a = await infer("silueta", small, SMALL, MEAN, STD);
  if (!big) {
    const m = dropSpecks(a, SMALL), out = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) out[i] = Math.round(m[i] * 255);
    return { m: out, size: SMALL };
  }
  const b = await infer("isnet", big, BIG, [0.5, 0.5, 0.5], [1, 1, 1]);
  const s = upscale(a, SMALL, BIG);
  // The small model finds the whole subject; ISNet vetoes what it is sure is background
  // (like a balloon or chair right behind a shoulder) without cutting thin parts it is unsure of.
  for (let i = 0; i < s.length; i++) s[i] *= Math.min(1, b[i] / 0.3);
  const m = dropSpecks(s, BIG), out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = Math.round(m[i] * 255);
  return { m: out, size: BIG };
}

onmessage = async (e) => {
  const { id, type, rgba } = e.data;
  try {
    if (type === "load") { await load(["silueta", "isnet"]); postMessage({ id, type: "ready" }); return; }
    const { m, size } = await mask(new Uint8ClampedArray(rgba), e.data.big ? new Uint8ClampedArray(e.data.big) : null);
    postMessage({ id, type: "mask", mask: m.buffer, size }, [m.buffer]);
  } catch (err) {
    postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};
