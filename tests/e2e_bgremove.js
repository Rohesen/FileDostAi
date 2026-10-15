// End-to-end checks for the Background Remover, in Chromium against a running server.
// By default the server finds the subject; the "This device" choice downloads the models (90 MB).
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8806 &
//   BASE_URL=http://localhost:8806 node tests/e2e_bgremove.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8806";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-bgr-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();

// A 900×700 "photo": a figure (head and shoulders) in front of a sky-to-grass background.
py(`
import sys, pymupdf
W, H = 900, 700
buf = bytearray(W * H * 3)
for y in range(H):
    for x in range(W):
        i = (y * W + x) * 3
        if y < 480: buf[i:i+3] = bytes((120 + y // 6, 170 + y // 8, 235))
        else: buf[i:i+3] = bytes((70, 140 - (y - 480) // 6, 60))
        if (x - 450) ** 2 + (y - 230) ** 2 < 95 ** 2: buf[i:i+3] = bytes((205, 150, 120))
        elif y > 330 and abs(x - 450) < 90 + (y - 330) * 0.7: buf[i:i+3] = bytes((200, 30, 40))
pix = pymupdf.Pixmap(pymupdf.csRGB, W, H, bytes(buf), False)
pix.save(sys.argv[1] + "/person.png")
pymupdf.Pixmap(pix, 600, 466, None).save(sys.argv[1] + "/person-small.png")
`, OUT);
// An exam-style photo: the same figure, with a white strip and a name and date printed under it.
py(`
import sys, pymupdf
src = pymupdf.Pixmap(sys.argv[1] + "/person.png")
doc = pymupdf.open(); page = doc.new_page(width=900, height=820)
page.insert_image(pymupdf.Rect(0, 0, 900, 700), pixmap=src)
page.insert_text((250, 760), "RAHUL KUMAR", fontsize=44, fontname="hebo")
page.insert_text((330, 805), "14/10/2026", fontsize=36, fontname="hebo")
page.get_pixmap(dpi=72).save(sys.argv[1] + "/exam.png")
`, OUT);

const px = (file, points) => JSON.parse(py(`
import sys, json, pymupdf
p = pymupdf.Pixmap(sys.argv[1])
pts = json.loads(sys.argv[2])
print(json.dumps({"w": p.width, "h": p.height, "alpha": p.alpha, "px": [list(p.pixel(x, y)) for x, y in pts]}))
`, file, JSON.stringify(points)));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const modelGets = [];
  page.on("request", (r) => { if (/onnx\.part/.test(r.url())) modelGets.push(r.url()); });
  const save = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), page.click("#btnExecute")]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };

  await page.goto(`${BASE}/remove-background`);
  await page.waitForSelector("#universalModal.open");
  check("tool opens from its own page", await page.locator("#bgrRoot .bgr").count() === 1);
  check("tool has its own SVG icon", await page.evaluate(() => Icons.glyph({ id: "remove-bg" }).startsWith("<svg")));
  const t0 = Date.now();
  await page.setInputFiles("#fileInput", path.join(OUT, "person.png"));
  await page.waitForFunction(() => /px/.test(document.querySelector("#bgrInfo").textContent) || /bad/.test(document.querySelector("#bgrInfo").className), null, { timeout: 180000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await page.textContent("#bgrInfo");
  check("finds the subject on the server", /900×700 px/.test(info) && modelGets.length === 0, `${info}, ${secs}s, ${modelGets.length} model downloads`);
  check("says the server is used", /server/i.test(await page.textContent("#privacyNote")));

  // See-through PNG: the sky corner is clear, the figure is solid.
  let f = await save();
  let r = px(f, [[20, 20], [880, 680], [450, 230], [450, 520]]);
  check("saves a see-through PNG", /_no_background\.png$/.test(f) && r.alpha === 1 && r.w === 900, `${path.basename(f)} ${r.w}×${r.h}`);
  check("background is removed", r.px[0][3] < 20 && r.px[1][3] < 20, JSON.stringify(r.px.slice(0, 2)));
  check("subject is kept", r.px[2][3] > 230 && r.px[3][3] > 230, JSON.stringify(r.px.slice(2)));

  // White background as JPG.
  await page.check('input[name="bgrBg"][value="white"]', { force: true });
  await page.selectOption("#bgrFmt", "jpeg");
  f = await save();
  r = px(f, [[20, 20], [450, 520]]);
  check("white background as JPG", /\.jpg$/.test(f) && r.px[0].every((v) => v > 245) && r.px[1][0] > 150 && r.px[1][1] < 80, JSON.stringify(r.px));

  // Custom colour (light blue swatch), trimmed to the subject.
  await page.check('input[name="bgrBg"][value="colour"]', { force: true });
  check("colour choices appear", await page.isVisible("#bgrColours"));
  await page.click('.bgr-sw[data-c="#1e5bbd"]');
  await page.check("#bgrTrim");
  await page.selectOption("#bgrFmt", "png");
  f = await save();
  r = px(f, [[2, 2]]);
  check("custom colour background", Math.abs(r.px[0][0] - 0x1e) < 4 && Math.abs(r.px[0][2] - 0xbd) < 4, JSON.stringify(r.px));
  check("trim makes it smaller", r.w < 900 && r.h <= 700, `${r.w}×${r.h}`);

  // Hold to compare shows the original.
  await page.hover("#bgrCompare");
  await page.mouse.down();
  const shown = await page.evaluate(() => document.querySelector("#bgrStage").classList.contains("show-before"));
  await page.mouse.up();
  check("hold to see the original", shown);
  await page.screenshot({ path: path.join(OUT, "bgr.png") });

  // Second photo.
  const t1 = Date.now(), gets = modelGets.length;
  await page.uncheck("#bgrTrim");
  await page.setInputFiles("#fileInput", path.join(OUT, "person-small.png"));
  await page.waitForFunction(() => /600×466 px/.test(document.querySelector("#bgrInfo").textContent), null, { timeout: 90000 });
  check("second photo needs no download", modelGets.length === gets, `${((Date.now() - t1) / 1000).toFixed(1)}s`);
  check("no name strip on an ordinary photo", await page.isHidden("#bgrStripRow"));

  // Exam photo: the name and date strip goes with the background, unless the visitor keeps it.
  await page.check('input[name="bgrBg"][value="none"]', { force: true });
  await page.setInputFiles("#fileInput", path.join(OUT, "exam.png"));
  await page.waitForFunction(() => /900×820 px/.test(document.querySelector("#bgrInfo").textContent), null, { timeout: 90000 });
  check("name strip is found", await page.isVisible("#bgrStripRow") && /strip was removed/.test(await page.textContent("#bgrInfo")));
  f = await save();
  r = px(f, [[300, 750], [450, 790], [450, 230], [450, 640]]);
  check("name strip is removed", r.px[0][3] < 20 && r.px[1][3] < 20, JSON.stringify(r.px.slice(0, 2)));
  check("person above the strip is kept", r.px[2][3] > 230 && r.px[3][3] > 230, JSON.stringify(r.px.slice(2)));
  await page.check("#bgrKeepStrip");
  check("strip can be kept", !/strip was removed/.test(await page.textContent("#bgrInfo")));

  // On this device: the models download once and run in the browser, nothing is sent.
  const posts = [];
  page.on("request", (q) => { if (q.method() === "POST") posts.push(q.url()); });
  await page.evaluate(() => { document.querySelector("#bgrInfo").textContent = ""; });
  await page.selectOption("#bgrWhere", "device");
  await page.waitForFunction(() => /900×820 px/.test(document.querySelector("#bgrInfo").textContent), null, { timeout: 180000 });
  f = await save();
  r = px(f, [[20, 20], [450, 230], [450, 790]]);
  check("on this device works too", r.px[0][3] < 20 && r.px[1][3] > 230 && r.px[2][3] < 20, JSON.stringify(r.px));
  check("on this device downloads both models and sends nothing", modelGets.length === 4 && posts.length === 0,
    `${modelGets.map((u) => path.basename(u)).join(", ")}; posts: ${posts.join(", ")}`);

  check("no console errors (CSP included)", errors.length === 0, errors.join(" | "));
  console.log(`screenshot: ${path.join(OUT, "bgr.png")}`);
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
