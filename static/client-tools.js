// FileDost AI in-browser tools.
// These run entirely on the user's device with pdf-lib and JSZip: the file is never uploaded.
// Works as a browser global (window.ClientPDF) and as a CommonJS module for tests.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/pdf-lib.min.js"), require("./vendor/jszip.min.js"));
  } else {
    root.ClientPDF = factory(root.PDFLib, root.JSZip);
  }
})(typeof self !== "undefined" ? self : this, function (PDFLib, JSZip) {
  "use strict";

  const { PDFDocument, StandardFonts, rgb, degrees, BlendMode } = PDFLib;

  class UserError extends Error {}

  async function load(bytes) {
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      throw new UserError("This file doesn't look like a valid PDF.");
    }
    if (doc.isEncrypted) {
      throw new UserError("This PDF is password protected. Use Unlock PDF first.");
    }
    return doc;
  }

  function pdfResult(bytes, filename) {
    return { bytes, filename, mime: "application/pdf" };
  }

  /**
   * Parses "1-3, 5, 8-" (1-based, inclusive) into 0-based indices, in the order given.
   * "all" or an empty string selects every page. Duplicates are kept only when allowDuplicates.
   */
  function parsePageList(spec, total, { allowDuplicates = false } = {}) {
    const text = String(spec || "").trim().toLowerCase();
    if (text === "" || text === "all") return [...Array(total).keys()];
    const out = [];
    for (const raw of text.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
      if (!m || (!m[1] && !m[3])) throw new UserError(`"${part}" is not a page number or range.`);
      const start = m[1] ? parseInt(m[1], 10) : 1;
      const end = m[2] ? (m[3] ? parseInt(m[3], 10) : total) : start;
      if (start < 1 || end < 1 || start > total || end > total) {
        throw new UserError(`Page ${Math.max(start, end)} doesn't exist: this PDF has ${total} pages.`);
      }
      const step = start <= end ? 1 : -1;
      for (let p = start; step > 0 ? p <= end : p >= end; p += step) {
        if (allowDuplicates || !out.includes(p - 1)) out.push(p - 1);
      }
    }
    if (!out.length) throw new UserError("Choose at least one page.");
    return out;
  }

  async function copyPages(src, indices) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    return out;
  }

  async function merge(pdfs) {
    if (pdfs.length < 2) throw new UserError("Add at least two PDFs to merge.");
    const out = await PDFDocument.create();
    for (const bytes of pdfs) {
      const src = await load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    return pdfResult(await out.save(), "merged.pdf");
  }

  async function split(bytes, ranges) {
    const src = await load(bytes);
    const total = src.getPageCount();
    if (String(ranges || "").trim().toLowerCase() === "all") {
      const zip = new JSZip();
      const width = String(total).length;
      for (let i = 0; i < total; i++) {
        const one = await copyPages(src, [i]);
        zip.file(`page_${String(i + 1).padStart(width, "0")}.pdf`, await one.save());
      }
      const zipped = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return { bytes: zipped, filename: "split_pages.zip", mime: "application/zip" };
    }
    const out = await copyPages(src, parsePageList(ranges, total));
    return pdfResult(await out.save(), "extracted_pages.pdf");
  }

  async function reorder(bytes, order) {
    const src = await load(bytes);
    const indices = parsePageList(order, src.getPageCount(), { allowDuplicates: true });
    const out = await copyPages(src, indices);
    return pdfResult(await out.save(), "reordered.pdf");
  }

  async function removePages(bytes, pages) {
    const src = await load(bytes);
    const total = src.getPageCount();
    const drop = new Set(parsePageList(pages, total));
    const keep = [...Array(total).keys()].filter((i) => !drop.has(i));
    if (!keep.length) throw new UserError("You can't remove every page.");
    const out = await copyPages(src, keep);
    return pdfResult(await out.save(), "pages_removed.pdf");
  }

  async function rotate(bytes, angle, pages) {
    const a = Number(angle);
    if (![90, 180, 270].includes(a)) throw new UserError("Rotation must be 90, 180 or 270 degrees.");
    const doc = await load(bytes);
    const targets = new Set(parsePageList(pages, doc.getPageCount()));
    doc.getPages().forEach((page, i) => {
      if (targets.has(i)) page.setRotation(degrees((page.getRotation().angle + a) % 360));
    });
    return pdfResult(await doc.save(), "rotated.pdf");
  }

  function checkEncodable(font, text) {
    try {
      font.encodeText(text);
    } catch (e) {
      throw new UserError("This text has characters the built-in font can't draw. Use plain Latin letters.");
    }
  }

  async function watermark(bytes, { text = "CONFIDENTIAL", opacity = 0.25, angle = 45, fontSize = 40 } = {}) {
    const doc = await load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    checkEncodable(font, text);
    const rad = (Number(angle) * Math.PI) / 180;
    const w = font.widthOfTextAtSize(text, fontSize);
    const h = fontSize / 3;
    for (const page of doc.getPages()) {
      const box = page.getMediaBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // Shift the text origin so the rotated text is centred on the page.
      const x = cx - (w / 2) * Math.cos(rad) + h * Math.sin(rad);
      const y = cy - (w / 2) * Math.sin(rad) - h * Math.cos(rad);
      page.drawText(text, {
        x, y, size: fontSize, font,
        color: rgb(0.39, 0.45, 0.55),
        opacity: Math.min(Math.max(Number(opacity), 0.05), 1),
        rotate: degrees(Number(angle)),
      });
    }
    return pdfResult(await doc.save(), "watermarked.pdf");
  }

  async function pageNumbers(bytes, { format = "Page {n} of {total}", position = "bottom-center", fontSize = 10 } = {}) {
    const doc = await load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = pages.length;
    const margin = 36;
    pages.forEach((page, i) => {
      const label = format.split("{n}").join(String(i + 1)).split("{total}").join(String(total));
      checkEncodable(font, label);
      const box = page.getMediaBox();
      const w = font.widthOfTextAtSize(label, fontSize);
      const [vert, horiz] = position.split("-");
      const x = horiz === "left" ? box.x + margin
        : horiz === "right" ? box.x + box.width - w - margin
        : box.x + (box.width - w) / 2;
      const y = vert === "top" ? box.y + box.height - margin : box.y + margin;
      page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.25, 0.33) });
    });
    return pdfResult(await doc.save(), "numbered.pdf");
  }

  /** images: [{ bytes, type: "image/jpeg" | "image/png" }]. Each image gets a page of its own size (96 dpi). */
  async function imagesToPdf(images) {
    if (!images.length) throw new UserError("Add at least one image.");
    const doc = await PDFDocument.create();
    for (const { bytes, type, pageSize, layout, name } of images) {
      let img;
      try {
        img = type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch (e) {
        throw new UserError(`${name || "One image"} looks damaged and can't be added. Remove it and try again.`);
      }
      if (layout) {
        // layout: { paper: [w, h] in points or null for the image's own size, margin in points }.
        // The image keeps its shape, centred; landscape photos get a landscape page.
        const m = layout.margin || 0, iw = img.width * 0.75, ih = img.height * 0.75;
        let [pw, ph] = layout.paper || [iw + 2 * m, ih + 2 * m];
        if (layout.paper && iw > ih && pw < ph) [pw, ph] = [ph, pw];
        const s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
        const page = doc.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - iw * s) / 2, y: (ph - ih * s) / 2, width: iw * s, height: ih * s });
        continue;
      }
      // pageSize (points) when the caller knows the paper, e.g. a scan to A4.
      const [w, h] = pageSize || [img.width * 0.75, img.height * 0.75];
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    return pdfResult(await doc.save(), "images.pdf");
  }


  /**
   * Builds a new PDF from pages of one or more PDFs.
   * plan: [{ file: index into pdfs, page: 0-based page, rotate: extra degrees (0/90/180/270) }]
   * This one call backs merge, organize, rotate and remove pages in the page-grid UI.
   */
  async function assemble(pdfs, plan, filename = "organized.pdf") {
    if (!plan.length) throw new UserError("There are no pages left to save.");
    const sources = [];
    for (const bytes of pdfs) sources.push(await load(bytes));
    const out = await PDFDocument.create();
    // Copy each source's pages once, then reuse them in plan order.
    const copied = new Map();
    for (let f = 0; f < sources.length; f++) {
      const wanted = [...new Set(plan.filter((p) => p.file === f).map((p) => p.page))];
      for (const pg of wanted) {
        if (pg < 0 || pg >= sources[f].getPageCount()) throw new UserError(`Page ${pg + 1} doesn't exist.`);
      }
      if (!wanted.length) continue;
      const pages = await out.copyPages(sources[f], wanted);
      wanted.forEach((pg, i) => copied.set(`${f}:${pg}`, pages[i]));
    }
    const used = new Set();
    for (const step of plan) {
      const key = `${step.file}:${step.page}`;
      let page = copied.get(key);
      if (!page) throw new UserError("A page in the list couldn't be found.");
      if (used.has(key)) {
        // The same page used twice needs its own copy, or rotating one would rotate both.
        [page] = await out.copyPages(sources[step.file], [step.page]);
      }
      used.add(key);
      const extra = ((Number(step.rotate) || 0) % 360 + 360) % 360;
      if (extra % 90) throw new UserError("Pages can only be turned in steps of 90 degrees.");
      if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
      out.addPage(page);
    }
    return pdfResult(await out.save(), filename);
  }

  async function getMetadata(bytes) {
    const doc = await load(bytes);
    return {
      title: doc.getTitle() || "",
      author: doc.getAuthor() || "",
      subject: doc.getSubject() || "",
      keywords: doc.getKeywords() || "",
      creator: doc.getCreator() || "",
      producer: doc.getProducer() || "",
      pages: doc.getPageCount(),
    };
  }

  /** Sets the given fields; an empty string clears a field, a missing key leaves it alone. */
  async function editMetadata(bytes, fields) {
    const doc = await load(bytes);
    if ("title" in fields) doc.setTitle(fields.title || "");
    if ("author" in fields) doc.setAuthor(fields.author || "");
    if ("subject" in fields) doc.setSubject(fields.subject || "");
    if ("keywords" in fields) {
      doc.setKeywords(String(fields.keywords || "").split(",").map((k) => k.trim()).filter(Boolean));
    }
    doc.setModificationDate(new Date());
    return pdfResult(await doc.save(), "metadata_updated.pdf");
  }

  /**
   * Stamps an image (a signature, initials, a logo) onto pages.
   * placements: [{ page: 0-based, x, y, width, height }] in PDF points from the page's
   * bottom-left as the reader sees it (page rotation is taken into account).
   */
  async function stampImage(bytes, { imageBytes, imageType = "image/png", placements }) {
    if (!placements || !placements.length) throw new UserError("Click on the page to place your signature.");
    const doc = await load(bytes);
    const img = imageType === "image/png" ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
    const pages = doc.getPages();
    for (const pl of placements) {
      const page = pages[pl.page];
      if (!page) throw new UserError(`Page ${pl.page + 1} doesn't exist.`);
      const box = page.getCropBox();
      const rot = page.getRotation().angle % 360;
      // Convert from what the reader sees (rotated page) to the page's own coordinates.
      let { x, y, width: w, height: h } = pl;
      let opts;
      if (rot === 90) opts = { x: box.x + box.width - y, y: box.y + x, width: w, height: h, rotate: degrees(90) };
      else if (rot === 180) opts = { x: box.x + box.width - x, y: box.y + box.height - y, width: w, height: h, rotate: degrees(180) };
      else if (rot === 270) opts = { x: box.x + y, y: box.y + box.height - x, width: w, height: h, rotate: degrees(270) };
      else opts = { x: box.x + x, y: box.y + y, width: w, height: h };
      page.drawImage(img, opts);
    }
    return pdfResult(await doc.save(), "signed.pdf");
  }

  /** 0-based page indices from a page spec, or every page. */
  function pickPages(spec, total) {
    return !spec || String(spec).trim().toLowerCase() === "all" ? [...Array(total).keys()] : parsePageList(spec, total);
  }

  /** Page size as the reader sees it, and a function that maps reader coordinates to the page's own. */
  function viewOf(page) {
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const w = rot % 180 ? box.height : box.width;
    const h = rot % 180 ? box.width : box.height;
    const toPage = (x, y) => {
      if (rot === 90) return { x: box.x + box.width - y, y: box.y + x };
      if (rot === 180) return { x: box.x + box.width - x, y: box.y + box.height - y };
      if (rot === 270) return { x: box.x + y, y: box.y + box.height - x };
      return { x: box.x + x, y: box.y + y };
    };
    return { box, rot, width: w, height: h, toPage };
  }

  /**
   * Crops pages. margins are fractions (0-1) of the page as the reader sees it, cut from each side.
   * Sets the CropBox, which every viewer and printer honours.
   */
  async function crop(bytes, { left = 0, top = 0, right = 0, bottom = 0, pages = "all" } = {}) {
    const m = [left, top, right, bottom].map(Number);
    if (m.some((v) => !(v >= 0 && v < 1)) || m[0] + m[2] >= 0.95 || m[1] + m[3] >= 0.95) {
      throw new UserError("The crop area is too small.");
    }
    const [L, T, R, B] = m;
    const doc = await load(bytes);
    const all = doc.getPages();
    for (const i of pickPages(pages, all.length)) {
      const page = all[i];
      const { box, rot } = viewOf(page);
      // Which side of the page's own box each side of the reader's view falls on.
      const side = {
        0: { l: L, r: R, t: T, b: B },
        90: { l: T, r: B, t: R, b: L },
        180: { l: R, r: L, t: B, b: T },
        270: { l: B, r: T, t: L, b: R },
      }[rot];
      const x = box.x + side.l * box.width;
      const y = box.y + side.b * box.height;
      page.setCropBox(x, y, box.width * (1 - side.l - side.r), box.height * (1 - side.t - side.b));
    }
    return pdfResult(await doc.save(), "cropped.pdf");
  }

  const PAPER = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008] };

  /** Puts every page on a new paper size, scaled to fit and centred. orientation: auto | portrait | landscape. */
  async function resize(bytes, { size = "a4", orientation = "auto", margin = 0, pages = "all" } = {}) {
    if (!PAPER[size]) throw new UserError("Pick a paper size.");
    const src = await load(bytes);
    const out = await PDFDocument.create();
    const srcPages = src.getPages();
    const wanted = new Set(pickPages(pages, srcPages.length));
    for (let i = 0; i < srcPages.length; i++) {
      if (!wanted.has(i)) {
        const [copy] = await out.copyPages(src, [i]);
        out.addPage(copy);
        continue;
      }
      const sp = srcPages[i];
      const { box, rot, width: dw, height: dh } = viewOf(sp);
      let [W, H] = PAPER[size];
      const landscape = orientation === "landscape" || (orientation === "auto" && dw > dh);
      if (landscape) [W, H] = [H, W];
      const mg = Math.max(0, Math.min(Number(margin) || 0, Math.min(W, H) / 4));
      const s = Math.min((W - 2 * mg) / dw, (H - 2 * mg) / dh);
      const ox = (W - dw * s) / 2;
      const oy = (H - dh * s) / 2;
      const emb = await out.embedPage(sp, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
      const page = out.addPage([W, H]);
      const at = {
        0: { x: ox, y: oy },
        90: { x: ox, y: oy + dh * s },
        180: { x: ox + dw * s, y: oy + dh * s },
        270: { x: ox + dw * s, y: oy },
      }[rot];
      page.drawPage(emb, { x: at.x, y: at.y, xScale: s, yScale: s, rotate: degrees(-rot) });
    }
    return pdfResult(await out.save(), `resized_${size}.pdf`);
  }

  /**
   * Header and footer text. header/footer: { left, center, right } with {n}, {total}, {date}, {title}, {file}.
   * firstNumber: the number printed on page 1. skipFirst: leave the first page (a cover) blank.
   */
  async function headerFooter(bytes, {
    header = {}, footer = {}, fontSize = 10, margin = 30, color = "#334155",
    firstNumber = 1, skipFirst = false, filename = "", pages = "all",
  } = {}) {
    const doc = await load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const all = doc.getPages();
    const total = all.length;
    const date = new Date().toLocaleDateString();
    const title = doc.getTitle() || filename.replace(/\.pdf$/i, "");
    const hex = /^#?([0-9a-f]{6})$/i.exec(color);
    const c = hex ? rgb(...[0, 2, 4].map((k) => parseInt(hex[1].slice(k, k + 2), 16) / 255)) : rgb(0.2, 0.25, 0.33);
    const slots = [["header", "left"], ["header", "center"], ["header", "right"], ["footer", "left"], ["footer", "center"], ["footer", "right"]];
    const texts = { header, footer };
    if (!slots.some(([band, pos]) => (texts[band][pos] || "").trim())) throw new UserError("Type the text for a header or footer.");
    const size = Math.max(5, Math.min(Number(fontSize) || 10, 48));
    const mg = Math.max(4, Number(margin) || 30);
    for (const i of pickPages(pages, total)) {
      if (skipFirst && i === 0) continue;
      const page = all[i];
      const view = viewOf(page);
      for (const [band, pos] of slots) {
        const raw = (texts[band][pos] || "").trim();
        if (!raw) continue;
        const label = raw.split("{n}").join(String(i + Number(firstNumber || 1)))
          .split("{total}").join(String(total)).split("{date}").join(date)
          .split("{title}").join(title).split("{file}").join(filename);
        checkEncodable(font, label);
        const w = font.widthOfTextAtSize(label, size);
        const x = pos === "left" ? mg : pos === "right" ? view.width - mg - w : (view.width - w) / 2;
        const y = band === "header" ? view.height - mg - size * 0.75 : mg;
        const p = view.toPage(x, y);
        page.drawText(label, { x: p.x, y: p.y, size, font, color: c, rotate: degrees(view.rot) });
      }
    }
    return pdfResult(await doc.save(), "header_footer.pdf");
  }

  /** Dark mode for documents: inverts every colour on the page. Text stays real, selectable text. */
  async function invertColors(bytes, { pages = "all" } = {}) {
    const doc = await load(bytes);
    const all = doc.getPages();
    for (const i of pickPages(pages, all.length)) {
      const box = all[i].getCropBox();
      // Paint white paper under the content first: pages are transparent, and inverting
      // "nothing" would leave the background white in some viewers.
      const paper = doc.context.register(doc.context.stream(
        `q 1 1 1 rg ${box.x} ${box.y} ${box.width} ${box.height} re f Q`));
      const contents = all[i].node.Contents();
      if (contents instanceof PDFLib.PDFArray) contents.insert(0, paper);
      else all[i].node.set(PDFLib.PDFName.of("Contents"), doc.context.obj(contents ? [paper, contents] : [paper]));
      all[i].drawRectangle({
        x: box.x, y: box.y, width: box.width, height: box.height,
        color: rgb(1, 1, 1), blendMode: BlendMode.Difference,
      });
    }
    return pdfResult(await doc.save(), "inverted.pdf");
  }

  async function pageCount(bytes) {
    return (await load(bytes)).getPageCount();
  }

  return {
    UserError, parsePageList, merge, split, reorder, removePages, rotate, watermark, pageNumbers,
    imagesToPdf, pageCount, assemble, getMetadata, editMetadata, stampImage,
    crop, resize, headerFooter, invertColors,
  };
});
