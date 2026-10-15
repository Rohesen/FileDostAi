// End-to-end checks for Image to Text, JPG to Word, Image Upscaler and Signature Maker,
// in Chromium against a running server (OCR needs Tesseract on that server).
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8807 &
//   BASE_URL=http://localhost:8807 node tests/e2e_newtools.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8807";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-new-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args], { cwd: path.join(__dirname) }).toString();

py(`
import sys, random
from PIL import Image, ImageDraw, ImageFilter
from test_image_ocr import page_photo
out = sys.argv[1]
open(out + "/page.jpg", "wb").write(page_photo())
# a small, soft 120x90 picture to upscale (with a see-through corner)
img = Image.new("RGBA", (120, 90), (230, 240, 255, 255)); d = ImageDraw.Draw(img)
d.ellipse((20, 15, 70, 65), fill=(200, 40, 40, 255)); d.rectangle((75, 30, 110, 80), fill=(30, 90, 200, 255))
d.rectangle((0, 0, 10, 10), fill=(0, 0, 0, 0))
img.save(out + "/small.png")
img.convert("RGB").filter(ImageFilter.GaussianBlur(1)).save(out + "/small.jpg", quality=60)
# a signature photographed on greyish, unevenly lit paper
W, H = 900, 450
paper = Image.new("L", (W, H))
paper.putdata([int(150 + 70 * x / W + 20 * y / H) for y in range(H) for x in range(W)])
sig = Image.merge("RGB", (paper, paper, paper)); d = ImageDraw.Draw(sig)
pts = [(120 + i * 6, 230 + int(60 * __import__("math").sin(i / 9))) for i in range(110)]
d.line(pts, fill=(20, 30, 90), width=7); d.line([(200, 320), (720, 300)], fill=(20, 30, 90), width=5)
sig.save(out + "/signature.jpg", quality=85)
`, OUT);

const px = (file, points) => JSON.parse(py(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGBA")
pts = json.loads(sys.argv[2])
a = im.getchannel("A")
print(json.dumps({"w": im.width, "h": im.height, "px": [list(im.getpixel((x, y))) for x, y in pts], "solid": sum(a.histogram()[201:])}))
`, file, JSON.stringify(points)));
const docxText = (file) => py(`
import sys, docx
print("\\n".join(p.text for p in docx.Document(sys.argv[1]).paragraphs))
`, file);

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const keep = async (dl) => { const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`); await dl.saveAs(f); return f; };
  const save = async (sel = "#btnExecute") => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), page.click(sel)]);
    return keep(dl);
  };
  const open = async (slug, files) => {
    await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };

  await page.goto(BASE);
  const icons = await page.evaluate(() => ["image-to-text", "jpg-to-word", "upscale-image", "signature-maker"].map((id) => Icons.glyph({ id }).startsWith("<svg")));
  check("all four tools have SVG icons", icons.every(Boolean), JSON.stringify(icons));
  for (const slug of ["image-to-text", "jpg-to-word", "image-upscaler", "signature-maker", "photo-to-text", "image-enhancer"]) {
    const res = await page.request.get(`${BASE}/${slug}`);
    if (res.status() !== 200) check(`page /${slug} exists`, false, String(res.status()));
  }

  // ----- Image to Text
  await open("image-to-text", ["page.jpg"]);
  check("language list includes Hindi", await page.locator('#itLanguage option[value="hin"]').count() === 1);
  await page.click("#btnExecute");
  await page.waitForSelector(".it-text", { timeout: 120000 });
  const text = await page.inputValue(".it-text");
  check("image to text reads the words", /brown fox jumps/.test(text) && /Roll No: 123456/.test(text), text.slice(0, 60).replace(/\n/g, " | "));
  let f = await save('.it-actions [data-act="txt"]');
  check("text downloads as .txt", /page\.txt$/.test(f) && /brown fox/.test(fs.readFileSync(f, "utf8")));

  // ----- JPG to Word
  await open("jpg-to-word", ["page.jpg", "page.jpg"]);
  f = await save();
  const words = docxText(f);
  check("JPG to Word makes an editable docx", /\.docx$/.test(f) && /brown fox jumps over the lazy dog and keeps running/.test(words), path.basename(f));
  check("two pictures, both in the Word file", (words.match(/Exam Admit Card/g) || []).length === 2);

  // ----- Image Upscaler
  await open("image-upscaler", ["small.png"]);
  await page.waitForFunction(() => /px →/.test(document.querySelector("#upInfo").textContent));
  check("upscaler shows the new size", /120×90 px → 240×180 px/.test(await page.textContent("#upInfo")), await page.textContent("#upInfo"));
  let t0 = Date.now();
  f = await save();
  let r = px(f, [[2, 2], [90, 90]]);
  check("2× upscale (AI) keeps PNG and size", /small_2x\.png$/.test(f) && r.w === 240 && r.h === 180, `${r.w}×${r.h}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check("see-through corner stays see-through", r.px[0][3] < 30 && r.px[1][3] === 255, JSON.stringify(r.px));
  check("before/after slider appears", await page.isVisible("#upCompare"));
  await page.selectOption("#upScale", "4");
  t0 = Date.now();
  f = await save();
  r = px(f, [[0, 0]]);
  check("4× upscale", r.w === 480 && r.h === 360, `${r.w}×${r.h}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await open("image-upscaler", ["small.jpg"]);
  f = await save();
  check("JPG stays JPG", /small_2x\.jpg$/.test(f));

  // ----- Signature Maker: draw
  await page.goto(`${BASE}/signature-maker`);
  await page.waitForSelector("#universalModal.open");
  check("no upload box or Run button while drawing", !(await page.isVisible("#dropZone")) && !(await page.isVisible("#btnExecute")));
  check("download disabled before signing", await page.isDisabled("#smPng"));
  const box = await page.locator("#smPad").boundingBox();
  await page.mouse.move(box.x + 60, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) await page.mouse.move(box.x + 60 + i * 12, box.y + box.height * (0.6 - 0.25 * Math.sin(i / 4)));
  await page.mouse.up();
  f = await save("#smPng");
  r = px(f, [[0, 0]]);
  check("drawn signature: see-through PNG, cropped", /signature\.png$/.test(f) && r.px[0][3] === 0 && r.solid > 300 && r.w < 900 && r.h < 300, `${r.w}×${r.h}, ${r.solid} ink px`);
  await page.click(".sm-ink[data-c='#1d3fbf']");
  await page.selectOption("#smSize", "350x150");
  f = await save("#smJpg");
  r = px(f, [[0, 0]]);
  check("form size on white as JPG", /\.jpg$/.test(f) && r.w === 350 && r.h === 150 && r.px[0][0] > 245, `${r.w}×${r.h}`);
  await page.click("#smUndo");
  check("undo clears the stroke", await page.isDisabled("#smPng"));

  // type
  await page.click('.sign-tab[data-tab="type"]');
  await page.fill("#smText", "Rohan Kumar");
  await page.click('.sm-font[data-font="Great Vibes"]');
  await page.selectOption("#smSize", "0");
  f = await save("#smPng");
  r = px(f, [[0, 0]]);
  check("typed signature in a handwriting font", r.px[0][3] === 0 && r.solid > 300 && r.w > r.h * 2, `${r.w}×${r.h}`);

  // photo
  await page.click('.sign-tab[data-tab="photo"]');
  check("upload box shows for a photo", await page.isVisible("#dropZone"));
  await page.setInputFiles("#fileInput", path.join(OUT, "signature.jpg"));
  await page.waitForFunction(() => !document.querySelector("#smPng").disabled);
  f = await save("#smPng");
  r = px(f, [[0, 0], [5, 5]]);
  check("photo: paper removed, ink kept", r.px[0][3] === 0 && r.solid > 2000 && r.w < 900, `${r.w}×${r.h}, ${r.solid} ink px`);
  await page.screenshot({ path: path.join(OUT, "signature.png") });
  await page.evaluate(() => { closeModal("universalModal"); openToolModal("merge"); });
  await page.waitForSelector("#universalModal.open");
  check("other tools get their Run button back", await page.isVisible("#btnExecute") && await page.isVisible("#dropZone"));

  check("no console errors (CSP included)", errors.length === 0, errors.join(" | "));
  console.log(`files: ${OUT}`);
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
