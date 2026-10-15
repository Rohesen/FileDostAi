// pdf.js helpers: open documents, render pages, and the PDF to image / PDF to text tools.
// Everything here runs in the browser; nothing is uploaded.

const PdfRender = (() => {
  function ready() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve) => window.addEventListener("pdfjs-ready", () => resolve(window.pdfjsLib), { once: true }));
  }

  async function open(bytes) {
    const pdfjs = await ready();
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: "/static/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/static/vendor/pdfjs/standard_fonts/",
      isEvalSupported: false,
    });
    try {
      return await task.promise;
    } catch (e) {
      if (e && e.name === "PasswordException") {
        throw new ClientPDF.UserError("This PDF is password protected. Use Unlock PDF first.");
      }
      throw new ClientPDF.UserError("This file doesn't look like a valid PDF.");
    }
  }

  /** Renders a page into a canvas. Either scale or maxWidth (CSS pixels) decides the size. */
  async function renderPage(pdfPage, canvas, { scale, maxWidth, background = "#ffffff" } = {}) {
    const base = pdfPage.getViewport({ scale: 1 });
    const s = scale || Math.min(maxWidth / base.width, 4);
    const ratio = scale ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const viewport = pdfPage.getViewport({ scale: s * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    if (!scale) {
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    return { scale: s * ratio, viewport };
  }

  function canvasToBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Couldn't encode the image."));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, type, quality));
  }

  /** PDF to JPG/PNG. One page gives one image; several pages give a ZIP. */
  async function toImages(bytes, { format = "jpeg", dpi = 150, pages = "all", onProgress } = {}) {
    const doc = await open(bytes);
    const indices = ClientPDF.parsePageList(pages, doc.numPages);
    const type = format === "png" ? "image/png" : "image/jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const canvas = document.createElement("canvas");
    const files = [];
    for (let n = 0; n < indices.length; n++) {
      const page = await doc.getPage(indices[n] + 1);
      // Cap very large pages at about 40 megapixels so the browser doesn't run out of memory.
      const base = page.getViewport({ scale: 1 });
      let scale = dpi / 72;
      const maxPixels = 40e6;
      if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
      await renderPage(page, canvas, { scale });
      files.push({ name: `page_${String(indices[n] + 1).padStart(String(doc.numPages).length, "0")}.${ext}`,
        bytes: await canvasToBytes(canvas, type, 0.92) });
      page.cleanup();
      if (onProgress) onProgress(n + 1, indices.length);
    }
    await doc.destroy();
    if (files.length === 1) return { bytes: files[0].bytes, filename: files[0].name, mime: type };
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.name, f.bytes));
    return { bytes: await zip.generateAsync({ type: "uint8array" }), filename: "pdf_images.zip", mime: "application/zip" };
  }

  /** Text of each page, with lines rebuilt from pdf.js text items. */
  async function extractText(bytes) {
    const doc = await open(bytes);
    const meta = await doc.getMetadata().catch(() => ({}));
    const pages = [];
    let words = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      words += text.split(/\s+/).filter(Boolean).length;
      pages.push({ page: i, text });
      page.cleanup();
    }
    const title = (meta.info && meta.info.Title) || "Extracted Document";
    const body = pages.map((p) => `## Page ${p.page}\n\n${p.text}`).join("\n\n");
    const result = {
      title,
      page_count: doc.numPages,
      word_count: words,
      estimated_read_time_minutes: Math.round((words / 200) * 10) / 10,
      pages,
      markdown: `# ${title}\n\n*Pages: ${doc.numPages} | Words: ${words}*\n\n---\n\n${body}`,
    };
    await doc.destroy();
    return result;
  }

  return { ready, open, renderPage, toImages, extractText };
})();
