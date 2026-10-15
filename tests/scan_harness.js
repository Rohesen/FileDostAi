// Runs the Scan to PDF image core (static/scan-tool.js) under Node, without a browser.
//
//   node tests/scan_harness.js detect IN.rgba W H              -> JSON { corners, confidence }
//   node tests/scan_harness.js warp IN.rgba W H CORNERS_JSON FILTER OUT.rgba MAXEDGE
//        -> writes the straightened, filtered RGBA and prints JSON { w, h }
// CORNERS_JSON is [[x,y] x4] in pixels of the input.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "static", "scan-tool.js"), "utf8");
const ScanTool = new Function(`${src}\nreturn ScanTool;`)();
const Core = ScanTool._core;

async function main() {
  const [cmd, file, ws, hs, ...rest] = process.argv.slice(2);
  const w = Number(ws), h = Number(hs);
  const rgba = new Uint8ClampedArray(fs.readFileSync(file));
  if (cmd === "detect") {
    const t0 = Date.now();
    const r = Core.detect(rgba, w, h);
    console.log(JSON.stringify({ ...r, ms: Date.now() - t0 }));
    return;
  }
  if (cmd === "warp") {
    const [cornersJson, filter, out, maxEdgeS] = rest;
    const q = JSON.parse(cornersJson);
    let { W, H } = Core.docSize(q, w, h, false);
    const s = Math.min(1, Number(maxEdgeS || 2500) / Math.max(W, H));
    W = Math.round(W * s);
    H = Math.round(H * s);
    const data = await Core.warp(rgba, w, h, q, W, H, () => undefined);
    await Core.applyFilter(data, W, H, filter, () => undefined);
    fs.writeFileSync(out, Buffer.from(data.buffer));
    console.log(JSON.stringify({ w: W, h: H }));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
