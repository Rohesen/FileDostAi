// End-to-end checks for pdf-extras.js: Compress PDF to Exact Size, Extract Images, N-up,
// Booklet, Bookmarks & Contents and Split by Chapters, in Chromium against a running server.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8802 &
//   BASE_URL=http://localhost:8802 node tests/e2e_pdfextras.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8802";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-extras-"));
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, "..", "..", "screens");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args], { maxBuffer: 64 << 20 }).toString();

py(`
import sys, random, io, pymupdf
from PIL import Image
out = sys.argv[1]
random.seed(3)

def noisy(w, h):
    im = Image.effect_noise((w, h), 90).convert("RGB")
    return im

# 4 pages, each a full-page noisy photo plus a line of text: compresses badly on purpose.
d = pymupdf.open()
for i in range(4):
    p = d.new_page()
    b = io.BytesIO(); noisy(1200, 1550).save(b, "JPEG", quality=92)
    p.insert_image(p.rect, stream=b.getvalue())
    p.insert_text((72, 60), f"Photo page {i+1}", fontsize=20)
d.save(out + "/photos.pdf")

# Images: a JPEG used on two pages, a PNG with transparency, and a tiny 16px icon.
jpg = io.BytesIO(); noisy(400, 300).save(jpg, "JPEG", quality=85); open(out + "/orig.jpg", "wb").write(jpg.getvalue())
rgba = Image.new("RGBA", (200, 120), (255, 0, 0, 128)); pb = io.BytesIO(); rgba.save(pb, "PNG")
tiny = Image.new("RGB", (16, 16), (0, 128, 255)); tb = io.BytesIO(); tiny.save(tb, "PNG")
d = pymupdf.open()
p = d.new_page(); xref = p.insert_image(pymupdf.Rect(50, 50, 450, 350), stream=jpg.getvalue())
p.insert_image(pymupdf.Rect(50, 400, 250, 520), stream=pb.getvalue())
p.insert_image(pymupdf.Rect(300, 400, 316, 416), stream=tb.getvalue())
p = d.new_page(); p.insert_image(pymupdf.Rect(50, 50, 250, 200), xref=xref)
d.new_page().insert_text((72, 72), "no images here")
d.save(out + "/images.pdf")

# 10 numbered pages
d = pymupdf.open()
for i in range(10):
    p = d.new_page(); p.insert_text((200, 400), f"PAGE{i+1:02d}", fontsize=40)
d.save(out + "/ten.pdf")
# 6 numbered pages for the booklet
d = pymupdf.open()
for i in range(6):
    p = d.new_page(); p.insert_text((200, 400), f"PAGE{i+1:02d}", fontsize=40)
d.save(out + "/six.pdf")

# A study book: headings in big text, body text, 12 pages, bookmarks on a copy.
d = pymupdf.open()
heads = {1: "Chapter 1 Motion", 5: "Chapter 2 Force", 9: "Chapter 3 Energy"}
subs = {3: "1.1 Speed and velocity", 7: "2.1 Newton's laws"}
for i in range(1, 13):
    p = d.new_page()
    p.insert_text((72, 40), "Physics Notes  Class 11", fontsize=9)
    y = 100
    if i in heads: p.insert_text((72, y), heads[i], fontsize=24); y += 40
    if i in subs: p.insert_text((72, y), subs[i], fontsize=16); y += 30
    for k in range(18):
        p.insert_text((72, y), f"Body text line {k} on page {i}, some ordinary sentences to read.", fontsize=11); y += 16
d.save(out + "/book.pdf")
d.set_toc([[1, "Preface", 1], [1, "Motion", 2], [2, "Speed", 3], [1, "Force", 5], [2, "Newton", 7], [1, "Energy", 9]])
d.save(out + "/book_marked.pdf")
`, OUT);

const info = (file) => JSON.parse(py(`
import sys, json, pymupdf
d = pymupdf.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "w": d[0].rect.width, "h": d[0].rect.height,
  "toc": d.get_toc(), "labels": [d[i].get_label() for i in range(min(3, d.page_count))],
  "links": [len(d[i].get_links()) for i in range(min(2, d.page_count))],
  "text": [d[i].get_text() for i in range(min(4, d.page_count))],
  "words": [[(w[4], round(w[0]), round(w[1])) for w in d[i].get_text("words") if w[4].startswith("PAGE")] for i in range(min(4, d.page_count))],
  "imgs": sum(len(d[i].get_images()) for i in range(d.page_count)), "size": len(open(sys.argv[1], "rb").read())}))
`, file));

const zipList = (file) => JSON.parse(py(`
import sys, json, zipfile, pymupdf
z = zipfile.ZipFile(sys.argv[1]); out = []
for n in z.namelist():
    b = z.read(n); e = {"name": n, "size": len(b)}
    if n.endswith(".pdf"): e["pages"] = pymupdf.open(stream=b, filetype="pdf").page_count
    out.append(e)
print(json.dumps(out))
`, file));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await page.addInitScript(() => localStorage.setItem("ultrapdf-theme", "dark"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const save = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), page.click("#btnExecute")]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };
  // The server has no page routes for these slugs yet, so open the tool from the home page.
  const openOn = async (pg, slug) => {
    await pg.goto(BASE);
    await pg.evaluate((s) => openToolModal(TOOLS.find((t) => t.slug === s).id), slug);
    await pg.waitForSelector("#universalModal.open");
  };
  const open = async (slug, files) => {
    await openOn(page, slug);
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };
  const resultText = () => page.locator("#pxResult").innerText();
  const toast = async () => (await page.locator(".toast").last().innerText().catch(() => ""));

  // ---------- home: the new cards exist and search finds them ----------
  await page.goto(BASE);
  for (const slug of ["compress-pdf-to-size", "extract-images", "n-up-pdf", "booklet-pdf", "pdf-bookmarks", "split-by-bookmarks"]) {
    check(`card for /${slug}`, await page.locator(`.tool-card[href="/${slug}"] .card-desc`).count() === 1);
  }
  await page.click("#searchToggle").catch(() => {});
  await page.fill("#toolSearch", "200kb");
  check("search '200kb' finds Compress to Size", await page.locator('.tool-card[href="/compress-pdf-to-size"]').isVisible());

  // ---------- Compress to exact size ----------
  const photos = info(path.join(OUT, "photos.pdf"));
  await open("compress-pdf-to-size", ["photos.pdf"]);
  check("compress-to-size marked as a server tool", (await page.locator("#privacyNote").innerText()).includes("server"));
  await page.click('.px-chip[data-px-size="1"][data-px-unit="MB"]');
  check("quick button sets the target", (await page.inputValue("#pxTarget")) === "1" && (await page.inputValue("#pxUnit")) === "MB");
  check("size info shows file and target", /Your file is .*Target: under 1(\.00)? MB/.test(await page.locator("#pxSizeInfo").innerText()), await page.locator("#pxSizeInfo").innerText());
  // Reachable by the server's compressor alone.
  let f = await save();
  let r = info(f);
  check("server step fits 1 MB and keeps text", r.size <= 1048576 && r.text[0].includes("Photo page 1"), `${photos.size} → ${r.size}`);
  check("result box shows the final size", /Fits: .*KB/.test(await resultText()), await resultText());
  // Needs pages as pictures.
  await page.fill("#pxTarget", "100");
  await page.selectOption("#pxUnit", "KB");
  f = await save();
  r = info(f);
  check("picture fallback fits 100 KB", r.size <= 100 * 1024 && r.pages === 4, `${r.size} bytes, ${r.pages} pages`);
  check("warns that text became an image", /picture/.test(await resultText()) && !r.text[0].includes("Photo page"), await resultText());
  // Impossible target: still offers the smallest file and says so.
  await page.fill("#pxTarget", "10");
  f = await save();
  r = info(f);
  check("impossible target: says so plainly and gives the smallest file", /Can't reach 10 KB/.test(await resultText()) && r.pages === 4, `${await resultText()} | ${r.size}`);
  // Already small enough.
  await page.fill("#pxTarget", "8");
  await page.selectOption("#pxUnit", "MB");
  f = await save();
  check("already under the target: returned unchanged", fs.statSync(f).size === photos.size && /Already small enough/.test(await resultText()));
  // Text kept when pictures aren't allowed.
  await page.fill("#pxTarget", "100");
  await page.selectOption("#pxUnit", "KB");
  await page.uncheck("#pxAllowRaster");
  f = await save();
  r = info(f);
  check("without picture fallback: text kept, honest message", r.text[0].includes("Photo page 1") && /Not under 100 KB/.test(await resultText()), await resultText());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.check("#pxAllowRaster");
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-compress-phone-dark.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-compress-desktop-dark.png") });

  // ---------- Extract images ----------
  await open("extract-images", ["images.pdf"]);
  f = await save();
  let z = zipList(f);
  const names = z.map((e) => e.name).sort();
  const origJpg = fs.statSync(path.join(OUT, "orig.jpg")).size;
  check("extracts 2 images, skips the tiny one and the repeat", names.length === 2 && names.includes("page1_img1.jpg") && names.some((n) => /^page1_img2\.png$/.test(n)), names.join(","));
  const jpgEntry = z.find((e) => e.name.endsWith(".jpg"));
  check("JPEG saved byte-for-byte", jpgEntry && jpgEntry.size === origJpg, `${jpgEntry && jpgEntry.size} vs ${origJpg}`);
  const alpha = py(`
import sys, zipfile, io
from PIL import Image
z = zipfile.ZipFile(sys.argv[1]); n = [x for x in z.namelist() if x.endswith(".png")][0]
im = Image.open(io.BytesIO(z.read(n))); print(im.size, im.mode, im.getpixel((10, 10)))
`, f).trim();
  check("PNG keeps size and transparency", alpha.startsWith("(200, 120) RGBA") && /255, 0, 0, 12[78]/.test(alpha), alpha);
  await page.check("#pxTiny");
  f = await save();
  z = zipList(f);
  check("tiny images included when asked", z.length === 3, z.map((e) => e.name).join(","));
  await open("extract-images", ["ten.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector(".toast.error");
  check("PDF without pictures gives a friendly message", /No pictures found/.test(await toast()), await toast());

  // ---------- N-up ----------
  await open("n-up-pdf", ["ten.pdf"]);
  await page.selectOption("#pxPerSheet", "4");
  await page.waitForFunction(() => /2 × 2 on portrait A4/.test(document.getElementById("pxPreview").innerText));
  check("preview shows 2 × 2 portrait for 4-up", true);
  await page.check("#pxBorders");
  f = await save();
  r = info(f);
  check("10 pages 4-up → 3 A4 portrait sheets", r.pages === 3 && Math.round(r.w) === 595 && Math.round(r.h) === 842, `${r.pages} ${r.w}x${r.h}`);
  const w0 = r.words[0];
  const pos = Object.fromEntries(w0.map(([t, x, y]) => [t, [x, y]]));
  check("Z order: 1 top-left, 2 top-right, 3 bottom-left", pos.PAGE01 && pos.PAGE02 && pos.PAGE03 &&
    pos.PAGE02[0] > pos.PAGE01[0] && Math.abs(pos.PAGE02[1] - pos.PAGE01[1]) < 3 && pos.PAGE03[1] > pos.PAGE01[1], JSON.stringify(w0));
  await page.selectOption("#pxPerSheet", "2");
  f = await save();
  r = info(f);
  check("2-up → landscape sheets", r.pages === 5 && r.w > r.h, `${r.pages} ${r.w}x${r.h}`);
  await page.selectOption("#pxPerSheet", "9");
  await page.selectOption("#pxPaper", "letter");
  f = await save();
  r = info(f);
  check("9-up on Letter → 2 sheets", r.pages === 2 && Math.round(r.w) === 612, `${r.pages} ${r.w}x${r.h}`);
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-nup-desktop-dark.png") });

  // ---------- Booklet ----------
  await open("booklet-pdf", ["six.pdf"]);
  f = await save();
  r = info(f);
  const sideOrder = r.words.map((ws) => ws.sort((a, b) => a[1] - b[1]).map((w) => w[0]).join("|"));
  // 6 pages padded to 8: [8,1] [2,7] [6,3] [4,5]; pages 7 and 8 are blank
  check("booklet: 4 landscape sides in saddle-stitch order", r.pages === 4 && r.w > r.h &&
    sideOrder.join(" ") === "PAGE01 PAGE02 PAGE06|PAGE03 PAGE04|PAGE05", sideOrder.join(" "));
  const right1 = r.words[0].find((w) => w[0] === "PAGE01");
  check("booklet: page 1 on the right half of side 1", right1 && right1[1] > r.w / 2, JSON.stringify(r.words[0]));
  check("booklet tells you to flip on short edge", /flip on short edge/i.test(await resultText()));
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-booklet-desktop-dark.png") });

  // ---------- Bookmarks & Contents ----------
  await open("pdf-bookmarks", ["book.pdf"]);
  await page.click("#pxSuggest");
  await page.waitForFunction(() => document.getElementById("pxToc").value.includes("Chapter 3"));
  const sug = await page.inputValue("#pxToc");
  check("finds headings from large text", /Chapter 1 Motion — 1/.test(sug) && /Chapter 2 Force — 5/.test(sug) && /^  1\.1 Speed and velocity — 3$/m.test(sug) && !/Physics Notes/.test(sug) && !/Body text/.test(sug), JSON.stringify(sug));
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-bookmarks-desktop-dark.png") });
  f = await save();
  r = info(f);
  check("contents page added at the front", r.pages === 13 && /Contents/.test(r.text[0]) && /Chapter 2 Force/.test(r.text[0]), r.text[0].slice(0, 80));
  check("contents entries are clickable links", r.links[0] === 5, `${r.links[0]} links`);
  check("bookmarks added, nested, pointing at the right pages", JSON.stringify(r.toc) === JSON.stringify([[1, "Chapter 1 Motion", 2], [2, "1.1 Speed and velocity", 4], [1, "Chapter 2 Force", 6], [2, "2.1 Newton's laws", 8], [1, "Chapter 3 Energy", 10]]), JSON.stringify(r.toc));
  check("page labels keep the old numbers (i, 1, 2)", r.labels.join(",") === "i,1,2", r.labels.join(","));
  await page.fill("#pxToc", "Intro — 1\nNonsense line");
  await page.click("#btnExecute");
  await page.waitForSelector(".toast.error");
  check("bad line gets a friendly error", /Line 2 needs a title and a page number/.test(await toast()), await toast());
  await page.fill("#pxToc", "Intro — 40");
  await page.click("#btnExecute");
  await page.waitForFunction(() => /doesn't exist/.test((([...document.querySelectorAll(".toast")].pop() || {}).innerText || "")));
  check("page past the end gets a friendly error", true);
  // Existing bookmarks are filled in.
  await open("pdf-bookmarks", ["book_marked.pdf"]);
  await page.waitForFunction(() => document.getElementById("pxToc").value.includes("Energy"));
  check("existing bookmarks are prefilled", /^Preface — 1\nMotion — 2\n  Speed — 3/.test(await page.inputValue("#pxToc")));
  // Hindi titles: bookmarks keep them, contents page shows "?"
  await page.fill("#pxToc", "अध्याय एक — 2\nChapter Two — 5");
  f = await save();
  r = info(f);
  check("non-Latin titles survive in bookmarks", r.toc[0] && r.toc[0][1] === "अध्याय एक", JSON.stringify(r.toc));

  // ---------- Split by chapters ----------
  await open("split-by-bookmarks", ["book_marked.pdf"]);
  await page.waitForSelector(".px-chap");
  let rows = await page.locator(".px-chap-list li").allInnerTexts();
  check("chapter preview lists top-level chapters with ranges", rows.length === 4 && /Preface\s+p\. 1/.test(rows[0]) && /Motion\s+pp\. 2–4/.test(rows[1]) && /Energy\s+pp\. 9–12/.test(rows[3]), rows.join(" / "));
  await page.selectOption("#pxDepth", "2");
  rows = await page.locator(".px-chap-list li").allInnerTexts();
  check("sections option splits deeper", rows.length === 6 && /Speed\s+pp\. 3–4/.test(rows[2]), rows.join(" / "));
  await page.selectOption("#pxDepth", "1");
  await page.screenshot({ path: path.join(SHOTS, "pdfextras-chapters-desktop-dark.png") });
  f = await save();
  z = zipList(f);
  check("ZIP has one PDF per chapter with the right pages", z.length === 4 && z.map((e) => `${e.name}:${e.pages}`).join(",") === "1 Preface.pdf:1,2 Motion.pdf:3,3 Force.pdf:4,4 Energy.pdf:4", z.map((e) => `${e.name}:${e.pages}`).join(","));
  await page.uncheck(".px-chap >> nth=0");
  await page.uncheck(".px-chap >> nth=1");
  await page.uncheck(".px-chap >> nth=2");
  f = await save();
  r = info(f);
  check("one chapter ticked → a single PDF", f.endsWith("4 Energy.pdf") && r.pages === 4, path.basename(f));
  await open("split-by-bookmarks", ["book.pdf"]);
  await page.waitForSelector("#pxChapters .px-warn");
  check("PDF without bookmarks explains what to do", /no bookmarks/.test(await page.locator("#pxChapters").innerText()));

  // ---------- light theme + phone screenshots ----------
  const light = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await light.addInitScript(() => localStorage.setItem("ultrapdf-theme", "light"));
  light.on("pageerror", (e) => errors.push(e.message));
  for (const [slug, file, shot] of [["split-by-bookmarks", "book_marked.pdf", "chapters"], ["n-up-pdf", "ten.pdf", "nup"], ["pdf-bookmarks", "book_marked.pdf", "bookmarks"], ["compress-pdf-to-size", "photos.pdf", "compress"]]) {
    await openOn(light, slug);
    await light.setInputFiles("#fileInput", path.join(OUT, file));
    await light.waitForTimeout(900);
    const overflow = await light.evaluate(() => document.querySelector("#universalModal .modal-card").scrollWidth - document.querySelector("#universalModal .modal-card").clientWidth);
    check(`${slug} fits a 390px phone`, overflow <= 1, `${overflow}px overflow`);
    await light.screenshot({ path: path.join(SHOTS, `pdfextras-${shot}-phone-light.png`), fullPage: false });
  }
  await openOn(light, "booklet-pdf");
  await light.setViewportSize({ width: 1280, height: 900 });
  await light.screenshot({ path: path.join(SHOTS, "pdfextras-booklet-desktop-light.png") });

  check("no console errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
