// End-to-end checks for tool chains ("Keep going" after a result) and saved recipes.
//   ULTRAPDF_DATA_DIR=$(mktemp -d) python3 -m uvicorn main:app --app-dir server --port 8805 &
//   BASE_URL=http://localhost:8805 node tests/e2e_chains.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:8805";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "ultrapdf-e2e-chains-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args]).toString();
py(`
import sys, pymupdf
d = pymupdf.open()
for i in range(3):
    p = d.new_page(); p.insert_text((72, 72), f"Chapter {i + 1}")
d.save(sys.argv[1] + "/three.pdf")
`, OUT);
const pdfText = (f) => py(`
import sys, pymupdf
print("|".join(p.get_text().replace("\\n", " ") for p in pymupdf.open(sys.argv[1])))
`, f);

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const waitDownload = async (action) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), action()]);
    const f = path.join(OUT, `${Date.now()}_${dl.suggestedFilename()}`);
    await dl.saveAs(f);
    return f;
  };

  // /my-recipes needs a server page entry; until then open it from the home page.
  const openRecipes = async () => {
    await page.goto(BASE);
    await page.click(".tool-card[href='/my-recipes']");
    await page.waitForSelector("#universalModal.open");
  };
  await page.goto(BASE);
  check("My Recipes card on the home page", await page.locator(".tool-card[href='/my-recipes']").count() === 1);

  // Step 1: page numbers, then carry the result into Compress without re-uploading.
  await page.goto(`${BASE}/add-page-numbers`);
  await page.waitForSelector("#universalModal.open");
  await page.setInputFiles("#fileInput", path.join(OUT, "three.pdf"));
  await page.fill("#pnFormat", "No. {n}");
  let f = await waitDownload(() => page.click("#btnExecute"));
  check("page numbers added", pdfText(f).includes("No. 2"));
  await page.waitForSelector("#chainBox");
  check("Keep going bar offers next tools", await page.locator("#chainBox [data-next='compress']").count() === 1);
  await page.click("#chainBox [data-next='compress']");
  await page.waitForFunction(() => document.getElementById("mTitle").textContent === "Compress PDF");
  check("next tool opens with the file already added", (await page.textContent("#selectedFilesList")).includes(".pdf"));
  f = await waitDownload(() => page.click("#btnExecute"));
  check("compressed file still has the page numbers", pdfText(f).includes("No. 3"));
  await page.waitForSelector("#chainBox .chain-keep");
  check("both steps listed", (await page.textContent("#chainBox .chain-steps")).includes("Page Numbers") && (await page.textContent("#chainBox .chain-steps")).includes("Compress PDF"));
  await page.fill("#chainBox .chain-name", "Number & shrink");
  await page.click("#chainBox .chain-keep");
  check("recipe saved", (await page.textContent("#chainBox .chain-keep")).includes("Saved"));

  // Run the saved recipe on a fresh file in one click.
  await openRecipes();
  const names = await page.locator(".recipe-name").allTextContents();
  check("My Recipes lists the saved recipe and the starters", names[0].startsWith("Number & shrink") && names.length >= 3, names.join(" / "));
  await page.setInputFiles("#fileInput", path.join(OUT, "three.pdf"));
  f = await waitDownload(async () => {
    await page.click("#btnExecute");
    await page.waitForSelector("#recipeBanner", { timeout: 20000 });
    check("recipe shows its steps while running", (await page.textContent("#recipeBanner")).includes("step"));
  });
  check("recipe output has the saved page-number format", pdfText(f).includes("No. 1"), pdfText(f).slice(0, 80));
  await page.waitForTimeout(300);
  check("banner gone when the recipe finishes", await page.locator("#recipeBanner").count() === 0);

  // Delete it again.
  await openRecipes();
  await page.click(".recipe-del");
  check("recipe can be deleted", !(await page.locator(".recipe-name").allTextContents()).some((n) => n.startsWith("Number & shrink")));

  // Phone layout of the Keep going bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/add-page-numbers`);
  await page.waitForSelector("#universalModal.open");
  await page.setInputFiles("#fileInput", path.join(OUT, "three.pdf"));
  await waitDownload(() => page.click("#btnExecute"));
  await page.waitForSelector("#chainBox");
  const overflow = await page.evaluate(() => document.getElementById("chainBox").scrollWidth > document.getElementById("chainBox").clientWidth + 2);
  check("Keep going bar fits a phone", !overflow);
  await page.locator("#chainBox").scrollIntoViewIfNeeded();
  fs.mkdirSync("/mnt/project-files/ultra_pdf/screens", { recursive: true });
  await page.locator("#chainBox").screenshot({ path: "/mnt/project-files/ultra_pdf/screens/chains-phone.png" });

  check("no console errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
