// End-to-end checks for Remove Photo Location & EXIF, Blur Faces & Text, Watermark Images,
// Video to GIF, Compress GIF, Resize Video for Reels, Change Speed, Volume Booster, Audio Joiner
// and Diff Checker, in Chromium against a running server. Needs ffmpeg/ffprobe on this machine.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8808 &
//   BASE_URL=http://localhost:8808 node tests/e2e_batch3.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8808";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-b3-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const run = (cmd, ...args) => execFileSync(cmd, args).toString();
const ff = (...args) => run("ffmpeg", "-loglevel", "error", "-y", ...args);
const py = (code, ...args) => run("python3", "-c", code, ...args);
const probe = (file) => {
  const j = JSON.parse(run("ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", file));
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { duration: Number(j.format.duration), size: Number(j.format.size), v, a };
};
const meanVolume = (file) => {
  const r = require("child_process").spawnSync("ffmpeg", ["-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  return Number((/mean_volume: (-?[\d.]+) dB/.exec(r.stderr.toString()) || [])[1]);
};

// ----- fixtures
py(`
import sys
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo
out = sys.argv[1]
img = Image.new("RGB", (800, 600), (120, 160, 200)); d = ImageDraw.Draw(img)
d.rectangle((300, 200, 500, 400), fill=(220, 60, 60))
ex = Image.Exif()
ex[0x010f] = "Apple"; ex[0x0110] = "iPhone 15 Pro"; ex[0x0131] = "17.2"; ex[0x0112] = 6
gps = ex.get_ifd(0x8825)
gps[1] = "N"; gps[2] = (28.0, 36.0, 50.4); gps[3] = "E"; gps[4] = (77.0, 12.0, 30.0)
img.save(out + "/gps.jpg", exif=ex, quality=90)
info = PngInfo(); info.add_text("Author", "Rohan Kumar"); info.add_text("Comment", "secret")
img.save(out + "/notes.png", pnginfo=info)
img.save(out + "/clean.webp", exif=ex)
Image.new("RGB", (900, 600), (128, 128, 128)).save(out + "/grey.jpg", quality=95)
Image.new("RGB", (600, 900), (60, 90, 140)).save(out + "/blue.png")
`, OUT);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
  "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(OUT, "wide.mp4"));
ff("-f", "lavfi", "-i", "testsrc2=size=480x270:rate=25:duration=3", "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", path.join(OUT, "anim.gif"));
ff("-f", "lavfi", "-i", "sine=frequency=500:sample_rate=44100", "-t", "4", "-af", "volume=-24dB", "-c:a", "libmp3lame", "-b:a", "128k", path.join(OUT, "quiet.mp3"));
ff("-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000", "-t", "3", "-c:a", "aac", path.join(OUT, "two.m4a"));

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

  await page.goto(BASE);
  const ids = ["remove-exif", "blur-image", "watermark-image", "video-to-gif", "compress-gif", "reels-resizer", "media-speed", "volume-booster", "audio-joiner", "text-diff"];
  const icons = await page.evaluate((ids) => ids.map((id) => Icons.glyph({ id }).startsWith("<svg") && !!TOOLS.find((t) => t.id === id)), ids);
  check("all ten tools are listed with SVG icons", icons.every(Boolean), JSON.stringify(icons));

  // ----- EXIF
  await open("remove-exif", ["gps.jpg", "notes.png", "clean.webp"]);
  await page.waitForSelector(".ex-file");
  const report = await page.textContent("#exRoot");
  check("shows the location and phone", /Location \(GPS\)28\.61400, 77\.20833/.test(report) && /iPhone 15 Pro/.test(report), report.slice(0, 160));
  check("shows PNG notes", /Rohan Kumar/.test(report));
  check("warns that photos show where they were taken", /2 photos show where they were taken/.test(report));
  let f = await save();
  check("several photos come back as a zip", /photos_clean\.zip$/.test(f));
  const zipped = JSON.parse(py(`
import sys, json, zipfile, io
from PIL import Image
z = zipfile.ZipFile(sys.argv[1]); out = {}
for n in z.namelist():
    b = z.read(n); im = Image.open(io.BytesIO(b)); ex = im.getexif()
    out[n] = {"gps": len(ex.get_ifd(0x8825)), "model": ex.get(0x0110), "orient": ex.get(0x0112), "text": dict(getattr(im, "text", {}) or {}), "size": im.size}
orig = Image.open(sys.argv[2]); clean = Image.open(io.BytesIO(z.read("gps.jpg")))
out["same_pixels"] = list(orig.getdata()) == list(clean.getdata())
print(json.dumps(out))
`, f, path.join(OUT, "gps.jpg")));
  check("JPG: GPS and phone removed, orientation kept", zipped["gps.jpg"].gps === 0 && !zipped["gps.jpg"].model && zipped["gps.jpg"].orient === 6, JSON.stringify(zipped["gps.jpg"]));
  check("JPG: picture untouched (no re-encode)", zipped.same_pixels === true);
  check("PNG: text notes removed", Object.keys(zipped["notes.png"].text).length === 0, JSON.stringify(zipped["notes.png"].text));
  check("WebP: EXIF removed", zipped["clean.webp"].gps === 0 && !zipped["clean.webp"].model, JSON.stringify(zipped["clean.webp"]));

  // ----- Blur
  await open("blur-face", ["grey.jpg"]);
  await page.waitForSelector("#blWrap:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#blBusy").hidden, null, { timeout: 120000 });
  check("face finder ran", /faces? found/.test(await page.textContent("#blInfo")), await page.textContent("#blInfo"));
  const vb = await page.locator("#blView").boundingBox();
  await page.mouse.move(vb.x + vb.width * 0.1, vb.y + vb.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.4, vb.y + vb.height * 0.4, { steps: 5 });
  await page.mouse.up();
  check("dragging adds a box", await page.locator(".bl-box").count() === 1);
  await page.check('input[name="blStyle"][value="black"]', { force: true });
  f = await save();
  let px = JSON.parse(py(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
print(json.dumps([im.getpixel((200, 150)), im.getpixel((800, 500))]))
`, f));
  check("black box covers the area, rest unchanged", px[0].every((v) => v < 10) && px[1].every((v) => Math.abs(v - 128) < 6), JSON.stringify(px));

  // ----- Watermark
  await open("watermark-image", ["grey.jpg", "blue.png"]);
  await page.waitForSelector("#wiPreview:not([hidden])");
  await page.fill("#wiText", "FileDost Test");
  await page.fill("#wiOpacity", "100");
  f = await save();
  const wm = JSON.parse(py(`
import sys, json, zipfile, io
from PIL import Image
z = zipfile.ZipFile(sys.argv[1]); out = {}
for n in z.namelist():
    im = Image.open(io.BytesIO(z.read(n))).convert("RGB"); w, h = im.size
    br = [im.getpixel((x, y)) for x in range(int(w * .55), w - 5, 4) for y in range(int(h * .85), h - 5, 4)]
    out[n] = {"size": im.size, "tl": im.getpixel((20, 20)), "white": sum(1 for p in br if min(p) > 230)}
print(json.dumps(out))
`, f));
  check("watermark lands bottom-right on both photos", wm["grey_watermarked.jpg"].white > 5 && wm["blue_watermarked.png"].white > 5, JSON.stringify(wm));
  check("rest of the photo unchanged", Math.abs(wm["grey_watermarked.jpg"].tl[0] - 128) < 6);

  // ----- Video to GIF
  await open("video-to-gif", ["wide.mp4"]);
  await page.fill("#vgStart", "1");
  await page.fill("#vgEnd", "3");
  await page.selectOption("#vgWidth", "320");
  let t0 = Date.now();
  f = await save();
  let p = probe(f);
  check("video to GIF: 2 s at 320 px", /wide\.gif$/.test(f) && p.v.codec_name === "gif" && p.v.width === 320 && Math.abs(p.duration - 2) < 0.3, `${p.v.width}×${p.v.height}, ${p.duration}s, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ----- Compress GIF
  await open("compress-gif", ["anim.gif"]);
  await page.selectOption("#cgLevel", "strong");
  await page.selectOption("#cgWidth", "0.5");
  f = await save();
  p = probe(f);
  check("GIF compressed and smaller", p.v.codec_name === "gif" && p.size < fs.statSync(path.join(OUT, "anim.gif")).size && p.v.width === 240, `${fs.statSync(path.join(OUT, "anim.gif")).size} → ${p.size}, ${p.v.width} px, ${p.v.r_frame_rate}`);

  // ----- Reels
  await open("resize-video-for-reels", ["wide.mp4"]);
  t0 = Date.now();
  f = await save();
  p = probe(f);
  check("reels: 720×1280 with sound", p.v.width === 720 && p.v.height === 1280 && !!p.a && Math.abs(p.duration - 6) < 0.5, `${p.v.width}×${p.v.height}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.selectOption("#rsShape", "1:1");
  await page.selectOption("#rsFill", "black");
  f = await save();
  p = probe(f);
  check("square with bars", p.v.width === 720 && p.v.height === 720);

  // ----- Speed
  await open("change-video-speed", ["wide.mp4"]);
  await page.selectOption("#spSpeed", "2");
  f = await save();
  p = probe(f);
  check("video at 2× is half as long, keeps sound", Math.abs(p.duration - 3) < 0.4 && !!p.a, `${p.duration}s`);
  await open("change-video-speed", ["quiet.mp3"]);
  await page.selectOption("#spSpeed", "0.5");
  f = await save();
  p = probe(f);
  check("audio at 0.5× is twice as long, MP3", /\.mp3$/.test(f) && Math.abs(p.duration - 8) < 0.5, `${p.duration}s`);

  // ----- Volume
  await open("volume-booster", ["quiet.mp3"]);
  f = await save();
  const before = meanVolume(path.join(OUT, "quiet.mp3")), after = meanVolume(f);
  check("volume booster makes it louder", after - before > 10, `${before} dB → ${after} dB`);
  await open("volume-booster", ["wide.mp4"]);
  await page.selectOption("#vbBoost", "6");
  f = await save();
  p = probe(f);
  check("video keeps its picture", !!p.v && !!p.a && p.v.width === 640, `${p.v && p.v.codec_name}`);

  // ----- Joiner
  await open("audio-joiner", ["quiet.mp3", "two.m4a"]);
  f = await save();
  p = probe(f);
  check("audio joiner: 4 s + 3 s = 7 s MP3", /_joined\.mp3$/.test(f) && Math.abs(p.duration - 7) < 0.4, `${p.duration}s`);
  await page.selectOption("#ajFade", "2");
  f = await save();
  p = probe(f);
  check("with a 2 s crossfade: 5 s", Math.abs(p.duration - 5) < 0.4, `${p.duration}s`);

  // ----- Diff checker
  await page.goto(`${BASE}/diff-checker`);
  await page.waitForSelector("#universalModal.open");
  check("no upload box or Run button", !(await page.isVisible("#dropZone")) && !(await page.isVisible("#btnExecute")));
  await page.fill("#tdA", "line one\nThe quick brown fox\nsame line\nremove me\nend");
  await page.fill("#tdB", "line one\nThe quick red fox\nsame line\nend\nadded line");
  await page.click("#tdGo");
  const sum = await page.textContent(".td-summary");
  check("counts the changes", /1 removed/.test(sum) && /1 added/.test(sum) && /1 changed/.test(sum), sum);
  check("marks the changed word", (await page.textContent(".td-mod .td-a mark")).trim() === "brown" && (await page.textContent(".td-mod .td-b mark")).trim() === "red");
  await page.fill("#tdB", "LINE ONE\nThe quick brown   fox\nsame line\nremove me\nend");
  await page.check("#tdCase");
  await page.check("#tdSpace");
  check("ignore capitals and spaces", /the same/.test(await page.textContent("#tdOut")), await page.textContent("#tdOut"));
  await page.evaluate(() => { closeModal("universalModal"); openToolModal("merge"); });
  check("other tools get their upload box back", await page.isVisible("#dropZone") && await page.isVisible("#btnExecute"));

  check("no console errors (CSP included)", errors.length === 0, errors.join(" | "));
  console.log(`files: ${OUT}`);
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
