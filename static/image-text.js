// Image to Text and JPG to Word: read the words in photos, screenshots and scans with the
// server's Tesseract OCR (image_ocr.py). Text comes back to copy; Word comes back as a .docx.

const ImageText = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function languageSelect(hint) {
    const ocr = TOOLS.find((t) => t.id === "ocr");
    const langs = (ocr && ocr.languages) || [];
    return `
      <div class="form-group">
        <label class="form-label" for="itLanguage">Language of the text</label>
        <select id="itLanguage" class="form-select">
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
        <p class="drop-hint">${hint}</p>
      </div>`;
  }

  function renderResults(data, box) {
    const results = (data && data.results) || [];
    const all = results.map((r) => (results.length > 1 ? `--- ${r.name} ---\n${r.text}` : r.text)).join("\n\n");
    box.innerHTML = `
      <div class="it-results">
        ${results.map((r, i) => `
          <section class="it-item">
            <div class="it-head"><strong>${esc(r.name)}</strong><span>${r.words ? `${r.words} word${r.words === 1 ? "" : "s"}` : "No text found"}</span></div>
            <textarea class="form-input it-text" rows="${Math.min(14, Math.max(4, r.text.split("\n").length + 1))}" data-i="${i}" spellcheck="false">${esc(r.text)}</textarea>
          </section>`).join("")}
        <div class="sign-row it-actions">
          <button type="button" class="btn btn-primary btn-xs" data-act="copy">${Icons.ui("copy")} Copy ${results.length > 1 ? "all " : ""}text</button>
          <button type="button" class="btn btn-xs" data-act="txt">${Icons.ui("download")} Download .txt</button>
        </div>
        ${results.some((r) => !r.words) ? `<p class="drop-hint">Nothing readable in some pictures. Check the language, and use a sharper, well-lit, straight photo.</p>` : ""}
      </div>`;
    // Edits in the boxes are kept for Copy and Download.
    const current = () => {
      const boxes = [...box.querySelectorAll(".it-text")];
      return boxes.map((t, i) => (boxes.length > 1 ? `--- ${results[i].name} ---\n${t.value}` : t.value)).join("\n\n");
    };
    box.querySelector('[data-act="copy"]').addEventListener("click", async () => {
      const text = current();
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const t = box.querySelector(".it-text");
        t.select();
        document.execCommand("copy");
      }
      showToast("Copied the text.", "success");
    });
    box.querySelector('[data-act="txt"]').addEventListener("click", () => {
      const name = results.length === 1 ? `${ImageKit.stem(results[0].name)}.txt` : SaveName.auto("pictures_text.txt");
      downloadBlob(new Blob([current() || all], { type: "text/plain;charset=utf-8" }), name);
    });
  }

  return { languageSelect, renderResults };
})();

TOOLS.push(
  {
    id: "image-to-text",
    slug: "image-to-text",
    aliases: ["image-to-text-converter", "photo-to-text", "extract-text-from-image", "ocr-image", "jpg-to-text", "picture-to-text"],
    name: "Image to Text",
    desc: "Copy the text out of a photo, screenshot or scanned page. Works with Hindi and other Indian languages too.",
    keywords: "image to text converter photo to text picture to text extract text from image ocr online jpg to text png to text screenshot to text copy text from photo hindi ocr read text",
    category: "image",
    badge: "New",
    accept: "image/*,.jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff",
    acceptLabel: "photos or screenshots",
    multipleFiles: true,
    endpoint: "/api/image-to-text",
    slow: true,
    actionLabel: "Get the text",
    caption: "Copy words from photos",
    get configHtml() { return ImageText.languageSelect("Up to 20 pictures at once. Straight, sharp, well-lit photos read best."); },
    form: (ctx) => ({ language: ctx.value("itLanguage") || "eng" }),
    renderResult: (data, box) => ImageText.renderResults(data, box),
  },
  {
    id: "jpg-to-word",
    slug: "jpg-to-word",
    aliases: ["image-to-word", "jpeg-to-word", "png-to-word", "photo-to-word", "jpg-to-word-converter"],
    name: "JPG to Word",
    desc: "Turn a photo or scan of a page into an editable Word document. Paragraphs and line breaks are kept.",
    keywords: "jpg to word converter jpeg to word image to word png to word photo to word scan to word editable word docx ocr picture to doc",
    category: "convert",
    badge: "New",
    accept: "image/*,.jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff",
    acceptLabel: "photos or scans",
    multipleFiles: true,
    endpoint: "/api/image-to-word",
    slow: true,
    actionLabel: "Convert to Word",
    caption: "Photo in, Word out",
    get configHtml() { return ImageText.languageSelect("Several pictures become one Word file, one page each, in the order you add them."); },
    form: (ctx) => ({ language: ctx.value("itLanguage") || "eng" }),
  },
);
