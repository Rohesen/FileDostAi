// Barcode Generator: Code 128, EAN-13, EAN-8, UPC-A, Code 39, ITF-14 and Codabar, as PNG or SVG.
// One code or many (one per line, saved together in a ZIP). Runs in the browser with JsBarcode (MIT),
// loaded only when the tool opens.

const BarcodeTool = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!document.querySelector("link[data-qr-css]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/qr-tool.css?v=40" });
    link.dataset.qrCss = "1";
    document.head.append(link);
  }

  let loading = null;
  function load() {
    if (window.JsBarcode) return Promise.resolve(window.JsBarcode);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = Object.assign(document.createElement("script"), { src: "/static/vendor/jsbarcode.min.js?v=40" });
        s.onload = () => (window.JsBarcode ? resolve(window.JsBarcode) : reject(new Error("no JsBarcode")));
        s.onerror = () => { loading = null; s.remove(); reject(new Error("load failed")); };
        document.head.append(s);
      });
    }
    return loading;
  }

  const TYPES = {
    CODE128: { label: "Code 128 (any text, most common)", sample: "FILEDOST-001", help: "Letters, numbers and symbols. Used for shipping labels, stock and ID cards." },
    EAN13: { label: "EAN-13 (product barcode in shops)", sample: "890123456789", help: "12 digits; the 13th (check digit) is added for you. Indian products start with 890." },
    EAN8: { label: "EAN-8 (small products)", sample: "8901234", help: "7 digits; the check digit is added for you." },
    UPC: { label: "UPC-A (USA and Canada products)", sample: "03600029145", help: "11 digits; the check digit is added for you." },
    CODE39: { label: "Code 39 (factories, ID badges)", sample: "ABC-1234", help: "Capital letters, numbers, space and - . $ / + %." },
    ITF14: { label: "ITF-14 (cartons)", sample: "1540014128876", help: "13 digits; the check digit is added for you." },
    codabar: { label: "Codabar (libraries, blood banks)", sample: "A12345B", help: "Numbers and - $ : / . +, starting and ending with A, B, C or D." },
  };

  const configHtml = `<div id="bcRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="qr bc">
        <div class="qr-grid">
          <div class="qr-fields">
            <div class="form-group"><label class="form-label" for="bcType">Barcode type</label>
              <select id="bcType" class="form-select">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join("")}</select>
              <p class="drop-hint" id="bcHelp"></p></div>
            <div class="form-group"><label class="form-label" for="bcText">Text or number <span class="bc-sub">(one per line for many barcodes)</span></label>
              <textarea id="bcText" class="form-input bc-text" rows="3" spellcheck="false" autocomplete="off"></textarea></div>
            <details class="qr-style">
              <summary>Size and look</summary>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="bcHeight">Bar height</label>
                  <select id="bcHeight" class="form-select"><option value="50">Short</option><option value="90" selected>Normal</option><option value="140">Tall</option></select></div>
                <div class="form-group"><label class="form-label" for="bcWidth">Thickness</label>
                  <select id="bcWidth" class="form-select"><option value="2">Thin</option><option value="3" selected>Normal</option><option value="4">Thick (big labels)</option></select></div>
              </div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="bcColor">Bars</label><input type="color" id="bcColor" class="qr-color" value="#000000"></div>
                <div class="form-group"><label class="form-label" for="bcBg">Background</label><input type="color" id="bcBg" class="qr-color" value="#ffffff"></div>
              </div>
              <label class="checkbox-group"><input type="checkbox" id="bcShow" checked> Print the text under the bars</label>
            </details>
          </div>
          <div class="qr-out">
            <div class="bc-preview" id="bcPreview"><p class="qr-placeholder">Loading…</p></div>
            <p class="qr-info" id="bcInfo"></p>
            <div class="qr-dl-row">
              <button type="button" class="btn btn-primary" id="bcPng" disabled>${Icons.ui("download")} PNG</button>
              <button type="button" class="btn btn-secondary" id="bcSvg" disabled>${Icons.ui("download")} SVG</button>
            </div>
          </div>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    const shared = { drop: document.getElementById("dropZone"), exec: document.getElementById("btnExecute") };
    if (shared.drop) shared.drop.style.display = "none";
    if (shared.exec) shared.exec.style.display = "none";
    let lib = null, good = [];

    function opts() {
      return {
        format: $("bcType").value, height: Number($("bcHeight").value), width: Number($("bcWidth").value),
        lineColor: $("bcColor").value, background: $("bcBg").value, displayValue: $("bcShow").checked,
        margin: 14, fontSize: 18, textMargin: 4, font: "monospace",
      };
    }
    function lines() { return $("bcText").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 500); }

    /** Draws one code into an <svg>; returns it or null when the text doesn't fit the type. */
    function svgOf(text, o) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      let ok = true;
      try { lib(svg, text, { ...o, valid: (v) => { ok = v; } }); } catch (e) { ok = false; }
      return ok ? svg : null;
    }
    function canvasOf(text, o) {
      const c = document.createElement("canvas");
      let ok = true;
      try { lib(c, text, { ...o, valid: (v) => { ok = v; } }); } catch (e) { ok = false; }
      return ok ? c : null;
    }

    function refresh() {
      const t = TYPES[$("bcType").value];
      $("bcHelp").textContent = t.help;
      if (!lib) return;
      const o = opts(), list = lines();
      const box = $("bcPreview");
      good = []; const bad = [];
      list.forEach((s) => (svgOf(s, o) ? good : bad).push(s));
      box.innerHTML = "";
      if (!list.length) box.innerHTML = '<p class="qr-placeholder">Type a number or text to make a barcode.</p>';
      good.slice(0, 3).forEach((s) => box.append(svgOf(s, o)));
      const info = $("bcInfo");
      info.classList.toggle("warn", bad.length > 0);
      info.textContent = bad.length
        ? `${bad.length === 1 ? `“${bad[0]}” doesn't` : `${bad.length} lines don't`} fit ${t.label.split(" (")[0]}. ${t.help}`
        : good.length > 1 ? `${good.length} barcodes. PNG and SVG save them all in one ZIP.` : good.length ? "Scan-ready. PNG for printing and sharing, SVG for any size." : "";
      $("bcPng").disabled = $("bcSvg").disabled = !good.length;
    }

    const base = (s) => `barcode_${s.replace(/[^\w.-]+/g, "_").slice(0, 40) || "code"}`;
    async function save(kind) {
      if (!good.length) return;
      const o = opts();
      const items = [];
      for (const s of good) {
        if (kind === "svg") {
          const svg = svgOf(s, o);
          svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          items.push({ filename: `${base(s)}.svg`, bytes: new TextEncoder().encode(svg.outerHTML), mime: "image/svg+xml" });
        } else {
          const blob = await fastCanvasBlob(canvasOf(s, o), "image/png");
          items.push({ filename: `${base(s)}.png`, bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" });
        }
      }
      if (items.length === 1) {
        downloadBlob(new Blob([items[0].bytes], { type: items[0].mime }), items[0].filename);
        showToast(`Done! Downloaded ${items[0].filename}. Nothing was uploaded.`, "success");
        return;
      }
      const names = new Set();
      items.forEach((m) => { let n = m.filename, k = 2; while (names.has(n)) n = m.filename.replace(/(\.\w+)$/, `_${k++}$1`); names.add(n); m.filename = n; });
      const z = await ImageKit.zipOf(items, `barcodes_${kind}.zip`);
      downloadBlob(new Blob([z.bytes], { type: "application/zip" }), z.filename);
      showToast(`Done! Downloaded ${items.length} barcodes in ${z.filename}. Nothing was uploaded.`, "success");
    }

    $("bcType").addEventListener("change", () => {
      const prev = Object.values(TYPES).map((t) => t.sample);
      if (!$("bcText").value.trim() || prev.includes($("bcText").value.trim())) $("bcText").value = TYPES[$("bcType").value].sample;
      refresh();
    });
    root.addEventListener("input", (e) => { if (e.target.id !== "bcType") refresh(); });
    root.addEventListener("change", (e) => { if (e.target.id !== "bcType") refresh(); });
    $("bcPng").onclick = () => save("png").catch(() => showToast("Couldn't make the picture.", "error"));
    $("bcSvg").onclick = () => save("svg").catch(() => showToast("Couldn't make the file.", "error"));
    $("bcText").value = TYPES.CODE128.sample;
    $("bcHelp").textContent = TYPES.CODE128.help;
    load().then((l) => { lib = l; refresh(); }).catch(() => {
      $("bcPreview").innerHTML = '<p class="qr-placeholder">Couldn\'t load the barcode maker. Check your connection and try again.</p>';
    });

    return {
      destroy() {
        if (shared.drop) shared.drop.style.display = "";
        if (shared.exec) shared.exec.style.display = "";
      },
    };
  }

  return { configHtml, create, esc };
})();

TOOLS.push({
  id: "barcode-generator",
  slug: "barcode-generator",
  aliases: ["barcode-maker", "create-barcode", "ean-13-barcode", "code-128-barcode", "upc-barcode", "product-barcode", "barcode-creator"],
  name: "Barcode Generator",
  desc: "Make barcodes for products, stock and labels: Code 128, EAN-13, UPC and more. Download PNG or SVG, one or hundreds at once.",
  keywords: "barcode generator barcode maker create barcode ean 13 ean-13 code 128 upc-a code 39 product barcode stock label inventory shop sticker itf-14 codabar print barcode png svg",
  category: "image",
  badge: "New",
  accept: "image/*",
  acceptLabel: "nothing (type the code)",
  wide: true,
  caption: "EAN, UPC, Code 128",
  configHtml: BarcodeTool.configHtml,
  onOpen: (ctx) => { ctx.bc = BarcodeTool.create(ctx.el("bcRoot")); },
  onClose: (ctx) => ctx.bc && ctx.bc.destroy(),
  run: async () => { throw new ClientPDF.UserError("Use the PNG or SVG buttons under the preview."); },
});
