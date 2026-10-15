// Fill PDF forms: finds the form fields in a PDF (text boxes, tick boxes, radio buttons, drop-downs,
// lists), shows them as a simple form with a live page preview, and saves the filled PDF.
// Runs in the browser with pdf-lib and pdf.js; the file is never uploaded.

const FormFill = (() => {
  const { PDFDocument, PDFName, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
    PDFSignature, PDFButton, StandardFonts } = window.PDFLib || {};
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!document.querySelector("link[data-ff-css]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/form-fill.css?v=13" });
    link.dataset.ffCss = "1";
    document.head.append(link);
  }

  // ---------- Lazy font for letters outside plain English (Ł, ő, Cyrillic, Greek…) ----------
  let fontkitLoader = null;
  function loadFontkit() {
    if (window.fontkit) return Promise.resolve(window.fontkit);
    if (!fontkitLoader) {
      fontkitLoader = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/static/vendor/fontkit.umd.min.js?v=13";
        s.onload = () => (window.fontkit ? resolve(window.fontkit) : reject(UserError("Couldn't start the font helper.")));
        s.onerror = () => { fontkitLoader = null; s.remove(); reject(UserError("Couldn't load the font for special letters. Check your connection and try again.")); };
        document.head.append(s);
      });
    }
    return fontkitLoader;
  }
  async function unicodeFont(doc) {
    const fontkit = await loadFontkit();
    const res = await fetch("/static/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf");
    if (!res.ok) throw UserError("Couldn't load the font for special letters. Check your connection and try again.");
    doc.registerFontkit(fontkit);
    return doc.embedFont(new Uint8Array(await res.arrayBuffer()), { subset: true });
  }

  async function loadDoc(bytes) {
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      throw UserError("This file doesn't look like a valid PDF.");
    }
    if (doc.isEncrypted) throw UserError("This PDF is password protected. Use Unlock PDF first.");
    return doc;
  }

  // ---------- Reading the form ----------

  /** "applicant_first-name[0]" or "form1[0].Page1[0].FirstName[0]" -> "Applicant first name" / "First name". */
  function prettify(name) {
    const parts = String(name).split(".").map((p) => p.replace(/\[\d+\]$/, "")).filter(Boolean);
    let n = parts.filter((p) => !/^(form|topmostsubform|page|subform)\d*$/i.test(p)).pop() || parts.pop() || String(name);
    n = n.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
    if (!n) n = String(name);
    n = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    return n.replace(/\b(pan|pin|dob|id|upi|ifsc|gst|gstin|pdf|ssn|zip)\b/gi, (w) => w.toUpperCase());
  }

  function tooltip(field) {
    try {
      const tu = field.acroField.dict.lookup(PDFName.of("TU"));
      const t = tu && tu.decodeText ? tu.decodeText().trim() : "";
      return t && t.length <= 120 ? t : "";
    } catch (e) { return ""; }
  }

  function kindOf(field) {
    if (field instanceof PDFTextField) return "text";
    if (field instanceof PDFCheckBox) return "checkbox";
    if (field instanceof PDFRadioGroup) return "radio";
    if (field instanceof PDFDropdown) return "dropdown";
    if (field instanceof PDFOptionList) return "list";
    if (field instanceof PDFSignature) return "signature";
    if (field instanceof PDFButton) return "button";
    return "other";
  }

  /** The page and rectangle of every widget (the visible box) of a field. */
  function widgetsOf(doc, field) {
    const pages = doc.getPages();
    const out = [];
    let widgets = [];
    try { widgets = field.acroField.getWidgets(); } catch (e) { return out; }
    for (const w of widgets) {
      let page = -1;
      const pRef = w.P && w.P();
      if (pRef) page = pages.findIndex((p) => p.ref === pRef || p.ref.objectNumber === pRef.objectNumber);
      if (page < 0) {
        const ref = doc.context.getObjectRef(w.dict);
        if (ref) {
          page = pages.findIndex((p) => {
            const annots = p.node.Annots();
            return annots && annots.asArray().some((a) => a === ref || a.objectNumber === ref.objectNumber);
          });
        }
      }
      let rect = null;
      try { rect = w.getRectangle(); } catch (e) { /* no rectangle */ }
      let onValue = null;
      try {
        const v = w.getOnValue && w.getOnValue();
        if (v) onValue = v.decodeText ? v.decodeText() : String(v).replace(/^\//, "");
      } catch (e) { /* none */ }
      out.push({ page, rect, onValue });
    }
    return out;
  }

  function readValue(field, kind) {
    try {
      if (kind === "text") return field.getText() || "";
      if (kind === "checkbox") return field.isChecked();
      if (kind === "radio") return field.getSelected() || "";
      if (kind === "dropdown") return (field.getSelected() || [])[0] || "";
      if (kind === "list") return field.getSelected() || [];
    } catch (e) { /* unreadable value */ }
    return kind === "checkbox" ? false : kind === "list" ? [] : "";
  }

  async function readForm(bytes) {
    const doc = await loadDoc(bytes);
    const form = doc.getForm();
    const hasXfa = !!form.acroForm.dict.lookup(PDFName.of("XFA"));
    let fields = [];
    try { fields = form.getFields(); } catch (e) { fields = []; }
    const list = [];
    const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };
    for (const f of fields) {
      const kind = kindOf(f);
      if (kind === "button" || kind === "other") continue;
      const name = f.getName();
      const info = {
        name, kind, label: tooltip(f) || prettify(name),
        widgets: widgetsOf(doc, f),
        readOnly: safe(() => f.isReadOnly(), false),
        required: safe(() => f.isRequired(), false),
      };
      const pages = info.widgets.map((w) => w.page).filter((p) => p >= 0);
      info.page = pages.length ? Math.min(...pages) : -1;
      if (kind === "text") {
        info.maxLength = safe(() => f.getMaxLength(), undefined);
        info.multiline = safe(() => f.isMultiline(), false);
      }
      if (kind === "radio" || kind === "dropdown" || kind === "list") info.options = safe(() => f.getOptions(), []);
      if (kind === "dropdown") info.editable = safe(() => f.isEditable(), false);
      if (kind === "list") info.multi = safe(() => f.isMultiselect(), false);
      info.value = readValue(f, kind);
      info.original = Array.isArray(info.value) ? [...info.value] : info.value;
      list.push(info);
    }
    // Reading order: page, then top to bottom, then left to right.
    const top = (f) => (f.widgets[0] && f.widgets[0].rect ? f.widgets[0].rect.y + f.widgets[0].rect.height : 0);
    const left = (f) => (f.widgets[0] && f.widgets[0].rect ? f.widgets[0].rect.x : 0);
    list.sort((a, b) => {
      const pa = a.page < 0 ? 1e9 : a.page, pb = b.page < 0 ? 1e9 : b.page;
      if (pa !== pb) return pa - pb;
      const dy = top(b) - top(a);
      return Math.abs(dy) > 4 ? dy : left(a) - left(b);
    });
    return { fields: list, hasXfa, pageCount: doc.getPageCount() };
  }

  // ---------- Writing the answers ----------

  /**
   * Makes sure answers fit their box: picks a size for "auto" text when an embedded font is used
   * (pdf-lib sizes those badly), and shrinks text whose fixed size is taller than the box.
   */
  function fitFontSize(field, kind, value, custom) {
    try {
      const da = field.acroField.getDefaultAppearance() || "";
      const m = da.match(/([\d.]+)\s+Tf/);
      const size = m ? Number(m[1]) : 0;
      const w = field.acroField.getWidgets()[0];
      const h = w ? w.getRectangle().height : 20;
      const multi = kind === "text" && field.isMultiline();
      let max;
      if (multi) max = Math.min(12, (h - 4) / (Math.max(1, String(value || "").split("\n").length) * 1.25));
      else if (kind === "list") max = Math.min(12, (h - 2) / (Math.max(1, Math.min(field.getOptions().length, 4)) * 1.2));
      else max = Math.min(14, h * 0.7);
      max = Math.max(5, Math.floor(max * 2) / 2);
      if (size === 0 ? custom : size > max) field.setFontSize(max);
    } catch (e) { /* leave the size alone */ }
  }

  async function fill(bytes, values, { flatten = false, onProgress } = {}) {
    const doc = await loadDoc(bytes);
    const form = doc.getForm();
    // Old Adobe "XFA" data would hide the answers in some viewers; the normal form fields take over.
    try { form.deleteXFA(); } catch (e) { /* no XFA */ }
    const texts = [];
    for (const [, v] of values) {
      if (typeof v === "string" && v) texts.push(v);
      if (Array.isArray(v)) texts.push(...v);
    }
    // Built-in Helvetica covers English and Western European letters; other letters need an
    // embedded font, and some scripts (Hindi, Tamil…) can't be shaped by pdf-lib at all yet.
    let font = await doc.embedFont(StandardFonts.Helvetica);
    const allText = texts.join("").replace(/[\r\n\t]/g, " ");
    let ansi = true;
    let custom = false;
    try { font.encodeText(allText); } catch (e) { ansi = false; }
    if (!ansi) {
      if (onProgress) onProgress(0.2, "Loading a font for special letters…");
      font = await unicodeFont(doc);
      custom = true;
      const have = new Set(font.getCharacterSet());
      const missing = [...new Set([...allText].filter((ch) => !/\s/.test(ch) && !have.has(ch.codePointAt(0))))];
      if (missing.length) {
        const hint = missing.includes("₹") ? " For the rupee sign, type Rs." : "";
        throw UserError(`These characters can't be written into PDF form fields here yet: ${missing.slice(0, 12).join(" ")}. Please use English letters and numbers.${hint} To write in another script, use Edit PDF and type on the page.`);
      }
    }
    if (onProgress) onProgress(0.4, "Writing your answers…");
    let needAppearances = false;
    for (const [name, v] of values) {
      let field;
      try { field = form.getField(name); } catch (e) { continue; }
      const kind = kindOf(field);
      try {
        if (kind === "text") {
          let t = String(v || "");
          const max = field.getMaxLength();
          if (max !== undefined && t.length > max) t = t.slice(0, max);
          field.setText(t || undefined);
        } else if (kind === "checkbox") {
          if (v) field.check(); else field.uncheck();
        } else if (kind === "radio" || kind === "dropdown") {
          if (v) field.select(v); else field.clear();
        } else if (kind === "list") {
          if (v && v.length) field.select(v); else field.clear();
        } else continue;
      } catch (e) {
        throw UserError(`Couldn't fill “${prettify(name)}”. ${e.message || "That value isn't allowed."}`);
      }
      if (kind === "text" || kind === "dropdown" || kind === "list") fitFontSize(field, kind, v, custom);
      try {
        if (kind === "text" || kind === "dropdown" || kind === "list") field.defaultUpdateAppearances(font);
        else field.defaultUpdateAppearances();
      } catch (e) {
        // Some forms use unusual field styles; ask the PDF viewer to draw those fields itself.
        needAppearances = true;
      }
    }
    if (needAppearances) form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
    if (flatten) {
      if (onProgress) onProgress(0.75, "Locking the answers into the page…");
      try {
        form.flatten({ updateFieldAppearances: false });
      } catch (e) {
        throw UserError("This form couldn't be locked. Save it without “Flatten” and try Flatten PDF instead.");
      }
      // pdf-lib can leave the removed fields listed on the page; drop those leftovers.
      for (const page of doc.getPages()) {
        const annots = page.node.Annots();
        if (!annots) continue;
        const keep = annots.asArray().filter((ref) => {
          const obj = doc.context.lookup(ref);
          if (!obj) return false;
          const sub = obj.get && obj.get(PDFName.of("Subtype"));
          return !(sub && sub.toString() === "/Widget");
        });
        if (keep.length) page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
        else page.node.delete(PDFName.of("Annots"));
      }
    }
    if (onProgress) onProgress(0.9, "Saving the PDF…");
    return doc.save({ updateFieldAppearances: false });
  }

  // ---------- UI ----------

  const EMPTY = `<p class="ff-empty">Add a PDF form. Every box you can fill appears here.</p>`;
  const configHtml = `<div class="ff" id="ffRoot">${EMPTY}</div>`;

  function create(root) {
    let fields = [];
    let pdfDoc = null;       // pdf.js document for previews
    let shownPage = -1;
    let renderToken = 0;
    let active = null;       // name of the field being edited
    let viewport = null;
    let closed = false;
    let resizeTimer = null;

    const changedField = (f) => (Array.isArray(f.value) ? f.value.join("\u0000") !== f.original.join("\u0000") : f.value !== f.original);
    function summaryText() {
      const changed = fields.filter(changedField).length;
      const pages = new Set(fields.map((f) => f.page).filter((p) => p >= 0)).size || 1;
      return `${fields.length} field${fields.length === 1 ? "" : "s"} on ${pages} page${pages > 1 ? "s" : ""} · ${changed} changed by you`;
    }
    const prettyOption = (o) => String(o).replace(/_+/g, " ");
    const kindLabel = (f) => ({
      text: f.multiline ? "Text, several lines" : f.maxLength ? `Text, up to ${f.maxLength}` : "Text",
      checkbox: "Tick box", radio: "Choose one", dropdown: "Drop-down", list: f.multi ? "Choose any" : "List", signature: "Signature",
    }[f.kind] || "");

    function inputHtml(f, i) {
      const id = `ffIn${i}`;
      const dis = f.readOnly ? " disabled" : "";
      if (f.kind === "text") {
        const max = f.maxLength ? ` maxlength="${f.maxLength}"` : "";
        if (f.multiline) return `<textarea id="${id}" class="form-input ff-input" rows="3"${max}${dis}>${esc(f.value)}</textarea>`;
        return `<input type="text" id="${id}" class="form-input ff-input" value="${esc(f.value)}"${max}${dis} autocomplete="off">`;
      }
      if (f.kind === "checkbox") {
        return `<label class="checkbox-group ff-check"><input type="checkbox" id="${id}"${f.value ? " checked" : ""}${dis}> Yes, tick this</label>`;
      }
      if (f.kind === "radio") {
        return `<div class="ff-radios" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map((o, k) => `
          <label class="checkbox-group"><input type="radio" ${k === 0 ? `id="${id}" ` : ""}name="${id}" value="${esc(o)}"${f.value === o ? " checked" : ""}${dis}> ${esc(prettyOption(o))}</label>`).join("")}
          <button type="button" class="btn btn-xs ff-clear" data-clear="${i}"${dis}>Clear</button></div>`;
      }
      if (f.kind === "dropdown") {
        if (f.editable) {
          return `<input type="text" id="${id}" class="form-input ff-input" list="${id}L" value="${esc(f.value)}"${dis} autocomplete="off">
            <datalist id="${id}L">${f.options.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`;
        }
        return `<select id="${id}" class="form-select ff-input"${dis}><option value="">(none)</option>${f.options.map((o) =>
          `<option value="${esc(o)}"${f.value === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      }
      if (f.kind === "list") {
        return `<select id="${id}" class="form-select ff-input"${f.multi ? " multiple" : ""} size="${Math.min(5, Math.max(2, f.options.length))}"${dis}>${f.options.map((o) =>
          `<option value="${esc(o)}"${f.value.includes(o) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      }
      if (f.kind === "signature") {
        return `<p class="ff-note">A box for a signature. Save first, then sign it with <a href="/sign-pdf" data-ff-open="sign">Sign PDF</a>.</p>`;
      }
      return "";
    }

    function renderNoFields(info, file) {
      const why = info.hasXfa
        ? "It was made with Adobe's older XFA forms, which only Adobe Acrobat Reader can fill. Open it in Adobe Reader, or type on the page with Edit PDF."
        : "It may be a scanned or flat form that only looks fillable. You can still type anywhere on it with Edit PDF.";
      root.innerHTML = `
        <div class="ff-none">
          <strong>This PDF has no fillable fields.</strong>
          <p>${why}</p>
          <button type="button" class="btn btn-primary ff-to-edit" id="ffToEdit">${Icons.ui("edit")} Type on it with Edit PDF</button>
        </div>`;
      root.querySelector("#ffToEdit").onclick = () => {
        openToolModal("edit");
        if (file) addFilesToTool([file]);
      };
    }

    function renderForm(info, file) {
      fields = info.fields;
      if (!fields.length) return renderNoFields(info, file);
      let lastPage = null;
      const rows = fields.map((f, i) => {
        let head = "";
        if (f.page !== lastPage) {
          lastPage = f.page;
          head = `<div class="ff-page-head" data-page="${f.page}">${f.page >= 0 ? `Page ${f.page + 1}` : "Other fields"}</div>`;
        }
        return `${head}<div class="ff-row${f.readOnly ? " ff-ro" : ""}" data-i="${i}">
          <div class="ff-label"><label for="ffIn${i}">${esc(f.label)}${f.required ? ' <span class="ff-req" title="Required">*</span>' : ""}</label>
            <span class="ff-kind">${kindLabel(f)}${f.page >= 0 ? ` · page ${f.page + 1}` : ""}${f.readOnly ? " · locked" : ""}</span></div>
          ${inputHtml(f, i)}
        </div>`;
      }).join("");
      root.innerHTML = `
        <div class="ff-top">
          <span class="ff-sum" id="ffSum"></span>
          ${fields.length > 8 ? `<input type="search" id="ffFilter" class="form-input ff-filter" placeholder="Find a field…" autocomplete="off" aria-label="Find a field">` : ""}
        </div>
        <div class="ff-main">
          <div class="ff-list" id="ffList">${rows}</div>
          <details class="ff-preview" id="ffPreview" open>
            <summary>Page preview</summary>
            <div class="ff-stage" id="ffStage"><div class="ff-sheet"><canvas id="ffCanvas"></canvas><div class="ff-layer" id="ffLayer"></div></div></div>
            <div class="ff-pager"><button type="button" class="btn btn-xs" id="ffPrev" aria-label="Previous page">◀</button><span id="ffPageNo">Loading the page…</span><button type="button" class="btn btn-xs" id="ffNext" aria-label="Next page">▶</button></div>
          </details>
        </div>
        <label class="checkbox-group ff-flat"><input type="checkbox" id="ffFlatten"> <span><strong>Flatten (lock answers)</strong>: the answers become part of the page, so they can't be changed and look the same in every app</span></label>`;
      if (window.matchMedia && window.matchMedia("(max-width: 700px)").matches) root.querySelector("#ffPreview").open = false;
      root.querySelector("#ffSum").textContent = summaryText();
      wire();
    }

    function update(i, value) {
      fields[i].value = value;
      root.querySelector("#ffSum").textContent = summaryText();
      const row = root.querySelector(`.ff-row[data-i="${i}"]`);
      if (row) row.classList.toggle("ff-changed", changedField(fields[i]));
      drawLayer();
    }

    function readInput(t) {
      const row = t.closest(".ff-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      const f = fields[i];
      if (f.kind === "checkbox") update(i, t.checked);
      else if (f.kind === "radio") { if (t.checked) update(i, t.value); }
      else if (f.kind === "list") update(i, [...t.selectedOptions].map((o) => o.value));
      else if (f.kind === "text" || f.kind === "dropdown") update(i, t.value);
    }

    function wire() {
      const list = root.querySelector("#ffList");
      list.addEventListener("input", (e) => readInput(e.target));
      list.addEventListener("change", (e) => readInput(e.target));
      list.addEventListener("focusin", (e) => {
        const row = e.target.closest(".ff-row");
        if (row) setActive(Number(row.dataset.i));
      });
      list.addEventListener("click", (e) => {
        const c = e.target.closest("[data-clear]");
        if (c) {
          const i = Number(c.dataset.clear);
          list.querySelectorAll(`input[name="ffIn${i}"]`).forEach((r) => { r.checked = false; });
          update(i, "");
          setActive(i);
        }
        const o = e.target.closest("[data-ff-open]");
        if (o) { e.preventDefault(); openToolModal(o.dataset.ffOpen); }
      });
      const filter = root.querySelector("#ffFilter");
      if (filter) filter.addEventListener("input", () => {
        const q = filter.value.toLowerCase().trim();
        list.querySelectorAll(".ff-row").forEach((r) => {
          const f = fields[Number(r.dataset.i)];
          r.hidden = !!q && !`${f.label} ${f.name}`.toLowerCase().includes(q);
        });
        list.querySelectorAll(".ff-page-head").forEach((h) => { h.hidden = !!q; });
      });
      root.querySelector("#ffPrev").onclick = () => showPage(Math.max(0, shownPage - 1));
      root.querySelector("#ffNext").onclick = () => showPage(Math.min((pdfDoc ? pdfDoc.numPages : 1) - 1, shownPage + 1));
      root.querySelector("#ffPreview").addEventListener("toggle", () => {
        if (root.querySelector("#ffPreview").open && shownPage >= 0) { const p = shownPage; shownPage = -1; showPage(p); }
      });
      root.querySelector("#ffLayer").addEventListener("click", (e) => {
        const box = e.target.closest("[data-i]");
        if (!box) return;
        const i = Number(box.dataset.i);
        const row = list.querySelector(`.ff-row[data-i="${i}"]`);
        if (!row) return;
        row.hidden = false;
        const input = row.querySelector("input, textarea, select");
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (input && !input.disabled) {
          if (input.type === "checkbox") { input.checked = !input.checked; update(i, input.checked); }
          input.focus({ preventScroll: true });
        }
        setActive(i);
      });
      window.addEventListener("resize", onResize);
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (shownPage >= 0) { const p = shownPage; shownPage = -1; showPage(p); } }, 200);
    }

    function setActive(i) {
      const f = fields[i];
      active = f ? f.name : null;
      root.querySelectorAll(".ff-row.ff-active").forEach((r) => r.classList.remove("ff-active"));
      const row = root.querySelector(`.ff-row[data-i="${i}"]`);
      if (row) row.classList.add("ff-active");
      if (f && f.page >= 0 && f.page !== shownPage) showPage(f.page);
      else drawLayer();
      const box = root.querySelector("#ffLayer .ff-box.on");
      const stage = root.querySelector("#ffStage");
      if (box && stage && stage.scrollHeight > stage.clientHeight) {
        stage.scrollTo({ top: Math.max(0, box.offsetTop - stage.clientHeight / 3), behavior: "smooth" });
      }
    }

    async function showPage(index) {
      if (!pdfDoc) return;
      if (index === shownPage) return drawLayer();
      const stage = root.querySelector("#ffStage");
      if (!stage) return;
      const token = ++renderToken;
      shownPage = index;
      root.querySelector("#ffPageNo").textContent = `Page ${index + 1} of ${pdfDoc.numPages}`;
      const preview = root.querySelector("#ffPreview");
      if (!preview.open) return;
      const page = await pdfDoc.getPage(index + 1);
      if (token !== renderToken || closed) return;
      const width = Math.max(220, Math.min((stage.clientWidth || 360) - 4, 760));
      const canvas = document.createElement("canvas");
      await PdfRender.renderPage(page, canvas, { maxWidth: width });
      if (token !== renderToken || closed || !root.querySelector("#ffCanvas")) return;
      canvas.id = "ffCanvas";
      root.querySelector("#ffCanvas").replaceWith(canvas);
      const base = page.getViewport({ scale: 1 });
      viewport = page.getViewport({ scale: Math.min(width / base.width, 4) });
      drawLayer();
    }

    function drawLayer() {
      const layer = root.querySelector("#ffLayer");
      if (!layer || !viewport) return;
      const boxes = [];
      fields.forEach((f, i) => {
        f.widgets.forEach((w, wi) => {
          if (w.page !== shownPage || !w.rect) return;
          const r = w.rect;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.width, r.y + r.height]);
          const l = Math.min(x1, x2), t = Math.min(y1, y2), wd = Math.abs(x2 - x1), ht = Math.abs(y2 - y1);
          const changed = changedField(f);
          let text = "";
          if (changed) {
            if (f.kind === "checkbox") text = f.value ? "✓" : "";
            else if (f.kind === "radio") text = f.value && (w.onValue === f.value || (!w.onValue && f.options[wi] === f.value)) ? "●" : "";
            else if (f.kind === "list") text = f.value.join(", ");
            else text = f.value;
          }
          const size = Math.max(7, Math.min(ht * 0.68, 14));
          const center = f.kind === "checkbox" || f.kind === "radio";
          boxes.push(`<div class="ff-box${f.name === active ? " on" : ""}${changed ? " filled" : ""}${center ? " mid" : ""}" data-i="${i}" title="${esc(f.label)}"
            style="left:${l}px;top:${t}px;width:${wd}px;height:${ht}px;font-size:${size}px">${changed ? `<span>${esc(text)}</span>` : ""}</div>`);
        });
      });
      layer.innerHTML = boxes.join("");
    }

    async function load(file, bytes) {
      root.innerHTML = `<p class="ff-empty">Looking for form fields…</p>`;
      const info = await readForm(bytes);
      if (closed) return;
      renderForm(info, file);
      if (!fields.length) return;
      try {
        pdfDoc = await PdfRender.open(bytes);
        if (closed) return;
        const first = fields.find((f) => f.page >= 0);
        await showPage(first ? first.page : 0);
      } catch (e) {
        const pv = root.querySelector("#ffPreview");
        if (pv) pv.hidden = true;
      }
    }

    function values() {
      return fields.filter((f) => !f.readOnly && f.kind !== "signature").map((f) => [f.name, f.value]);
    }

    function destroy() {
      closed = true;
      renderToken++;
      window.removeEventListener("resize", onResize);
      if (pdfDoc) pdfDoc.destroy().catch(() => {});
      pdfDoc = null;
      viewport = null;
      shownPage = -1;
    }

    function reset() {
      destroy();
      closed = false;
      fields = [];
      root.innerHTML = EMPTY;
    }

    return {
      load, values, destroy, reset,
      hasFields: () => fields.length > 0,
      flatten: () => !!(root.querySelector("#ffFlatten") || {}).checked,
    };
  }

  async function run(ctx) {
    const ui = ctx.formFill;
    if (!ui || !ui.hasFields()) throw UserError("This PDF has no fillable fields. Use Edit PDF to type anywhere on the page.");
    const bytes = await fill(ctx.buffers[0], ui.values(), { flatten: ui.flatten(), onProgress: ctx.progress });
    const base = ctx.files[0].name.replace(/\.pdf$/i, "");
    return { bytes, filename: `${base}_filled.pdf`, mime: "application/pdf" };
  }

  return { configHtml, create, run, fill, readForm, prettify };
})();

TOOLS.push({
  id: "fill-form",
  slug: "fill-pdf-form",
  name: "Fill PDF Form",
  desc: "Type into the boxes of a fillable PDF form, tick check boxes, pick options and save. Lock the answers if you like.",
  keywords: "fill pdf form filler fillable form acroform type in pdf form fields tick box checkbox radio button dropdown application form bank form government form kyc form sarkari form complete form fill in answers flatten lock form editable form interactive form",
  icon: "📝",
  category: "edit",
  badge: "New",
  accept: ".pdf,application/pdf",
  acceptLabel: "PDF forms",
  wide: true,
  compactFileList: true, // so onFiles also runs when the file is removed
  actionLabel: "Save filled PDF",
  caption: "Type, tick & save",
  scene: "write",
  configHtml: FormFill.configHtml,
  onOpen: (ctx) => { ctx.formFill = FormFill.create(ctx.el("ffRoot")); },
  onFiles: async (ctx) => {
    ctx.formFill.reset();
    if (ctx.files.length) await ctx.formFill.load(ctx.files[0], ctx.buffers[0]);
  },
  onClose: (ctx) => ctx.formFill && ctx.formFill.destroy(),
  run: FormFill.run,
});
