// End-to-end checks for crop, resize, headers & footers, dark mode, compare, summarize,
// read aloud and ratings, in Chromium against a running server.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --port 8790 &
//   BASE_URL=http://localhost:8790 node tests/e2e_more_tools.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8790";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e2-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();

py(`
import sys, pymupdf
out = sys.argv[1]
para = "UltraPDF keeps documents private by running tools in the browser. "
def doc(path, words):
    d = pymupdf.open()
    for i in range(2):
        p = d.new_page()
        p.insert_textbox(pymupdf.Rect(72, 72, 520, 760), (words + " ") * 1 + (para * 12) + f" Page {i+1} ends here.", fontsize=11)
    d.set_metadata({"title": "Quarterly plan"})
    d.save(path)
doc(out + "/old.pdf", "The budget is 500 dollars and the deadline is Friday.")
doc(out + "/new.pdf", "The budget is 750 dollars and the deadline is Monday.")
`, OUT);

const info = (file) => JSON.parse(py(`
import sys, json, pymupdf
d = pymupdf.open(sys.argv[1]); p = d[0]
pix = p.get_pixmap(dpi=20)
print(json.dumps({"pages": len(d), "w": round(p.rect.width), "h": round(p.rect.height), "text": p.get_text(),
  "mean": sum(pix.samples) / len(pix.samples)}))
`, file));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const save = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#btnExecute")]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };
  const open = async (slug, files) => {
    await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  };

  // Crop: drag a box over the top-left of the page.
  await page.setViewportSize({ width: 1280, height: 1600 });
  await open("crop-pdf", ["old.pdf"]);
  await page.waitForFunction(() => document.querySelector("#cropCanvas").width > 100);
  await page.locator("#cropStage").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector("#cropStage").scrollIntoView({ block: "start" }));
  const st = await page.locator("#cropStage").boundingBox();
  const se = await page.locator(".crop-handle.h-se").boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(st.x + st.width / 2, st.y + st.height / 4, { steps: 5 });
  await page.mouse.up();
  let r = info(await save());
  check("crop keeps the dragged area", Math.abs(r.w - 306) < 12 && Math.abs(r.h - 210) < 12, `${r.w}x${r.h}`);

  await page.setViewportSize({ width: 1280, height: 900 });
  // Resize to A4.
  await open("resize-pdf", ["old.pdf"]);
  r = info(await save());
  check("resize to A4", r.w === 595 && r.h === 842, `${r.w}x${r.h}`);

  // Headers and footers with the defaults ({title}, {date}, Page {n} of {total}).
  await open("header-footer-pdf", ["old.pdf"]);
  r = info(await save());
  check("header and footer text added", r.text.includes("Quarterly plan") && r.text.includes("Page 1 of 2"));

  // Dark mode.
  await open("invert-pdf-colors", ["old.pdf"]);
  r = info(await save());
  check("dark mode makes the page dark", r.mean < 60, `mean ${r.mean.toFixed(0)}`);

  // The rating prompt appears after a tool works, and a rating shows on the tool card.
  await page.waitForSelector("#rateBox");
  await page.click('#rateBox .rate-stars button[data-n="5"]');
  await page.fill("#rateComment", "Works great");
  await page.click("#rateSend");
  await page.waitForSelector(".rate-thanks");
  await page.goto(BASE);
  await page.waitForSelector('a[href="/invert-pdf-colors"] .card-rating');
  check("rating shows on the tool card", (await page.textContent('a[href="/invert-pdf-colors"] .card-rating')).includes("5"));

  // Compare.
  await open("compare-pdf", ["old.pdf", "new.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector("#cmpB");
  const ins = await page.$$eval("#cmpB ins", (els) => els.map((e) => e.textContent).join("|"));
  const del = await page.$$eval("#cmpA del", (els) => els.map((e) => e.textContent).join("|"));
  check("compare finds the changed words", ins.includes("750") && ins.includes("Monday") && del.includes("500") && del.includes("Friday"), `${ins} / ${del}`);
  await page.click('.sign-tab[data-view="visual"]');
  await page.waitForFunction(() => /changed|identical/.test(document.querySelector("#cmpPixels").textContent));
  check("visual compare marks the changed page", (await page.textContent("#cmpPixels")).includes("changed"));

  // Summarize (offline key-sentence fallback in this browser).
  await open("summarize-pdf", ["old.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector(".ai-summary-list li, .toast.error");
  const sumErr = await page.$(".toast.error");
  if (sumErr) console.log("summary error:", await sumErr.textContent());
  check("summary has key points", (await page.$$(".ai-summary-list li")).length >= 2);

  // Read aloud renders the sentence list.
  await open("pdf-to-audio", ["old.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector("#ttsText span");
  check("read aloud lists sentences", (await page.$$("#ttsText span")).length > 5);

  // Report a problem form.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator('.footer-grid [data-feedback="problem"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.click('.footer-grid [data-feedback="problem"]');
  await page.fill("#fbComment", "Crop handles are small on my phone");
  await page.click("#fbSend");
  await page.waitForSelector(".toast.success");
  check("problem report sent", true);

  check("no browser console errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
