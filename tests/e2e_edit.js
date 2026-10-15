// End-to-end check of the Edit PDF tool in Chromium against the real app.
//
//   python3 -m uvicorn main:app --port 8781 &
//   BASE_URL=http://localhost:8781 node tests/e2e_edit.js
//
// Env: BASE_URL (default http://localhost:8781), CHROMIUM_PATH (optional browser binary),
//      SHOTS (optional folder for screenshots).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8781";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-edit-"));
const SHOTS = process.env.SHOTS || OUT;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function makeFixtures() {
  execFileSync("python3", ["-c", `
import io, sys, pymupdf
from reportlab.pdfgen import canvas
from PIL import Image
out = sys.argv[1]
buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(612, 792))
c.setFont("Helvetica", 24); c.drawString(72, 700, "Hello World")
c.setFont("Times-Bold", 14); c.drawString(72, 640, "Serif bold line")
c.setFont("Helvetica", 12); c.drawString(72, 600, "Body text on page 1")
c.showPage()
c.setFont("Helvetica", 18); c.drawString(72, 700, "Second page")
c.showPage(); c.save()
doc = pymupdf.open(stream=buf.getvalue()); doc[1].set_rotation(90); doc.save(out + "/doc.pdf")
Image.new("RGB", (80, 40), (0, 150, 0)).save(out + "/green.png")
Image.new("RGB", (60, 60), (200, 30, 30)).save(out + "/red.webp", "WEBP")
`, OUT]);
}

function inspect(file) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys, pymupdf
d = pymupdf.open(sys.argv[1])
def px(page, x, y):
    pix = page.get_pixmap(dpi=72)
    return list(pix.pixel(int(x), int(y))[:3])
p0, p1 = d[0], d[1]
spans = []
for i, page in enumerate(d):
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                o = pymupdf.Point(s["origin"]) * page.rotation_matrix
                spans.append({"page": i, "text": s["text"], "x": o.x, "y": o.y, "font": s["font"], "color": s["color"]})
pix = p0.get_pixmap(dpi=144)
# Where "World" used to be (about x 140..200, y 72..97 in points); "Hi there" ends near x 157.
world_dark = sum(1 for x in range(336, 400) for y in range(146, 192) if sum(pix.pixel(x, y)[:3]) < 300)
print(json.dumps({"pages": len(d), "spans": spans, "images0": len(p0.get_images()),
  "drawings0": len(p0.get_drawings()), "rot1": p1.rotation, "rect_px": px(p0, 350, 430),
  "p1_px": px(p1, 150, 150), "p1_out": px(p1, 30, 30), "world_dark": world_dark}))
`, file]).toString());
}

async function main() {
  makeFixtures();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const uploads = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (r) => { if (r.method() === "POST") uploads.push(r.url()); });

  const state = () => page.evaluate(() => document.getElementById("editRoot").__edit.state());
  const screen = (x, y) => page.evaluate(([x, y]) => document.getElementById("editRoot").__edit.toScreen(x, y), [x, y]);
  const tool = (id) => page.click(`.ed-tool[data-tool="${id}"]`);
  // Scrolls the editor so the page point (x, y) is on screen.
  const reveal = (x, y) => page.evaluate(([x, y]) => {
    const root = document.getElementById("editRoot");
    const st = root.querySelector(".ed-stage");
    const body = document.querySelector("#universalModal .modal-body");
    const footer = document.querySelector("#universalModal .modal-footer").getBoundingClientRect();
    // Bring the whole stage into the visible part of the dialog, below the sticky toolbar.
    const bar = root.querySelector(".ed-bar").getBoundingClientRect();
    let r = st.getBoundingClientRect();
    if (r.top < bar.bottom + 4) body.scrollTop -= bar.bottom + 4 - r.top;
    else if (r.bottom > footer.top) body.scrollTop += Math.min(r.bottom - footer.top, r.top - bar.bottom - 4);
    r = st.getBoundingClientRect();
    const top = Math.max(r.top, root.querySelector(".ed-bar").getBoundingClientRect().bottom);
    const bottom = Math.min(r.bottom, footer.top);
    const p = root.__edit.toScreen(x, y);
    st.scrollTop += p.y - (top + bottom) / 2;
    st.scrollLeft += p.x - (r.left + r.right) / 2;
  }, [x, y]);
  // Scrolls the dialog so the toolbar, properties and top of the page are in view, for screenshots.
  const frameEditor = () => page.evaluate(() => {
    const body = document.querySelector("#universalModal .modal-body");
    body.scrollTop = document.getElementById("editRoot").offsetTop - body.offsetTop - 8;
    document.querySelector(".ed-stage").scrollTop = 0;
  });
  async function clickAt(x, y) { await reveal(x, y); const p = await screen(x, y); await page.mouse.click(p.x, p.y); }
  async function dragPts(x1, y1, x2, y2) {
    await reveal((x1 + x2) / 2, (y1 + y2) / 2);
    const a = await screen(x1, y1), b = await screen(x2, y2);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8);
    await page.mouse.up();
  }

  await page.goto(`${BASE}/edit-pdf`);
  await page.waitForSelector("#universalModal.open");
  await page.setInputFiles("#fileInput", path.join(OUT, "doc.pdf"));
  await page.waitForSelector(".ed-main:not([hidden])");
  await page.waitForFunction(() => document.querySelector(".ed-canvas").width > 300);
  let s = await state();
  check("PDF opens in the editor", s.numPages === 2 && Math.abs(s.W - 612) < 1, `${s.numPages} pages, scale ${s.scale.toFixed(2)}`);

  // Add text.
  await tool("text");
  await clickAt(100, 300);
  await page.keyboard.type("Hello from e2e");
  await page.keyboard.press("Escape");
  s = await state();
  const added = s.objects.find((o) => o.type === "text");
  check("add text", added && added.text === "Hello from e2e" && !s.editingId, added && `at ${added.x.toFixed(1)},${added.y.toFixed(1)}`);
  check("Escape while typing keeps the dialog open", await page.isVisible("#universalModal.open"));

  // Rectangle by dragging, then style it.
  await tool("rect");
  await dragPts(300, 400, 400, 460);
  s = await state();
  const rect = s.objects.find((o) => o.type === "rect");
  check("draw rectangle", rect && Math.abs(rect.w - 100) < 2 && Math.abs(rect.h - 60) < 2 && s.tool === "select");
  await page.check('.ed-props [data-prop="fillOn"]');
  await page.$eval('.ed-props [data-prop="fill"]', (el) => { el.value = "#0000ff"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  s = await state();
  check("properties bar changes the selected shape", s.objects.find((o) => o.type === "rect").fill === "#0000ff");

  // Undo / redo / delete.
  const before = (await state()).objects.length;
  await page.keyboard.press("Control+z");
  const undone = (await state()).objects.find((o) => o.type === "rect").fill;
  await page.keyboard.press("Control+y");
  const redone = (await state()).objects.find((o) => o.type === "rect").fill;
  check("undo / redo", undone !== "#0000ff" && redone === "#0000ff", `${undone} -> ${redone}`);
  await tool("ellipse");
  await dragPts(450, 400, 520, 450);
  await page.keyboard.press("Delete");
  check("Delete removes the selected object", (await state()).objects.length === before);

  // Arrow and freehand.
  await tool("arrow");
  await dragPts(300, 520, 450, 560);
  await tool("pen");
  await dragPts(300, 600, 380, 640);
  s = await state();
  check("arrow and pen", s.objects.some((o) => o.type === "arrow") && s.objects.some((o) => o.type === "pen" && o.paths[0].length >= 6));

  // Edit existing text.
  await tool("edittext");
  await page.waitForSelector(".ed-run");
  const runs = await page.evaluate(() => document.getElementById("editRoot").__edit.runs());
  const hello = runs.find((r) => r.text === "Hello World");
  const serif = runs.find((r) => r.text === "Serif bold line");
  check("text runs found", !!hello && runs.length >= 3, runs.map((r) => r.text).join(" | "));
  check("font matching", serif && serif.family === "serif" && serif.bold && hello.family === "sans",
    serif && `${serif.family} bold=${serif.bold}`);
  await clickAt(hello.x + 20, hello.base - 8);
  for (let i = 0; i < 11; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Hi there");
  await page.keyboard.press("Escape");
  s = await state();
  const replaced = s.objects.find((o) => o.cover);
  check("edit existing text", replaced && replaced.text === "Hi there" && Math.abs(replaced.size - 24) < 0.2,
    replaced && `${replaced.text} @ ${replaced.size}pt ${replaced.color}`);

  // Images: PNG straight in, WebP converted to PNG.
  await page.setInputFiles(".ed-file", path.join(OUT, "green.png"));
  await page.waitForFunction(() => document.getElementById("editRoot").__edit.state().objects.some((o) => o.type === "image"));
  await page.setInputFiles(".ed-file", path.join(OUT, "red.webp"));
  await page.waitForFunction(() => document.getElementById("editRoot").__edit.state().objects.filter((o) => o.type === "image").length === 2);
  s = await state();
  check("images added (WebP converted)", s.objects.filter((o) => o.type === "image").every((o) => o.mime === "image/png"));
  // Resizing an image from a corner keeps its shape.
  let img = (await state()).objects.filter((o) => o.type === "image").pop();
  await reveal(img.x + img.w, img.y + img.h);
  const h = await page.$(".ed-h-se");
  const hb = await h.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 15, hb.y + hb.height / 2 + i * 4);
  await page.mouse.up();
  const img2 = (await state()).objects.find((o) => o.id === img.id);
  check("image corner resize keeps aspect ratio", img2.w > img.w + 30 && Math.abs(img2.w / img2.h - img.w / img.h) < 0.01,
    `${img.w.toFixed(0)}x${img.h.toFixed(0)} -> ${img2.w.toFixed(0)}x${img2.h.toFixed(0)}`);
  await page.keyboard.press("Delete");

  // Text the standard fonts can't draw becomes an image.
  await tool("text");
  await clickAt(100, 700);
  await page.keyboard.type("नमस्ते दुनिया");
  check("non-Latin text shows the image note", await page.isVisible(".ed-raster-note"));
  await page.keyboard.press("Escape");

  await clickAt(350, 430); // select the rectangle so the properties bar shows
  await frameEditor();
  await page.screenshot({ path: path.join(SHOTS, "edit-1280.png") });

  // Rotated page 2.
  await page.click('[data-act="next"]');
  await page.waitForFunction(() => document.getElementById("editRoot").__edit.state().pageIndex === 1);
  await page.waitForFunction(() => document.getElementById("editRoot").__edit.state().renderedIndex === 1);
  await tool("rect");
  await dragPts(100, 100, 200, 200);
  await page.check('.ed-props [data-prop="fillOn"]');
  await page.$eval('.ed-props [data-prop="fill"]', (el) => { el.value = "#ff0000"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  s = await state();
  if (process.env.DEBUG) console.log(JSON.stringify(s.objects.map((o) => [o.page, o.type, o.x, o.y, o.w, o.h, o.fill, o.text])));
  check("rotated page shows in reading orientation", Math.abs(s.W - 792) < 1 && Math.abs(s.H - 612) < 1);

  // Save.
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnExecute")]);
  const file = path.join(OUT, "edited.pdf");
  await dl.saveAs(file);
  check("download is edited.pdf", dl.suggestedFilename() === "edited.pdf");
  const info = inspect(file);
  const span = (t) => info.spans.find((x) => x.text.includes(t));
  const a = span("Hello from e2e");
  check("added text in output at the clicked spot", a && a.page === 0 && Math.abs(a.x - 100) < 1 && Math.abs(a.y - 300) < 12,
    a && `${a.x.toFixed(1)},${a.y.toFixed(1)}`);
  const e = span("Hi there");
  check("edited text in output on the original baseline", e && Math.abs(e.x - 72) < 1 && Math.abs(e.y - 92) < 0.6,
    e && `${e.x.toFixed(1)},${e.y.toFixed(1)}`);
  check("old word is covered", info.world_dark === 0, `${info.world_dark} dark px`);
  check("rectangle drawn", info.rect_px[2] > 200 && info.rect_px[0] < 60, JSON.stringify(info.rect_px));
  check("image + Hindi text image embedded", info.images0 === 2, `${info.images0} images`);
  check("rotated page edit placed in displayed space", info.rot1 === 90 && info.p1_px[0] > 200 && info.p1_px[1] < 60
    && info.p1_out[1] > 200, `${JSON.stringify(info.p1_px)} ${JSON.stringify(info.p1_out)}`);
  check("nothing uploaded", uploads.length === 0, uploads.join(", "));

  // Phone layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-act="prev"]');
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => {
    const st = document.querySelector(".ed-stage");
    const pg = document.querySelector(".ed-page");
    return { stage: st.clientWidth, page: pg.offsetWidth, doc: document.documentElement.scrollWidth };
  });
  check("phone: page fits the width", overflow.page <= overflow.stage && overflow.doc <= 390, JSON.stringify(overflow));
  await clickAt(100, 300);
  await frameEditor();
  await page.screenshot({ path: path.join(SHOTS, "edit-390.png") });

  check("no console errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
