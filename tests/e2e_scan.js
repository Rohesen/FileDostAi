// End-to-end check of Scan to PDF in Chromium against the real app:
// edge detection on synthetic phone photos, corner dragging, reorder, filters, page size,
// the PDF it saves (checked with PyMuPDF), a phone-width layout and the (fake) camera.
//
//   NODE_PATH=/path/to/node_modules node tests/e2e_scan.js
//
// Starts its own server on PORT (default 8782) unless BASE_URL is set.
// Env: CHROMIUM_PATH (browser binary), SHOTS_DIR (where screenshots go; default a temp dir).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || "8782";
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-scan-"));
const SHOTS = process.env.SHOTS_DIR || OUT;
const CHROME = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on("error", () => {
        if (Date.now() > end) reject(new Error("server did not start"));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

async function waitIdle(page, n, timeout = 30000) {
  await page.waitForFunction((count) => {
    const a = typeof ScanTool !== "undefined" && ScanTool._active;
    if (!a) return false;
    const s = a._state();
    return s.pages.length === count && s.pages.every((p) => (p.loaded && p.previewed && !p.busy) || p.error);
  }, n, { timeout }).catch(async (e) => {
    console.log("state at timeout:", JSON.stringify(await page.evaluate(() => ScanTool._active && ScanTool._active._state())));
    throw e;
  });
  return page.evaluate(() => ScanTool._active._state());
}

function cornerError(found, truth, w, h) {
  const diag = Math.hypot(w, h);
  return Math.max(...found.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]) / diag));
}

function analysePdf(file) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys, pymupdf, numpy as np
d = pymupdf.open(sys.argv[1])
out = []
for p in d:
    r = p.rect
    pix = p.get_pixmap(matrix=pymupdf.Matrix(600 / max(r.width, r.height), 600 / max(r.width, r.height)), colorspace=pymupdf.csGRAY)
    g = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).astype(float)
    h, w = g.shape
    white = float((g > 200).mean())
    dark = g < 110
    mid = dark[int(h * .1):int(h * .9), int(w * .15):int(w * .85)]
    rows = mid.mean(1)
    inked = rows > 0.004
    # Text bands: runs of inked rows separated by blank rows. A skewed page smears them together.
    bands, run = 0, 0
    for v in inked:
        if v: run += 1
        else:
            if run >= 2: bands += 1
            run = 0
    if run >= 2: bands += 1
    first = int(np.argmax(dark.mean(1) > 0.004)) / h
    out.append({"w": r.width, "h": r.height, "white": white, "ink": float(mid.mean()), "blank_rows": float(1 - inked.mean()),
                "bands": bands, "first_ink": first, "imgs": len(p.get_images())})
print(json.dumps(out))
`, file]).toString());
}

async function main() {
  execFileSync("python3", [path.join(__dirname, "scan_harness_fixtures.py"), OUT]);
  const truth = JSON.parse(fs.readFileSync(path.join(OUT, "corners.json"), "utf8"));
  const photoA = path.join(OUT, "photo_a.jpg"), photoB = path.join(OUT, "photo_b.jpg"), blank = path.join(OUT, "blank.jpg");

  let server = null;
  if (!process.env.BASE_URL) {
    server = spawn("python3", ["-m", "uvicorn", "main:app", "--app-dir", "server", "--port", PORT], { cwd: ROOT, stdio: "ignore" });
  }
  let browser, camBrowser;
  try {
    await waitForServer(`${BASE}/`);
    browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
    const errors = [];
    const watch = (pg) => {
      pg.on("pageerror", (e) => errors.push(e.message));
      pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    };

    // ---------------- desktop ----------------
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/scan-to-pdf`);
    await page.waitForSelector("#universalModal.open #scanCameraBtn");
    check("tool opens at /scan-to-pdf with camera button", await page.isVisible("#scanCameraBtn"));
    await page.screenshot({ path: path.join(SHOTS, "scan-empty-1280.png") });

    await page.setInputFiles("#fileInput", [photoA, photoB, blank]);
    let s = await waitIdle(page, 3);
    const [pa, pb, pblank] = s.pages;
    const errA = cornerError(pa.auto, truth["photo_a.jpg"], pa.w, pa.h);
    const errB = cornerError(pb.auto, truth["photo_b.jpg"], pb.w, pb.h);
    check("photo A: page edges found near the true corners", pa.found && errA < 0.015, `max error ${(errA * 100).toFixed(2)}% of diagonal, confidence ${pa.confidence.toFixed(2)}`);
    check("photo B (light table): page edges found", pb.found && errB < 0.015, `max error ${(errB * 100).toFixed(2)}%`);
    check("photo without a page falls back to the whole photo", !pblank.found &&
      cornerError(pblank.auto, [[0, 0], [pblank.w, 0], [pblank.w, pblank.h], [0, pblank.h]], pblank.w, pblank.h) < 1e-6);
    const lastCorners = await page.evaluate(() => ScanTool._lastCorners);
    check("ScanTool._lastCorners debug getter is set", Array.isArray(lastCorners) && lastCorners.length === 4);
    check("preview of photo A is A4-shaped (perspective-aware aspect)", Math.abs(pa.preview[1] / pa.preview[0] - Math.SQRT2) < 0.03, `${pa.preview.join("x")}`);
    check("pixel work runs in a Worker", s.worker === true);

    // Select photo A and look at it.
    await page.click('.scan-thumb:nth-child(1) .scan-thumb-btn');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, "scan-desktop-1280.png") });
    await page.locator(".scan").screenshot({ path: path.join(SHOTS, "scan-tool-1280.png") });

    // Drag a corner with the mouse.
    const before = (await page.evaluate(() => ScanTool._active._state())).pages[0].corners[0];
    const hb = await page.locator('.scan-handle[data-i="0"]').boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 25, { steps: 5 });
    const loupeShown = await page.isVisible("#scanLoupe");
    await page.screenshot({ path: path.join(SHOTS, "scan-drag-1280.png") });
    await page.mouse.up();
    const after = (await page.evaluate(() => ScanTool._active._state())).pages[0].corners[0];
    check("dragging a corner handle moves it (with magnifier)", after[0] > before[0] + 20 && after[1] > before[1] + 10 && loupeShown);
    await page.click('[data-act="auto"]');
    s = await waitIdle(page, 3);
    check("Auto puts the detected corners back", cornerError(s.pages[0].corners, s.pages[0].auto, pa.w, pa.h) < 1e-6);

    // Keyboard nudge.
    await page.focus('.scan-handle[data-i="2"]');
    await page.keyboard.press("ArrowLeft");
    s = await page.evaluate(() => ScanTool._active._state());
    check("arrow keys nudge a focused corner", s.pages[0].corners[2][0] < s.pages[0].auto[2][0]);
    await page.click('[data-act="auto"]');

    // Rotate cycles in quarter turns.
    for (let i = 0; i < 4; i++) await page.click('[data-act="rotate"]');
    s = await waitIdle(page, 3);
    check("rotate turns 90° per click (4 clicks = upright)", s.pages[0].rot === 0);
    await page.click('[data-act="rotate"]');
    s = await waitIdle(page, 3);
    check("rotated preview is landscape", s.pages[0].rot === 90 && s.pages[0].preview[0] > s.pages[0].preview[1]);
    for (let i = 0; i < 3; i++) await page.click('[data-act="rotate"]');

    // Reorder with the arrow buttons; the app's file list follows.
    await page.click('[data-act="right"]');
    let order = await page.evaluate(() => ScanTool._active._state().pages.map((p) => p.name));
    let appOrder = await page.evaluate(() => currentFiles.map((f) => f.name));
    check("move right reorders pages and the app's file list", order.join() === "photo_b.jpg,photo_a.jpg,blank.jpg" && appOrder.join() === order.join(), order.join());
    // Drag thumbnail 2 (photo_a) back in front of photo_b.
    await page.evaluate(() => document.querySelector("#scanStrip").scrollIntoView({ block: "center" }));
    const t2 = await page.locator(".scan-thumb").nth(1).boundingBox();
    const t1 = await page.locator(".scan-thumb").nth(0).boundingBox();
    await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2);
    await page.mouse.down();
    await page.mouse.move(t1.x + 10, t1.y + t1.height / 2, { steps: 8 });
    await page.mouse.up();
    order = await page.evaluate(() => ScanTool._active._state().pages.map((p) => p.name));
    check("dragging a thumbnail reorders pages", order.join() === "photo_a.jpg,photo_b.jpg,blank.jpg", order.join());

    // Delete the blank page via its thumbnail.
    await page.click('.scan-thumb:nth-child(3) .scan-thumb-del');
    await page.waitForFunction(() => ScanTool._active._state().pages.length === 2 && currentFiles.length === 2);
    check("deleting a page removes it from the app's file list too", (await page.evaluate(() => currentFiles.length)) === 2);

    // Filters: B&W on page 2, A4 paper for all.
    await page.click('.scan-thumb:nth-child(2) .scan-thumb-btn');
    await page.click('[data-filter="bw"]');
    await page.click('[data-paper="a4"]');
    s = await waitIdle(page, 2);
    check("filter and page size apply", s.pages[1].filter === "bw" && s.pages[0].filter === "enhanced" && s.paper === "a4");
    await page.screenshot({ path: path.join(SHOTS, "scan-bw-1280.png") });

    // Save.
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnExecute")]);
    const pdfPath = path.join(OUT, "scan.pdf");
    await download.saveAs(pdfPath);
    const info = analysePdf(pdfPath);
    check("PDF has one page per photo", info.length === 2, `${info.length} pages`);
    for (const [i, pg] of info.entries()) {
      const ratio = Math.max(pg.w, pg.h) / Math.min(pg.w, pg.h);
      check(`page ${i + 1}: A4 aspect`, Math.abs(ratio - Math.SQRT2) < 0.02, ratio.toFixed(3));
      check(`page ${i + 1}: mostly white paper`, pg.white > 0.85, `${(pg.white * 100).toFixed(1)}% white`);
      check(`page ${i + 1}: dark text in the middle`, pg.ink > 0.01, `${(pg.ink * 100).toFixed(1)}% ink`);
      check(`page ${i + 1}: text lines are horizontal (deskewed)`, pg.bands >= 14 && pg.blank_rows > 0.3, `${pg.bands} bands, ${(pg.blank_rows * 100).toFixed(0)}% blank rows`);
      check(`page ${i + 1}: right way up (heading near the top)`, pg.first_ink < 0.2, pg.first_ink.toFixed(2));
    }
    const size = fs.statSync(pdfPath).size;
    check("PDF is reasonably small", size < 3.5 * 1024 * 1024, `${(size / 1024).toFixed(0)} KB`);
    check("saved as Scan_<date>_<time>.pdf", /^Scan_\d{4}-\d\d-\d\d_\d{4}\.pdf$/.test(download.suggestedFilename()), download.suggestedFilename());
    check("filter label says Magic color", (await page.textContent('[data-filter="enhanced"]')).includes("Magic color"));
    // PDF size: Small makes a smaller file than Best.
    const sizeOf = async (preset) => {
      await page.click(`[data-size="${preset}"]`);
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnExecute")]);
      const f = path.join(OUT, `scan_${preset}.pdf`);
      await dl.saveAs(f);
      return fs.statSync(f).size;
    };
    const small = await sizeOf("small"), best = await sizeOf("best");
    check("PDF size Small is much smaller than Best", small < best * 0.75, `${(small / 1024).toFixed(0)} KB vs ${(best / 1024).toFixed(0)} KB`);
    await page.click('[data-size="standard"]');
    await ctx.close();

    // ---------------- phone width ----------------
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await mctx.newPage();
    watch(m);
    await m.goto(`${BASE}/scan-to-pdf`);
    await m.waitForSelector("#scanCameraBtn");
    await m.screenshot({ path: path.join(SHOTS, "scan-empty-390.png") });
    await m.setInputFiles("#fileInput", [photoA, blank]);
    await waitIdle(m, 2);
    await m.locator(".scan").scrollIntoViewIfNeeded();
    const noHScroll = await m.evaluate(() => {
      const card = document.querySelector("#universalModal .modal-body");
      return card.scrollWidth <= card.clientWidth + 1;
    });
    check("no horizontal overflow at 390px", noHScroll);
    await m.locator(".scan").screenshot({ path: path.join(SHOTS, "scan-result-390.png") });
    await m.tap('[data-view="edit"]');
    await m.waitForTimeout(150);
    const hbox = await m.locator('.scan-handle[data-i="0"]').boundingBox();
    check("corner handles are big touch targets", hbox && hbox.width >= 44 && hbox.height >= 44);
    await m.locator(".scan").screenshot({ path: path.join(SHOTS, "scan-corners-390.png") });
    // Touch-drag a handle.
    const ms0 = (await m.evaluate(() => ScanTool._active._state())).pages[1].corners[2];
    await m.evaluate(async () => {
      const h = document.querySelector('.scan-handle[data-i="2"]');
      const r = h.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const ev = (type, dx, dy) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", clientX: x + dx, clientY: y + dy, isPrimary: true }));
      ev("pointerdown", 0, 0); ev("pointermove", -30, -30); ev("pointermove", -60, -50); ev("pointerup", -60, -50);
    });
    const ms1 = (await m.evaluate(() => ScanTool._active._state())).pages[1].corners[2];
    check("touch pointer drags a corner", ms1[0] < ms0[0] - 40 && ms1[1] < ms0[1] - 30);
    await mctx.close();

    // ---------------- no Worker / OffscreenCanvas: runs on the page ----------------
    const fctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    await fctx.addInitScript(() => { delete window.OffscreenCanvas; });
    const f = await fctx.newPage();
    watch(f);
    await f.goto(`${BASE}/scan-to-pdf`);
    await f.waitForSelector("#scanCameraBtn");
    await f.setInputFiles("#fileInput", [photoA]);
    const fs1 = await waitIdle(f, 1);
    const [fdl] = await Promise.all([f.waitForEvent("download", { timeout: 60000 }), f.click("#btnExecute")]);
    const fpdf = path.join(OUT, "fallback.pdf");
    await fdl.saveAs(fpdf);
    const finfo = analysePdf(fpdf);
    check("without OffscreenCanvas it still detects and saves on the page", !fs1.worker && fs1.pages[0].found &&
      cornerError(fs1.pages[0].auto, truth["photo_a.jpg"], fs1.pages[0].w, fs1.pages[0].h) < 0.015 && finfo.length === 1 && finfo[0].bands >= 14);
    await fctx.close();

    check("no console errors (main contexts)", errors.length === 0, errors.slice(0, 3).join(" | "));

    // ---------------- fake camera ----------------
    camBrowser = await chromium.launch({
      ...(CHROME ? { executablePath: CHROME } : {}),
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });
    const cctx = await camBrowser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
    const c = await cctx.newPage();
    const camErrors = [];
    c.on("pageerror", (e) => camErrors.push(e.message));
    c.on("console", (msg) => { if (msg.type() === "error") camErrors.push(msg.text()); });
    await c.goto(`${BASE}/scan-to-pdf`);
    await c.click("#scanCameraBtn");
    await c.waitForSelector(".scan-cam.live", { timeout: 15000 });
    await c.waitForFunction(() => document.querySelector(".scan-cam video").videoWidth > 0);
    check("camera opens with a live preview", await c.evaluate(() => ScanTool._active._state().camera));
    await c.click("#scanShutter");
    await c.waitForFunction(() => ScanTool._active._state().pages.length === 1);
    await c.waitForTimeout(300);
    await c.click("#scanShutter");
    await c.waitForFunction(() => ScanTool._active._state().pages.length === 2);
    await c.waitForTimeout(200);
    await c.screenshot({ path: path.join(SHOTS, "scan-camera-390.png") });
    const doneText = await c.textContent("#scanCamDone");
    await c.click("#scanCamDone");
    await waitIdle(c, 2);
    const camState = await c.evaluate(() => ({
      overlay: !!document.querySelector(".scan-cam"),
      camera: ScanTool._active._state().camera,
      files: currentFiles.map((f) => f.type),
    }));
    check("shutter adds a page per capture", camState.files.length === 2 && camState.files.every((t) => t === "image/jpeg"), doneText);
    check("Done closes the camera and stops it", !camState.overlay && !camState.camera);
    // Retake page 1: one shot replaces it, keeps its place, and the camera closes by itself.
    const namesBefore = await c.evaluate(() => ScanTool._active._state().pages.map((p) => p.name));
    await c.click('.scan-thumb:nth-child(1) .scan-thumb-btn');
    await c.click('[data-view="result"]').catch(() => {});
    await c.click('[data-act="retake"]');
    await c.waitForSelector(".scan-cam.live", { timeout: 15000 });
    await c.waitForFunction(() => document.querySelector(".scan-cam video").videoWidth > 0);
    await c.click("#scanShutter");
    await c.waitForFunction(() => !document.querySelector(".scan-cam"));
    await waitIdle(c, 2);
    const retaken = await c.evaluate(() => ({ names: ScanTool._active._state().pages.map((p) => p.name), files: currentFiles.length }));
    check("Retake replaces the page in place", retaken.names.length === 2 && retaken.files === 2 && retaken.names[1] === namesBefore[1] && retaken.names[0] !== namesBefore[0], `${namesBefore.join()} -> ${retaken.names.join()}`);
    // Escape closes only the camera, not the tool.
    await c.click("#scanCameraBtn");
    await c.waitForSelector(".scan-cam.live", { timeout: 15000 });
    await c.keyboard.press("Escape");
    const escState = await c.evaluate(() => ({ overlay: !!document.querySelector(".scan-cam"), modal: document.querySelector("#universalModal").classList.contains("open") }));
    check("Escape closes the camera but keeps the tool open", !escState.overlay && escState.modal);
    // Closing the tool while the camera runs stops the camera.
    await c.click("#scanCameraBtn");
    await c.waitForSelector(".scan-cam.live", { timeout: 15000 });
    const tracks = await c.evaluate(() => {
      const v = document.querySelector(".scan-cam video");
      const stream = v.srcObject;
      closeModal("universalModal");
      return stream.getTracks().map((t) => t.readyState);
    });
    check("closing the tool stops the camera tracks", tracks.length > 0 && tracks.every((t) => t === "ended") && !(await c.$(".scan-cam")));
    check("no console errors (camera)", camErrors.length === 0, camErrors.slice(0, 3).join(" | "));
    await cctx.close();
  } finally {
    if (browser) await browser.close();
    if (camBrowser) await camBrowser.close();
    if (server) server.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
