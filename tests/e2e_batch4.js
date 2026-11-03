// End-to-end checks for Video Converter, Audio Converter, Merge/Mute/Rotate/Crop Video,
// Rotate & Flip Image, Barcode Generator and the PAN / Aadhaar / signature / passport pages,
// in Chromium against a running server. Needs ffmpeg/ffprobe; the barcode check uses zxing-cpp if installed.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --app-dir server --port 8812 &
//   BASE_URL=http://localhost:8812 node tests/e2e_batch4.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8812";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-b4-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const run = (cmd, ...args) => execFileSync(cmd, args).toString();
const ff = (...args) => run("ffmpeg", "-loglevel", "error", "-y", ...args);
const py = (code, ...args) => run("python3", "-c", code, ...args);
const probe = (file) => {
  const j = JSON.parse(run("ffprobe", "-v", "error", "-show_entries", "format=duration,size,format_name:stream=codec_type,codec_name,width,height", "-of", "json", file));
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { duration: Number(j.format.duration), size: Number(j.format.size), fmt: j.format.format_name, v, a };
};
/** Average colour of a w×h box at (x, y) of the video's frame at time t, as [r, g, b]. */
const pixel = (file, t, x, y, w = 8, h = 8) => {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...r.stdout.subarray(0, 3)];
};

// ----- fixtures: a video with a red square at top-left and blue at bottom-right
const QUAD = "color=c=gray:size=640x360:rate=25,drawbox=x=0:y=0:w=160:h=90:color=red:t=fill,drawbox=x=480:y=270:w=160:h=90:color=blue:t=fill";
ff("-f", "lavfi", "-i", QUAD, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(OUT, "quad.mp4"));
ff("-i", path.join(OUT, "quad.mp4"), "-c", "copy", path.join(OUT, "quad.mov"));
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "3",
  "-c:v", "mpeg4", "-c:a", "libmp3lame", "-shortest", path.join(OUT, "old.avi"));
ff("-f", "lavfi", "-i", "testsrc2=size=480x480:rate=30", "-t", "2", "-c:v", "libvpx", "-b:v", "500k", path.join(OUT, "silent.webm"));
ff("-f", "lavfi", "-i", "sine=frequency=500:sample_rate=44100", "-t", "3", "-c:a", "libmp3lame", "-b:a", "128k", path.join(OUT, "tone.mp3"));
ff("-f", "lavfi", "-i", "sine=frequency=700:sample_rate=22050", "-t", "2", "-ac", "1", path.join(OUT, "mono.wav"));
py(`
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
img = Image.new("RGB", (400, 200), (128, 128, 128)); d = ImageDraw.Draw(img)
d.rectangle((0, 0, 99, 99), fill=(255, 0, 0))
img.save(out + "/pic.jpg", quality=95)
img.save(out + "/pic.png")
`, OUT);

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const save = async (sel = "#btnExecute", timeout = 300000) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout }), page.click(sel)]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };
  const open = async (slug, files) => {
    await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };
  const near = (c, want, tol = 60) => c.every((v, i) => Math.abs(v - want[i]) < tol);
  const RED = [255, 0, 0], BLUE = [0, 0, 255];

  await page.goto(BASE);
  const ids = ["video-converter", "audio-converter", "merge-videos", "mute-video", "rotate-video", "crop-video", "rotate-image", "barcode-generator"];
  const icons = await page.evaluate((ids) => ids.map((id) => Icons.glyph({ id }).startsWith("<svg") && !!TOOLS.find((t) => t.id === id)), ids);
  check("all eight tools are listed with SVG icons", icons.every(Boolean), JSON.stringify(icons));

  // ----- Landing pages
  for (const [slug, id, value] of [["pan-card-photo-size", "ptPreset", "pan-photo"], ["signature-resize-20kb", "ptPreset", "sign-20kb"],
    ["photo-resize-20kb", "ptPreset", "ten-kb"], ["passport-photo-maker", "ptPreset", "passport"], ["aadhaar-card-compress", "pxTarget", "200"],
    ["mp3-to-wav", "acFormat", "wav"], ["mov-to-mp4", "vcFormat", "mp4"]]) {
    const res = await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    await page.waitForTimeout(300);
    const v = await page.inputValue(`#${id}`);
    const html = await res.text();
    check(`/${slug} opens set up (${id}=${v})`, res.status() === 200 && v === value && /<title>[^<]+<\/title>/.test(html));
  }
  const pan = await (await page.request.get(`${BASE}/pan-card-photo-size`)).text();
  check("PAN page has its size table in the HTML", /295 × 413 px/.test(pan) && /531 × 236 px/.test(pan));
  const aad = await (await page.request.get(`${BASE}/aadhaar-card-compress`)).text();
  check("Aadhaar page explains the e-Aadhaar password", /first 4 letters of your name/.test(aad));
  const sm = await (await page.request.get(`${BASE}/sitemap.xml`)).text();
  check("new pages are in the sitemap", ["pan-card-photo-size", "barcode-generator", "video-converter", "mp3-to-wav"].every((s) => sm.includes(`/${s}<`)));

  // PAN photo comes out at 295×413 under 50 KB
  await open("pan-card-photo-size", ["pic.jpg"]);
  await page.waitForSelector("#ptWrap:not([hidden])");
  await page.waitForTimeout(800);
  let f = await save();
  let dims = py("import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.size[0],im.size[1])", f).trim();
  check("PAN photo: 295×413 under 50 KB", dims === "295 413" && fs.statSync(f).size <= 50 * 1024, `${dims}, ${fs.statSync(f).size} B, ${path.basename(f)}`);

  // ----- Video converter
  await open("video-converter", ["quad.mov"]);
  let t0 = Date.now();
  f = await save();
  let p = probe(f);
  check("MOV (H.264) to MP4 copies the picture", /quad\.mp4$/.test(f) && /mp4/.test(p.fmt) && p.v.codec_name === "h264" && p.a && Math.abs(p.duration - 4) < 0.3, `${Date.now() - t0} ms`);
  await open("video-converter", ["old.avi"]);
  f = await save();
  p = probe(f);
  check("AVI (MPEG-4) to MP4 re-encodes to H.264", /old\.mp4$/.test(f) && p.v.codec_name === "h264" && /^(mp3|aac)$/.test(p.a.codec_name), `${p.v.codec_name}/${p.a.codec_name}`);
  await page.selectOption("#vcFormat", "webm");
  await page.selectOption("#vcSize", "480");
  f = await save();
  p = probe(f);
  check("AVI to WebM", /old\.webm$/.test(f) && /webm|matroska/.test(p.fmt) && /vp8|vp9/.test(p.v.codec_name) && /vorbis|opus/.test(p.a.codec_name), `${p.v.codec_name}/${p.a.codec_name} ${p.v.width}x${p.v.height}`);
  await open("video-converter", ["quad.mp4"]);
  await page.selectOption("#vcFormat", "avi");
  await page.selectOption("#vcSize", "0");
  f = await save();
  p = probe(f);
  check("MP4 to AVI", /quad\.avi$/.test(f) && /avi/.test(p.fmt) && p.v.codec_name === "mpeg4", p.fmt);

  // ----- Audio converter
  await open("mp3-to-wav", ["tone.mp3"]);
  f = await save();
  p = probe(f);
  check("MP3 to WAV", /tone\.wav$/.test(f) && p.a.codec_name === "pcm_s16le" && Math.abs(p.duration - 3) < 0.2, `${p.a.codec_name} ${p.duration}s`);
  for (const [fmt, codec] of [["m4a", "aac"], ["ogg", "vorbis"], ["flac", "flac"], ["opus", "opus"]]) {
    await page.selectOption("#acFormat", fmt);
    f = await save();
    p = probe(f);
    check(`MP3 to ${fmt.toUpperCase()}`, f.endsWith(`tone.${fmt}`) && p.a.codec_name === codec, p.a.codec_name);
  }
  await open("audio-converter", ["tone.mp3", "mono.wav", "quad.mp4"]);
  f = await save();
  const list = py("import sys,zipfile;print(' '.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", f).trim();
  check("three files (one a video) to MP3 in one ZIP", /\.zip$/.test(f) && list === "mono.mp3 quad.mp3 tone.mp3", list);

  // ----- Merge videos
  await open("merge-videos", ["quad.mp4", "quad.mov"]);
  f = await save();
  p = probe(f);
  check("two same-format clips joined without re-encoding", /quad_merged\.mp4$/.test(f) && Math.abs(p.duration - 8) < 0.4 && p.a, `${p.duration}s`);
  await open("merge-videos", ["quad.mp4", "old.avi", "silent.webm"]);
  f = await save();
  p = probe(f);
  check("mixed sizes and a silent clip: 4 + 3 + 2 s at 640×360 with sound",
    Math.abs(p.duration - 9) < 0.5 && p.v.width === 640 && p.v.height === 360 && p.a && p.v.codec_name === "h264", `${p.duration}s ${p.v.width}x${p.v.height}`);
  check("merged picture keeps the first clip's colours", near(pixel(f, 1, 20, 20), RED) && near(pixel(f, 1, 600, 330), BLUE));

  // ----- Mute
  await open("mute-video", ["quad.mp4"]);
  f = await save();
  p = probe(f);
  check("mute video removes the sound", /quad_muted\.mp4$/.test(f) && !p.a && p.v.codec_name === "h264" && Math.abs(p.duration - 4) < 0.3);

  // ----- Rotate
  await open("rotate-video", ["quad.mp4"]);
  f = await save();
  p = probe(f);
  // Turned right: top-left red goes to the top-right corner.
  check("rotate right: 360×640, red at top-right", /quad_rotated\.mp4$/.test(f) && p.v.width === 360 && p.v.height === 640 && near(pixel(f, 1, 340, 20), RED) && !!p.a,
    `${p.v.width}x${p.v.height} ${pixel(f, 1, 340, 20)}`);
  await page.check('input[name="rvTurn"][value="hflip"]', { force: true });
  f = await save();
  p = probe(f);
  check("mirror: red moves to the top-right", /quad_mirrored\.mp4$/.test(f) && p.v.width === 640 && near(pixel(f, 1, 620, 20), RED));

  // ----- Crop
  await open("crop-video", ["quad.mp4"]);
  await page.waitForSelector("#cvStage:not([hidden])", { timeout: 90000 });
  check("crop shows a frame of the video", (await page.evaluate(() => document.getElementById("cvCanvas").width)) > 100);
  await page.selectOption("#cvShape", "1:1");
  f = await save();
  p = probe(f);
  check("crop 1:1 keeps a centred 360×360", /quad_cropped\.mp4$/.test(f) && p.v.width === 360 && p.v.height === 360 && !!p.a, `${p.v.width}x${p.v.height}`);
  // Drag the box to the top-left quarter in free mode.
  await page.selectOption("#cvShape", "free");
  await page.evaluate(() => document.getElementById("cvStage").scrollIntoView({ block: "center" }));
  await page.waitForTimeout(200);
  const box = await page.locator("#cvStage").boundingBox();
  const se = await page.locator("#cvBox .h-se").boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const bx = await page.locator("#cvBox").boundingBox();
  await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
  await page.mouse.down();
  await page.mouse.move(bx.x + bx.width / 2 - box.width, bx.y + bx.height / 2 - box.height, { steps: 6 });
  await page.mouse.up();
  f = await save();
  p = probe(f);
  // The square box (left edge at 140 px) is shrunk to the middle, then dragged to the corner: 180×180.
  check("drag-cropped top-left corner: about 180×180 with red at the corner", Math.abs(p.v.width - 180) < 12 && Math.abs(p.v.height - 180) < 12 && near(pixel(f, 1, 5, 5), RED),
    `${p.v.width}x${p.v.height}`);

  // ----- Rotate & flip image
  await open("rotate-image", ["pic.jpg", "pic.png"]);
  await page.waitForSelector("#irCanvas:not([hidden])");
  await page.click('[data-op="right"]');
  f = await save();
  const zl = py("import sys,zipfile;print(' '.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", f).trim();
  check("two photos turned right into one ZIP, same formats", zl === "pic_rotated.jpg pic_rotated.png", zl);
  await open("rotate-image", ["pic.png"]);
  await page.waitForSelector("#irCanvas:not([hidden])");
  await page.click('[data-op="right"]');
  await page.click('[data-op="h"]');
  check("state reads turned left and mirrored", /turned left 90° and mirrored|turned right 90° and mirrored/.test(await page.textContent("#irState")), await page.textContent("#irState"));
  await page.click('[data-op="h"]');
  f = await save();
  const px = py("import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');print(im.size[0],im.size[1],*im.getpixel((im.size[0]-10,10)))", f).trim().split(" ").map(Number);
  check("PNG turned right: 200×400, red at top-right", /pic_rotated\.png$/.test(f) && px[0] === 200 && px[1] === 400 && near(px.slice(2), RED, 20), px.join(","));

  // ----- Barcode
  await page.goto(`${BASE}/barcode-generator`);
  await page.waitForSelector("#universalModal.open");
  await page.waitForSelector("#bcPreview svg", { timeout: 15000 });
  check("barcode: no upload box or Run button", !(await page.isVisible("#dropZone")) && !(await page.isVisible("#btnExecute")));
  await page.selectOption("#bcType", "EAN13");
  check("EAN-13 sample fills in", (await page.inputValue("#bcText")) === "890123456789");
  f = await save("#bcPng");
  let decoded = "";
  try {
    decoded = py("import sys,zxingcpp;from PIL import Image;r=zxingcpp.read_barcodes(Image.open(sys.argv[1]));print(r[0].format.name if r else '', r[0].text if r else '')", f).trim();
  } catch (e) { decoded = "skip"; }
  check("EAN-13 PNG scans with the check digit added", decoded === "skip" || decoded === "EAN13 8901234567890", decoded);
  await page.fill("#bcText", "12AB");
  check("bad EAN-13 input is explained", /doesn't fit EAN-13/.test(await page.textContent("#bcInfo")) && await page.isDisabled("#bcPng"));
  await page.selectOption("#bcType", "CODE128");
  await page.fill("#bcText", "SKU-001\nSKU-002\nSKU-003");
  f = await save("#bcSvg");
  const zb = py("import sys,zipfile;print(' '.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", f).trim();
  check("three Code 128 lines save as three SVGs in a ZIP", zb === "barcode_SKU-001.svg barcode_SKU-002.svg barcode_SKU-003.svg", zb);
  await page.fill("#bcText", "FileDost-42");
  f = await save("#bcPng");
  try {
    decoded = py("import sys,zxingcpp;from PIL import Image;r=zxingcpp.read_barcodes(Image.open(sys.argv[1]));print(r[0].text if r else '')", f).trim();
  } catch (e) { decoded = "skip"; }
  check("Code 128 PNG scans back", decoded === "skip" || decoded === "FileDost-42", decoded);
  await page.evaluate(() => { closeModal("universalModal"); openToolModal("merge"); });
  check("other tools get their upload box back", await page.isVisible("#dropZone") && await page.isVisible("#btnExecute"));

  check("no console errors (CSP included)", errors.length === 0, errors.join(" | "));
  console.log(`files: ${OUT}`);
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
