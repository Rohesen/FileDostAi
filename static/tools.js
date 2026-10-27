// Tool catalogue. Each tool is a small config plus a handler:
//   run(ctx)          runs in the browser (via the PDF worker or pdf.js); the file is never uploaded.
//   endpoint + form() sends the file to the server, which processes it in memory and does not store it.
//   board             shows the page grid ("organize", "select", "remove" or "rotate").
//   onFiles(ctx)      called after files are chosen, e.g. to fill in a form.
// ctx = { files: File[], buffers: Uint8Array[], board, value(id), checked(id), el(id) }
// slug is the tool's own web address (/merge-pdf); main.py serves the same slugs.

const TOOLS = [
  {
    id: "merge",
    slug: "merge-pdf",
    name: "Merge PDF",
    desc: "Combine PDFs into one file. Drag pages to change the order, turn or remove any page.",
    icon: "📑",
    category: "organize",
    badge: "Most popular",
    accept: ".pdf,application/pdf",
    multipleFiles: true,
    board: "organize",
    boardOptional: true,
    configHtml: `
      <div class="board-toolbar">
        <span class="drop-hint">Add more files any time. Drag a page, or use ◀ ▶, to move it.</span>
        <button type="button" class="btn btn-xs" data-board="resetOrder">Original order</button>
      </div>`,
    run: (ctx) => {
      if (ctx.buffers.length < 2) throw new ClientPDF.UserError("Add at least two PDFs to merge.");
      // Merging can start before the thumbnails are drawn: without a board it keeps the files' order.
      return PdfWorker.run("assemble", ctx.buffers, ctx.board ? ctx.board.plan() : null, "merged.pdf");
    },
  },
  {
    id: "split",
    slug: "split-pdf",
    name: "Split PDF",
    desc: "Pick pages to pull out into a new PDF, or save every page as its own file.",
    icon: "✂️",
    category: "organize",
    badge: "Core",
    accept: ".pdf,application/pdf",
    board: "select",
    configHtml: `
      <div class="form-group">
        <div class="radio-row">
          <label class="checkbox-group"><input type="radio" name="splitMode" value="ranges" checked> Selected pages into one PDF</label>
          <label class="checkbox-group"><input type="radio" name="splitMode" value="all"> Every page as a separate PDF (ZIP)</label>
        </div>
        <input type="text" id="splitRanges" class="form-input" placeholder="Click pages below, or type e.g. 1-3, 5">
        <div class="board-toolbar">
          <button type="button" class="btn btn-xs" data-action="selectAll">Select all</button>
          <button type="button" class="btn btn-xs" data-action="selectNone">Clear</button>
        </div>
      </div>`,
    onBoardChange: (ctx) => { ctx.el("splitRanges").value = PageBoard.toRanges(ctx.board.selectedPages()); },
    onInput: (ctx, id) => {
      if (id === "splitRanges") syncSelection(ctx, "splitRanges", "setSelection");
    },
    actions: {
      selectAll: (ctx) => ctx.board.setSelection([...Array(ctx.board.totalPages()).keys()]),
      selectNone: (ctx) => ctx.board.setSelection([]),
    },
    run: (ctx) => {
      const mode = document.querySelector('input[name="splitMode"]:checked').value;
      const ranges = mode === "all" ? "all" : ctx.value("splitRanges");
      if (mode !== "all" && !ranges.trim()) throw new ClientPDF.UserError("Click the pages you want, or type a range like 1-3.");
      return PdfWorker.run("split", ctx.buffers[0], ranges);
    },
  },
  {
    id: "organize",
    slug: "organize-pdf",
    name: "Organize PDF",
    desc: "See every page. Drag to reorder, turn pages, and delete the ones you don't need.",
    icon: "🔀",
    category: "organize",
    badge: "Visual",
    accept: ".pdf,application/pdf",
    board: "organize",
    configHtml: `
      <div class="board-toolbar">
        <span class="drop-hint">Drag a page, or use ◀ ▶, to move it.</span>
        <button type="button" class="btn btn-xs" data-board="reverse">Reverse order</button>
        <button type="button" class="btn btn-xs" data-board="resetOrder">Original order</button>
      </div>`,
    run: (ctx) => PdfWorker.run("assemble", ctx.buffers, ctx.board.plan(), "organized.pdf"),
  },
  {
    id: "remove-pages",
    slug: "remove-pages",
    name: "Remove Pages",
    desc: "Click the pages you don't want. Everything else stays in order.",
    icon: "🗑️",
    category: "organize",
    badge: "Core",
    accept: ".pdf,application/pdf",
    board: "remove",
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="removePagesList">Pages to remove</label>
        <input type="text" id="removePagesList" class="form-input" placeholder="Click pages below, or type e.g. 2, 5-7">
      </div>`,
    onBoardChange: (ctx) => { ctx.el("removePagesList").value = PageBoard.toRanges(ctx.board.removedPages()); },
    onInput: (ctx, id) => {
      if (id === "removePagesList") syncSelection(ctx, "removePagesList", "setRemoved");
    },
    run: (ctx) => {
      if (!ctx.board.removedPages().length) throw new ClientPDF.UserError("Click the pages you want to remove.");
      return PdfWorker.run("assemble", ctx.buffers, ctx.board.plan(), "pages_removed.pdf");
    },
  },
  {
    id: "rotate",
    slug: "rotate-pdf",
    name: "Rotate PDF",
    desc: "Turn single pages with a click, or all pages at once.",
    icon: "🔄",
    category: "organize",
    badge: "Core",
    accept: ".pdf,application/pdf",
    board: "rotate",
    configHtml: `
      <div class="board-toolbar">
        <span class="drop-hint">Click a page to turn it 90° clockwise.</span>
        <button type="button" class="btn btn-xs" data-action="left">⟲ All left</button>
        <button type="button" class="btn btn-xs" data-action="right">⟳ All right</button>
      </div>`,
    actions: {
      left: (ctx) => ctx.board.rotateAll(270),
      right: (ctx) => ctx.board.rotateAll(90),
    },
    run: (ctx) => {
      if (ctx.board.plan().every((p) => !p.rotate)) throw new ClientPDF.UserError("Click a page or use the buttons to turn pages first.");
      return PdfWorker.run("assemble", ctx.buffers, ctx.board.plan(), "rotated.pdf");
    },
  },
  {
    id: "compress",
    slug: "compress-pdf",
    name: "Compress PDF",
    desc: "Shrink PDFs by downsampling and recompressing images and removing unused data. Text stays sharp.",
    icon: "📉",
    category: "optimize",
    badge: "Smaller files",
    accept: ".pdf,application/pdf",
    endpoint: "/api/compress",
    form: (ctx) => ({ level: ctx.value("compressLevel") }),
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="compressLevel">Compression</label>
        <select id="compressLevel" class="form-select">
          <option value="low">Low: lossless, images untouched</option>
          <option value="medium" selected>Recommended: images at 150 dpi</option>
          <option value="extreme">Extreme: images at 72 dpi, smallest file</option>
        </select>
      </div>`,
  },
  {
    id: "img-to-pdf",
    slug: "jpg-to-pdf",
    aliases: ["png-to-pdf", "image-to-pdf"],
    name: "JPG & PNG to PDF",
    desc: "Merge any number of JPG, PNG, WebP or other images into one PDF. Sort by date or name, or drag them into your own order.",
    keywords: "images to pdf png to pdf jpg to pdf jpeg to pdf photo to pdf picture merge png merge jpg merge jpeg merge images merge photos combine images combine png combine jpg join images many images",
    icon: "🖼️",
    category: "convert",
    badge: "Convert",
    accept: "image/*,.heic,.heif,.avif,.bmp,.svg",
    acceptLabel: "images",
    multipleFiles: true,
    compactFileList: true,
    wide: true,
    actionLabel: "Make PDF",
    configHtml: `<div id="imgOrderRoot"></div>`,
    onOpen: (ctx) => {
      ctx.order = ImageOrder.create(ctx.el("imgOrderRoot"), {
        onRemove: (file) => { const i = currentFiles.indexOf(file); if (i >= 0) removeFile(i); },
      });
    },
    onFiles: (ctx) => ctx.order.setFiles(ctx.files),
    onClose: (ctx) => ctx.order && ctx.order.destroy(),
    run: async (ctx) => {
      const files = ctx.order.files();
      const layout = ctx.order.layout();
      const images = [];
      for (let i = 0; i < files.length; i++) {
        ctx.progress(i / files.length * 0.8, `Adding image ${i + 1} of ${files.length}`);
        images.push({ ...(await imageForPdf(files[i])), layout });
      }
      ctx.progress(0.85, `Building the PDF (${files.length} pages)`);
      const out = await PdfWorker.run("imagesToPdf", images);
      out.filename = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") + ".pdf" : "images.pdf";
      return out;
    },
  },
  {
    id: "image-convert",
    slug: "convert-image",
    aliases: ["png-to-jpg", "jpg-to-png", "webp-to-jpg", "pdf-to-png"],
    name: "Image Converter",
    desc: "Change any image to JPG, PNG, WebP, AVIF, BMP, ICO or PDF, or turn PDF pages into images. Resize while you're at it.",
    keywords: "png to jpg jpg to png webp to jpg heic avif bmp ico svg to png pdf to png image format",
    icon: "🔄",
    category: "image",
    badge: "Any format",
    accept: "image/*,.svg,.ico,.avif,.pdf,application/pdf,.heic,.heif",
    acceptLabel: "images or PDFs",
    multipleFiles: true,
    actionLabel: "Convert & download",
    configHtml: ImageConvert.configHtml,
    onInput: ImageConvert.onInput,
    run: ImageConvert.run,
  },
  {
    id: "photo-resize",
    slug: "resize-image",
    aliases: ["crop-image", "image-cropper", "photo-resizer"],
    name: "Exam Photo & Signature Resizer",
    desc: "Crop and resize a photo or signature to the exact pixels, KB and DPI that JEE, NEET, SSC, UPSC and other forms ask for.",
    keywords: "image cropper crop image resize image kb jee neet ssc upsc passport photo signature 20kb 50kb dpi pixels",
    icon: "🪪",
    category: "image",
    badge: "Exam ready",
    accept: "image/*,.heic,.heif",
    acceptLabel: "a photo",
    wide: true,
    actionLabel: "Save photo",
    configHtml: `<div id="photoRoot"></div>`,
    onOpen: (ctx) => { ctx.photo = PhotoTool.create(ctx.el("photoRoot")); },
    onFiles: (ctx) => ctx.photo.setFile(ctx.files[0]),
    onClose: (ctx) => ctx.photo && ctx.photo.destroy(),
    run: (ctx) => ctx.photo.result(),
  },
  {
    id: "compress-any",
    slug: "compress-file",
    aliases: ["compress-image", "reduce-image-size"],
    name: "Compress Any File",
    desc: "Make photos, PDFs, Word, Excel, PowerPoint and any other file smaller. Set a target size in KB if a form has a limit.",
    keywords: "reduce file size compress image compress jpg compress png kb reduce photo size zip docx pptx",
    icon: "🗜️",
    category: "optimize",
    badge: "Any file",
    accept: "*/*",
    acceptLabel: "any files",
    multipleFiles: true,
    actionLabel: "Compress & download",
    configHtml: AnyCompress.configHtml,
    run: AnyCompress.run,
  },
  {
    id: "scan",
    slug: "scan-to-pdf",
    name: "Scan to PDF",
    desc: "Take photos of paper pages with your camera, straighten and clean them up, and save one PDF.",
    icon: "📷",
    category: "convert",
    badge: "Mobile",
    accept: "image/*,.heic,.heif",
    acceptLabel: "photos",
    multipleFiles: true,
    wide: true,
    configHtml: `<div id="scanRoot"></div>`,
    onOpen: (ctx) => { ctx.scan = ScanTool.create(ctx.el("scanRoot")); },
    onFiles: (ctx) => ctx.scan.setFiles(ctx.files),
    onClose: (ctx) => ctx.scan && ctx.scan.destroy(),
    run: async (ctx) => {
      const t0 = performance.now();
      let result = await PdfWorker.run("imagesToPdf", await ctx.scan.pages());
      const name = ctx.scan.name();
      if (ctx.scan.ocr()) {
        ctx.progress(0.8, "Making the text searchable on the server…");
        const fd = new FormData();
        fd.append("file", new Blob([result.bytes], { type: "application/pdf" }), name);
        fd.append("language", "eng");
        const r = await serverRequest("/api/ocr", fd, ctx, { quiet: true, label: "Making the text searchable (OCR)…" });
        result = { ...result, bytes: r.bytes };
      }
      result = { ...result, filename: name };
      ScanTool._lastMs = Math.round(performance.now() - t0);
      ctx.scan.setResult(result);
      return result;
    },
  },
  {
    id: "word-to-pdf",
    slug: "word-to-pdf",
    aliases: ["doc-to-pdf", "docx-to-pdf"],
    name: "Word (DOC) to PDF",
    keywords: "doc docx word document odt rtf ms word to pdf convert doc to pdf",
    desc: "Turn Word documents into PDFs that look exactly like the original.",
    icon: "📘",
    category: "convert",
    badge: "Convert",
    accept: ".doc,.docx,.odt,.rtf,.txt",
    acceptLabel: "Word files (.doc, .docx, .odt, .rtf)",
    endpoint: "/api/to-pdf",
    slow: true,
    configHtml: `<p class="drop-hint">Fonts, tables, images and page layout are kept.</p>`,
  },
  {
    id: "excel-to-pdf",
    slug: "excel-to-pdf",
    aliases: ["xls-to-pdf", "xlsx-to-pdf"],
    name: "Excel (XLS) to PDF",
    keywords: "xls xlsx excel spreadsheet sheet ods csv to pdf convert xls to pdf",
    desc: "Turn spreadsheets into PDFs, one sheet after another.",
    icon: "📗",
    category: "convert",
    badge: "Convert",
    accept: ".xls,.xlsx,.ods,.csv",
    acceptLabel: "Excel files (.xls, .xlsx, .ods, .csv)",
    endpoint: "/api/to-pdf",
    slow: true,
    configHtml: `<p class="drop-hint">Uses each sheet's print settings. CSV files become a neat table.</p>`,
  },
  {
    id: "powerpoint-to-pdf",
    slug: "powerpoint-to-pdf",
    aliases: ["ppt-to-pdf", "pptx-to-pdf"],
    name: "PowerPoint (PPT) to PDF",
    keywords: "ppt pptx powerpoint slides presentation deck odp to pdf convert ppt to pdf",
    desc: "Turn slide decks into PDFs to share or print, one slide per page.",
    icon: "📙",
    category: "convert",
    badge: "Convert",
    accept: ".ppt,.pptx,.odp",
    acceptLabel: "PowerPoint files (.ppt, .pptx, .odp)",
    endpoint: "/api/to-pdf",
    slow: true,
    configHtml: `<p class="drop-hint">Every slide becomes a page.</p>`,
  },
  {
    id: "markdown-to-pdf",
    slug: "markdown-to-pdf",
    name: "Markdown, HTML & CSV to PDF",
    desc: "Turn Markdown notes, HTML pages, CSV tables or plain text into clean, readable PDFs.",
    icon: "🧩",
    category: "convert",
    badge: "New",
    accept: ".md,.markdown,.html,.htm,.csv,.txt",
    acceptLabel: "Markdown, HTML, CSV or text files",
    endpoint: "/api/to-pdf",
    configHtml: `<p class="drop-hint">Headings, lists, tables, code and links are formatted. Nothing is fetched from the internet.</p>`,
  },
  {
    id: "pdf-to-jpg",
    slug: "pdf-to-jpg",
    name: "PDF to JPG",
    desc: "Save each page as a JPG or PNG image.",
    icon: "📸",
    category: "convert",
    badge: "Convert",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label" for="imgFormat">Format</label>
          <select id="imgFormat" class="form-select"><option value="jpeg">JPG</option><option value="png">PNG</option></select>
        </div>
        <div class="form-group">
          <label class="form-label" for="imgDpi">Quality</label>
          <select id="imgDpi" class="form-select">
            <option value="72">Screen (72 dpi)</option>
            <option value="150" selected>Standard (150 dpi)</option>
            <option value="300">High (300 dpi)</option>
            <option value="600">Print (600 dpi)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="imgPages">Pages</label>
        <input type="text" id="imgPages" class="form-input" value="all" placeholder="all, or e.g. 1-3, 5">
      </div>`,
    run: (ctx) => PdfRender.toImages(ctx.buffers[0], {
      format: ctx.value("imgFormat"),
      dpi: Number(ctx.value("imgDpi")),
      pages: ctx.value("imgPages") || "all",
      onProgress: (n, total) => setProcessingLabel(`Rendering page ${n} of ${total}...`),
    }),
  },
  {
    id: "pdf-to-text",
    actionLabel: "Extract text",
    slug: "pdf-to-text",
    name: "PDF to Text",
    desc: "Pull out the text as Markdown, ready to copy into notes or an AI chat.",
    icon: "📝",
    category: "convert",
    badge: "LLM ready",
    accept: ".pdf,application/pdf",
    configHtml: `<p class="drop-hint">Scanned pages have no text yet. Run OCR PDF on them first.</p>`,
    run: async (ctx) => ({ json: await PdfRender.extractText(ctx.buffers[0]) }),
  },
  {
    id: "pdf-to-docx",
    slug: "pdf-to-word",
    aliases: ["pdf-to-doc", "pdf-to-docx"],
    name: "PDF to Word (DOC)",
    keywords: "pdf to doc pdf to docx editable word document convert pdf to word",
    desc: "Turn a PDF into an editable Word document with its layout, tables and images.",
    icon: "📄",
    category: "convert",
    badge: "Editable",
    accept: ".pdf,application/pdf",
    endpoint: "/api/pdf-to-docx",
    slow: true,
    configHtml: `<p class="drop-hint">Scanned pages need OCR PDF first, so their text can be edited.</p>`,
  },
  {
    id: "pdf-to-excel",
    slug: "pdf-to-excel",
    aliases: ["pdf-to-xls", "pdf-to-xlsx"],
    name: "PDF to Excel (XLS)",
    keywords: "pdf to xls pdf to xlsx spreadsheet table extract convert pdf to excel",
    desc: "Pull tables out of a PDF into a spreadsheet, with numbers you can add up.",
    icon: "📊",
    category: "convert",
    badge: "New",
    accept: ".pdf,application/pdf",
    endpoint: "/api/pdf-to-excel",
    slow: true,
    configHtml: `<p class="drop-hint">Each page with tables becomes a sheet. Amounts like 1,234.50 or 12% become real numbers.</p>`,
  },
  {
    id: "pdf-to-powerpoint",
    slug: "pdf-to-powerpoint",
    aliases: ["pdf-to-ppt", "pdf-to-pptx"],
    name: "PDF to PowerPoint (PPT)",
    keywords: "pdf to ppt pdf to pptx slides presentation convert pdf to powerpoint",
    desc: "Turn PDF pages into slides, with each page's text in the speaker notes.",
    icon: "📽️",
    category: "convert",
    badge: "New",
    accept: ".pdf,application/pdf",
    endpoint: "/api/pdf-to-powerpoint",
    slow: true,
    configHtml: `<p class="drop-hint">Great for presenting a PDF: every page becomes a sharp full-slide picture.</p>`,
  },
  {
    id: "pdf-to-pdfa",
    slug: "pdf-to-pdfa",
    name: "PDF to PDF/A",
    desc: "Make an archive-safe PDF/A that will open the same way in decades, as courts and governments require.",
    icon: "🗄️",
    category: "convert",
    badge: "Archive",
    accept: ".pdf,application/pdf",
    endpoint: "/api/pdf-to-pdfa",
    slow: true,
    configHtml: `<p class="drop-hint">Creates PDF/A-2b: fonts are embedded and colours are fixed.</p>`,
  },
  {
    id: "ocr",
    slug: "ocr-pdf",
    name: "OCR PDF",
    desc: "Turn scanned pages into searchable, selectable text with Tesseract OCR.",
    icon: "🔎",
    category: "optimize",
    badge: "Searchable",
    accept: ".pdf,application/pdf",
    endpoint: "/api/ocr",
    slow: true,
    form: (ctx) => ({ language: ctx.value("ocrLanguage") || "eng" }),
    // Tesseract code, name in its own script, English name.
    languages: [
      ["hin", "हिन्दी", "Hindi"], ["mar", "मराठी", "Marathi"], ["ben", "বাংলা", "Bengali"], ["tam", "தமிழ்", "Tamil"],
      ["tel", "తెలుగు", "Telugu"], ["guj", "ગુજરાતી", "Gujarati"], ["kan", "ಕನ್ನಡ", "Kannada"], ["mal", "മലയാളം", "Malayalam"],
      ["pan", "ਪੰਜਾਬੀ", "Punjabi"], ["urd", "اردو", "Urdu"], ["ori", "ଓଡ଼ିଆ", "Odia"], ["san", "संस्कृतम्", "Sanskrit"],
    ],
    get configHtml() {
      const langs = this.languages;
      return `
      <div class="form-group">
        <label class="form-label" for="ocrLanguage">Document language</label>
        <select id="ocrLanguage" class="form-select">
          <option value="eng" selected>English</option>
          <optgroup label="Indian languages">
            ${langs.map(([c, native, en]) => `<option value="${c}">${native} (${en})</option>`).join("")}
          </optgroup>
          <optgroup label="Mixed with English">
            ${langs.map(([c, native, en]) => `<option value="eng+${c}">English + ${en} (${native})</option>`).join("")}
          </optgroup>
          <optgroup label="Other">
            <option value="eng+fra">English + French</option>
            <option value="eng+deu">English + German</option>
            <option value="eng+spa">English + Spanish</option>
          </optgroup>
        </select>
        <p class="drop-hint">Pages that already have text are left as they are. Pick "English + …" when a page mixes English with another script. Each language needs its Tesseract language pack on the server.</p>
      </div>`;
    },
    // The server says a Tesseract language pack is missing: explain how to add it, in plain words.
    // Returns null for any other error.
    missingLanguageHelp(err, language) {
      const text = String((err && err.message) || "");
      if (!/language data|traineddata|tessdata|failed loading language|language pack/i.test(text)) return null;
      const names = Object.fromEntries([["eng", "English"], ["fra", "French"], ["deu", "German"], ["spa", "Spanish"], ...this.languages.map(([c, , en]) => [c, en])]);
      const asked = language.split("+");
      // ocrmypdf lists the missing codes between "languages:" and "Please install".
      const part = (text.match(/languages?:([\s\S]*?)(?:Please|$)/i) || [, text])[1];
      const listed = (part.match(/\b[a-z]{3}(?:_[a-z]+)?\b/g) || []).filter((c) => asked.includes(c));
      const missing = [...new Set(listed.length ? listed : asked.filter((c) => c !== "eng"))];
      const what = missing.map((c) => `${names[c] || c} (${c})`).join(", ") || "that language";
      const files = missing.map((c) => `<code>${escapeHtml(c)}.traineddata</code>`).join(" and ") || "the <code>.traineddata</code> file";
      return {
        short: `The ${what} language pack isn't installed on the server. See the steps below.`,
        html: `<div class="drop-hint" style="text-align:left;line-height:1.55">
          <p><strong>This server can't read ${escapeHtml(what)} yet.</strong> OCR uses Tesseract, and its language pack for ${escapeHtml(what)} isn't installed. Whoever runs the server can add it:</p>
          <ul style="margin:6px 0 6px 18px">
            <li><strong>Windows:</strong> run the Tesseract installer again and tick the language under <em>Additional language data</em>, or download ${files} and drop it into Tesseract's <code>tessdata</code> folder.</li>
            <li><strong>Linux:</strong> install <code>tesseract-ocr-${escapeHtml(missing[0] || "hin")}</code> (or copy the <code>.traineddata</code> file into the tessdata folder).</li>
          </ul>
          <p>Then try again. English works already.</p></div>`,
      };
    },
    // Runs the normal server request, but turns "language data missing" into plain advice.
    run: async (ctx) => {
      const tool = TOOLS.find((t) => t.id === "ocr");
      const own = new AbortController();
      if (ctx.signal) ctx.signal.addEventListener("abort", () => own.abort(), { once: true });
      Progress.begin({ steps: ["Upload", "Convert (the slowest part)", "Download the result"], expectMs: 2000, cancel: () => own.abort() });
      try {
        const r = await runOnServer(tool, { ...ctx, signal: own.signal }, ctx.files.reduce((n, f) => n + f.size, 0));
        return { ...r, message: r.message || `Done! Downloaded ${r.filename}.` };
      } catch (err) {
        const help = tool.missingLanguageHelp(err, ctx.value("ocrLanguage") || "eng");
        if (!help) throw err;
        const box = document.getElementById("resultBox");
        box.innerHTML = help.html;
        box.style.display = "flex";
        const e = new Error(help.short);
        e.userFacing = true;
        throw e;
      }
    },
  },
  {
    id: "repair",
    slug: "repair-pdf",
    name: "Repair PDF",
    desc: "Fix damaged PDFs that won't open, and recover every page that can be saved.",
    icon: "🩹",
    category: "optimize",
    badge: "New",
    accept: ".pdf,application/pdf",
    endpoint: "/api/repair",
    configHtml: `<p class="drop-hint">Rebuilds broken file structure, cross-reference tables and cut-off downloads.</p>`,
  },
  {
    id: "sign",
    slug: "sign-pdf",
    name: "Sign PDF",
    desc: "Draw, type or upload your signature and click where it goes.",
    icon: "✍️",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    wide: true,
    configHtml: `<div id="signRoot"></div>`,
    onOpen: (ctx) => { ctx.sign = SignTool.create(ctx.el("signRoot")); },
    onFiles: (ctx) => ctx.sign.setPdf(ctx.buffers[0]),
    onClose: (ctx) => ctx.sign && ctx.sign.destroy(),
    run: async (ctx) => PdfWorker.run("stampImage", ctx.buffers[0], await ctx.sign.stampArgs()),
  },
  {
    id: "edit",
    slug: "edit-pdf",
    name: "Edit PDF",
    desc: "Change existing text, add text, images, shapes, highlights and drawings, right on the page.",
    icon: "🖊️",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    wide: true,
    configHtml: `<div id="editRoot"></div>`,
    onOpen: (ctx) => { ctx.edit = EditTool.create(ctx.el("editRoot")); },
    onFiles: (ctx) => ctx.edit.setPdf(ctx.buffers[0]),
    onClose: (ctx) => ctx.edit && ctx.edit.destroy(),
    run: async (ctx) => PdfWorker.run("applyEdits", ctx.buffers[0], await ctx.edit.edits()),
  },
  {
    id: "protect",
    slug: "protect-pdf",
    name: "Protect PDF",
    desc: "Lock a PDF with a password using AES-256 encryption.",
    icon: "🔐",
    category: "security",
    badge: "Security",
    accept: ".pdf,application/pdf",
    endpoint: "/api/protect",
    form: (ctx) => {
      const pwd = ctx.value("protectPassword");
      if (!pwd) throw new ClientPDF.UserError("Enter a password.");
      if (pwd !== ctx.value("protectPassword2")) throw new ClientPDF.UserError("The two passwords don't match.");
      return { password: pwd };
    },
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="protectPassword">Password</label>
        <input type="password" id="protectPassword" class="form-input" autocomplete="new-password">
      </div>
      <div class="form-group">
        <label class="form-label" for="protectPassword2">Repeat password</label>
        <input type="password" id="protectPassword2" class="form-input" autocomplete="new-password">
      </div>`,
  },
  {
    id: "unlock",
    slug: "unlock-pdf",
    name: "Unlock PDF",
    desc: "Remove the password from a PDF you know the password for.",
    icon: "🔓",
    category: "security",
    badge: "Security",
    accept: ".pdf,application/pdf",
    endpoint: "/api/unlock",
    form: (ctx) => ({ password: ctx.value("unlockPassword") }),
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="unlockPassword">Current password</label>
        <input type="password" id="unlockPassword" class="form-input" autocomplete="current-password">
      </div>`,
  },
  {
    id: "redact",
    slug: "redact-pdf",
    name: "Redact PDF",
    desc: "Permanently removes emails, phone numbers and your keywords: the text is deleted from the file, not just covered.",
    icon: "🛡️",
    category: "security",
    badge: "True redaction",
    accept: ".pdf,application/pdf",
    endpoint: "/api/redact",
    form: (ctx) => ({
      keywords: ctx.value("redactKeywords"),
      redact_emails: ctx.checked("redactEmails"),
      redact_phones: ctx.checked("redactPhones"),
    }),
    configHtml: `
      <div class="form-group">
        <label class="checkbox-group"><input type="checkbox" id="redactEmails" checked> Email addresses</label>
        <label class="checkbox-group"><input type="checkbox" id="redactPhones" checked> Phone numbers</label>
      </div>
      <div class="form-group">
        <label class="form-label" for="redactKeywords">Words or names to remove</label>
        <input type="text" id="redactKeywords" class="form-input" placeholder="e.g. Jane Doe, Project X, salary">
        <p class="drop-hint">Separate with commas. Matching ignores upper and lower case.</p>
      </div>`,
  },
  {
    id: "privacy-check",
    actionLabel: "Check privacy",
    slug: "privacy-check-pdf",
    name: "Privacy Check",
    desc: "Find hidden personal data before you share a PDF: author names, old versions, emails, phone numbers, attachments and scripts.",
    icon: "🕵️",
    category: "security",
    badge: "New",
    accept: ".pdf,application/pdf",
    endpoint: "/api/privacy-scan",
    configHtml: `<p class="drop-hint">You get a privacy score and one-click fixes.</p>`,
    renderResult: (data, box, ctx) => PrivacyView.render(data, box, ctx),
  },
  {
    id: "flatten",
    slug: "flatten-pdf",
    name: "Flatten PDF",
    desc: "Burn form fields and annotations into the page so they can't be edited, while keeping them visible.",
    icon: "🧱",
    category: "security",
    badge: "Lock forms",
    accept: ".pdf,application/pdf",
    endpoint: "/api/flatten",
    configHtml: `<p class="drop-hint">Filled-in values, comments and stamps become part of the page.</p>`,
  },
  {
    id: "watermark",
    slug: "watermark-pdf",
    name: "Watermark PDF",
    desc: "Stamp text like DRAFT or CONFIDENTIAL across every page.",
    icon: "💧",
    category: "edit",
    badge: "Branding",
    accept: ".pdf,application/pdf",
    run: (ctx) => PdfWorker.run("watermark", ctx.buffers[0], {
      text: ctx.value("wmText") || "CONFIDENTIAL",
      opacity: parseFloat(ctx.value("wmOpacity")) || 0.25,
      angle: parseFloat(ctx.value("wmAngle")) || 0,
      fontSize: parseFloat(ctx.value("wmSize")) || 40,
    }),
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="wmText">Text</label>
        <input type="text" id="wmText" class="form-input" value="CONFIDENTIAL">
      </div>
      <div class="grid-3">
        <div class="form-group"><label class="form-label" for="wmOpacity">Opacity</label>
          <input type="number" id="wmOpacity" class="form-input" step="0.05" min="0.05" max="1" value="0.25"></div>
        <div class="form-group"><label class="form-label" for="wmAngle">Angle</label>
          <input type="number" id="wmAngle" class="form-input" value="45"></div>
        <div class="form-group"><label class="form-label" for="wmSize">Size</label>
          <input type="number" id="wmSize" class="form-input" min="8" max="200" value="40"></div>
      </div>`,
  },
  {
    id: "page-numbers",
    slug: "add-page-numbers",
    name: "Page Numbers",
    desc: "Number every page, like 'Page 3 of 10', in the corner you choose.",
    icon: "🔢",
    category: "edit",
    badge: "Formatting",
    accept: ".pdf,application/pdf",
    run: (ctx) => PdfWorker.run("pageNumbers", ctx.buffers[0], {
      format: ctx.value("pnFormat") || "Page {n} of {total}",
      position: ctx.value("pnPosition") || "bottom-center",
    }),
    configHtml: `
      <div class="form-group">
        <label class="form-label" for="pnFormat">Format</label>
        <input type="text" id="pnFormat" class="form-input" value="Page {n} of {total}">
        <p class="drop-hint">{n} is the page number, {total} the page count.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="pnPosition">Position</label>
        <select id="pnPosition" class="form-select">
          <option value="bottom-center" selected>Bottom centre</option>
          <option value="bottom-right">Bottom right</option>
          <option value="bottom-left">Bottom left</option>
          <option value="top-right">Top right</option>
          <option value="top-center">Top centre</option>
          <option value="top-left">Top left</option>
        </select>
      </div>`,
  },
  {
    id: "crop",
    slug: "crop-pdf",
    name: "Crop PDF",
    desc: "Drag a box to keep part of a page, or trim white margins in one click.",
    icon: "🔳",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    wide: true,
    configHtml: `<div id="cropRoot"></div>`,
    onOpen: (ctx) => { ctx.crop = CropTool.create(ctx.el("cropRoot")); },
    onFiles: (ctx) => ctx.crop.setPdf(ctx.buffers[0]),
    onClose: (ctx) => ctx.crop && ctx.crop.destroy(),
    run: (ctx) => PdfWorker.run("crop", ctx.buffers[0], ctx.crop.options()),
  },
  {
    id: "resize",
    slug: "resize-pdf",
    name: "Resize PDF",
    desc: "Put every page on A4, Letter, A3, A5 or Legal paper, scaled to fit without cutting anything off.",
    icon: "📐",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="grid-2">
        <div class="form-group"><label class="form-label" for="rsSize">Paper size</label>
          <select id="rsSize" class="form-select">
            <option value="a4" selected>A4 (210 × 297 mm)</option><option value="letter">US Letter</option>
            <option value="legal">US Legal</option><option value="a3">A3</option><option value="a5">A5</option>
          </select></div>
        <div class="form-group"><label class="form-label" for="rsOrient">Orientation</label>
          <select id="rsOrient" class="form-select">
            <option value="auto" selected>Match each page</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option>
          </select></div>
      </div>
      <div class="form-group"><label class="form-label" for="rsMargin">Margin (mm)</label>
        <input type="number" id="rsMargin" class="form-input" min="0" max="50" value="0"></div>`,
    run: (ctx) => PdfWorker.run("resize", ctx.buffers[0], {
      size: ctx.value("rsSize"), orientation: ctx.value("rsOrient"),
      margin: (Number(ctx.value("rsMargin")) || 0) * 72 / 25.4,
    }),
  },
  {
    id: "header-footer",
    slug: "header-footer-pdf",
    name: "Headers & Footers",
    desc: "Add a header and footer to every page: titles, dates, page numbers, in any corner.",
    icon: "🧾",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    configHtml: `
      <p class="drop-hint">Use {n} for the page number, {total} for the page count, {date}, {title} and {file}.</p>
      <label class="form-label">Header</label>
      <div class="grid-3 hf-row">
        <input type="text" id="hfHL" class="form-input" placeholder="Left">
        <input type="text" id="hfHC" class="form-input" placeholder="Centre">
        <input type="text" id="hfHR" class="form-input" placeholder="Right" value="{title}">
      </div>
      <label class="form-label" style="margin-top:12px;">Footer</label>
      <div class="grid-3 hf-row">
        <input type="text" id="hfFL" class="form-input" placeholder="Left" value="{date}">
        <input type="text" id="hfFC" class="form-input" placeholder="Centre">
        <input type="text" id="hfFR" class="form-input" placeholder="Right" value="Page {n} of {total}">
      </div>
      <div class="grid-3" style="margin-top:12px;">
        <div class="form-group"><label class="form-label" for="hfSize">Text size</label><input type="number" id="hfSize" class="form-input" min="6" max="36" value="10"></div>
        <div class="form-group"><label class="form-label" for="hfFirst">First number</label><input type="number" id="hfFirst" class="form-input" min="0" value="1"></div>
        <div class="form-group"><label class="form-label" for="hfColor">Colour</label><input type="color" id="hfColor" class="form-input" value="#334155"></div>
      </div>
      <label class="checkbox-group"><input type="checkbox" id="hfSkip"> Leave the first page (cover) blank</label>`,
    run: (ctx) => PdfWorker.run("headerFooter", ctx.buffers[0], {
      header: { left: ctx.value("hfHL"), center: ctx.value("hfHC"), right: ctx.value("hfHR") },
      footer: { left: ctx.value("hfFL"), center: ctx.value("hfFC"), right: ctx.value("hfFR") },
      fontSize: Number(ctx.value("hfSize")) || 10,
      firstNumber: Number(ctx.value("hfFirst")) || 1,
      color: ctx.value("hfColor"),
      skipFirst: ctx.checked("hfSkip"),
      filename: ctx.files[0].name,
    }),
  },
  {
    id: "invert",
    slug: "invert-pdf-colors",
    name: "Dark Mode PDF",
    desc: "Invert a PDF's colours for comfortable reading at night. Text stays sharp and searchable.",
    icon: "🌗",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="form-group"><label class="form-label" for="invPages">Pages</label>
        <input type="text" id="invPages" class="form-input" value="all" placeholder="all, or e.g. 1-3, 5"></div>`,
    run: (ctx) => PdfWorker.run("invertColors", ctx.buffers[0], { pages: ctx.value("invPages") || "all" }),
  },
  {
    id: "metadata",
    slug: "edit-pdf-metadata",
    name: "Edit Metadata",
    desc: "See and change a PDF's title, author, subject and keywords.",
    icon: "🏷️",
    category: "edit",
    badge: "New",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="form-group"><label class="form-label" for="metaTitle">Title</label><input type="text" id="metaTitle" class="form-input"></div>
      <div class="form-group"><label class="form-label" for="metaAuthor">Author</label><input type="text" id="metaAuthor" class="form-input"></div>
      <div class="form-group"><label class="form-label" for="metaSubject">Subject</label><input type="text" id="metaSubject" class="form-input"></div>
      <div class="form-group"><label class="form-label" for="metaKeywords">Keywords</label><input type="text" id="metaKeywords" class="form-input" placeholder="comma, separated"></div>
      <p class="drop-hint" id="metaInfo"></p>`,
    onFiles: async (ctx) => {
      const m = await PdfWorker.run("getMetadata", ctx.buffers[0]);
      ctx.el("metaTitle").value = m.title;
      ctx.el("metaAuthor").value = m.author;
      ctx.el("metaSubject").value = m.subject;
      ctx.el("metaKeywords").value = m.keywords;
      ctx.el("metaInfo").textContent = `${m.pages} pages${m.producer ? ` · made with ${m.producer}` : ""}`;
    },
    run: (ctx) => PdfWorker.run("editMetadata", ctx.buffers[0], {
      title: ctx.value("metaTitle"),
      author: ctx.value("metaAuthor"),
      subject: ctx.value("metaSubject"),
      keywords: ctx.value("metaKeywords"),
    }),
  },
  {
    id: "compare",
    actionLabel: "Compare",
    slug: "compare-pdf",
    name: "Compare PDFs",
    desc: "See exactly what changed between two versions: added and removed words side by side, plus a visual page check.",
    icon: "🆚",
    category: "ai",
    badge: "New",
    accept: ".pdf,application/pdf",
    multipleFiles: true,
    wide: true,
    configHtml: `<p class="drop-hint">Add the old version first, then the new one.</p>`,
    run: (ctx) => PdfCompare.run(ctx),
    renderResult: (data, box, ctx) => PdfCompare.render(data, box, ctx),
  },
  {
    id: "summarize",
    actionLabel: "Summarize",
    slug: "summarize-pdf",
    name: "Summarize PDF",
    desc: "Get the key points of a long PDF in seconds. Runs on your device, so private documents stay private.",
    icon: "🧠",
    category: "ai",
    badge: "On-device AI",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="form-group"><label class="form-label" for="sumLength">Length</label>
        <select id="sumLength" class="form-select">
          <option value="short">Short</option><option value="medium" selected>Medium</option><option value="long">Long</option>
        </select></div>
      <p class="drop-hint">Uses your browser's built-in AI when it has one (recent Chrome), otherwise picks the key sentences. Nothing is uploaded.</p>`,
    run: (ctx) => ReadTools.summaryRun(ctx),
    renderResult: (data, box) => ReadTools.summaryRender(data, box),
  },
  {
    id: "translate",
    actionLabel: "Translate",
    slug: "translate-pdf",
    name: "Translate PDF",
    desc: "Translate a PDF's text into 25 languages, including Hindi and other Indian languages, with on-device AI. Your document never leaves your computer.",
    icon: "🌐",
    category: "ai",
    badge: "On-device AI",
    accept: ".pdf,application/pdf",
    configHtml: `
      <div class="grid-2">
        <div class="form-group"><label class="form-label" for="trSource">From</label>
          <select id="trSource" class="form-select"><option value="auto" selected>Detect automatically</option>
            ${ReadTools.LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("")}</select></div>
        <div class="form-group"><label class="form-label" for="trTarget">To</label>
          <select id="trTarget" class="form-select">
            ${ReadTools.LANGS.map(([c, n]) => `<option value="${c}" ${c === "hi" ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      </div>
      <p class="drop-hint">Needs a recent Chrome on a computer. The first time, Chrome downloads the language pack.</p>`,
    run: (ctx) => ReadTools.translateRun(ctx),
    renderResult: (data, box) => ReadTools.translateRender(data, box),
  },
  {
    id: "audio",
    actionLabel: "Get ready to listen",
    slug: "pdf-to-audio",
    name: "Read PDF Aloud",
    desc: "Listen to any PDF. Pick a voice and speed, click a sentence to jump to it.",
    icon: "🔊",
    category: "ai",
    badge: "New",
    accept: ".pdf,application/pdf",
    configHtml: `<p class="drop-hint">Uses the voices built into your device. Nothing is uploaded.</p>`,
    run: (ctx) => ReadTools.audioRun(ctx),
    renderResult: (data, box) => ReadTools.audioRender(data, box),
    onClose: () => ReadTools.stopAudio(),
  },
  {
    id: "ai-analyze",
    actionLabel: "Analyze",
    slug: "pdf-insights",
    name: "Document Insights",
    desc: "Word count, reading time, readability and the most frequent topics. Uses simple text statistics, not an AI model.",
    icon: "📊",
    category: "ai",
    badge: "Insights",
    accept: ".pdf,application/pdf",
    endpoint: "/api/ai-analyze",
    configHtml: `<p class="drop-hint">Upload any PDF to see its key numbers.</p>`,
  },
];

function syncSelection(ctx, inputId, setter) {
  if (!ctx.board) return;
  try {
    const text = ctx.value(inputId).trim();
    ctx.board[setter](text ? ClientPDF.parsePageList(text, ctx.board.totalPages()) : []);
    ctx.el(inputId).classList.remove("input-error");
  } catch (e) {
    ctx.el(inputId).classList.add("input-error");
  }
}

// JPEG and PNG go straight into the PDF; other formats (WebP, GIF, BMP...) are converted to PNG in the browser.
async function imageForPdf(file) {
  if (typeof ImageKit !== "undefined" && ImageKit.normalize) file = await ImageKit.normalize(file); // HEIC → JPG
  // Trust the bytes, not the file name: a ".png" saved from a website or phone is often really
  // a JPG or WebP inside. PNG and JPG go straight in; anything else is redrawn as PNG.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isPng) return { bytes, type: "image/png", name: file.name };
  if (isJpg) return { bytes, type: "image/jpeg", name: file.name };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    throw new ClientPDF.UserError(`${file.name} isn't an image this browser can read.`);
  }
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext("2d").drawImage(bitmap, 0, 0);
  const png = await fastCanvasBlob(c, "image/png");
  return { bytes: new Uint8Array(await png.arrayBuffer()), type: "image/png", name: file.name };
}
