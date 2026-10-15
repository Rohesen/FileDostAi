// End-to-end check of the real app in Chromium: page grid, in-browser tools, the worker,
// per-tool addresses, offline mode and the upload limit.
//
//   npm install            (once, installs Playwright from package.json)
//   ULTRAPDF_MAX_UPLOAD_MB=1 python3 -m uvicorn main:app --port 8765 &
//   node tests/e2e_browser.js
//
// Env: BASE_URL (default http://localhost:8765), CHROMIUM_PATH (optional browser binary).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8765";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// Fixture PDFs, made with the Python stack the server already needs.
function makeFixtures() {
  execFileSync("python3", ["-c", `
import io, sys, pymupdf
from reportlab.pdfgen import canvas
def pdf(n, label, path):
    buf = io.BytesIO(); c = canvas.Canvas(buf)
    for p in range(1, n + 1):
        c.setFont("Helvetica-Bold", 40); c.drawString(72, 700, f"{label} page {p}"); c.showPage()
    c.setTitle(f"{label} title"); c.save(); open(path, "wb").write(buf.getvalue())
out = sys.argv[1]
pdf(3, "Alpha", out + "/a.pdf"); pdf(2, "Beta", out + "/b.pdf")
from PIL import Image
noise = io.BytesIO(); Image.effect_noise((1500, 1500), 90).convert("RGB").save(noise, "JPEG", quality=95)
big = pymupdf.open(); pg = big.new_page(); pg.insert_image(pg.rect, stream=noise.getvalue())
big.save(out + "/big.pdf")
`, OUT]);
}

function pdfInfo(file) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json, sys, pymupdf
d = pymupdf.open(sys.argv[1])
print(json.dumps({"pages": [p.get_text().strip().split("\\n")[0] if p.get_text().strip() else "" for p in d],
  "rot": [p.rotation for p in d], "images": [len(p.get_images()) for p in d], "title": d.metadata.get("title")}))
`, file]).toString());
}

async function main() {
  makeFixtures();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const apiCalls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  // Only uploads count: the rating stars on the home page are fetched with a GET.
  page.on("request", (r) => { if (r.url().includes("/api/") && r.method() === "POST") apiCalls.push(r.url()); });

  async function save(trigger) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), trigger()]);
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    return file;
  }
  async function open(slug, files) {
    await page.goto(`${BASE}/${slug}`);
    await page.waitForSelector("#universalModal.open");
    if (files) await page.setInputFiles("#fileInput", files.map((f) => path.join(OUT, f)));
  }
  async function thumbsDrawn(n) {
    await page.waitForFunction((n) => document.querySelectorAll(".page-thumb canvas[data-drawn]").length >= n, n, { timeout: 20000 });
    // A drawn thumbnail has dark text pixels on white.
    return page.evaluate(() => [...document.querySelectorAll(".page-thumb canvas")].every((c) => {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) return true;
      return false;
    }));
  }

  // 1. Per-tool address opens the tool, with its own title.
  await open("merge-pdf");
  check("tool page opens its tool", (await page.title()).startsWith("Merge PDF"));

  // 2. Merge with the page grid: thumbnails, move, rotate, delete.
  await page.setInputFiles("#fileInput", [path.join(OUT, "a.pdf"), path.join(OUT, "b.pdf")]);
  check("merge shows a thumbnail for each page", await thumbsDrawn(5), "5 pages");
  const cards = page.locator(".page-card");
  await cards.nth(3).locator('button[title="Move left"]').click(); // Beta 1 before Alpha 3
  await cards.nth(0).locator('button[title="Turn right"]').click();
  await cards.nth(4).locator('button[title="Delete page"]').click(); // drop Beta 2
  let info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("merge keeps grid order, rotation and deletions",
    JSON.stringify(info.pages) === JSON.stringify(["Alpha page 1", "Alpha page 2", "Beta page 1", "Alpha page 3"]) && info.rot[0] === 90,
    JSON.stringify(info));

  // 3. Organize: drag and drop.
  await open("organize-pdf", ["a.pdf"]);
  await thumbsDrawn(3);
  const first = page.locator(".page-card").nth(0);
  const last = page.locator(".page-card").nth(2);
  const box = await last.boundingBox();
  await first.dragTo(last, { targetPosition: { x: box.width - 5, y: box.height / 2 } });
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("drag a page to the end", info.pages.join() === "Alpha page 2,Alpha page 3,Alpha page 1", info.pages.join());

  // 4. Split: click pages, the range box follows.
  await open("split-pdf", ["a.pdf"]);
  await thumbsDrawn(3);
  await page.locator(".page-card").nth(0).click();
  await page.locator(".page-card").nth(2).click();
  check("clicking pages fills the range box", (await page.inputValue("#splitRanges")) === "1, 3");
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("split saves the selected pages", info.pages.join() === "Alpha page 1,Alpha page 3");

  // 5. Remove pages by typing; the grid follows.
  await open("remove-pages", ["a.pdf"]);
  await thumbsDrawn(3);
  await page.fill("#removePagesList", "2");
  check("typing a page marks it in the grid", (await page.locator(".page-card.is-removed").count()) === 1);
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("remove pages", info.pages.join() === "Alpha page 1,Alpha page 3");

  // 6. Rotate one page by clicking it.
  await open("rotate-pdf", ["a.pdf"]);
  await thumbsDrawn(3);
  await page.locator(".page-card").nth(1).click();
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("rotate a single page", info.rot.join() === "0,90,0");

  // 7. Sign: type a name, click the page.
  await open("sign-pdf", ["a.pdf"]);
  await page.click('.sign-tab[data-tab="type"]');
  await page.fill("#sigText", "Rohesen");
  await page.waitForFunction(() => document.querySelector("#sigPageCanvas").width > 100);
  await page.locator("#sigPageCanvas").click({ position: { x: 150, y: 300 } });
  await page.waitForSelector("#sigGhost:not([hidden])");
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("sign stamps an image on the chosen page", info.images[0] === 1 && info.images[1] === 0, JSON.stringify(info.images));

  // 8. Metadata is read in the browser and saved back.
  await open("edit-pdf-metadata", ["a.pdf"]);
  await page.waitForFunction(() => document.querySelector("#metaTitle").value !== "");
  check("metadata form is pre-filled", (await page.inputValue("#metaTitle")) === "Alpha title");
  await page.fill("#metaTitle", "New title");
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("metadata saved", info.title === "New title");

  // 9. PDF to JPG gives a ZIP with one image per page.
  await open("pdf-to-jpg", ["a.pdf"]);
  const zip = await save(() => page.click("#btnExecute"));
  const names = execFileSync("python3", ["-c", "import sys,zipfile;print(','.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", zip]).toString().trim();
  check("PDF to JPG", names === "page_1.jpg,page_2.jpg,page_3.jpg", names);

  // 10. PDF to text runs in the browser.
  await open("pdf-to-text", ["a.pdf"]);
  await page.click("#btnExecute");
  await page.waitForSelector("#mdOutput");
  check("PDF to text", (await page.inputValue("#mdOutput")).includes("Alpha page 3"));

  check("browser tools made no server calls", apiCalls.length === 0, apiCalls.join(" "));

  // 11. Upload limit (server started with ULTRAPDF_MAX_UPLOAD_MB=1).
  await open("compress-pdf", ["big.pdf"]);
  await page.click("#btnExecute");
  const toast = await page.waitForSelector(".toast.error", { timeout: 20000 });
  check("server tools explain the size limit", /too large/i.test(await toast.textContent()), await toast.textContent());

  // 12. Offline: the app and its browser tools work with no network.
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.goto(`${BASE}/rotate-pdf`);
  await page.setInputFiles("#fileInput", path.join(OUT, "a.pdf"));
  await thumbsDrawn(3);
  await page.click('button[data-action="right"]');
  info = pdfInfo(await save(() => page.click("#btnExecute")));
  check("works offline after the first visit", info.rot.join() === "90,90,90");
  await context.setOffline(false);

  // 13. Phone layout has no sideways scrolling.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${BASE}/merge-pdf`);
  await phone.setInputFiles("#fileInput", [path.join(OUT, "a.pdf"), path.join(OUT, "b.pdf")]);
  await phone.waitForSelector(".page-card");
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll on a phone", overflow <= 0, `${overflow}px`);
  if (process.env.SCREENSHOTS) {
    await phone.screenshot({ path: path.join(process.env.SCREENSHOTS, "phone-merge.png") });
  }

  // The upload-limit check above causes one expected 413 in the console.
  const unexpected = errors.filter((e) => !/413/.test(e));
  check("no errors in the browser console", unexpected.length === 0, unexpected.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
