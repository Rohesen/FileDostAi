// End-to-end checks for the Exam & Govt Form Kit and HEIC support (HEIC to JPG, and HEIC in the
// image converter and photo resizer), in Chromium against a running server.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --app-dir server --port 8801 &
//   BASE_URL=http://localhost:8801 node tests/e2e_formkit.js
// Needs Pillow and pymupdf; the HEIC fixture needs pillow-heif (skipped with a note if missing).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8801";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-formkit-"));
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, "..", "..", "screens");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();

const fixtures = JSON.parse(py(`
import sys, random, json, io, pymupdf
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1]
random.seed(3)
# A portrait on a light blue wall with uneven light.
w, h = 1200, 1600
im = Image.new("RGB", (w, h))
px = im.load()
for y in range(h):
    for x in range(w):
        k = 1 - 0.18 * (x / w) - 0.08 * (y / h)
        px[x, y] = (int(170 * k), int(195 * k), int(225 * k))
d = ImageDraw.Draw(im)
d.ellipse([200, 1050, 1000, 1900], fill=(40, 40, 60))          # shoulders
d.rectangle([520, 850, 680, 1100], fill=(200, 150, 120))       # neck
d.ellipse([380, 380, 820, 960], fill=(210, 160, 130))          # face
d.ellipse([370, 330, 830, 640], fill=(30, 25, 25))             # hair
d.ellipse([400, 480, 800, 960], fill=(210, 160, 130))
im = im.filter(ImageFilter.GaussianBlur(2))
im.save(out + "/portrait.jpg", quality=92)
# A signature photographed on paper with a shadow.
s = Image.new("RGB", (1400, 700))
px = s.load()
for y in range(700):
    for x in range(1400):
        v = int(235 - 70 * (x / 1400) * (y / 700))
        px[x, y] = (v, v - 3, v - 8)
d = ImageDraw.Draw(s)
pts = [(150 + i * 9, 350 + int(120 * __import__("math").sin(i / 7.0)) + random.randint(-3, 3)) for i in range(120)]
d.line(pts, fill=(40, 50, 140), width=9)
d.line([(300, 500), (1200, 450)], fill=(40, 50, 140), width=7)
s.save(out + "/signature.jpg", quality=90)
# A thumb impression.
t = Image.new("RGB", (900, 1100), (228, 228, 222))
d = ImageDraw.Draw(t)
for r in range(10, 330, 18):
    d.ellipse([450 - r, 560 - int(r * 1.3), 450 + r, 560 + int(r * 1.3)], outline=(50, 60, 150), width=6)
t.save(out + "/thumb.jpg", quality=90)
# A heavy 3-page scanned certificate PDF (noisy photos, well over 300 KB).
doc = pymupdf.open()
for n in range(3):
    page = doc.new_page(width=595, height=842)
    img = Image.effect_noise((1240, 1754), 60).convert("RGB")
    b = io.BytesIO(); img.save(b, "JPEG", quality=95)
    page.insert_image(page.rect, stream=b.getvalue())
    page.insert_text((72, 100 + n * 10), f"CERTIFICATE page {n + 1}", fontsize=24)
doc.save(out + "/big_cert.pdf")
# A tiny text PDF (under 50 KB, so it needs padding to the minimum).
doc = pymupdf.open(); p = doc.new_page(); p.insert_text((72, 72), "PwD certificate"); doc.save(out + "/small_cert.pdf")
# A photo of a document (for an image -> PDF slot).
dimg = Image.new("RGB", (1500, 2000), (205, 200, 190))
d = ImageDraw.Draw(dimg)
for i in range(40): d.text((120, 120 + i * 44), "Income certificate line %d  ----  Rs 1,20,000" % i, fill=(30, 30, 30))
dimg.save(out + "/doc_photo.jpg", quality=92)
heic = False
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    im.resize((640, 853)).save(out + "/iphone.heic", quality=80)
    hi = Image.new("RGB", (800, 600), (30, 120, 200)); ImageDraw.Draw(hi).rectangle([100, 100, 400, 400], fill=(250, 200, 0))
    hi.save(out + "/IMG_0002.HEIC", quality=80)
    heic = True
except Exception as e:
    print(e, file=sys.stderr)
print(json.dumps({"heic": heic, "big": len(open(out + "/big_cert.pdf", "rb").read())}))
`, OUT));

const fileInfo = (file) => JSON.parse(py(`
import sys, json, io
from PIL import Image
raw = open(sys.argv[1], "rb").read()
r = {"size": len(raw)}
if raw[:4] == b"%PDF":
    import pymupdf
    d = pymupdf.open(stream=raw, filetype="pdf"); r["pages"] = d.page_count; r["pdf"] = True
else:
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    r.update(w=im.width, h=im.height, fmt=Image.open(io.BytesIO(raw)).format, dpi=list(Image.open(io.BytesIO(raw)).info.get("dpi", (0, 0))))
    W, H = im.size
    r["corner"] = list(im.getpixel((3, 3)))
    r["mid"] = list(im.getpixel((W // 2, int(H * 0.55))))
    px = im.convert("L").load()
    r["darkest"] = min(px[x, y] for x in range(0, W, 2) for y in range(0, H, 2))
print(json.dumps(r))
`, file));

// New tools have no server page route until main.py lists them, so open them from the home page.
// heicAccept: until tools.js lists ".heic,.heif" in that tool's accept, add it here (some
// browsers give HEIC files no MIME type, so "image/*" alone turns them away).
const openTool = async (p, slug, { heicAccept = false } = {}) => {
  await p.goto(`${BASE}/`);
  await p.evaluate(([s, h]) => {
    const t = TOOLS.find((x) => x.slug === s);
    if (h && !/\.heic/.test(t.accept)) t.accept += ",.heic,.heif";
    openToolModal(t.id);
  }, [slug, heicAccept]);
  await p.waitForSelector("#universalModal.open");
};

const zipInfo = (file) => JSON.parse(py(`
import sys, json, zipfile
z = zipfile.ZipFile(sys.argv[1]); out = sys.argv[2]
names = z.namelist()
for n in names: open(out + "/zip_" + n, "wb").write(z.read(n))
print(json.dumps(names))
`, file, OUT));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const download = async (action) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), action()]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return { file: f, name: dl.suggestedFilename() };
  };
  const slot = (i) => `.fk-slot[data-i="${i}"]`;
  const put = async (i, file) => {
    await page.setInputFiles(`${slot(i)} input[data-role="file"] >> nth=0`, path.join(OUT, file));
  };
  const waitSlot = async (i) => {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && (el.classList.contains("is-done") || el.classList.contains("is-bad"));
    }, slot(i), { timeout: 90000 });
    await page.evaluate(() => ctx.formKit.whenIdle());
    return page.locator(`${slot(i)} [data-role="result"]`).innerText();
  };

  // ---------- Form kit ----------
  await openTool(page, "exam-form-kit");
  check("form kit opens at /exam-form-kit", (await page.locator("#mTitle").innerText()) === "Exam & Govt Form Kit");
  check("main drop zone is hidden (each slot has its own picker)", !(await page.locator("#dropZone").isVisible()));
  check("JEE checklist has 4 slots", (await page.locator(".fk-slot").count()) === 4);
  check("says to check the official notice", /official notice/i.test(await page.locator(".fk-warn").innerText()));
  check("photo spec shown", /JPG · 350×450 px · 10–300 KB/.test(await page.locator(`${slot(0)} .fk-spec`).innerText()),
    await page.locator(`${slot(0)} .fk-spec`).innerText());
  check("each slot offers a camera picker", (await page.locator('.fk-slot input[capture]').count()) === 4);

  await put(0, "portrait.jpg");
  let txt = await waitSlot(0);
  check("photo slot done with exact pixels", /✓ Photograph\.jpg/.test(txt) && /350×450 px/.test(txt), txt.replace(/\n/g, " "));
  // Background to white
  await page.check(`${slot(0)} input[data-opt="bg"]`);
  txt = await waitSlot(0);
  let dl = await download(() => page.click(`${slot(0)} [data-act="download"]`));
  let info = fileInfo(dl.file);
  check("per-slot download is named Photograph.jpg", dl.name === "Photograph.jpg", dl.name);
  check("photo is 350×450 and within 10–300 KB", info.w === 350 && info.h === 450 && info.size >= 10240 && info.size <= 300 * 1024, JSON.stringify([info.w, info.h, info.size]));
  check("photo DPI written (254)", info.dpi && Math.round(info.dpi[0]) === 254, JSON.stringify(info.dpi));
  check("background turned white", info.corner.every((v) => v >= 245), JSON.stringify(info.corner));
  check("face left alone", info.mid[0] < 235 && info.mid[0] > 150, JSON.stringify(info.mid));

  await put(1, "signature.jpg");
  txt = await waitSlot(1);
  info = fileInfo((await download(() => page.click(`${slot(1)} [data-act="download"]`))).file);
  check("signature slot done", /✓ Signature\.jpg/.test(txt), txt.replace(/\n/g, " "));
  check("signature cleaned: paper white even in the shadow", info.corner.every((v) => v >= 248), JSON.stringify(info.corner));
  check("signature ink kept and darker", info.darkest < 60, String(info.darkest));
  check("signature at preset size and KB", info.w === (await page.evaluate(() => PhotoTool.PRESETS["jee-sign"].w)) && info.size <= 50 * 1024, JSON.stringify([info.w, info.h, info.size]));

  await put(2, "big_cert.pdf");
  txt = await waitSlot(2);
  info = fileInfo((await download(() => page.click(`${slot(2)} [data-act="download"]`))).file);
  check("heavy PDF squeezed into 50–300 KB", info.pdf && info.size <= 300 * 1024 && info.size >= 50 * 1024 && info.pages === 3,
    `${fixtures.big} → ${info.size} bytes, ${info.pages} pages`);
  check("PDF slot says it fits", /✓ Category_certificate\.pdf/.test(txt), txt.replace(/\n/g, " "));

  await put(3, "small_cert.pdf");
  txt = await waitSlot(3);
  info = fileInfo((await download(() => page.click(`${slot(3)} [data-act="download"]`))).file);
  check("tiny PDF padded up to the 50 KB minimum and still opens", info.pdf && info.size >= 50 * 1024 && info.size < 60 * 1024 && info.pages === 1, String(info.size));

  check("progress says 2 of 2 required", /2 of 2 required ready · 2 optional/.test(await page.locator("#fkProgress").innerText()));
  dl = await download(() => page.click("#btnExecute"));
  const names = zipInfo(dl.file);
  check("ZIP named after the form", dl.name === "JEE_Main_documents.zip", dl.name);
  check("ZIP has properly named files", JSON.stringify(names.sort()) === JSON.stringify(["Category_certificate.pdf", "Photograph.jpg", "PwD_certificate.pdf", "Signature.jpg"]), names.join(","));

  // Editing a spec re-runs the slot
  await page.click(`${slot(0)} .fk-edit summary`);
  await page.fill(`${slot(0)} [data-spec="max"]`, "25");
  await page.locator(`${slot(0)} [data-spec="max"]`).dispatchEvent("change");
  txt = await waitSlot(0);
  const m = txt.match(/([\d.]+) KB/);
  check("changing max KB refits the photo", m && Number(m[1]) <= 25 && /✓/.test(txt), txt.replace(/\n/g, " "));
  check("spec line updates", /10–25 KB/.test(await page.locator(`${slot(0)} .fk-spec`).innerText()));

  // NEET: thumb with no fixed pixel size, photo from an image into a PDF slot
  await page.selectOption("#fkForm", "neet");
  check("NEET has 7 slots incl. thumb and postcard", (await page.locator(".fk-slot").count()) === 7 &&
    /thumb/i.test(await page.locator(".fk-list").innerText()) && /Postcard/.test(await page.locator(".fk-list").innerText()));
  await put(3, "thumb.jpg");
  txt = await waitSlot(3);
  check("thumb impression saved within 10–200 KB", /✓ Left_thumb\.jpg/.test(txt), txt.replace(/\n/g, " "));
  await put(1, "portrait.jpg");
  txt = await waitSlot(1);
  check("postcard photo is 600×900", /600×900 px/.test(txt), txt.replace(/\n/g, " "));
  await put(4, "doc_photo.jpg");
  await page.check(`${slot(4)} input[data-opt="paper"]`);
  txt = await waitSlot(4);
  dl = await download(() => page.click(`${slot(4)} [data-act="download"]`));
  info = fileInfo(dl.file);
  check("photo of a document becomes a 50–300 KB PDF", info.pdf && info.size >= 50 * 1024 && info.size <= 300 * 1024, `${info.size}`);
  dl = await download(() => page.click("#btnExecute"));
  check("partial ZIP still downloads and lists what's missing", dl.name === "NEET_UG_documents.zip" &&
    /Still missing: Passport-size photograph, Signature/.test(await page.locator(".toast").last().innerText()),
    await page.locator(".toast").last().innerText());

  // Custom: add a slot
  await page.selectOption("#fkForm", "custom");
  await page.click("#fkAdd");
  check("custom form can add a document", (await page.locator(".fk-slot").count()) === 4);
  await page.click(`${slot(3)} .fk-edit summary`);
  await page.fill(`${slot(3)} [data-spec="name"]`, "Domicile certificate");
  await page.locator(`${slot(3)} [data-spec="name"]`).dispatchEvent("change");
  await put(3, "small_cert.pdf");
  txt = await waitSlot(3);
  check("custom name becomes the file name", /Domicile_certificate\.pdf/.test(txt), txt.replace(/\n/g, " "));

  // Remove clears a slot
  await page.click(`${slot(3)} [data-act="clear"]`);
  check("remove empties the slot", !(await page.locator(`${slot(3)}`).evaluate((e) => e.classList.contains("is-done"))));

  // ---------- HEIC ----------
  if (fixtures.heic) {
    await page.selectOption("#fkForm", "jee");
    await put(0, "iphone.heic");
    txt = await waitSlot(0);
    check("form kit takes an iPhone HEIC photo", /✓ Photograph\.jpg/.test(txt), txt.replace(/\n/g, " "));

    const sniff = await page.evaluate(async () => {
      const b = await (await fetch("/static/manifest.webmanifest")).blob();
      return [await ImageKit.isHeic(new File([b], "x.png")), !!window.libheif];
    });
    check("non-HEIC isn't mistaken for HEIC; reader loaded only on demand", sniff[0] === false && sniff[1] === true);

    await openTool(page, "heic-to-jpg");
    const lazy = await page.evaluate(() => !!window.libheif || !!document.querySelector('script[src*="libheif"]'));
    check("HEIC reader is not loaded until needed", !lazy);
    await page.setInputFiles("#fileInput", [path.join(OUT, "iphone.heic"), path.join(OUT, "IMG_0002.HEIC")]);
    dl = await download(() => page.click("#btnExecute"));
    const hn = zipInfo(dl.file);
    check("HEIC to JPG: two photos in a ZIP", dl.name === "heic_to_jpg.zip" && hn.sort().join(",") === "IMG_0002.jpg,iphone.jpg", hn.join(","));
    info = fileInfo(path.join(OUT, "zip_IMG_0002.jpg"));
    check("HEIC decoded with the right size and colours", info.fmt === "JPEG" && info.w === 800 && info.h === 600 &&
      Math.abs(info.corner[0] - 30) < 20 && Math.abs(info.corner[2] - 200) < 20, JSON.stringify(info));

    await openTool(page, "heic-to-jpg");
    await page.selectOption("#hcFormat", "png");
    await page.setInputFiles("#fileInput", [path.join(OUT, "IMG_0002.HEIC")]);
    dl = await download(() => page.click("#btnExecute"));
    check("HEIC to PNG single file", dl.name === "IMG_0002.png" && fileInfo(dl.file).fmt === "PNG", dl.name);
    const brand = await page.evaluate(async () => {
      const r = await fetch("/static/vendor/libheif-bundle.js"); // any non-HEIC bytes
      const notHeic = await ImageKit.isHeic(new File([await r.blob()], "a"));
      return notHeic;
    });
    check("sniffing ignores other files", brand === false);

    // Image converter takes HEIC
    await openTool(page, "convert-image", { heicAccept: true });
    await page.selectOption("#icFormat", "png");
    await page.setInputFiles("#fileInput", [path.join(OUT, "IMG_0002.HEIC")]);
    dl = await download(() => page.click("#btnExecute"));
    info = fileInfo(dl.file);
    check("Image Converter accepts HEIC (with .heic in its accept list)", dl.name === "IMG_0002.png" && info.w === 800, dl.name);

    // Photo resizer takes HEIC
    await openTool(page, "resize-image", { heicAccept: true });
    await page.setInputFiles("#fileInput", [path.join(OUT, "iphone.heic")]);
    await page.waitForFunction(() => /px/.test(document.querySelector("#ptResult").textContent), null, { timeout: 60000 });
    check("Photo resizer accepts HEIC (with .heic in its accept list)", /350×450 px/.test(await page.locator("#ptResult").innerText()), await page.locator("#ptResult").innerText());

    // HEIC bytes with a .jpg name and no type: still detected
    const renamed = path.join(OUT, "renamed.jpg");
    fs.copyFileSync(path.join(OUT, "IMG_0002.HEIC"), renamed);
    await openTool(page, "convert-image");
    await page.setInputFiles("#fileInput", [renamed]);
    dl = await download(() => page.click("#btnExecute"));
    check("HEIC saved with a .jpg name is detected by its bytes", fileInfo(dl.file).w === 800, dl.name);
  } else {
    console.log("NOTE  pillow-heif is missing, HEIC checks skipped");
  }

  // ---------- Screens: desktop and phone, dark and light ----------
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [theme, vw, vh] of [["dark", 1280, 1000], ["light", 1280, 1000], ["dark", 390, 844], ["light", 390, 844]]) {
    const ctxB = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: vw < 500 ? 2 : 1 });
    await ctxB.addInitScript((t) => localStorage.setItem("ultrapdf-theme", t), theme);
    const p = await ctxB.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await openTool(p, "exam-form-kit");
    await p.setInputFiles(`${slot(0)} input[data-role="file"] >> nth=0`, path.join(OUT, "portrait.jpg"));
    await p.setInputFiles(`${slot(1)} input[data-role="file"] >> nth=0`, path.join(OUT, "signature.jpg"));
    await p.waitForSelector(`${slot(1)}.is-done`, { timeout: 60000 });
    await p.waitForSelector(`${slot(0)}.is-done`, { timeout: 60000 });
    const overflow = await p.evaluate(() => {
      const card = document.querySelector("#universalModal .modal-card");
      return { doc: document.documentElement.scrollWidth - window.innerWidth, card: card.scrollWidth - card.clientWidth };
    });
    await p.screenshot({ path: path.join(SHOTS, `formkit-${vw < 500 ? "phone" : "desktop"}-${theme}.png`) });
    if (vw < 500) {
      await p.locator(slot(1)).scrollIntoViewIfNeeded();
      await p.screenshot({ path: path.join(SHOTS, `formkit-phone-${theme}-slot.png`) });
    }
    // The home page's decorative background already pokes a few px past the edge on desktop; only
    // fail when this tool makes it worse.
    const base = await p.evaluate(async () => {
      closeModal("universalModal");
      await new Promise((r) => setTimeout(r, 200));
      const v = document.documentElement.scrollWidth - window.innerWidth;
      return v;
    });
    check(`no sideways scrolling at ${vw}px (${theme})`, overflow.doc <= Math.max(0, base) && overflow.card <= 1, JSON.stringify({ ...overflow, homePage: base }));
    await ctxB.close();
  }

  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
