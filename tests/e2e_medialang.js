// End-to-end checks for the video/audio tools (Compress Video, Video to MP3, Trim Audio or Video,
// all on ffmpeg.wasm in the browser), Indian languages in OCR, Read aloud and Translate.
// Needs ffmpeg/ffprobe on this machine to make and check the test clips.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --app-dir server --port 8804 &
//   BASE_URL=http://localhost:8804 node tests/e2e_medialang.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8804";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-media-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const run = (cmd, ...args) => execFileSync(cmd, args).toString();
const ff = (...args) => run("ffmpeg", "-loglevel", "error", "-y", ...args);

// 12 s of 720p with sound, at a high bitrate (about 20 MB), keyframe every second.
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
  "-t", "12", "-c:v", "libx264", "-b:v", "13M", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path.join(OUT, "clip.mp4"));
// A portrait phone-style video, 8 s.
ff("-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30", "-f", "lavfi", "-i", "sine=frequency=300",
  "-t", "8", "-c:v", "libx264", "-b:v", "8M", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(OUT, "portrait.mp4"));
// A small video (already under 16 MB) and an MP3.
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(OUT, "small.mp4"));
// A WebM (this test browser can preview WebM but not H.264).
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000",
  "-t", "12", "-c:v", "libvpx", "-b:v", "1M", "-g", "25", "-deadline", "realtime", "-c:a", "libopus", "-shortest", path.join(OUT, "clip.webm"));
ff("-f", "lavfi", "-i", "sine=frequency=660", "-t", "20", "-c:a", "libmp3lame", "-b:a", "128k", path.join(OUT, "song.mp3"));
// A scanned page for OCR.
execFileSync("python3", ["-c", `
import sys, pymupdf
from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (1200, 400), "white")
ImageDraw.Draw(im).text((50, 150), "Hello scanned world", fill="black", font=ImageFont.load_default(size=60))
im.save(sys.argv[1] + "/scan.png")
d = pymupdf.open(); p = d.new_page(width=600, height=200); p.insert_image(p.rect, filename=sys.argv[1] + "/scan.png"); d.save(sys.argv[1] + "/scan.pdf")
`, OUT]);

const probe = (file) => {
  const j = JSON.parse(run("ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height", "-of", "json", file));
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { duration: Number(j.format.duration), size: Number(j.format.size), v, a };
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const wasmFetches = [];
  page.on("request", (r) => { if (r.url().includes("ffmpeg-core.wasm")) wasmFetches.push(r.url()); });

  const labels = [];
  let watch = null;
  const save = async (timeout = 240000) => {
    labels.length = 0;
    watch = setInterval(async () => { try { labels.push(await page.textContent("#processingLabel")); } catch (e) { /* closed */ } }, 300);
    try {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout }), page.click("#btnExecute")]);
      const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
      await dl.saveAs(f);
      return f;
    } finally { clearInterval(watch); }
  };
  const open = async (id, files) => {
    await page.evaluate((t) => openToolModal(t), id);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };
  const toast = async (type) => {
    await page.waitForSelector(`.toast.${type}`, { timeout: 120000 });
    const t = await page.locator(`.toast.${type}`).last().textContent();
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((x) => x.remove()));
    return t;
  };

  // Home: cards, captions, search.
  await page.goto(BASE);
  for (const slug of ["compress-video", "video-to-mp3", "trim-media"]) {
    const card = page.locator(`a.tool-card[href="/${slug}"]`);
    check(`${slug} card is on the home page with a caption`, (await card.count()) === 1 && (await card.locator(".card-desc").count()) === 1);
  }
  check("ffmpeg is not downloaded on page load", wasmFetches.length === 0);
  const found = await page.evaluate(() => {
    const hit = (q) => TOOLS.filter((t) => `${t.name} ${t.desc} ${t.keywords || ""}`.toLowerCase().includes(q)).map((t) => t.id);
    return { wa: hit("whatsapp"), mp3: hit("mp4 to mp3"), cut: hit("cut video") };
  });
  check("search words find the tools", found.wa.includes("compress-video") && found.mp3.includes("video-to-mp3") && found.cut.includes("trim-media"), JSON.stringify(found));

  // Compress Video: a custom 3 MB target.
  await open("compress-video", ["clip.mp4"]);
  check("phone warning is shown", (await page.textContent("#toolConfig")).includes("phones"));
  await page.selectOption("#mvTarget", "custom");
  check("custom size field appears", await page.isVisible("#mvCustom"));
  await page.fill("#mvCustom", "3");
  let t0 = Date.now();
  let f = await save();
  let info = probe(f);
  check("compressed video fits the target", info.size <= 3_000_000 && info.size > 1_000_000, `${info.size} bytes in ${(Date.now() - t0) / 1000}s`);
  check("compressed video is H.264 + AAC MP4", info.v && info.v.codec_name === "h264" && info.a && info.a.codec_name === "aac" && /\.mp4$/.test(f));
  check("compressed video keeps its length", Math.abs(info.duration - 12) < 0.3, String(info.duration));
  check("engine download progress was shown", labels.some((l) => /video engine/.test(l)));
  check("real encode progress was shown", labels.some((l) => /Compressing on your device… 0:0\d\.\d of 0:12\.0/.test(l)), labels.filter((l) => /Compress/.test(l)).slice(0, 2).join(" / "));
  check("ffmpeg core downloaded once from this server", wasmFetches.length === 1 && wasmFetches[0].startsWith(BASE), wasmFetches.join(","));

  // 480p scale on a portrait video, WhatsApp preset (8 MB file -> already small? no: 8 s at 8 Mbps is ~8 MB).
  await open("compress-video", ["portrait.mp4"]);
  await page.selectOption("#mvTarget", "custom");
  await page.fill("#mvCustom", "2");
  await page.selectOption("#mvScale", "480");
  f = await save();
  info = probe(f);
  check("portrait video scaled on its short side to 480", info.v.width === 480 && info.v.height === 854, `${info.v.width}x${info.v.height}`);
  check("second run reuses the loaded engine", wasmFetches.length === 1);

  // Already small enough.
  await open("compress-video", ["small.mp4"]);
  await page.click("#btnExecute");
  const small = await toast("error");
  check("a video already under the limit gets a friendly note", /already .* under 16 MB/.test(small), small);

  // Cancel stops the work, and the next run still works.
  await open("compress-video", ["clip.mp4"]);
  await page.selectOption("#mvTarget", "custom");
  await page.fill("#mvCustom", "2");
  await page.click("#btnExecute");
  await page.waitForFunction(() => /Compressing/.test(document.querySelector("#processingLabel").textContent), null, { timeout: 60000 });
  await page.click("#progressCancel");
  const cancelled = await toast("success");
  check("cancel stops the encode", /Cancelled/.test(cancelled), cancelled);
  check("cancel stops the ffmpeg worker", await page.evaluate(() => document.querySelector("#processingState").style.display === "none"));

  // Video to MP3 (engine restarts after the cancel).
  await open("video-to-mp3", ["clip.mp4"]);
  await page.selectOption("#mp3Quality", "128");
  f = await save();
  info = probe(f);
  check("video to MP3 makes an MP3 with the whole sound", /\.mp3$/.test(f) && info.a && info.a.codec_name === "mp3" && !info.v && Math.abs(info.duration - 12) < 0.3, `${info.duration}s`);

  // Trim video: preview, sliders, fast cut (WebM, which this browser can play).
  await open("trim-media", ["clip.webm"]);
  await page.waitForFunction(() => /Keeping 0:12\.0 of 0:12\.0/.test(document.querySelector("#trimLen")?.textContent || ""), null, { timeout: 20000 });
  check("trim preview reads the length", true);
  check("trim shows a video player and two sliders", (await page.locator("#trimMedia").evaluate((e) => e.tagName)) === "VIDEO" && (await page.locator(".media-range input[type=range]").count()) === 2);
  await page.locator("#trimStartR").fill("250"); // 3.0 s
  await page.locator("#trimEndR").fill("750"); // 9.0 s
  check("sliders update the time fields", (await page.inputValue("#trimStart")) === "0:03.0" && (await page.inputValue("#trimEnd")) === "0:09.0",
    `${await page.inputValue("#trimStart")} - ${await page.inputValue("#trimEnd")}`);
  check("sliders paint the kept part", await page.evaluate(() => Math.abs(parseFloat(document.querySelector("#trimSel").style.left) - 25) < 0.5 && Math.abs(parseFloat(document.querySelector("#trimSel").style.width) - 50) < 0.5));
  f = await save();
  info = probe(f);
  // A fast cut starts at the keyframe at or before 3 s, so it may keep up to about a second more.
  check("fast trim of WebM keeps about 6 s as WebM", /_trimmed\.webm$/.test(f) && info.duration > 5.7 && info.duration < 7.3 && info.v && info.a, `${info.duration}s`);

  // An MP4 this browser can't preview: typed times still work.
  await open("trim-media", ["clip.mp4"]);
  await page.waitForFunction(() => !!document.querySelector("#trimStart"), null, { timeout: 20000 });
  await page.fill("#trimStart", "2");
  await page.fill("#trimEnd", "0:05");
  check("typed times update the summary", (await page.textContent("#trimLen")).includes("Keeping 0:03.0"));
  f = await save();
  info = probe(f);
  check("fast trim keeps about 3 s", /_trimmed\.mp4$/.test(f) && Math.abs(info.duration - 3) < 0.6 && info.v && info.a, `${info.duration}s`);
  await page.check("#trimExact");
  f = await save();
  info = probe(f);
  check("exact trim keeps 3 s", Math.abs(info.duration - 3) < 0.15 && info.v.codec_name === "h264", `${info.duration}s`);
  await page.fill("#trimEnd", "1");
  check("end before start is flagged", await page.locator("#trimEnd.input-error").count() === 1);
  await page.click("#btnExecute");
  const bad = await toast("error");
  check("end before start gives a friendly error", /end must come after the start/.test(bad), bad);

  // Trim audio.
  await open("trim-media", ["song.mp3"]);
  await page.waitForFunction(() => /of 0:20/.test(document.querySelector("#trimLen")?.textContent || ""), null, { timeout: 15000 });
  check("audio gets an audio player and no exact-cut box", (await page.locator("audio#trimMedia").count()) === 1 && (await page.locator("#trimExact").count()) === 0);
  await page.fill("#trimStart", "5");
  await page.fill("#trimEnd", "15.5");
  f = await save();
  info = probe(f);
  check("audio trim keeps 10.5 s as MP3", /_trimmed\.mp3$/.test(f) && info.a.codec_name === "mp3" && Math.abs(info.duration - 10.5) < 0.15, `${info.duration}s`);

  // OCR: Indian languages with native names; a missing pack gives clear advice.
  await open("ocr", ["scan.pdf"]);
  const opts = await page.$$eval("#ocrLanguage option", (os) => os.map((o) => [o.value, o.textContent]));
  const has = (v, txt) => opts.some(([a, b]) => a === v && b.includes(txt));
  check("OCR lists Indian languages in their own script",
    has("hin", "हिन्दी") && has("mar", "मराठी") && has("ben", "বাংলা") && has("tam", "தமிழ்") && has("tel", "తెలుగు") && has("guj", "ગુજરાતી")
    && has("kan", "ಕನ್ನಡ") && has("mal", "മലയാളം") && has("pan", "ਪੰਜਾਬੀ") && has("urd", "اردو") && has("ori", "ଓଡ଼ିଆ") && has("san", "संस्कृतम्") && has("eng+hin", "English + Hindi"),
    `${opts.length} options`);
  check("OCR still says it runs on the server", (await page.textContent("#privacyNote")).includes("server"));
  await page.selectOption("#ocrLanguage", "eng+tam");
  await page.click("#btnExecute");
  const ocrErr = await toast("error");
  const help = await page.textContent("#resultBox");
  check("missing language pack gets a friendly message", /^The Tamil \(tam\) language pack isn't installed/.test(ocrErr), ocrErr);
  check("the message explains how to install it", /Additional language data/.test(help) && help.includes("tam.traineddata") && help.includes("tessdata"), help.slice(0, 120));
  await page.selectOption("#ocrLanguage", "eng");
  f = await save();
  check("English OCR still works", /\.pdf$/.test(f) && run("python3", "-c", "import sys,pymupdf;print(pymupdf.open(sys.argv[1])[0].get_text())", f).toLowerCase().includes("scanned"));

  // Read aloud: language picker with Indian voices, and a note when there is no voice.
  const detected = await page.evaluate(() => ["नमस्ते, आप कैसे हैं? यह एक परीक्षा है।", "मी घरी आहे आणि हे माझे पुस्तक आहे", "வணக்கம் உலகம்", "یہ ایک کتاب ہے", "Hello world"].map(ReadTools.detectScript));
  check("document language is guessed from the script", detected.join(",") === "hi,mr,ta,ur,en", detected.join(","));
  check("Hindi sentences split at the danda", await page.evaluate(() => ReadTools.sentences("पहला वाक्य। दूसरा वाक्य।").length === 2));
  await page.evaluate(() => closeModal("universalModal"));
  await open("audio");
  await page.evaluate(() => {
    const box = document.getElementById("resultBox");
    box.style.display = "flex";
    ReadTools.audioRender({ title: "t", lang: "hi", pages: [{ page: 1, sentences: ["नमस्ते।", "यह एक परीक्षा है।"] }] }, box);
  });
  const langOpts = await page.$$eval("#ttsLang option", (os) => os.map((o) => o.value));
  check("read aloud offers Indian languages", ["en-IN", "hi-IN", "mr-IN", "bn-IN", "ta-IN", "te-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "ur-IN"].every((v) => langOpts.includes(v)));
  check("read aloud defaults to the document's language", (await page.textContent("#ttsLang option[value=auto]")).includes("Hindi"));
  await page.waitForTimeout(1700);
  const voices = await page.evaluate(() => speechSynthesis.getVoices().length);
  const note = await page.textContent("#ttsNote");
  check("read aloud explains a missing voice", voices > 0 || /no voices/.test(note), `${voices} voices; ${note.slice(0, 80)}`);
  await page.selectOption("#ttsLang", "ta-IN");
  check("changing language refreshes the voice list", (await page.locator("#ttsVoice option").count()) >= 1);
  await page.evaluate(() => closeModal("universalModal"));

  // Read aloud on a real PDF still works (sentence list).
  execFileSync("python3", ["-c", `
import sys, pymupdf
d = pymupdf.open(); p = d.new_page()
p.insert_textbox(pymupdf.Rect(72, 72, 520, 760), "UltraPDF reads documents aloud. " * 20, fontsize=11)
d.save(sys.argv[1])`, path.join(OUT, "read.pdf")]);
  await open("audio", ["read.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector("#ttsText span");
  check("read aloud lists sentences", (await page.$$("#ttsText span")).length > 5);

  // Translate: Indian languages listed with their own script.
  await page.evaluate(() => closeModal("universalModal"));
  await open("translate");
  const tr = await page.$$eval("#trTarget option", (os) => os.map((o) => [o.value, o.textContent]));
  const trHas = (c, t) => tr.some(([a, b]) => a === c && b.includes(t));
  check("translate lists Indian languages", trHas("hi", "हिन्दी") && trHas("mr", "मराठी") && trHas("bn", "বাংলা") && trHas("ta", "தமிழ்") && trHas("te", "తెలుగు")
    && trHas("gu", "ગુજરાતી") && trHas("kn", "ಕನ್ನಡ") && trHas("ml", "മലയാളം") && trHas("pa", "ਪੰਜਾਬੀ") && trHas("ur", "اردو"), `${tr.length} options`);
  check("translate still defaults to Hindi", (await page.inputValue("#trTarget")) === "hi");
  const hasTranslator = await page.evaluate(() => typeof Translator !== "undefined");
  await page.setInputFiles("#fileInput", path.join(OUT, "read.pdf"));
  if (hasTranslator) {
    // This Chromium has the on-device translator; it can't do every Indian language yet.
    await page.waitForTimeout(1500);
    const marked = await page.$$eval("#trTarget option", (os) => os.filter((o) => o.textContent.includes("not in this browser yet")).map((o) => o.value));
    check("languages the browser can't translate are marked", !marked.includes("hi") && !marked.includes("en"), marked.join(","));
    const unsupported = marked[0];
    if (unsupported) {
      await page.selectOption("#trSource", "en");
      await page.selectOption("#trTarget", unsupported);
      await page.click("#btnExecute");
      const trMsg = await toast("error");
      check("translate explains an unsupported language", /can't translate English to/.test(trMsg), trMsg);
    }
  } else {
    await page.click("#btnExecute");
    const trMsg = await toast("error");
    check("translate explains when the browser has no on-device translator", /recent Chrome/.test(trMsg), trMsg);
  }

  // Phone layout: trim fits in 390 px.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => closeModal("universalModal"));
  await open("trim-media", ["clip.webm"]);
  await page.waitForFunction(() => /of 0:12/.test(document.querySelector("#trimLen")?.textContent || ""));
  await page.screenshot({ path: path.join(OUT, "trim-phone.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("trim fits a 390 px phone screen", overflow <= 0, `overflow ${overflow}px`);

  // The OCR request for a missing language pack fails with 503 on purpose; the browser logs that.
  const real = errors.filter((e) => !/status of 503/.test(e));
  check("no browser console errors (besides the expected OCR 503)", real.length === 0, real.join(" | "));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
