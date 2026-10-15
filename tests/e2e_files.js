// End-to-end checks for the image and file tools, the progress bar, tile scenes and the
// donate section, in Chromium against a running server.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8791 &
//   BASE_URL=http://localhost:8791 node tests/e2e_files.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8791";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-files-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();

py(`
import sys, random, zipfile, io, pymupdf, openpyxl, csv
out = sys.argv[1]
# a noisy 1600x1200 photo-like PNG
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1600, 1200), False)
random.seed(1)
buf = bytearray(1600 * 1200 * 3)
for i in range(0, len(buf), 3):
    x = (i // 3) % 1600; y = (i // 3) // 1600
    buf[i] = (x * 255 // 1600 + random.randint(0, 40)) % 256
    buf[i + 1] = (y * 255 // 1200 + random.randint(0, 40)) % 256
    buf[i + 2] = random.randint(90, 160)
pix = pymupdf.Pixmap(pymupdf.csRGB, 1600, 1200, bytes(buf), False)
pix.save(out + "/photo.png")
open(out + "/notes.txt", "w").write("UltraPDF compresses any file. " * 2000)
d = pymupdf.open(); p = d.new_page(); p.insert_text((72, 72), "Hello PDF"); d.save(out + "/one.pdf")
w = csv.writer(open(out + "/wide.csv", "w", newline=""))
w.writerow(["name"] + [f"col{i}" for i in range(16)] + ["LAST_COLUMN"])
for i in range(30): w.writerow([f"r{i}"] + [repr(random.random()) for _ in range(17)])
`, OUT);

const imgInfo = (file) => JSON.parse(py(`
import sys, json, pymupdf
p = pymupdf.Pixmap(sys.argv[1])
raw = open(sys.argv[1], "rb").read()
print(json.dumps({"w": p.width, "h": p.height, "size": len(raw), "jpeg": raw[:2] == b"\\xff\\xd8", "dpi": [raw[13], raw[14] * 256 + raw[15]] if raw[6:10] == b"JFIF" else None}))
`, file));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const save = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), page.click("#btnExecute")]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };
  const open = async (slug, files) => {
    await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };

  // Home: every card has its tool icon and a description, the Images tab and donate section exist.
  await page.goto(BASE);
  const cards = await page.locator(".tool-card").count();
  const icons = await page.locator(".tool-card .card-head .ti svg").count();
  check("every tool card has its icon", cards > 40 && cards === icons, `${icons}/${cards}`);
  const scenes = await page.locator(".tool-card .holo .h-ico svg").count();
  check("every tool card has a hologram scene", cards === scenes, `${scenes}/${cards}`);
  await page.waitForSelector(".holo.in-view");
  const running = await page.evaluate(() => getComputedStyle(document.querySelector(".holo.in-view .h-ico")).animationPlayState);
  check("holograms animate while visible", running === "running", running);
  const descs = await page.locator(".tool-card .card-desc").count();
  check("every card says what the tool does", descs === cards, `${descs}/${cards}`);
  await page.click('.tab-btn[data-cat="image"]');
  check("Images tab lists image tools", (await page.locator(".tool-card").count()) >= 2);
  await page.click('.tab-btn[data-cat="all"]');
  await page.click("#searchToggle");
  await page.fill("#toolSearch", "png to jpg");
  const hits = await page.locator("#searchResults strong").allTextContents();
  check("search finds the image converter for 'png to jpg'", hits[0] === "Image Converter", hits.join(", "));
  await page.fill("#toolSearch", "");
  await page.click("#searchToggle");

  // Top menu, FAQ, footer, info pages.
  await page.click(".nav-drop >> nth=0 >> button");
  check("Convert menu lists to- and from-PDF tools", await page.locator("#megaConvert a[data-tool]").count() >= 14);
  await page.hover(".nav-drop >> nth=0 >> button");
  await page.waitForSelector("#megaConvert a[data-tool='word-to-pdf']", { state: "visible" });
  await page.waitForTimeout(250); // let the drop-down finish sliding in
  await page.click("#megaConvert a[data-tool='word-to-pdf']");
  check("menu link opens the tool", (await page.textContent("#mTitle")) === "Word to PDF" && page.url().endsWith("/word-to-pdf"));
  await page.keyboard.press("Escape");
  check("All Tools menu has every tool", await page.locator("#megaAll a[data-tool]").count() === cards);
  const faqs = await page.locator(".faq-item").count();
  check("FAQ answers general and per-tool questions", faqs >= cards + 10, `${faqs} answers`);
  await page.fill("#faqSearch", "JEE");
  const jee = await page.locator(".faq-item:visible").count();
  check("FAQ search narrows the answers", jee >= 1 && jee < 6, `${jee}`);
  await page.fill("#faqSearch", "");
  check("footer has five link columns", await page.locator(".footer-grid > div:not(.footer-brand)").count() === 5);
  await page.click(".footer-grid a[data-page='privacy']");
  check("Privacy policy opens at /privacy", await page.isVisible("#infoModal.open") && page.url().endsWith("/privacy"));
  await page.click("#infoClose");
  await page.goto(`${BASE}/faq`);
  await page.waitForTimeout(600);
  const faqTop = await page.evaluate(() => document.getElementById("faq").getBoundingClientRect().top);
  check("/faq scrolls to the answers", Math.abs(faqTop) < 200, `${faqTop}`);
  await page.goto(BASE);
  check("donate section with buttons", (await page.locator("#supportLinks .support-btn").count()) === 4);
  await page.click("#supportLinks .support-btn >> nth=0");
  check("placeholder donate link explains itself", await page.locator(".toast", { hasText: "isn't set up yet" }).count() > 0 || await page.locator("text=isn't set up yet").count() > 0);

  // Aliases open the right tool.
  await open("png-to-pdf");
  check("/png-to-pdf opens JPG & PNG to PDF", (await page.textContent("#mTitle")) === "JPG & PNG to PDF");

  // Many images into one PDF: 100 PNGs plus JPGs, ordered by date, name, reverse or by hand.
  const manifest = JSON.parse(py(`
import sys, os, json, struct
from PIL import Image
out = os.path.join(sys.argv[1], "many"); os.makedirs(out, exist_ok=True)
base = 1700000000
items = []
def add(name, w, mtime, exif=None):
    img = Image.new("RGB", (w, 150), ((w * 7) % 256, (w * 13) % 256, (w * 29) % 256))
    p = os.path.join(out, name)
    if exif:
        ex = Image.Exif(); ex[0x8769] = {0x9003: exif}
        img.save(p, "JPEG", exif=ex.tobytes())
    elif name.endswith(".jpg"):
        img.save(p, "JPEG")
    else:
        img.save(p)
    os.utime(p, (mtime, mtime))
    items.append({"name": name, "w": w, "time": mtime * 1000, "exif": bool(exif)})
for i in range(1, 101):
    add(f"img{i}.png", 200 + i, base + ((i * 37) % 101) * 60)
add("photo_a.jpg", 401, base + 300 * 60)
add("photo_b.jpg", 402, base - 10 * 60)
add("photo_c.jpg", 403, base + 400 * 60, "2001:02:03 04:05:06")
print(json.dumps(items))
`, OUT));
  const manyFiles = manifest.map((m) => path.join(OUT, "many", m.name));
  const pdfWidths = (file) => JSON.parse(py(`
import sys, json, pymupdf
print(json.dumps([round(p.rect.width / 0.75) for p in pymupdf.open(sys.argv[1])]))
`, file));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const exifTime = new Date(2001, 1, 3, 4, 5, 6).getTime();
  const tOf = (m) => (m.exif ? exifTime : m.time);
  const widths = (arr) => arr.map((m) => m.w).join(",");
  const boardNames = () => page.locator("#ioGrid .io-name").allTextContents();

  let f;
  await page.goto(BASE);
  for (const q of ["merge png", "combine jpeg photos", "join pictures into pdf", "images to pdf"]) {
    await page.click("#searchToggle");
    await page.fill("#toolSearch", q);
    const top = (await page.locator("#searchResults strong").allTextContents())[0];
    check(`search '${q}' finds JPG & PNG to PDF first`, top === "JPG & PNG to PDF", top);
    await page.fill("#toolSearch", "");
    await page.click("#searchToggle");
  }

  await open("jpg-to-pdf");
  await page.setInputFiles("#fileInput", manyFiles);
  await page.waitForFunction((n) => document.querySelectorAll("#ioGrid .io-card").length === n, manifest.length, { timeout: 30000 });
  check("board shows all 103 images", true);
  check("file list shows one summary line, not 103 rows", (await page.locator("#selectedFilesList .file-item").count()) === 1 && (await page.textContent("#selectedFilesList")).includes("103 files"));
  check("phone photo shows the camera date", (await page.locator(".io-card", { hasText: "photo_c.jpg" }).locator(".io-date").textContent()).includes("2001"));
  const lm = await page.evaluate(() => ctx.files.find((f) => f.name === "img1.png").lastModified);
  check("browser sees each file's saved date", lm === manifest[0].time, `${lm} vs ${manifest[0].time}`);

  await page.selectOption("#ioMargin", "0");
  await page.selectOption("#ioSort", "time-asc");
  const byTime = [...manifest].sort((a, b) => tOf(a) - tOf(b) || collator.compare(a.name, b.name));
  check("oldest first on the board", (await boardNames()).join() === byTime.map((m) => m.name).join());
  f = await save();
  check("PDF has 103 pages, oldest first", widths(pdfWidths(f).map((w) => ({ w }))) === widths(byTime), pdfWidths(f).slice(0, 5).join(","));

  await page.selectOption("#ioSort", "time-desc");
  f = await save();
  check("newest first", pdfWidths(f).join(",") === widths([...byTime].sort((a, b) => tOf(b) - tOf(a) || collator.compare(a.name, b.name))));

  await page.selectOption("#ioSort", "name-asc");
  const byName = [...manifest].sort((a, b) => collator.compare(a.name, b.name));
  check("name A to Z puts img2 before img10", (await boardNames()).slice(0, 3).join() === "img1.png,img2.png,img3.png");
  f = await save();
  check("PDF follows name order", pdfWidths(f).join(",") === widths(byName));

  await page.selectOption("#ioSort", "name-desc");
  check("name Z to A", (await boardNames())[0] === "photo_c.jpg");

  await page.selectOption("#ioSort", "name-asc");
  await page.click("#ioReverse");
  check("reverse flips the order", (await boardNames())[0] === "photo_c.jpg" && (await page.inputValue("#ioSort")) === "manual");

  await page.selectOption("#ioSort", "name-asc");
  await page.locator(".io-card").nth(0).locator('[data-act="right"]').click();
  let names = await boardNames();
  check("▶ moves a picture later", names[0] === "img2.png" && names[1] === "img1.png" && (await page.inputValue("#ioSort")) === "manual");
  await page.locator(".io-card").nth(4).dragTo(page.locator(".io-card").nth(0), { targetPosition: { x: 5, y: 60 } });
  names = await boardNames();
  check("dragging moves a picture", names[0] === "img5.png", names.slice(0, 4).join());
  await page.locator(".io-card", { hasText: "img3.png" }).locator(".io-x").click();
  await page.waitForFunction(() => document.querySelectorAll("#ioGrid .io-card").length === 102);
  names = await boardNames();
  check("× removes a picture and keeps my order", !names.includes("img3.png") && names[0] === "img5.png" && names[1] === "img2.png", names.slice(0, 4).join());
  f = await save();
  const wHand = pdfWidths(f);
  check("PDF follows my hand-made order", wHand.length === 102 && wHand[0] === 205 && wHand[1] === 202 && wHand[2] === 201, wHand.slice(0, 4).join());

  await page.selectOption("#ioPage", "a4");
  f = await save();
  const a4 = JSON.parse(py(`
import sys, json, pymupdf
d = pymupdf.open(sys.argv[1]); print(json.dumps([d.page_count, round(d[0].rect.width), round(d[0].rect.height)]))
`, f));
  check("A4 pages, landscape for wide images", a4[0] === 102 && a4[1] === 842 && a4[2] === 595, a4.join());
  await page.click("#selectedFilesList .file-clear");
  await page.waitForTimeout(200);
  check("Clear all empties the board", (await page.locator("#ioGrid .io-card").count()) === 0);

  // A ".png" that is really a JPG or WebP inside (common for saved screenshots and downloads).
  py(`
import sys, os
from PIL import Image
out = os.path.join(sys.argv[1], "many")
Image.new("RGB", (300, 150), (200, 30, 30)).save(os.path.join(out, "really_jpg.png"), "JPEG")
Image.new("RGB", (310, 150), (30, 200, 30)).save(os.path.join(out, "really_webp.png"), "WEBP")
`, OUT);
  await page.setInputFiles("#fileInput", ["really_jpg.png", "really_webp.png", "img1.png"].map((n) => path.join(OUT, "many", n)));
  await page.waitForFunction(() => document.querySelectorAll("#ioGrid .io-card").length === 3);
  f = await save();
  check("PNGs that are really JPG or WebP still merge", pdfWidths(f).length === 3, pdfWidths(f).join());
  await page.click("#selectedFilesList .file-clear");

  // Image converter: PNG -> JPG and WebP, two files in a zip.
  await open("convert-image", ["photo.png"]);
  await page.selectOption("#icFormat", "jpeg");
  await page.fill("#icWidth", "800");
  f = await save();
  let i = imgInfo(f);
  check("PNG to JPG at 800 px wide", i.jpeg && i.w === 800 && i.h === 600, JSON.stringify(i));
  await page.selectOption("#icFormat", "webp");
  await page.fill("#icWidth", "");
  f = await save();
  check("PNG to WebP", fs.readFileSync(f).subarray(8, 12).toString() === "WEBP");
  await page.selectOption("#icFormat", "pdf");
  f = await save();
  check("image to PDF", fs.readFileSync(f).subarray(0, 5).toString() === "%PDF-");
  await open("convert-image", ["one.pdf"]);
  await page.selectOption("#icFormat", "png");
  f = await save();
  check("PDF page to PNG", fs.readFileSync(f).subarray(1, 4).toString() === "PNG");

  // Exam photo: JEE preset gives 350x450 JPG between 10 and 300 KB with 254 dpi.
  await open("resize-image", ["photo.png"]);
  await page.waitForSelector("#ptResult.ok", { timeout: 15000 });
  f = await save();
  i = imgInfo(f);
  check("JEE photo is 350x450 JPG within 10–300 KB", i.jpeg && i.w === 350 && i.h === 450 && i.size >= 10240 && i.size <= 300 * 1024, JSON.stringify(i));
  check("JEE photo carries 254 dpi", i.dpi && i.dpi[0] === 1 && i.dpi[1] === 254, JSON.stringify(i.dpi));
  check("file named Photograph.jpg", path.basename(f).endsWith("Photograph.jpg"));
  // Tight range forces quality search: 15–20 KB.
  await page.selectOption("#ptPreset", "custom");
  await page.fill("#ptW", "400"); await page.fill("#ptH", "400");
  await page.fill("#ptMin", "15"); await page.fill("#ptMax", "20");
  await page.waitForTimeout(600);
  await page.waitForSelector("#ptResult.ok", { timeout: 15000 });
  f = await save();
  i = imgInfo(f);
  check("custom 400x400 within 15–20 KB", i.w === 400 && i.h === 400 && i.size >= 15 * 1024 && i.size <= 20 * 1024, `${i.w}x${i.h} ${i.size} B`);
  // Minimum larger than the image naturally is: padded up.
  await page.selectOption("#ptPreset", "jee-sign");
  await page.fill("#ptMin", "40"); await page.fill("#ptMax", "50");
  await page.waitForTimeout(600);
  await page.waitForSelector("#ptResult.ok", { timeout: 15000 });
  f = await save();
  i = imgInfo(f);
  check("signature padded up to 40–50 KB, still a valid JPG", i.jpeg && i.w === 350 && i.h === 150 && i.size >= 40 * 1024 && i.size <= 50 * 1024, `${i.size} B`);

  // Compress any file: an image with a target, a text file zipped, a PDF via the server.
  await open("compress-file", ["photo.png", "notes.txt", "one.pdf"]);
  await page.fill("#acTarget", "60");
  f = await save();
  const listing = py(`
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for n in z.namelist(): print(n, z.getinfo(n).file_size)
`, f);
  const lines = Object.fromEntries(listing.trim().split("\n").map((l) => l.split(" ")));
  const imgName = Object.keys(lines).find((n) => n.startsWith("photo_compressed"));
  check("photo compressed under 60 KB", imgName && Number(lines[imgName]) <= 60 * 1024, `${imgName} ${lines[imgName]}`);
  check("text file zipped", "notes.txt.zip" in lines);
  check("PDF compressed via server", Object.keys(lines).some((n) => n.endsWith(".pdf")));

  // Progress bar during a server conversion, with steps, then hidden.
  await open("excel-to-pdf", ["wide.csv"]);
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 90000 }),
    (async () => {
      await page.click("#btnExecute");
      await page.waitForSelector("#processingState .progress-steps li", { timeout: 5000 });
    })(),
  ]);
  f = path.join(OUT, "wide.pdf");
  await dl.saveAs(f);
  check("progress bar shown with steps", true);
  check("progress bar hidden after finishing", !(await page.isVisible("#processingState")));
  const txt = py(`
import sys, pymupdf
print(pymupdf.open(sys.argv[1])[0].get_text())
`, f);
  check("wide CSV keeps every column on page 1", txt.includes("LAST_COLUMN") && txt.includes("col0"));

  // Cancel stops a run.
  await open("word-to-pdf");
  await page.evaluate(() => {
    const data = new Blob(["slow"], { type: "text/plain" });
    window.__slowFile = new File([data], "x.txt", { type: "text/plain" });
  });
  await page.evaluate(() => addFilesToTool([window.__slowFile]));
  await page.route("**/api/to-pdf", (route) => setTimeout(() => route.continue().catch(() => {}), 4000));
  await page.click("#btnExecute");
  await page.waitForSelector("#progressCancel:visible");
  await page.waitForTimeout(400);
  const pct = await page.textContent("#progressPct");
  await page.click("#progressCancel");
  await page.waitForTimeout(300);
  check("cancel hides the progress bar", !(await page.isVisible("#processingState")), `was at ${pct}`);
  check("cancel says Cancelled", await page.locator("text=Cancelled.").count() > 0);
  await page.unroute("**/api/to-pdf");

  // Theme toggle: follows the device, then remembers the visitor's pick.
  await page.goto(BASE);
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click("#themeToggle");
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload();
  const kept = await page.evaluate(() => document.documentElement.dataset.theme);
  check("theme toggle switches and is remembered", before !== after && kept === after, `${before} → ${after} → ${kept}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("light theme has a light background", after !== "light" || bg === "rgb(251, 251, 254)", bg);
  check("aurora background glow is drawn", await page.locator("#bgFx .aurora").count() === 1);
  check("drifting file background is drawn", await page.locator("canvas.bg-canvas").count() === 1);

  check("no console errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
