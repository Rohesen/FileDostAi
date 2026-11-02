// End-to-end checks for the Screen Recorder in Chromium against a running server: camera only,
// screen + camera (bubble drag, pause, frames keep coming while the tab is hidden), screen only,
// WebM duration fix and WebM to MP4. Needs ffmpeg/ffprobe on this machine.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --app-dir server --port 8808 &
//   BASE_URL=http://localhost:8808 node tests/e2e_recorder.js
// Set FACE_Y4M=/path/to/a_face_video.y4m to also check face tracking and the filters
// (Chromium's fake camera plays that file; any short clip of a face works).
const { chromium } = require("playwright");
const fs = require("fs");
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const BASE = process.env.BASE_URL || "http://localhost:8808";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-rec-"));
const CAM = process.env.FACE_Y4M || path.join(OUT, "cam.y4m");
if (!process.env.FACE_Y4M) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15", "-t", "2", "-pix_fmt", "yuv420p", CAM]);
}
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height", "-of", "json", f]).toString());
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${CAM}`,
    "--auto-select-tab-capture-source-by-title=Demo slide", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ["camera", "microphone"], acceptDownloads: true });
  const demo = await context.newPage();
  await demo.setContent(`<title>Demo slide</title><body style="margin:0;background:#fff"><h1 id=t style="font:bold 80px sans-serif;margin:120px">Slide 0</h1><script>let n=0;setInterval(()=>{document.getElementById('t').textContent='Slide '+(++n);document.body.style.background=n%2?'#fde68a':'#bfdbfe'},300)</script>`);
  const page = await context.newPage();
  await page.addInitScript(() => { window.__hidden = false; Object.defineProperty(Document.prototype, "hidden", { get() { return window.__hidden; } }); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 300)); });
  await page.goto(`${BASE}/screen-recorder`);
  await page.waitForFunction(() => typeof ctx !== "undefined" && ctx && ctx.sr, null, { timeout: 15000 });
  const dbg = () => page.evaluate(() => ctx.sr.debug());
  const save = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#srSave")]);
    const p = `${OUT}/${name}`; await dl.saveAs(p); return { p, suggested: dl.suggestedFilename() };
  };
  const formats = await page.evaluate(() => ({ mp4: MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2"), webm: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") }));
  console.log("formats", JSON.stringify(formats));

  // 1. Camera only, WebM, no countdown.
  await page.click(".sr-mode[data-mode=camera]");
  await page.click("details.sr-panel:nth-of-type(3) > summary");
  await page.click(".sr-seg[data-seg=format] button[data-v=webm]");
  await page.uncheck("#srCountdown");
  await page.waitForTimeout(1500);
  await page.click("#srRec");
  await page.waitForTimeout(3200);
  check("camera: recording", (await dbg()).recording);
  await page.click("#srStop");
  await page.waitForFunction(() => ctx.sr.debug().result, null, { timeout: 10000 });
  let r = await dbg();
  let f = await save("cam.webm");
  let pr = probe(f.p);
  const dur = Number(pr.format.duration);
  check("camera webm: has duration (fixed)", dur > 2.5 && dur < 4.5, `duration ${dur}, name ${f.suggested}`);
  check("camera webm: video + audio", pr.streams.some((s) => s.codec_type === "video") && pr.streams.some((s) => s.codec_type === "audio"), pr.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width || ""}`).join(" "));
  check("camera webm: name", /^Recording_\d{4}-\d\d-\d\d_\d{4}\.webm$/.test(f.suggested));

  // 1b. Convert to MP4 with ffmpeg.wasm
  if (await page.isVisible("#srMp4")) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), page.click("#srMp4")]);
    await dl.saveAs(`${OUT}/cam_conv.mp4`);
    pr = probe(`${OUT}/cam_conv.mp4`);
    check("webm -> mp4 conversion", pr.streams.some((s) => s.codec_name === "h264"), `${pr.format.duration}s ${dl.suggestedFilename()}`);
  } else check("mp4 button shown for webm", false);
  await page.click("#srAgain");

  if (process.env.FACE_Y4M) {
    await page.click('.sr-seg[data-seg=preset] button[data-v=fresh]');
    await page.selectOption("#srHair", "crop");
    await page.selectOption("#srBg", "blur");
    const ok = await page.waitForFunction(() => { const d = ctx.sr.debug().fx; return d.face && d.seg && d.lm > 400; }, null, { timeout: 120000 }).then(() => true, () => false);
    check("face filters: tracking + cut-out running", ok, JSON.stringify((await dbg()).fx));
    await page.click('.sr-seg[data-seg=preset] button[data-v=off]');
    await page.selectOption("#srHair", "none");
  }

  // 2. Screen + camera, MP4 if supported, with filters, while this tab is hidden.
  await page.click(".sr-seg[data-seg=format] button[data-v=mp4]");
  await page.click(".sr-mode[data-mode=both]");
  await page.click("#srPick");
  await page.waitForFunction(() => { const d = ctx.sr.debug(); return d.screen && d.screen[0] > 0; }, null, { timeout: 10000 }).catch(() => {});
  r = await dbg();
  check("screen picked (tab capture)", !!(r.screen && r.screen[0]), JSON.stringify(r.screen) + " canvas " + r.canvas);
  // drag bubble to top-right
  const box = await page.locator("#srCanvas").boundingBox();
  const b = r.bubble; const sx = box.width / r.canvas[0];
  await page.mouse.move(box.x + (b.x + b.w / 2) * sx, box.y + (b.y + b.h / 2) * sx);
  await page.mouse.down(); await page.mouse.move(box.x + box.width - 30, box.y + 30, { steps: 5 }); await page.mouse.up();
  const r2 = await dbg();
  check("bubble dragged to top-right", r2.bubble.x > r.canvas[0] * 0.6 && r2.bubble.y < r.canvas[1] * 0.2, JSON.stringify(r2.bubble));
  await page.click("#srRec");
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.__hidden = true; });
  const hidden = await page.evaluate(() => document.hidden);
  const camBefore = (await dbg()).cam[2];
  await page.waitForTimeout(4000);
  const camAfter = (await dbg()).cam[2];
  await page.evaluate(() => { window.__hidden = false; });
  check("camera frames keep coming while hidden", camAfter > camBefore + 10, `hidden=${hidden} frames ${camBefore}->${camAfter}`);
  await page.waitForTimeout(800);
  await page.click("#srPause"); await page.waitForTimeout(1000);
  check("pause", (await dbg()).state === "paused");
  await page.click("#srPause"); await page.waitForTimeout(800);
  await page.click("#srStop");
  await page.waitForFunction(() => ctx.sr.debug().result, null, { timeout: 15000 });
  r = await dbg();
  f = await save("both." + (r.result.type === "video/mp4" ? "mp4" : "webm"));
  pr = probe(f.p);
  check("screen+camera file", Number(pr.format.duration) > 5, `${r.result.type} ${pr.format.duration}s ${pr.streams.map((s) => s.codec_name + ":" + (s.width || "")).join(" ")}`);
  // Frames from the hidden period must differ (screen content changes every 300 ms)
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", f.p, "-vf", "fps=2,scale=320:-2", `${OUT}/both_%02d.png`]);
  const frames = fs.readdirSync(OUT).filter((x) => /^both_\d+\.png$/.test(x)).sort();
  const hashes = frames.map((x) => require("crypto").createHash("md5").update(fs.readFileSync(`${OUT}/${x}`)).digest("hex"));
  const unique = new Set(hashes.slice(2, 11)).size;
  check("video not frozen while tab hidden", unique >= 6, `${unique} unique of ${hashes.slice(2, 11).length} frames (2 fps)`);
  await page.click("#srAgain");

  // 3. Screen only
  await page.click(".sr-mode[data-mode=screen]");
  await page.click("#srRec"); await page.waitForTimeout(2500); await page.click("#srStop");
  await page.waitForFunction(() => ctx.sr.debug().result, null, { timeout: 15000 });
  r = await dbg();
  f = await save("screen." + (r.result.type === "video/mp4" ? "mp4" : "webm"));
  pr = probe(f.p);
  check("screen only file", Number(pr.format.duration) > 1.5 && !r.cam, `${pr.format.duration}s cam=${JSON.stringify(r.cam)}`);

  // 4. Close: everything stops
  await page.click("#universalModal .modal-close, #universalModal [data-close], #btnCloseModal").catch(() => page.keyboard.press("Escape"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const live = await page.evaluate(() => document.querySelectorAll(".sr-holder").length);
  check("closing removes recorder", live === 0);
  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
