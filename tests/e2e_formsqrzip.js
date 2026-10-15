// End-to-end checks for Fill PDF Form, QR Code Maker & Reader and ZIP Maker & Opener,
// in Chromium against a running server.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8803 &
//   BASE_URL=http://localhost:8803 node tests/e2e_formsqrzip.js
// Set SCREENS=1 to also save screenshots to ../screens/formsqrzip-*.png.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const BASE = process.env.BASE_URL || "http://localhost:8803";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-fqz-"));
const SCREENS = path.join(__dirname, "..", "..", "screens");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();
const fx = (name) => path.join(OUT, name);

// Tiny RAR 4, RAR 5 and 7-Zip samples from libarchive's own test suite (BSD-2-Clause).
const SAMPLES = {
  "sample.7z": "N3q8ryccAANBxn2IPAAAAAAAAABCAAAAAAAAAIPbi2MgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGUgMSBjb250ZW50cwpoZWxsbwpoZWxsbwpoZWxsbwoBBAYAAQk8AAcLAQABAQAMPAAICgGqHd4PAAAFARENAGYAaQBsAGUAMQAAABQKAQCA1kAAqLKdARUGAQAgAAAAAAA=",
  "sample.rar": "UmFyIRoHAM+QcwAADQAAAAAAAACEUnQgkDIAFAAAABQAAAADQqLIvrd22j4UMAgApIEAAHRlc3QudHh0gAi3dto+t3baPnRlc3QgdGV4dCBkb2N1bWVudA0KnS90IJAyAAgAAAAIAAAAA3tEybbRTNg+FDAIAP+hAAB0ZXN0bGlua8AI0UzYPlBf2j50ZXN0LnR4dM3gdCCQOgAUAAAAFAAAAANCosi+Y3faPhQwEACkgQAAdGVzdGRpclx0ZXN0LnR4dMDMY3faPmN32j50ZXN0IHRleHQgZG9jdW1lbnQNCqHIdOCQMQAAAAAAAAAAAAMAAAAAY3faPhQwBwDtQQAAdGVzdGRpcsDMY3faPmR32j7m53TgkDYAAAAAAAAAAAADAAAAAJ2r1T4UMAwA7UEAAHRlc3RlbXB0eWRpcoDMnavVPsVd2j7EPXsAQAcA",
  "sample5.rar": "UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAA4MAZjLAIDC50ABJ0ApIMCtEOglYAAAQ5oZWxsb3dvcmxkLnR4dAoDE34Oq1tW6Q4aaGVsbG8gbGliYXJjaGl2ZSB0ZXN0IHN1aXRlIQodd1ZRAwUEAA==",
};

py(`
import sys, io, zipfile, tarfile, base64, json, os
from PIL import Image, ImageDraw
out = sys.argv[1]
samples = json.loads(sys.argv[2])
for name, b64 in samples.items(): open(os.path.join(out, name), "wb").write(base64.b64decode(b64))
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("inner/notes.txt", "nested hello " * 50)
    z.writestr("inner/data.csv", "a,b\\n1,2\\n")
with zipfile.ZipFile(os.path.join(out, "outer.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("photos/a.txt", "A" * 1000)
    z.writestr("photos/b.txt", "B" * 2000)
    z.writestr("readme.md", "# Hello\\n")
    z.writestr("bundle.zip", inner.getvalue())
with tarfile.open(os.path.join(out, "sample.tar.gz"), "w:gz") as t:
    for n, data in [("t/one.txt", b"one"), ("t/two.txt", b"two two")]:
        ti = tarfile.TarInfo(n); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
os.makedirs(os.path.join(out, "d1"), exist_ok=True); os.makedirs(os.path.join(out, "d2"), exist_ok=True)
open(os.path.join(out, "d1", "same.txt"), "w").write("first " * 3000)
open(os.path.join(out, "d2", "same.txt"), "w").write("second " * 3000)
Image.new("RGB", (400, 300), (240, 240, 240)).save(os.path.join(out, "blank.png"))
`, OUT, JSON.stringify(SAMPLES));
execFileSync("zip", ["-q", "-j", "-P", "pass123", fx("locked.zip"), fx("d1/same.txt")]);

async function makeFormPdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  const form = doc.getForm();
  const label = (pg, t, y) => pg.drawText(t, { x: 50, y, size: 11, font });
  p.drawText("Bank account opening form", { x: 50, y: 790, size: 18, font });
  label(p, "Full name", 740); form.createTextField("applicant_full_name").addToPage(p, { x: 180, y: 732, width: 300, height: 22 });
  label(p, "City", 700); form.createTextField("address.city").addToPage(p, { x: 180, y: 692, width: 300, height: 22 });
  label(p, "PIN code", 660); const pin = form.createTextField("pin_code"); pin.setMaxLength(6); pin.addToPage(p, { x: 180, y: 652, width: 100, height: 22 });
  label(p, "I agree", 620); form.createCheckBox("agreeTerms").addToPage(p, { x: 180, y: 614, width: 16, height: 16 });
  label(p, "Account type", 580);
  const acct = form.createRadioGroup("accountType");
  acct.addOptionToPage("Savings", p, { x: 180, y: 574, width: 16, height: 16 });
  acct.addOptionToPage("Current", p, { x: 280, y: 574, width: 16, height: 16 });
  label(p, "Branch", 540); const br = form.createDropdown("branch"); br.addOptions(["Mumbai", "Delhi", "Chennai"]); br.addToPage(p, { x: 180, y: 532, width: 200, height: 22 });
  label(p, "Services", 500); const sv = form.createOptionList("services"); sv.addOptions(["Cheque book", "Debit card", "Net banking"]); sv.enableMultiselect(); sv.addToPage(p, { x: 180, y: 440, width: 200, height: 70 });
  label(p2, "Remarks", 790); const rm = form.createTextField("remarks"); rm.enableMultiline(); rm.addToPage(p2, { x: 50, y: 680, width: 480, height: 100 });
  fs.writeFileSync(file, await doc.save());
  const flat = await PDFDocument.create();
  flat.addPage().drawText("A flat page with no fields", { x: 50, y: 700, size: 14, font: await flat.embedFont(StandardFonts.Helvetica) });
  fs.writeFileSync(fx("flat.pdf"), await flat.save());
}

async function readForm(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const f = doc.getForm();
  return {
    fields: f.getFields().length,
    name: f.getFields().length ? f.getTextField("applicant_full_name").getText() : null,
    city: f.getFields().length ? f.getTextField("address.city").getText() : null,
    pin: f.getFields().length ? f.getTextField("pin_code").getText() : null,
    agree: f.getFields().length ? f.getCheckBox("agreeTerms").isChecked() : null,
    acct: f.getFields().length ? f.getRadioGroup("accountType").getSelected() : null,
    branch: f.getFields().length ? f.getDropdown("branch").getSelected()[0] : null,
    services: f.getFields().length ? f.getOptionList("services").getSelected() : null,
    remarks: f.getFields().length ? f.getTextField("remarks").getText() : null,
  };
}
const pdfText = (file) => py(`
import sys, pymupdf
print("\\n".join(p.get_text() for p in pymupdf.open(sys.argv[1])))
`, file);
const zipList = (file) => JSON.parse(py(`
import sys, json, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({i.filename: [i.file_size, i.compress_type, z.read(i.filename).decode("latin-1")[:40]] for i in z.infolist()}))
`, file));

(async () => {
  await makeFormPdf(fx("form.pdf"));
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const saveVia = async (selector) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click(selector)]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };
  const save = () => saveVia("#btnExecute");
  const openTool = async (id, files) => {
    await page.goto(BASE);
    await page.evaluate((t) => openToolModal(t), id);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map(fx));
  };
  const lastToast = async () => (await page.locator(".toast").allTextContents()).pop() || "";

  // ---------- Home page: cards and search ----------
  await page.goto(BASE);
  for (const [id, name] of [["fill-form", "Fill PDF Form"], ["qr-code", "QR Code Maker & Reader"], ["zip-tools", "ZIP Maker & Opener"]]) {
    const card = page.locator(`.tool-card[href="/${await page.evaluate((i) => TOOLS.find((t) => t.id === i).slug, id)}"]`);
    check(`${name} has a card with a caption`, (await card.count()) === 1 && (await card.locator(".card-desc").count()) === 1);
  }
  for (const [q, want] of [["upi qr", "QR Code Maker & Reader"], ["unzip", "ZIP Maker & Opener"], ["rar", "ZIP Maker & Opener"], ["fill form", "Fill PDF Form"]]) {
    await page.click("#searchToggle");
    await page.fill("#toolSearch", q);
    const top = (await page.locator("#searchResults strong").allTextContents())[0];
    check(`search '${q}' finds ${want} first`, top === want, top);
    await page.fill("#toolSearch", "");
    await page.click("#searchToggle");
  }

  // ---------- Fill PDF Form ----------
  await openTool("fill-form", ["form.pdf"]);
  await page.waitForSelector(".ff-row");
  const labels = await page.locator(".ff-label label").allTextContents();
  check("finds all 8 fields of every kind", labels.length === 8, labels.join(" | "));
  check("labels are readable names", labels.includes("Applicant full name") && labels.includes("City") && labels.includes("PIN code") && labels.includes("Agree terms"), labels.slice(0, 4).join(" | "));
  check("fields show their page", (await page.locator(".ff-page-head").allTextContents()).join() === "Page 1,Page 2");
  await page.waitForSelector("#ffLayer .ff-box");
  check("page preview shows the field boxes", (await page.locator("#ffLayer .ff-box").count()) >= 8);
  const row = (label) => page.locator(".ff-row", { has: page.locator(`label:text-is("${label}")`) });
  await row("Applicant full name").locator("input").fill("Asha Rao");
  check("editing a field highlights it on the page", (await page.locator("#ffLayer .ff-box.on").count()) === 1);
  check("preview shows the typed answer", (await page.locator("#ffLayer .ff-box.filled").first().textContent()).includes("Asha Rao"));
  await row("City").locator("input").fill("Pune");
  await row("PIN code").locator("input").fill("41100299");
  check("PIN box stops at its 6-character limit", (await row("PIN code").locator("input").inputValue()) === "411002");
  await row("Agree terms").locator("input").check();
  await row("Account type").locator('input[value="Current"]').check();
  await row("Branch").locator("select").selectOption("Delhi");
  await row("Services").locator("select").selectOption(["Debit card", "Net banking"]);
  await row("Remarks").locator("textarea").fill("Line one\nLine two");
  check("jumping to a page-2 field shows page 2", (await page.textContent("#ffPageNo")).startsWith("Page 2"));
  check("summary counts changes", (await page.textContent("#ffSum")).includes("8 changed"), await page.textContent("#ffSum"));
  let f = await save();
  let v = await readForm(f);
  check("saved PDF keeps the form with every answer",
    v.fields === 8 && v.name === "Asha Rao" && v.city === "Pune" && v.pin === "411002" && v.agree === true && v.acct === "Current" &&
    v.branch === "Delhi" && v.services.join() === "Debit card,Net banking" && v.remarks === "Line one\nLine two", JSON.stringify(v));
  check("answers are drawn on the page", /Asha Rao/.test(pdfText(f)) && /Pune/.test(pdfText(f)));
  check("file named form_filled.pdf", f.endsWith("form_filled.pdf"));

  await row("Applicant full name").locator("input").fill("Łukasz Żółć");
  await page.check("#ffFlatten");
  f = await save();
  v = await readForm(f);
  const txt = pdfText(f);
  check("Flatten locks the answers into the page", v.fields === 0 && txt.includes("Łukasz Żółć") && txt.includes("Pune") && txt.includes("Line two"), txt.replace(/\s+/g, " ").slice(0, 160));

  await page.uncheck("#ffFlatten");
  await row("Applicant full name").locator("input").fill("राम कुमार");
  await page.click("#btnExecute");
  await page.waitForSelector(".toast.error", { timeout: 15000 });
  check("unsupported script gets a plain message", (await lastToast()).includes("can't be written into PDF form fields"), await lastToast());

  await page.setInputFiles("#fileInput", fx("flat.pdf"));
  await page.waitForSelector(".ff-none");
  check("a PDF without fields says so", (await page.textContent(".ff-none")).includes("no fillable fields"));
  await page.click("#ffToEdit");
  await page.waitForTimeout(800);
  check("Edit PDF opens with the same file", (await page.textContent("#mTitle")) === "Edit PDF" && (await page.evaluate(() => currentFiles.length && currentFiles[0].name)) === "flat.pdf");

  // ---------- QR codes ----------
  await openTool("qr-code");
  check("make mode needs no file: drop zone hidden", !(await page.isVisible("#dropZone")) && !(await page.isVisible("#btnExecute")));
  await page.fill("#qrUrl", "example.com/pay?x=1");
  await page.waitForSelector("#qrPreview svg");
  check("link gets https:// added", (await page.textContent("#qrInfo")).includes("https://example.com/pay?x=1"));
  const linkPng = await saveVia("#qrPng");
  const pngInfo = JSON.parse(py(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]); print(json.dumps([im.format, im.size[0], im.size[1]]))
`, linkPng));
  check("PNG download is 512x512", pngInfo.join() === "PNG,512,512", pngInfo.join());
  const linkSvg = await saveVia("#qrSvg");
  const svg = fs.readFileSync(linkSvg, "utf8");
  check("SVG download is a real SVG", svg.startsWith("<svg") && svg.includes("viewBox") && svg.includes("<path"));

  await page.click('.qr-type:has-text("UPI")');
  await page.fill("#qrUpiId", "not a upi id");
  await page.waitForTimeout(150);
  check("bad UPI ID is refused with a hint", (await page.textContent("#qrPreview")).includes("doesn't look like a UPI ID") && await page.isDisabled("#qrPng"));
  await page.fill("#qrUpiId", "asha.rao@okhdfcbank");
  await page.fill("#qrUpiName", "Asha Rao Stores");
  await page.fill("#qrUpiAmount", "12x");
  await page.waitForTimeout(150);
  check("bad amount is refused", (await page.textContent("#qrPreview")).includes("amount"));
  await page.fill("#qrUpiAmount", "250");
  await page.waitForTimeout(150);
  const upiWant = "upi://pay?pa=asha.rao@okhdfcbank&pn=Asha%20Rao%20Stores&am=250.00&cu=INR";
  check("UPI link has the standard format", (await page.textContent("#qrInfo")).includes(upiWant), await page.textContent("#qrInfo"));
  await page.click("summary:has-text('Size, colours')");
  await page.selectOption("#qrSize", "1024");
  await page.selectOption("#qrEcl", "H");
  const upiPng = await saveVia("#qrPng");
  check("UPI PNG at 1024 px named upi-qr.png", upiPng.endsWith("upi-qr.png") && JSON.parse(py(`
import sys, json
from PIL import Image
print(json.dumps(Image.open(sys.argv[1]).size))
`, upiPng))[0] === 1024);

  await page.click('.qr-type:has-text("Wi-Fi")');
  await page.fill("#qrSsid", "Home;Net");
  await page.fill("#qrWifiPass", "p@ss:word");
  await page.waitForTimeout(150);
  check("Wi-Fi text escapes special characters", (await page.textContent("#qrInfo")).includes("WIFI:T:WPA;S:Home\\;Net;P:p@ss\\:word;;"), await page.textContent("#qrInfo"));
  const wifiPng = await saveVia("#qrPng");

  await page.click('.qr-type:has-text("Text")');
  const uni = "नमस्ते दुनिया 🙂 UltraPDF";
  await page.fill("#qrText", uni);
  await page.waitForTimeout(150);
  const textPng = await saveVia("#qrPng");

  await page.click('.qr-type:has-text("Contact")');
  await page.fill("#qrFirst", "Asha"); await page.fill("#qrLast", "Rao"); await page.fill("#qrPhone", "+91 98765 43210");
  await page.waitForTimeout(150);
  check("contact makes a vCard", (await page.textContent("#qrInfo")).includes("BEGIN:VCARD"));
  await page.fill("#qrFg", "#eeeeee");
  await page.waitForTimeout(150);
  check("warns when the colours are too close", (await page.textContent("#qrInfo")).includes("too close"));
  await page.fill("#qrBg", "#222222");
  await page.waitForTimeout(150);
  check("warns about a light code on a dark background", (await page.textContent("#qrInfo")).includes("Light code"));

  // Read them back: round trips.
  await page.click('.qr-mode[data-mode="read"]');
  check("read mode shows the drop zone", await page.isVisible("#dropZone") && (await page.textContent("#btnExecute")).includes("Read QR"));
  let readToast = "";
  const clearResult = () => page.evaluate(() => { const b = document.getElementById("resultBox"); b.style.display = "none"; b.innerHTML = ""; });
  const readBack = async (files) => {
    await clearResult();
    await page.setInputFiles("#fileInput", files);
    await page.waitForSelector("#resultBox .qr-card, #resultBox .qr-none", { timeout: 30000 });
    const texts = await page.locator("#resultBox .qr-text").allTextContents();
    readToast = await lastToast();
    await page.evaluate(() => { currentFiles.length = 0; return filesChanged(); });
    await clearResult();
    return texts;
  };
  let got = await readBack([linkPng]);
  check("round trip: link", got.length === 1 && got[0] === "https://example.com/pay?x=1", got.join());
  got = await readBack([upiPng]);
  check("round trip: UPI payment", got[0] === upiWant, got.join());
  got = await readBack([wifiPng]);
  check("round trip: Wi-Fi", got[0] === "WIFI:T:WPA;S:Home\\;Net;P:p@ss\\:word;;", got.join());
  got = await readBack([textPng]);
  check("round trip: Hindi and emoji text", got[0] === uni, got.join());
  got = await readBack([upiPng, linkPng]);
  check("several pictures at once", got.length === 2, got.join(" | "));

  // A photo-like picture with two codes, and a PDF with a code on page 2.
  py(`
import sys
from PIL import Image
a = Image.open(sys.argv[1]).convert("RGB").resize((300, 300)); b = Image.open(sys.argv[2]).convert("RGB").resize((300, 300))
c = Image.new("RGB", (900, 500), (205, 200, 190)); c.paste(a, (60, 100)); c.paste(b, (520, 120)); c.save(sys.argv[3], quality=88)
import pymupdf
d = pymupdf.open(); d.new_page().insert_text((72, 72), "Cover page"); p = d.new_page(); p.insert_text((72, 72), "Pay here")
p.insert_image(pymupdf.Rect(72, 100, 272, 300), filename=sys.argv[2]); d.save(sys.argv[4])
`, linkPng, upiPng, fx("two.jpg"), fx("qr_on_page2.pdf"));
  got = await readBack([fx("two.jpg")]);
  check("finds two QR codes in one picture", got.length === 2 && got.includes(upiWant) && got.includes("https://example.com/pay?x=1"), got.join(" | "));
  await page.setInputFiles("#fileInput", fx("qr_on_page2.pdf"));
  await page.waitForSelector("#resultBox .qr-card", { timeout: 30000 });
  check("reads a QR from page 2 of a PDF", (await page.textContent("#resultBox .qr-from")).includes("page 2") && (await page.textContent("#resultBox .qr-text")) === upiWant);
  check("UPI result shows payee and a safety note", (await page.textContent("#resultBox")).includes("Asha Rao Stores") && (await page.textContent("#resultBox")).includes("Before paying"));
  await page.click("#selectedFilesList .file-remove");
  got = await readBack([fx("blank.png")]);
  check("a picture without a code says so", got.length === 0 && readToast.includes("No QR code"), readToast);

  // ---------- ZIP tools ----------
  await openTool("zip-tools", ["d1/same.txt", "d2/same.txt", "form.pdf"]);
  check("Make a ZIP is the default mode", (await page.textContent("#btnExecute")).includes("Make ZIP"));
  await page.selectOption("#ztLevel", "9");
  await page.fill("#ztName", "my stuff");
  f = await save();
  let z = zipList(f);
  check("ZIP has every file, same names made unique", Object.keys(z).sort().join() === "form.pdf,same (2).txt,same.txt", Object.keys(z).join());
  check("maximum compression uses DEFLATE and shrinks text", z["same.txt"][1] === 8 && fs.statSync(f).size < 8000, `${fs.statSync(f).size} B`);
  check("named my stuff.zip", f.endsWith("my stuff.zip"));
  await page.selectOption("#ztLevel", "0");
  f = await save();
  z = zipList(f);
  check("no compression stores files as they are", z["same.txt"][1] === 0 && fs.statSync(f).size > 36000);

  await page.click('.zt-mode[data-mode="open"]');
  check("switching to Open clears the file list", (await page.evaluate(() => currentFiles.length)) === 0);
  await page.setInputFiles("#fileInput", fx("outer.zip"));
  await page.waitForSelector("#ztTree .zt-file");
  const names = await page.locator("#ztTree .zt-name").allTextContents();
  check("tree shows folders, files and the ZIP inside the ZIP", ["photos", "a.txt", "b.txt", "bundle.zip", "inner", "notes.txt", "data.csv", "readme.md"].every((n) => names.includes(n)), names.join(","));
  check("summary counts files inside inner ZIPs", (await page.textContent("#ztOpenSum")).includes("5 files"), await page.textContent("#ztOpenSum"));
  f = await saveVia('.zt-file:has(.zt-name:text-is("b.txt")) [data-dl]');
  check("download a single file", fs.readFileSync(f, "utf8") === "B".repeat(2000));
  f = await save();
  z = zipList(f);
  check("download all: inner ZIP opened as a folder", ["photos/a.txt", "photos/b.txt", "readme.md", "bundle/inner/notes.txt", "bundle/inner/data.csv"].every((n) => n in z), Object.keys(z).join());
  await page.uncheck("#ztNested");
  check("inner ZIP can stay closed", (await page.locator('#ztTree [data-open]').count()) === 1);

  for (const [file, kind, want] of [["sample.rar", "RAR", "test.txt"], ["sample5.rar", "RAR", "helloworld.txt"], ["sample.tar.gz", "TAR", "one.txt"], ["sample.7z", "7-Zip", "file1"]]) {
    await page.setInputFiles("#fileInput", fx(file));
    await page.waitForFunction((w) => [...document.querySelectorAll("#ztTree .zt-name")].some((n) => n.textContent === w), want, { timeout: 30000 });
    check(`opens ${file}`, (await page.textContent("#ztOpenSum")).startsWith(kind), await page.textContent("#ztOpenSum"));
  }
  await page.setInputFiles("#fileInput", fx("sample5.rar"));
  await page.waitForSelector('#ztTree .zt-name:text-is("helloworld.txt")', { timeout: 30000 });
  f = await saveVia('.zt-file:has(.zt-name:text-is("helloworld.txt")) [data-dl]');
  check("takes a file out of a RAR 5", fs.readFileSync(f, "utf8") === "hello libarchive test suite!\n", JSON.stringify(fs.readFileSync(f, "utf8")));
  f = await save();
  z = zipList(f);
  check("RAR to ZIP", f.endsWith("sample5.zip") && "helloworld.txt" in z, Object.keys(z).join());

  await page.setInputFiles("#fileInput", fx("locked.zip"));
  await page.waitForSelector("#ztPass:not([hidden])", { timeout: 30000 });
  check("locked ZIP asks for the password", (await page.textContent("#ztOpenHint")).includes("locked with a password"));
  await page.fill("#ztPassword", "wrong");
  await page.click("#ztPassGo");
  await page.waitForFunction(() => document.getElementById("ztOpenHint").textContent.includes("didn't work"), null, { timeout: 30000 });
  check("wrong password is caught", true);
  await page.fill("#ztPassword", "pass123");
  await page.click("#ztPassGo");
  await page.waitForSelector('#ztTree .zt-name:text-is("same.txt")', { timeout: 30000 });
  f = await saveVia('.zt-file:has(.zt-name:text-is("same.txt")) [data-dl]');
  check("opens a password ZIP with the right password", fs.readFileSync(f, "utf8").startsWith("first first"));

  await page.setInputFiles("#fileInput", fx("form.pdf"));
  await page.waitForSelector("#ztToMake");
  check("a non-archive gets a plain message", (await page.textContent("#ztOpenHint")).includes("isn't a ZIP"));
  await page.click("#ztToMake");
  check("…and can be zipped instead", (await page.textContent("#btnExecute")).includes("Make ZIP") && (await page.evaluate(() => currentFiles.length)) === 1);

  check("no console errors", errors.length === 0, errors.join(" | "));

  // ---------- Camera scan with a fake camera that shows the UPI code ----------
  const y4m = fx("cam.y4m");
  py(`
import sys
from PIL import Image
W, H = 640, 480
frame = Image.new("L", (W, H), 225)
q = Image.open(sys.argv[1]).convert("L").resize((300, 300))
frame.paste(q, (170, 90))
y = frame.tobytes(); uv = bytes([128]) * (W * H // 4)
with open(sys.argv[2], "wb") as f:
    f.write(b"YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\\n")
    for _ in range(10): f.write(b"FRAME\\n" + y + uv + uv)
`, upiPng, y4m);
  const camBrowser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
  });
  const camCtx = await camBrowser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
  const cam = await camCtx.newPage();
  const camErrors = [];
  cam.on("pageerror", (e) => camErrors.push(e.message));
  await cam.goto(BASE);
  await cam.evaluate(() => openToolModal("qr-code"));
  await cam.click('.qr-mode[data-mode="read"]');
  await cam.click("#qrCam");
  await cam.waitForSelector("#qrLive .qr-text", { timeout: 20000 }).catch(() => {});
  const camText = await cam.locator("#qrLive .qr-text").textContent().catch(() => "");
  check("camera scan reads the code and stops the camera", camText === upiWant && (await cam.locator("#qrCamBox").isHidden()), camText);
  check("no errors while scanning", camErrors.length === 0, camErrors.join(" | "));
  await camBrowser.close();

  // ---------- Screenshots (optional) ----------
  if (process.env.SCREENS) {
    fs.mkdirSync(SCREENS, { recursive: true });
    for (const theme of ["dark", "light"]) {
      for (const [w, h, tag] of [[1280, 900, "desktop"], [390, 844, "phone"]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
        await ctx.addInitScript((t) => localStorage.setItem("ultrapdf-theme", t), theme);
        const p = await ctx.newPage();
        const shot = async (name) => p.screenshot({ path: path.join(SCREENS, `formsqrzip-${name}-${tag}-${theme}.png`) });
        await p.goto(BASE);
        await p.evaluate(() => openToolModal("fill-form"));
        await p.setInputFiles("#fileInput", fx("form.pdf"));
        await p.waitForSelector(".ff-row");
        await p.waitForTimeout(800);
        await p.locator(".ff-row input").first().fill("Asha Rao");
        await p.locator(".ff-row input[type=checkbox]").first().check();
        await p.waitForTimeout(400);
        await p.evaluate(() => document.querySelector(".tool-config-container").scrollIntoView());
        await shot("form");
        await p.evaluate(() => openToolModal("qr-code"));
        await p.click('.qr-type:has-text("UPI")');
        await p.fill("#qrUpiId", "asha.rao@okhdfcbank");
        await p.fill("#qrUpiName", "Asha Rao Stores");
        await p.fill("#qrUpiAmount", "250");
        await p.waitForTimeout(300);
        await shot("qr");
        await p.evaluate(() => openToolModal("zip-tools"));
        await p.click('.zt-mode[data-mode="open"]');
        await p.setInputFiles("#fileInput", fx("outer.zip"));
        await p.waitForSelector("#ztTree .zt-file");
        await p.evaluate(() => document.querySelector(".tool-config-container").scrollIntoView());
        await shot("zip");
        await ctx.close();
      }
    }
    console.log(`screenshots in ${SCREENS}`);
  }

  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
