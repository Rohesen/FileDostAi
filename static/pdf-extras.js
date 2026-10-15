// PDF extras: Compress PDF to an exact size, Extract images, N-up and Booklet printing,
// Bookmarks & Contents, and Split by Chapters.
// Everything runs in the browser with pdf-lib and pdf.js, except Compress to Size, which first
// tries the server's compressor (files processed in memory, never stored) and then falls back
// to the browser.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/pdf-extras.css?v=13" }));

const PdfExtras = (() => {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFRef, StandardFonts, rgb, degrees } = PDFLib;
  const UserError = ClientPDF.UserError;
  const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };

  // ---------- small helpers ----------

  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const stem = (name) => String(name || "document").replace(/\.[^.]+$/, "") || "document";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function checkCancel(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
      const e = new Error("Cancelled");
      e.cancelled = true;
      throw e;
    }
  }

  async function loadPdf(bytes) {
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      throw new UserError("This file doesn't look like a valid PDF.");
    }
    if (doc.isEncrypted) throw new UserError("This PDF is password protected. Use Unlock PDF first.");
    return doc;
  }

  function safeFileName(s, fallback) {
    const clean = String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return clean || fallback;
  }

  function canvasBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
      if (!blob) return reject(new UserError("This page is too large for your browser to turn into a picture."));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, type, quality));
  }

  /** Page size as the reader sees it (crop box, rotation applied). */
  function viewOf(page) {
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    return { box, rot, width: rot % 180 ? box.height : box.width, height: rot % 180 ? box.width : box.height };
  }

  /** Draws an embedded page upright, scaled to fit and centred in the cell {x, y, w, h}. */
  function drawFitted(sheet, emb, view, cell) {
    const s = Math.min(cell.w / view.width, cell.h / view.height);
    const dw = view.width * s, dh = view.height * s;
    const ox = cell.x + (cell.w - dw) / 2;
    const oy = cell.y + (cell.h - dh) / 2;
    const at = { 0: [ox, oy], 90: [ox, oy + dh], 180: [ox + dw, oy + dh], 270: [ox + dw, oy] }[view.rot];
    sheet.drawPage(emb, { x: at[0], y: at[1], xScale: s, yScale: s, rotate: degrees(-view.rot) });
    return { x: ox, y: oy, w: dw, h: dh };
  }

  /** Embeds source pages into out on first use (once each). */
  function embedder(out, src) {
    const pages = src.getPages();
    const cache = new Map();
    return async (i) => {
      if (!cache.has(i)) {
        const view = viewOf(pages[i]);
        const b = view.box;
        const emb = await out.embedPage(pages[i], { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height });
        cache.set(i, { emb, view });
      }
      return cache.get(i);
    };
  }

  function showResult(ctx, html, tone = "ok") {
    const box = ctx.el("pxResult");
    if (!box) return;
    box.hidden = false;
    box.className = `px-result px-${tone}`;
    box.innerHTML = html;
  }

  // =====================================================================
  // 1. Compress PDF to an exact size
  // =====================================================================

  const SIZE_CHIPS = [[100, "KB"], [200, "KB"], [500, "KB"], [1, "MB"], [2, "MB"]];

  const sizeConfig = `
    <div class="form-group px-target">
      <label class="form-label" for="pxTarget">Make it smaller than</label>
      <div class="px-target-row">
        <input type="number" id="pxTarget" class="form-input" min="1" step="any" value="200" inputmode="decimal" aria-label="Target size">
        <select id="pxUnit" class="form-select" aria-label="Unit">
          <option value="KB" selected>KB</option>
          <option value="MB">MB</option>
        </select>
      </div>
      <div class="px-chips" role="group" aria-label="Common limits">
        ${SIZE_CHIPS.map(([n, u]) => `<button type="button" class="btn btn-xs px-chip" data-px-size="${n}" data-px-unit="${u}">${n} ${u}</button>`).join("")}
      </div>
    </div>
    <label class="checkbox-group"><input type="checkbox" id="pxAllowRaster" checked> If needed, turn pages into pictures to reach the size (text can't be selected afterwards)</label>
    <p class="drop-hint" id="pxSizeInfo">We try normal compression first (text stays sharp) and only use pictures if that isn't enough.</p>
    <div class="px-result" id="pxResult" hidden></div>`;

  function targetBytes(ctx) {
    const n = Number(ctx.value("pxTarget"));
    if (!n || n <= 0) throw new UserError("Type the size you need, for example 200 KB or 1 MB.");
    const bytes = Math.floor(n * (ctx.value("pxUnit") === "MB" ? 1048576 : 1024));
    if (bytes < 10 * 1024) throw new UserError("That's too small for a PDF. Pick at least 10 KB.");
    return bytes;
  }

  function updateSizeInfo(ctx) {
    const info = ctx.el("pxSizeInfo");
    if (!info) return;
    let t = 0;
    try { t = targetBytes(ctx); } catch (e) { /* not typed yet */ }
    document.querySelectorAll(".px-chip").forEach((b) => {
      const v = Math.floor(Number(b.dataset.pxSize) * (b.dataset.pxUnit === "MB" ? 1048576 : 1024));
      b.classList.toggle("active", v === t);
    });
    const f = ctx.files && ctx.files[0];
    if (!f) return;
    info.textContent = !t ? `Your file is ${kb(f.size)}.`
      : f.size <= t ? `Your file is ${kb(f.size)}, already under ${kb(t)}.`
        : `Your file is ${kb(f.size)}. Target: under ${kb(t)} (${Math.round((1 - t / f.size) * 100)}% smaller).`;
  }

  async function serverCompress(ctx, level, label) {
    const fd = new FormData();
    fd.append("file", ctx.files[0]);
    fd.append("level", level);
    const r = await serverRequest("/api/compress", fd, ctx, { quiet: true, label: `Compressing on the server: ${label}…` });
    return r.bytes;
  }

  // Quality ladder for the picture fallback, best first: [dpi, JPEG quality].
  const LADDER = [
    [150, 0.85], [150, 0.72], [150, 0.6], [120, 0.72], [120, 0.6], [150, 0.5], [120, 0.5], [96, 0.6], [96, 0.5],
    [120, 0.4], [96, 0.4], [72, 0.5], [72, 0.4], [96, 0.32], [72, 0.32], [60, 0.4], [60, 0.32], [72, 0.25],
    [60, 0.25], [50, 0.32], [50, 0.25], [60, 0.18], [50, 0.18], [50, 0.12],
  ];
  const MAX_PIXELS = 12e6;

  function scaleFor(base, dpi) {
    let s = dpi / 72;
    if (base.w * base.h * s * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (base.w * base.h));
    return s;
  }

  /** Renders a page at dpi and returns its JPEG bytes at each of the given qualities. */
  async function renderJpegs(pdfPage, size, dpi, qualities, canvas) {
    await PdfRender.renderPage(pdfPage, canvas, { scale: scaleFor(size, dpi) });
    const out = {};
    for (const q of qualities) out[q] = await canvasBytes(canvas, "image/jpeg", q);
    return out;
  }

  async function buildImagePdf(pages) {
    const doc = await PDFDocument.create();
    for (const p of pages) {
      const img = await doc.embedJpg(p.jpg);
      const page = doc.addPage([p.w, p.h]);
      page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
    }
    return doc.save({ useObjectStreams: true });
  }

  /**
   * Turns every page into a JPEG and searches the quality ladder for the best step that fits.
   * A few sample pages estimate the file size at every step, so we can jump straight to the
   * likely step; full passes then confirm it, moving down the ladder until the file fits or the
   * lowest step is reached. Returns { bytes, fits, dpi, q } (the smallest file when nothing fits).
   */
  async function rasterFit(ctx, bytes, target, from, to) {
    const pdf = await PdfRender.open(bytes);
    const n = pdf.numPages;
    const canvas = document.createElement("canvas");
    const sizes = [];
    for (let i = 1; i <= n; i++) {
      const pg = await pdf.getPage(i);
      const v = pg.getViewport({ scale: 1 });
      sizes.push({ w: v.width, h: v.height });
    }
    const overhead = 2048 + n * 420;
    const px = (p, dpi) => { const s = scaleFor(p, dpi); return p.w * p.h * s * s; };

    ctx.progress(from, "Measuring how small the pages can get…");
    const sample = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
    const est = {};
    const dpis = [...new Set(LADDER.map((s) => s[0]))];
    for (let d = 0; d < dpis.length; d++) {
      const dpi = dpis[d];
      const qs = LADDER.filter((s) => s[0] === dpi).map((s) => s[1]);
      let samplePx = 0;
      const sum = Object.fromEntries(qs.map((q) => [q, 0]));
      for (const i of sample) {
        checkCancel(ctx);
        const pg = await pdf.getPage(i + 1);
        const jp = await renderJpegs(pg, sizes[i], dpi, qs, canvas);
        pg.cleanup();
        samplePx += px(sizes[i], dpi);
        qs.forEach((q) => { sum[q] += jp[q].length; });
      }
      const totalPx = sizes.reduce((a, p) => a + px(p, dpi), 0);
      qs.forEach((q) => { est[`${dpi}/${q}`] = (sum[q] * totalPx) / samplePx + overhead; });
      ctx.progress(from + (to - from) * 0.15 * ((d + 1) / dpis.length));
    }

    let step = LADDER.findIndex(([d, q]) => est[`${d}/${q}`] <= target * 0.93);
    if (step < 0) step = LADDER.findIndex(([d]) => d === LADDER[LADDER.length - 1][0]);
    let best = null;
    for (let pass = 0; pass < 4 && step >= 0 && step < LADDER.length; pass++) {
      const dpi = LADDER[step][0];
      // One render pass per dpi; encode the chosen quality and up to 3 lower ones at the same dpi.
      const qs = LADDER.slice(step).filter((s) => s[0] === dpi).map((s) => s[1]).slice(0, 4);
      const pages = [];
      for (let i = 0; i < n; i++) {
        checkCancel(ctx);
        ctx.progress(from + (to - from) * (0.15 + 0.85 * ((pass + i / n) / 4)), `Saving pages as pictures (${dpi} dpi): page ${i + 1} of ${n}`);
        const pg = await pdf.getPage(i + 1);
        const jp = await renderJpegs(pg, sizes[i], dpi, qs, canvas);
        pg.cleanup();
        pages.push({ w: sizes[i].w, h: sizes[i].h, jp });
      }
      for (const q of qs) {
        const out = await buildImagePdf(pages.map((p) => ({ w: p.w, h: p.h, jpg: p.jp[q] })));
        if (!best || out.length < best.bytes.length) best = { bytes: out, dpi, q, fits: out.length <= target };
        if (out.length <= target) { await pdf.destroy(); return best; }
      }
      // Jump to a lower dpi, corrected by how far the estimate was off.
      const off = Math.max(1, best.bytes.length / Math.max(1, est[`${dpi}/${qs[qs.length - 1]}`]));
      let next = LADDER.findIndex(([d, q], k) => k > step && d < dpi && est[`${d}/${q}`] * off <= target * 0.95);
      if (next < 0) next = LADDER.findIndex(([d], k) => k > step && d < dpi && d === LADDER[LADDER.length - 1][0]);
      step = next;
    }
    await pdf.destroy();
    return best;
  }

  async function compressToSize(ctx) {
    const file = ctx.files[0];
    const original = ctx.buffers[0];
    const target = targetBytes(ctx);
    const name = `${stem(file.name)}_under_${kb(target).replace(/\s|\./g, "")}.pdf`;
    const done = (bytes, message, html, tone) => {
      showResult(ctx, html, tone);
      return { bytes, filename: name, mime: "application/pdf", message };
    };
    if (ctx.el("pxResult")) ctx.el("pxResult").hidden = true;

    if (original.length <= target) {
      return done(original, `Your PDF is already ${kb(original.length)}, under ${kb(target)}. Downloaded it unchanged.`,
        `<strong>Already small enough:</strong> ${kb(original.length)} (target ${kb(target)}). Nothing needed changing.`);
    }

    // Step 1: the server's compressor, gentlest first. Text and drawings stay sharp.
    let best = { bytes: original, how: "unchanged" };
    let serverFailed = "";
    const levels = [["low", "lossless clean-up"], ["medium", "images at 150 dpi"], ["extreme", "images at 72 dpi"]];
    for (let i = 0; i < levels.length; i++) {
      const [level, label] = levels[i];
      checkCancel(ctx);
      ctx.progress(0.04 + i * 0.12, `Trying ${label}…`);
      let out;
      try {
        out = await serverCompress(ctx, level, label);
      } catch (e) {
        if (e && e.cancelled) throw e;
        serverFailed = e.message || "the server couldn't be reached";
        break;
      }
      if (out.length < best.bytes.length) best = { bytes: out, how: `normal compression, ${label}` };
      if (out.length <= target) {
        return done(out, `Done! ${kb(original.length)} → ${kb(out.length)}, under your ${kb(target)} limit. Text is still sharp and selectable.`,
          `<strong>Fits: ${kb(out.length)}</strong> (target ${kb(target)}, was ${kb(original.length)}).<br>Compressed with ${label}; text is still sharp and selectable.`);
      }
    }

    if (!ctx.checked("pxAllowRaster")) {
      return done(best.bytes,
        `Couldn't get under ${kb(target)} without turning pages into pictures. The smallest was ${kb(best.bytes.length)}; downloaded that.`,
        `<strong>Not under ${kb(target)}.</strong> Normal compression got it to ${kb(best.bytes.length)} (from ${kb(original.length)}), and that's the file you downloaded.<br>Tick "turn pages into pictures" to go smaller, or remove some pages first.`, "warn");
    }

    // Step 2: pages as pictures, in the browser.
    const raster = await rasterFit(ctx, original, target, 0.4, 0.97);
    const note = serverFailed ? `<br><span class="px-dim">The server compressor wasn't available (${esc(serverFailed)}), so this was done on your device.</span>` : "";
    if (raster && raster.fits) {
      return done(raster.bytes,
        `Done! ${kb(original.length)} → ${kb(raster.bytes.length)}, under ${kb(target)}. Pages are now pictures, so text can't be selected.`,
        `<strong>Fits: ${kb(raster.bytes.length)}</strong> (target ${kb(target)}, was ${kb(original.length)}).<br>` +
        `To get this small, each page was saved as a picture (${raster.dpi} dpi, quality ${Math.round(raster.q * 100)}%). ` +
        `Text can't be selected or searched any more, so keep your original too.${note}`, "warn");
    }
    const smallest = raster && raster.bytes.length < best.bytes.length
      ? { bytes: raster.bytes, how: `pages as low-quality pictures, ${raster.dpi} dpi` } : best;
    return done(smallest.bytes,
      `Couldn't get under ${kb(target)}. The smallest possible was ${kb(smallest.bytes.length)}; downloaded that file.`,
      `<strong>Can't reach ${kb(target)}.</strong> The smallest we could make is <strong>${kb(smallest.bytes.length)}</strong> ` +
      `(${esc(smallest.how)}), and that's the file you downloaded.<br>To go lower, remove pages you don't need or split the PDF and upload it in parts.${note}`,
      "bad");
  }

  // =====================================================================
  // 2. Extract images
  // =====================================================================

  const imagesConfig = `
    <label class="checkbox-group"><input type="checkbox" id="pxTiny"> Include tiny images (icons, bullets, lines under 32 px)</label>
    <p class="drop-hint">JPEG photos are saved exactly as they are inside the PDF, with no quality loss. Other images are saved as PNG. A picture used on several pages is saved once.</p>
    <div class="px-result" id="pxResult" hidden></div>`;

  function filterNames(dict) {
    const f = dict.lookup(PDFName.of("Filter"));
    if (f instanceof PDFName) return [f.asString()];
    if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.asString() : String(x)));
    return [];
  }

  function num(dict, key) {
    const v = dict.lookup(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : 0;
  }

  /** Every image XObject reachable from a page's resources (forms included), with its object ref. */
  function pageImages(doc, page) {
    const found = [];
    const seenForms = new Set();
    const walk = (res) => {
      if (!(res instanceof PDFDict)) return;
      const xo = res.lookup(PDFName.of("XObject"));
      if (!(xo instanceof PDFDict)) return;
      for (const [, val] of xo.entries()) {
        const ref = val instanceof PDFRef ? val : null;
        const obj = ref ? doc.context.lookup(ref) : val;
        if (!obj || !obj.dict) continue;
        const sub = obj.dict.lookup(PDFName.of("Subtype"));
        if (sub === PDFName.of("Image")) {
          found.push({ key: ref ? ref.toString() : null, stream: obj, w: num(obj.dict, "Width"), h: num(obj.dict, "Height"), filters: filterNames(obj.dict) });
        } else if (sub === PDFName.of("Form")) {
          const k = ref ? ref.toString() : obj;
          if (seenForms.has(k)) continue;
          seenForms.add(k);
          walk(obj.dict.lookup(PDFName.of("Resources")));
        }
      }
    };
    try { walk(page.node.Resources()); } catch (e) { /* odd resources: pdf.js still finds the pictures */ }
    return found;
  }

  function getObj(pdfPage, id) {
    const store = id.startsWith("g_") ? pdfPage.commonObjs : pdfPage.objs;
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 8000);
      try {
        store.get(id, (o) => { if (!done) { done = true; clearTimeout(t); resolve(o); } });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
  }

  /** A pdf.js decoded image (ImageBitmap or raw pixels) as PNG bytes. */
  async function pngOf(img) {
    const w = img.width, h = img.height;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    if (img.bitmap) {
      g.drawImage(img.bitmap, 0, 0);
    } else if (img.data) {
      const id = g.createImageData(w, h);
      const d = id.data, s = img.data;
      if (img.kind === 3) {
        d.set(s.subarray(0, d.length));
      } else if (img.kind === 2) {
        for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255; }
      } else { // 1 bit per pixel, rows padded to whole bytes
        const row = (w + 7) >> 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const v = (s[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          const j = (y * w + x) * 4;
          d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
        }
      }
      g.putImageData(id, 0, 0);
    } else {
      return null;
    }
    return canvasBytes(c, "image/png");
  }

  async function extractImages(ctx) {
    const bytes = ctx.buffers[0];
    const includeTiny = ctx.checked("pxTiny");
    const lib = await loadPdf(bytes);
    const libPages = lib.getPages();
    const pdf = await PdfRender.open(bytes);
    const OPS = pdfjsLib.OPS;
    const zip = new JSZip();
    const seen = new Set();
    let count = 0, jpegs = 0, skippedTiny = 0, failed = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      checkCancel(ctx);
      ctx.progress((p - 1) / pdf.numPages * 0.9, `Looking for pictures on page ${p} of ${pdf.numPages}`);
      const page = await pdf.getPage(p);
      const pool = libPages[p - 1] ? pageImages(lib, libPages[p - 1]) : [];
      const ops = await page.getOperatorList();
      let n = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject && fn !== OPS.paintImageXObjectRepeat) continue;
        const args = ops.argsArray[k];
        const inline = fn === OPS.paintInlineImageXObject;
        const id = inline ? null : args[0];
        const w = inline ? args[0].width : args[1];
        const h = inline ? args[0].height : args[2];
        if (id && seen.has(`js:${id}`)) continue;
        if (id) seen.add(`js:${id}`);
        // The same picture in the file itself: same pixel size, not matched yet on this page.
        const mi = inline ? -1 : pool.findIndex((x) => x.w === w && x.h === h);
        const match = mi >= 0 ? pool.splice(mi, 1)[0] : null;
        if (match && match.key) {
          if (seen.has(match.key)) continue;
          seen.add(match.key);
        }
        if (!includeTiny && (w < 32 || h < 32)) { skippedTiny++; continue; }
        let data = null, ext = "png";
        if (match && match.filters.length === 1 && match.filters[0] === "/DCTDecode" && match.stream.contents) {
          data = match.stream.contents; // the original JPEG, byte for byte
          ext = "jpg";
        }
        if (!data) {
          const img = inline ? args[0] : await getObj(page, id);
          data = img ? await pngOf(img) : null;
        }
        if (!data) { failed++; continue; }
        n++; count++;
        if (ext === "jpg") jpegs++;
        zip.file(`page${p}_img${n}.${ext}`, data);
      }
      page.cleanup();
      await tick();
    }
    await pdf.destroy();
    if (!count) {
      const why = skippedTiny ? ` Only ${skippedTiny} tiny one${skippedTiny > 1 ? "s were" : " was"} found; tick "Include tiny images" to get ${skippedTiny > 1 ? "them" : "it"}.` : "";
      throw new UserError(`No pictures found in this PDF.${why} To save whole pages as images, use PDF to JPG.`);
    }
    ctx.progress(0.95, `Zipping ${count} images…`);
    const out = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const extra = [jpegs ? `${jpegs} original JPEG` : "", count - jpegs ? `${count - jpegs} PNG` : ""].filter(Boolean).join(", ");
    showResult(ctx, `<strong>Saved ${count} image${count > 1 ? "s" : ""}</strong> (${extra}).` +
      (skippedTiny ? ` Skipped ${skippedTiny} tiny one${skippedTiny > 1 ? "s" : ""}.` : "") +
      (failed ? ` ${failed} couldn't be read.` : ""));
    const zipName = `${stem(ctx.files[0].name)}_images.zip`;
    return { bytes: out, filename: zipName, mime: "application/zip",
      message: `Done! Saved ${count} image${count > 1 ? "s" : ""} in ${zipName}. Nothing was uploaded.` };
  }

  // =====================================================================
  // 3. N-up and Booklet
  // =====================================================================

  const paperSelect = `
      <div class="form-group">
        <label class="form-label" for="pxPaper">Paper</label>
        <select id="pxPaper" class="form-select">
          <option value="a4" selected>A4</option>
          <option value="letter">Letter</option>
        </select>
      </div>`;

  const nupConfig = `
    <div class="grid-2 px-grid">
      <div class="form-group">
        <label class="form-label" for="pxPerSheet">Pages per sheet</label>
        <select id="pxPerSheet" class="form-select">
          <option value="2" selected>2 per sheet</option>
          <option value="4">4 per sheet</option>
          <option value="6">6 per sheet</option>
          <option value="9">9 per sheet</option>
        </select>
      </div>
      ${paperSelect}
    </div>
    <div class="grid-2 px-grid">
      <div class="form-group">
        <label class="form-label" for="pxOrient">Sheet direction</label>
        <select id="pxOrient" class="form-select">
          <option value="auto" selected>Automatic (biggest pages)</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="pxOrder">Order</label>
        <select id="pxOrder" class="form-select">
          <option value="rows" selected>Across, then down</option>
          <option value="cols">Down, then across</option>
        </select>
      </div>
    </div>
    <label class="checkbox-group"><input type="checkbox" id="pxBorders"> Draw a thin border around each page</label>
    <div class="px-preview" id="pxPreview" aria-hidden="true"></div>
    <div class="px-result" id="pxResult" hidden></div>`;

  const bookletConfig = `
    <div class="grid-2 px-grid">
      ${paperSelect}
      <div class="form-group">
        <label class="form-label" for="pxBinding">Opens on the</label>
        <select id="pxBinding" class="form-select">
          <option value="left" selected>Left (English, Hindi…)</option>
          <option value="right">Right (Urdu, Arabic…)</option>
        </select>
      </div>
    </div>
    <label class="checkbox-group"><input type="checkbox" id="pxBorders"> Draw a thin border around each page</label>
    <div class="px-note">
      <strong>How to print:</strong> print on both sides with <strong>"Flip on short edge"</strong>, then fold the stack in half and staple along the fold.
      Blank pages are added at the end when needed, because a booklet needs a multiple of 4 pages.
    </div>
    <div class="px-result" id="pxResult" hidden></div>`;

  /** Picks columns × rows and sheet direction that make the pages biggest. */
  function bestLayout(n, paper, orient, pw, ph, margin, gap) {
    let best = null;
    const dirs = orient === "portrait" || orient === "landscape" ? [orient] : ["portrait", "landscape"];
    for (const dir of dirs) {
      const [W, H] = dir === "landscape" ? [paper[1], paper[0]] : paper;
      for (let cols = 1; cols <= n; cols++) {
        if (n % cols) continue;
        const rows = n / cols;
        if (n > 2 && (cols === 1 || rows === 1)) continue; // long strips are never what people want
        const cw = (W - 2 * margin - (cols - 1) * gap) / cols;
        const ch = (H - 2 * margin - (rows - 1) * gap) / rows;
        const s = Math.min(cw / pw, ch / ph);
        if (!best || s > best.s + 1e-6) best = { s, W, H, cols, rows, cw, ch, dir };
      }
    }
    return best;
  }

  const cellAt = (k, L, order) => (order === "cols"
    ? { r: k % L.rows, c: Math.floor(k / L.rows) }
    : { r: Math.floor(k / L.cols), c: k % L.cols });

  function nupPreview(ctx) {
    const box = ctx.el("pxPreview");
    if (!box) return;
    const n = Number(ctx.value("pxPerSheet")) || 2;
    const paper = PAPER[ctx.value("pxPaper")] || PAPER.a4;
    const [pw, ph] = ctx.pxFirst || [595, 842];
    const L = bestLayout(n, paper, ctx.value("pxOrient"), pw, ph, 18, 8);
    const order = ctx.value("pxOrder");
    const cells = [];
    for (let i = 0; i < n; i++) {
      const { r, c } = cellAt(i, L, order);
      cells.push(`<span style="grid-row:${r + 1};grid-column:${c + 1}">${i + 1}</span>`);
    }
    box.innerHTML = `<div class="px-sheet px-${L.dir}" style="grid-template-columns:repeat(${L.cols},1fr);grid-template-rows:repeat(${L.rows},1fr)">${cells.join("")}</div>
      <span class="px-dim">${L.cols} × ${L.rows} on ${L.dir} ${ctx.value("pxPaper") === "letter" ? "Letter" : "A4"}</span>`;
  }

  async function nUp(ctx) {
    const src = await loadPdf(ctx.buffers[0]);
    const total = src.getPageCount();
    const n = Number(ctx.value("pxPerSheet")) || 2;
    const paper = PAPER[ctx.value("pxPaper")] || PAPER.a4;
    const borders = ctx.checked("pxBorders");
    const order = ctx.value("pxOrder");
    const margin = 18, gap = 8;
    const first = viewOf(src.getPage(0));
    const L = bestLayout(n, paper, ctx.value("pxOrient"), first.width, first.height, margin, gap);
    const out = await PDFDocument.create();
    const get = embedder(out, src);
    const sheets = Math.ceil(total / n);
    for (let sIdx = 0; sIdx < sheets; sIdx++) {
      checkCancel(ctx);
      ctx.progress(sIdx / sheets * 0.9, `Laying out sheet ${sIdx + 1} of ${sheets}`);
      const sheet = out.addPage([L.W, L.H]);
      for (let k = 0; k < n && sIdx * n + k < total; k++) {
        const { r, c } = cellAt(k, L, order);
        const cell = { x: margin + c * (L.cw + gap), y: L.H - margin - (r + 1) * L.ch - r * gap, w: L.cw, h: L.ch };
        const { emb, view } = await get(sIdx * n + k);
        const d = drawFitted(sheet, emb, view, cell);
        if (borders) sheet.drawRectangle({ x: d.x, y: d.y, width: d.w, height: d.h, borderColor: rgb(0.55, 0.58, 0.63), borderWidth: 0.6 });
      }
    }
    ctx.progress(0.95, "Saving…");
    const bytes = await out.save();
    showResult(ctx, `<strong>${total} pages → ${sheets} sheet${sheets > 1 ? "s" : ""}</strong> (${L.cols} × ${L.rows}, ${L.dir}).`);
    return { bytes, filename: `${stem(ctx.files[0].name)}_${n}up.pdf`, mime: "application/pdf",
      message: `Done! ${total} pages on ${sheets} sheet${sheets > 1 ? "s" : ""}, ${n} per sheet. Nothing was uploaded.` };
  }

  /**
   * Saddle-stitch imposition. Returns the padded page count and, for each printed side in order
   * (sheet 1 front, sheet 1 back, sheet 2 front…), the [left, right] page indices (0-based;
   * an index ≥ the real page count is a blank page).
   */
  function bookletOrder(count) {
    const n = Math.max(4, Math.ceil(count / 4) * 4);
    const sides = [];
    for (let k = 0; k < n / 4; k++) {
      sides.push([n - 1 - 2 * k, 2 * k]);
      sides.push([2 * k + 1, n - 2 - 2 * k]);
    }
    return { n, sides };
  }

  async function booklet(ctx) {
    const src = await loadPdf(ctx.buffers[0]);
    const total = src.getPageCount();
    const paper = PAPER[ctx.value("pxPaper")] || PAPER.a4;
    const borders = ctx.checked("pxBorders");
    const rtl = ctx.value("pxBinding") === "right";
    const [W, H] = [paper[1], paper[0]]; // landscape sheet, two pages side by side
    const margin = 14, gutter = 10;
    const out = await PDFDocument.create();
    const get = embedder(out, src);
    const { n, sides } = bookletOrder(total);
    for (let s = 0; s < sides.length; s++) {
      checkCancel(ctx);
      ctx.progress(s / sides.length * 0.9, `Laying out side ${s + 1} of ${sides.length}`);
      const sheet = out.addPage([W, H]);
      const pair = rtl ? [sides[s][1], sides[s][0]] : sides[s];
      for (let half = 0; half < 2; half++) {
        const i = pair[half];
        if (i >= total) continue; // blank padding page
        const cell = { x: half === 0 ? margin : W / 2 + gutter / 2, y: margin, w: W / 2 - margin - gutter / 2, h: H - 2 * margin };
        const { emb, view } = await get(i);
        const d = drawFitted(sheet, emb, view, cell);
        if (borders) sheet.drawRectangle({ x: d.x, y: d.y, width: d.w, height: d.h, borderColor: rgb(0.55, 0.58, 0.63), borderWidth: 0.6 });
      }
    }
    ctx.progress(0.95, "Saving…");
    const bytes = await out.save();
    const blanks = n - total;
    const paperSheets = n / 4;
    showResult(ctx, `<strong>${total} pages → booklet on ${paperSheets} sheet${paperSheets > 1 ? "s" : ""} of paper</strong> (${n / 2} printed sides)` +
      (blanks ? `, with ${blanks} blank page${blanks > 1 ? "s" : ""} added at the end` : "") +
      `.<br>Print double-sided with <strong>flip on short edge</strong>, then fold and staple.`);
    return { bytes, filename: `${stem(ctx.files[0].name)}_booklet.pdf`, mime: "application/pdf",
      message: `Done! Booklet ready: print double-sided with "flip on short edge", then fold. Nothing was uploaded.` };
  }

  // =====================================================================
  // 4a. Bookmarks & Contents
  // =====================================================================

  const bookmarksConfig = `
    <div class="form-group">
      <div class="px-label-row">
        <label class="form-label" for="pxToc">Chapters, one per line: Title — page</label>
        <button type="button" class="btn btn-xs" id="pxSuggest">${Icons.ui("sparkle")} Find headings</button>
      </div>
      <textarea id="pxToc" class="form-input px-toc" rows="8" spellcheck="false" placeholder="Introduction — 1&#10;Chapter 1: Motion — 3&#10;  1.1 Speed — 4&#10;Chapter 2: Force — 12"></textarea>
      <p class="drop-hint">Start a line with two spaces to make it a sub-section. Page numbers are the pages of your PDF as it is now.</p>
    </div>
    <div class="px-checks">
      <label class="checkbox-group"><input type="checkbox" id="pxAddToc" checked> Add a clickable contents page at the front</label>
      <label class="checkbox-group"><input type="checkbox" id="pxAddOutline" checked> Add bookmarks (the side panel in PDF readers)</label>
    </div>
    <div class="form-group">
      <label class="form-label" for="pxTocTitle">Contents page heading</label>
      <input type="text" id="pxTocTitle" class="form-input" value="Contents" maxlength="60">
    </div>
    <div class="px-result" id="pxResult" hidden></div>`;

  /** "Title — 5" lines → [{ title, page (1-based), level }] */
  function parseToc(text, total) {
    const items = [];
    String(text || "").split(/\r?\n/).forEach((raw, idx) => {
      if (!raw.trim()) return;
      const m = raw.match(/^([ \t]*)(?:[•*>]\s+)?(.*?)[\s.·…—–:|,-]*(?:\b(?:p|pg|page)\.?\s*)?(\d+)\s*$/i);
      if (!m || !m[2].trim()) throw new UserError(`Line ${idx + 1} needs a title and a page number, like "Chapter 1 — 5".`);
      const page = Number(m[3]);
      if (page < 1 || page > total) throw new UserError(`Line ${idx + 1}: page ${page} doesn't exist. This PDF has ${total} page${total > 1 ? "s" : ""}.`);
      const indent = m[1].replace(/\t/g, "  ").length;
      items.push({ title: m[2].trim(), page, level: indent >= 2 ? 1 : 0 });
    });
    return items;
  }

  /** Lines in larger text than the body, as a first guess at the chapters. */
  async function suggestHeadings(bytes, onProgress) {
    const pdf = await PdfRender.open(bytes);
    const lines = [];
    const hist = new Map();
    const pages = Math.min(pdf.numPages, 600);
    for (let p = 1; p <= pages; p++) {
      if (onProgress) onProgress(p, pages);
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let cur = null;
      const flush = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
      for (const it of tc.items) {
        if (!("str" in it)) continue;
        const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 2) / 2 || Math.round(it.height);
        const y = it.transform[5];
        if (it.str.trim()) hist.set(size, (hist.get(size) || 0) + it.str.length);
        if (cur && (Math.abs(cur.y - y) > size * 0.6 || Math.abs(cur.size - size) > 0.6)) flush();
        if (!it.str && !it.hasEOL) continue;
        if (!cur) cur = { text: "", size, y, page: p };
        cur.text += it.str;
        if (it.hasEOL) flush();
      }
      flush();
      page.cleanup();
      if (p % 20 === 0) await tick();
    }
    await pdf.destroy();
    let body = 10, most = 0;
    for (const [s, c] of hist) if (c > most) { most = c; body = s; }
    // Lines repeated on many pages are running headers, not chapters.
    const freq = new Map();
    lines.forEach((l) => { const t = l.text.trim(); freq.set(t, (freq.get(t) || 0) + 1); });
    const heads = lines.filter((l) => {
      const t = l.text.trim();
      return l.size >= body * 1.2 && t.length >= 2 && t.length <= 110 && /\p{L}/u.test(t) && freq.get(t) <= Math.max(2, pages * 0.2);
    });
    // Join headings that wrap onto a second line.
    const merged = [];
    for (const h of heads) {
      const prev = merged[merged.length - 1];
      if (prev && prev.page === h.page && prev.size === h.size && prev.y - h.y > 0 && prev.y - h.y < h.size * 1.8 && prev.text.length < 90) {
        prev.text = `${prev.text.trim()} ${h.text.trim()}`;
        prev.y = h.y;
      } else merged.push({ ...h });
    }
    const list = merged.slice(0, 200);
    const top = Math.max(0, ...list.map((h) => h.size));
    const twoLevels = new Set(list.map((h) => h.size)).size > 1;
    return list.map((h) => ({ title: h.text.replace(/\s+/g, " ").trim(), page: h.page, level: twoLevels && h.size < top * 0.92 ? 1 : 0 }));
  }

  /** The PDF's existing bookmarks as items, down to maxDepth levels. */
  async function readOutline(pdf, maxDepth = 2) {
    const outline = await pdf.getOutline().catch(() => null);
    if (!outline || !outline.length) return [];
    const out = [];
    const pageOf = async (dest) => {
      try {
        const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(d) || !d.length) return null;
        if (typeof d[0] === "number") return d[0];
        return await pdf.getPageIndex(d[0]);
      } catch (e) { return null; }
    };
    const walk = async (items, level) => {
      for (const it of items) {
        const idx = it.dest ? await pageOf(it.dest) : null;
        if (idx !== null && idx !== undefined) out.push({ title: (it.title || "").replace(/\s+/g, " ").trim() || "Untitled", page: idx + 1, level });
        if (it.items && it.items.length && level + 1 < maxDepth) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 0);
    return out;
  }

  const tocText = (items) => items.map((i) => `${i.level ? "  " : ""}${i.title} — ${i.page}`).join("\n");

  // The built-in PDF fonts only cover Western letters; anything else shows as "?" on the contents page.
  function encodable(font, text) {
    let out = "", lost = false;
    for (const ch of text) {
      try { font.encodeText(ch); out += ch; } catch (e) { out += "?"; lost = true; }
    }
    return { text: out, lost };
  }

  function fitText(font, text, size, maxW) {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    let t = text;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  function addOutline(doc, items, pageRefs) {
    const c = doc.context;
    const rootRef = c.nextRef();
    const nodes = items.map((it) => ({ ...it, ref: c.nextRef(), kids: [] }));
    const top = [];
    let lastTop = null;
    for (const n of nodes) {
      if (n.level > 0 && lastTop) lastTop.kids.push(n);
      else { top.push(n); lastTop = n; }
    }
    const build = (list, parentRef) => {
      list.forEach((n, i) => {
        const d = { Title: PDFHexString.fromText(n.title), Parent: parentRef, Dest: [pageRefs[n.page - 1], PDFName.of("Fit")] };
        if (i > 0) d.Prev = list[i - 1].ref;
        if (i < list.length - 1) d.Next = list[i + 1].ref;
        if (n.kids.length) { d.First = n.kids[0].ref; d.Last = n.kids[n.kids.length - 1].ref; d.Count = -n.kids.length; }
        c.assign(n.ref, c.obj(d));
        if (n.kids.length) build(n.kids, n.ref);
      });
    };
    build(top, rootRef);
    c.assign(rootRef, c.obj({ Type: "Outlines", First: top[0].ref, Last: top[top.length - 1].ref, Count: top.length }));
    doc.catalog.set(PDFName.of("Outlines"), rootRef);
    doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  }

  async function bookmarks(ctx) {
    const doc = await loadPdf(ctx.buffers[0]);
    const total = doc.getPageCount();
    const items = parseToc(ctx.value("pxToc"), total);
    if (!items.length) throw new UserError("Add at least one line like \"Chapter 1 — 5\", or tap Find headings.");
    const wantToc = ctx.checked("pxAddToc");
    const wantOutline = ctx.checked("pxAddOutline");
    if (!wantToc && !wantOutline) throw new UserError("Tick the contents page, the bookmarks, or both.");
    const pageRefs = doc.getPages().map((p) => p.ref);
    const ink = rgb(0.1, 0.12, 0.16);
    let tocPages = 0, lostChars = false;

    if (wantToc) {
      ctx.progress(0.3, "Writing the contents page…");
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const fv = viewOf(doc.getPage(0));
      const W = Math.max(fv.width, 300), H = Math.max(fv.height, 300);
      const mx = Math.max(36, W * 0.09), top = Math.max(44, H * 0.08), bottom = Math.max(36, H * 0.06);
      const size = Math.min(12, Math.max(9, W / 50)), lh = size * 1.9, titleSize = size * 1.9;
      const perFirst = Math.max(1, Math.floor((H - top - titleSize * 2.2 - bottom) / lh));
      const perNext = Math.max(1, Math.floor((H - top - bottom) / lh));
      tocPages = items.length <= perFirst ? 1 : 1 + Math.ceil((items.length - perFirst) / perNext);
      const heading = encodable(bold, ctx.value("pxTocTitle").trim() || "Contents");
      lostChars = heading.lost;
      let idx = 0;
      for (let t = 0; t < tocPages; t++) {
        const page = doc.insertPage(t, [W, H]);
        let y = H - top;
        if (t === 0) {
          page.drawText(heading.text, { x: mx, y: y - titleSize, size: titleSize, font: bold, color: ink });
          y -= titleSize * 2.2;
        }
        const annots = [];
        const per = t === 0 ? perFirst : perNext;
        for (let r = 0; r < per && idx < items.length; r++, idx++) {
          const it = items[idx];
          const f = it.level ? font : bold;
          const indent = it.level ? size * 1.6 : 0;
          const numText = String(it.page);
          const numW = font.widthOfTextAtSize(numText, size);
          const enc = encodable(f, it.title);
          if (enc.lost) lostChars = true;
          const title = fitText(f, enc.text, size, W - 2 * mx - indent - numW - size * 3);
          const tw = f.widthOfTextAtSize(title, size);
          const baseline = y - size;
          page.drawText(title, { x: mx + indent, y: baseline, size, font: f, color: ink });
          page.drawText(numText, { x: W - mx - numW, y: baseline, size, font, color: ink });
          const from = mx + indent + tw + size * 0.6, to = W - mx - numW - size * 0.6;
          const dotUnit = font.widthOfTextAtSize(". ", size);
          if (to - from > dotUnit * 2) {
            const dots = ". ".repeat(Math.floor((to - from) / dotUnit)).trimEnd();
            page.drawText(dots, { x: to - font.widthOfTextAtSize(dots, size), y: baseline, size, font, color: rgb(0.6, 0.62, 0.66) });
          }
          annots.push(doc.context.register(doc.context.obj({
            Type: "Annot", Subtype: "Link", Border: [0, 0, 0],
            Rect: [mx + indent, baseline - size * 0.45, W - mx, baseline + size * 1.05],
            Dest: [pageRefs[it.page - 1], PDFName.of("Fit")],
          })));
          y -= lh;
        }
        page.node.set(PDFName.of("Annots"), doc.context.obj(annots));
      }
      // Number the contents pages i, ii… and the rest 1, 2… so the reader's page numbers still match.
      doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({
        Nums: [0, { S: PDFName.of("r") }, tocPages, { S: PDFName.of("D") }],
      }));
    }
    if (wantOutline) {
      ctx.progress(0.7, "Adding bookmarks…");
      addOutline(doc, items, pageRefs);
    }
    ctx.progress(0.9, "Saving…");
    const bytes = await doc.save();
    const bits = [wantToc ? `a contents page${tocPages > 1 ? ` (${tocPages} pages)` : ""}` : "", wantOutline ? `${items.length} bookmark${items.length > 1 ? "s" : ""}` : ""].filter(Boolean);
    showResult(ctx, `<strong>Added ${bits.join(" and ")}.</strong>` +
      (wantToc ? ` The contents page${tocPages > 1 ? "s are" : " is"} numbered i, ii… so your page numbers stay the same.` : "") +
      (lostChars ? `<br><span class="px-dim">Some letters (for example Hindi) can't be drawn on the contents page and show as "?". The bookmarks keep them.</span>` : ""));
    return { bytes, filename: `${stem(ctx.files[0].name)}_with_contents.pdf`, mime: "application/pdf",
      message: `Done! Added ${bits.join(" and ")}. Nothing was uploaded.` };
  }

  async function bookmarksOnFiles(ctx) {
    const ta = ctx.el("pxToc");
    const buf = ctx.buffers[0];
    if (!ta || !buf || ta.value.trim()) return;
    const pdf = await PdfRender.open(buf);
    const items = await readOutline(pdf, 2);
    await pdf.destroy();
    if (items.length && ctx.el("pxToc") === ta && !ta.value.trim()) {
      ta.value = tocText(items);
      showResult(ctx, `This PDF already has ${items.length} bookmark${items.length > 1 ? "s" : ""}; they're filled in above. Edit them or tap Find headings. Saving replaces the old bookmarks.`, "info");
    }
  }

  async function onSuggest(ctx, btn) {
    if (!ctx.buffers[0]) return showToast("Add a PDF first.", "error");
    const ta = ctx.el("pxToc");
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const items = await suggestHeadings(ctx.buffers[0], (p, n) => { btn.textContent = `Reading ${p} of ${n}…`; });
      if (!items.length) {
        showResult(ctx, "No headings in larger text were found. Scanned PDFs have no text (run OCR first). You can type the chapters yourself.", "warn");
        return;
      }
      ta.value = tocText(items);
      showResult(ctx, `Found ${items.length} heading${items.length > 1 ? "s" : ""} in larger text. Check them, delete any that aren't chapters, then save.`, "info");
    } catch (e) {
      reportError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // =====================================================================
  // 4b. Split by chapters (bookmarks)
  // =====================================================================

  const chaptersConfig = `
    <div class="grid-2 px-grid">
      <div class="form-group">
        <label class="form-label" for="pxDepth">Split at</label>
        <select id="pxDepth" class="form-select">
          <option value="1" selected>Chapters (top-level bookmarks)</option>
          <option value="2">Chapters and sections</option>
        </select>
      </div>
      <label class="checkbox-group px-front"><input type="checkbox" id="pxFront" checked> Save pages before the first chapter as their own file</label>
    </div>
    <div class="px-chapters" id="pxChapters"><p class="drop-hint">Add a PDF with bookmarks to see its chapters here.</p></div>
    <div class="px-result" id="pxResult" hidden></div>`;

  function chapterRanges(items, total, depth, front) {
    const marks = items.filter((i) => i.level < depth).sort((a, b) => a.page - b.page);
    const starts = [];
    for (const m of marks) {
      const last = starts[starts.length - 1];
      if (last && last.page === m.page) continue; // two bookmarks on one page: keep the first
      starts.push(m);
    }
    const out = [];
    if (front && starts.length && starts[0].page > 1) out.push({ title: "Front matter", from: 1, to: starts[0].page - 1, front: true });
    starts.forEach((s, i) => out.push({ title: s.title, from: s.page, to: i + 1 < starts.length ? starts[i + 1].page - 1 : total }));
    return out;
  }

  function renderChapters(ctx) {
    const box = ctx.el("pxChapters");
    if (!box) return;
    ctx.pxRanges = null;
    if (!ctx.pxOutline) { box.innerHTML = `<p class="drop-hint">Add a PDF with bookmarks to see its chapters here.</p>`; return; }
    if (!ctx.pxOutline.items.length) {
      box.innerHTML = `<p class="px-result px-warn">This PDF has no bookmarks, so there are no chapters to split at. Add them with <a href="/pdf-bookmarks">Bookmarks &amp; Contents</a>, or use <a href="/split-pdf">Split PDF</a> to pick page ranges.</p>`;
      return;
    }
    const ranges = chapterRanges(ctx.pxOutline.items, ctx.pxOutline.total, Number(ctx.value("pxDepth")) || 1, ctx.checked("pxFront"));
    ctx.pxRanges = ranges;
    box.innerHTML = `
      <div class="px-chap-head"><span>${ranges.length} file${ranges.length > 1 ? "s" : ""} from ${ctx.pxOutline.total} pages</span>
        <button type="button" class="btn btn-xs" id="pxAllChaps">Select all</button>
        <button type="button" class="btn btn-xs" id="pxNoChaps">Clear</button></div>
      <ol class="px-chap-list">${ranges.map((r, i) => `
        <li><label><input type="checkbox" class="px-chap" data-i="${i}" checked>
          <span class="px-chap-title">${esc(r.title)}</span>
          <span class="px-chap-pages">${r.from === r.to ? `p. ${r.from}` : `pp. ${r.from}–${r.to}`}</span></label></li>`).join("")}
      </ol>`;
    const set = (v) => box.querySelectorAll(".px-chap").forEach((c) => { c.checked = v; });
    box.querySelector("#pxAllChaps").onclick = () => set(true);
    box.querySelector("#pxNoChaps").onclick = () => set(false);
  }

  async function chaptersOnFiles(ctx) {
    ctx.pxOutline = null;
    const buf = ctx.buffers[0];
    if (!buf) return renderChapters(ctx);
    const box = ctx.el("pxChapters");
    if (box) box.innerHTML = `<p class="drop-hint">Reading bookmarks…</p>`;
    const pdf = await PdfRender.open(buf);
    const items = await readOutline(pdf, 2);
    const total = pdf.numPages;
    await pdf.destroy();
    if (ctx.buffers[0] !== buf) return;
    ctx.pxOutline = { items, total };
    renderChapters(ctx);
  }

  async function splitChapters(ctx) {
    if (!ctx.pxOutline) await chaptersOnFiles(ctx);
    if (!ctx.pxOutline || !ctx.pxOutline.items.length) throw new UserError("This PDF has no bookmarks to split at. Add them with Bookmarks & Contents, or use Split PDF.");
    const ranges = ctx.pxRanges || chapterRanges(ctx.pxOutline.items, ctx.pxOutline.total, 1, true);
    const boxes = [...document.querySelectorAll(".px-chap")];
    const picked = boxes.length ? boxes.filter((c) => c.checked).map((c) => ranges[Number(c.dataset.i)]) : ranges;
    if (!picked.length) throw new UserError("Tick at least one chapter.");
    const src = await loadPdf(ctx.buffers[0]);
    const width = String(ranges.length).length;
    const offset = ranges[0].front ? 0 : 1;
    const files = [];
    for (let k = 0; k < picked.length; k++) {
      checkCancel(ctx);
      const r = picked[k];
      ctx.progress(k / picked.length * 0.9, `Saving ${k + 1} of ${picked.length}: ${r.title}`);
      const out = await PDFDocument.create();
      const idx = [];
      for (let p = r.from; p <= r.to; p++) idx.push(p - 1);
      (await out.copyPages(src, idx)).forEach((pg) => out.addPage(pg));
      out.setTitle(r.title);
      const numText = String(ranges.indexOf(r) + offset).padStart(width, "0");
      files.push({ name: `${numText} ${safeFileName(r.title, "Chapter")}.pdf`, bytes: await out.save(), pages: idx.length });
      await tick();
    }
    if (files.length === 1) {
      showResult(ctx, `<strong>Saved 1 chapter</strong> (${files[0].pages} page${files[0].pages > 1 ? "s" : ""}).`);
      return { bytes: files[0].bytes, filename: files[0].name, mime: "application/pdf" };
    }
    ctx.progress(0.95, "Zipping…");
    const zip = new JSZip();
    const used = new Set();
    files.forEach((f) => {
      let name = f.name;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = f.name.replace(/\.pdf$/, ` (${i}).pdf`);
      used.add(name.toLowerCase());
      zip.file(name, f.bytes);
    });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const zipName = `${stem(ctx.files[0].name)}_chapters.zip`;
    showResult(ctx, `<strong>Saved ${files.length} chapters</strong> as separate PDFs in one ZIP.`);
    return { bytes, filename: zipName, mime: "application/zip",
      message: `Done! ${files.length} chapters saved in ${zipName}. Nothing was uploaded.` };
  }

  return {
    sizeConfig, targetBytes, updateSizeInfo, compressToSize, rasterFit,
    imagesConfig, extractImages,
    nupConfig, nupPreview, nUp, bookletConfig, booklet, bookletOrder, bestLayout,
    bookmarksConfig, parseToc, suggestHeadings, bookmarks, bookmarksOnFiles, onSuggest,
    chaptersConfig, chapterRanges, renderChapters, chaptersOnFiles, splitChapters,
    viewOf,
  };
})();

TOOLS.push(
  {
    id: "compress-to-size",
    slug: "compress-pdf-to-size",
    aliases: ["compress-pdf-to-100kb", "compress-pdf-to-200kb", "compress-pdf-to-500kb", "compress-pdf-to-1mb"],
    name: "Compress PDF to Exact Size",
    desc: "Get a PDF under the size a form asks for: 100 KB, 200 KB, 1 MB or any limit you type.",
    keywords: "compress pdf to 200kb 100kb 500kb 1mb 2mb 50kb 300kb reduce pdf size in kb exact size target size under limit govt portal upload limit shrink pdf less than mb",
    icon: "🎯",
    category: "optimize",
    badge: "Exact KB",
    caption: "Under your KB limit",
    scene: "squash",
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    endpoint: "/api/compress", // labelled as a server tool: it tries the server compressor first (run() still drives it)
    actionLabel: "Compress to size",
    configHtml: PdfExtras.sizeConfig,
    onOpen: (ctx) => {
      ctx.el("toolConfig").querySelectorAll(".px-chip").forEach((b) => b.addEventListener("click", () => {
        ctx.el("pxTarget").value = b.dataset.pxSize;
        ctx.el("pxUnit").value = b.dataset.pxUnit;
        PdfExtras.updateSizeInfo(ctx);
      }));
      ctx.el("pxUnit").addEventListener("change", () => PdfExtras.updateSizeInfo(ctx));
      PdfExtras.updateSizeInfo(ctx);
    },
    onInput: (ctx) => PdfExtras.updateSizeInfo(ctx),
    onFiles: (ctx) => PdfExtras.updateSizeInfo(ctx),
    run: PdfExtras.compressToSize,
  },
  {
    id: "extract-images",
    slug: "extract-images",
    aliases: ["extract-images-from-pdf", "pdf-image-extractor"],
    name: "Extract Images from PDF",
    desc: "Save every picture inside a PDF at its original quality, all in one ZIP.",
    keywords: "extract images from pdf get pictures save photos pdf image extractor pull out images download images jpg png from pdf export images",
    icon: "🏞️",
    category: "convert",
    badge: "Original quality",
    caption: "Every picture, full quality",
    flip: ["PDF", "IMG"],
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    actionLabel: "Extract images",
    configHtml: PdfExtras.imagesConfig,
    run: PdfExtras.extractImages,
  },
  {
    id: "n-up",
    slug: "n-up-pdf",
    aliases: ["pages-per-sheet", "multiple-pages-per-sheet"],
    name: "Pages per Sheet (N-up)",
    desc: "Print 2, 4, 6 or 9 pages on one sheet of A4 or Letter to save paper on notes and question papers.",
    keywords: "n-up 2 up 4 up pages per sheet multiple pages per page print two pages on one sheet save paper handout notes print layout imposition combine pages on one page",
    icon: "🔲",
    category: "organize",
    badge: "Save paper",
    caption: "2 · 4 · 6 · 9 per sheet",
    scene: "resize",
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    actionLabel: "Make sheets",
    configHtml: PdfExtras.nupConfig,
    onOpen: (ctx) => {
      ctx.pxFirst = null;
      ["pxPerSheet", "pxPaper", "pxOrient", "pxOrder"].forEach((id) => ctx.el(id).addEventListener("change", () => PdfExtras.nupPreview(ctx)));
      PdfExtras.nupPreview(ctx);
    },
    onFiles: async (ctx) => {
      ctx.pxFirst = null;
      try {
        const doc = await PDFLib.PDFDocument.load(ctx.buffers[0], { ignoreEncryption: true, updateMetadata: false });
        const v = PdfExtras.viewOf(doc.getPage(0));
        ctx.pxFirst = [v.width, v.height];
      } catch (e) { /* the run reports a bad file */ }
      PdfExtras.nupPreview(ctx);
    },
    run: PdfExtras.nUp,
  },
  {
    id: "booklet",
    slug: "booklet-pdf",
    aliases: ["pdf-booklet", "booklet-maker"],
    name: "Booklet Maker",
    desc: "Turn a PDF into a fold-and-staple booklet. Pages are put in the right order for double-sided printing.",
    keywords: "booklet pdf booklet maker saddle stitch fold print booklet imposition zine magazine leaflet double sided duplex print as book",
    icon: "📖",
    category: "organize",
    badge: "Print & fold",
    caption: "Print, fold, staple",
    flip: ["PDF", "BOOK"],
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    actionLabel: "Make booklet",
    configHtml: PdfExtras.bookletConfig,
    run: PdfExtras.booklet,
  },
  {
    id: "pdf-bookmarks",
    slug: "pdf-bookmarks",
    aliases: ["add-bookmarks-to-pdf", "pdf-table-of-contents"],
    name: "Bookmarks & Contents",
    desc: "Add a clickable contents page and bookmarks to a PDF. Type the chapters, or let it find the headings.",
    keywords: "add bookmarks to pdf table of contents toc index page outline chapters navigation clickable contents study notes headings links",
    icon: "🔖",
    category: "edit",
    badge: "Study kit",
    caption: "Clickable contents page",
    scene: "tag",
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    actionLabel: "Add contents",
    configHtml: PdfExtras.bookmarksConfig,
    onOpen: (ctx) => {
      const btn = ctx.el("pxSuggest");
      btn.addEventListener("click", () => PdfExtras.onSuggest(ctx, btn));
    },
    onFiles: PdfExtras.bookmarksOnFiles,
    run: PdfExtras.bookmarks,
  },
  {
    id: "split-by-bookmarks",
    slug: "split-by-bookmarks",
    aliases: ["split-pdf-by-chapters", "split-by-chapters"],
    name: "Split by Chapters",
    desc: "Split a big PDF into one file per chapter using its bookmarks. See the page ranges before you save.",
    keywords: "split pdf by chapters bookmarks outline split book textbook chapter wise separate chapters split by toc table of contents study",
    icon: "📚",
    category: "organize",
    badge: "Study kit",
    caption: "One PDF per chapter",
    scene: "split",
    accept: ".pdf,application/pdf",
    acceptLabel: "a PDF",
    actionLabel: "Split chapters",
    configHtml: PdfExtras.chaptersConfig,
    onOpen: (ctx) => {
      ctx.pxOutline = null;
      ctx.pxRanges = null;
      ["pxDepth", "pxFront"].forEach((id) => ctx.el(id).addEventListener("change", () => PdfExtras.renderChapters(ctx)));
    },
    onFiles: PdfExtras.chaptersOnFiles,
    run: PdfExtras.splitChapters,
  },
);
