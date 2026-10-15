// Edit PDF: change existing text, add text, images, shapes, highlights, white-out and drawings
// on a pdf.js page view. Only the current page is rendered; objects are kept per page.
// The objects are turned into plain data by edits() and drawn into the PDF by edit-ops.js in a
// Web Worker. Nothing is uploaded.
//
// Coordinates of every object are PDF points on the page as displayed (after /Rotate),
// from the top-left corner, y down. See the format notes at the top of edit-ops.js.

const EditTool = (() => {
  // Keep in sync with edit-ops.js: where the first baseline sits inside a text box.
  const METRICS = { sans: [0.905, 0.212], serif: [0.891, 0.216], mono: [0.833, 0.3] };
  const LINE_HEIGHT = 1.2;
  const baselineOffset = (font) => {
    const [a, d] = METRICS[font] || METRICS.sans;
    return (LINE_HEIGHT - (a + d)) / 2 + a;
  };
  const FONT_CSS = {
    sans: "Helvetica, Arial, 'Liberation Sans', 'Noto Sans', sans-serif",
    serif: "'Times New Roman', Times, 'Liberation Serif', 'Noto Serif', serif",
    mono: "'Courier New', Courier, 'Liberation Mono', monospace",
  };
  const FONT_LABEL = { sans: "Sans (Helvetica)", serif: "Serif (Times)", mono: "Mono (Courier)" };

  // Characters the standard PDF fonts (WinAnsi encoding) can draw.
  const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  function winAnsi(s) {
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c === 10 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.includes(ch)) continue;
      return false;
    }
    return true;
  }

  const I = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    select: I('<path d="M5 3l13 7.5-5.8 1.6L9.6 18z"/><path d="M12.4 12.2l4.6 6.3"/>'),
    edittext: I('<path d="M3 6V4h11v2"/><path d="M8.5 4v14"/><path d="M6 18h5"/><path d="M15 20l1-3.5 4.5-4.5 2.5 2.5-4.5 4.5z"/>'),
    text: I('<path d="M5 7V4h14v3"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
    image: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-10 9"/>'),
    rect: I('<rect x="3.5" y="6" width="17" height="12" rx="1.5"/>'),
    ellipse: I('<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'),
    line: I('<path d="M5 19L19 5"/>'),
    arrow: I('<path d="M5 19L19 5"/><path d="M10 5h9v9"/>'),
    highlight: I('<path d="M9.5 15.5l-3-3 8.5-8.5 3 3z"/><path d="M6.5 12.5L4 17.5h4.5l1-2"/><path d="M3 21h18" stroke-width="3" stroke="#facc15"/>'),
    whiteout: I('<path d="M4 15.5L13.5 6l5.5 5.5L11.5 19H7.5z"/><path d="M9 10.5l5.5 5.5"/><path d="M14 19h7"/>'),
    pen: I('<path d="M3 18c2.5-2 4-7 7-7s2 7 5 7 4-4 6-6"/>'),
    undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>'),
    redo: I('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>'),
    prev: I('<path d="M15 18l-6-6 6-6"/>'),
    next: I('<path d="M9 18l6-6-6-6"/>'),
    zoomOut: I('<circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="M20.5 20.5L16 16"/>'),
    zoomIn: I('<circle cx="11" cy="11" r="7"/><path d="M8 11h6M11 8v6"/><path d="M20.5 20.5L16 16"/>'),
    trash: I('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>'),
    front: I('<path d="M12 17V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>'),
    back: I('<path d="M12 4v13"/><path d="M7 12l5 5 5-5"/><path d="M4 20h16"/>'),
    edit: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  };

  const TOOLS = [
    { id: "select", label: "Select", key: "v", group: 0 },
    { id: "edittext", label: "Edit text", key: "e", group: 0 },
    { id: "text", label: "Add text", key: "t", group: 0 },
    { id: "image", label: "Image", key: "i", group: 0 },
    { id: "rect", label: "Rectangle", key: "r", group: 1, iconOnly: true },
    { id: "ellipse", label: "Ellipse", key: "o", group: 1, iconOnly: true },
    { id: "line", label: "Line", key: "l", group: 1, iconOnly: true },
    { id: "arrow", label: "Arrow", key: "a", group: 1, iconOnly: true },
    { id: "highlight", label: "Highlight", key: "h", group: 2 },
    { id: "whiteout", label: "White-out", key: "w", group: 2 },
    { id: "pen", label: "Draw", key: "p", group: 2 },
  ];
  const HINTS = {
    select: "Click an object to select it. Drag to move it, use the handles to resize. Double-click text to edit it.",
    edittext: "Click any text on the page to change it. The old words are covered and redrawn in a matching font.",
    text: "Click on the page where the text should go, then type. Press Esc when you're done.",
    rect: "Drag on the page to draw a rectangle. Hold Shift for a square.",
    ellipse: "Drag on the page to draw an ellipse. Hold Shift for a circle.",
    line: "Drag to draw a line. Hold Shift to snap to 45°.",
    arrow: "Drag from the tail to the tip. Hold Shift to snap to 45°.",
    highlight: "Drag over text to highlight it.",
    whiteout: "Drag over anything you want to hide. It's covered with an opaque box.",
    pen: "Draw freely with your mouse, finger or stylus.",
  };
  const BOX_TYPES = new Set(["rect", "ellipse", "highlight", "whiteout", "image"]);
  const STICKY_TOOLS = new Set(["highlight", "whiteout", "pen", "edittext"]);
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const r2 = (v) => Math.round(v * 100) / 100;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const toast = (msg, kind = "error") => (typeof showToast === "function" ? showToast(msg, kind) : console.warn(msg));

  function html() {
    const btn = (t) => `
      <button type="button" class="ed-tool${t.iconOnly ? " ed-tool-icon" : ""}" data-tool="${t.id}" aria-pressed="false" title="${t.label} (${t.key.toUpperCase()})" aria-label="${t.label}">
        ${ICONS[t.id]}<span class="ed-tool-label">${t.label}</span>
      </button>`;
    const groups = [];
    TOOLS.forEach((t) => {
      if (!groups.length || groups[groups.length - 1].g !== t.group) groups.push({ g: t.group, items: [] });
      groups[groups.length - 1].items.push(t);
    });
    const toolBtns = groups.map((g) => g.items.map(btn).join("")).join('<span class="ed-sep" aria-hidden="true"></span>');
    return `
      <div class="ed">
        <p class="ed-empty">Add a PDF above to start editing. Every change happens on your device.</p>
        <div class="ed-main" hidden>
          <div class="ed-bar">
            <div class="ed-tools" role="toolbar" aria-label="Editing tools">${toolBtns}
              <span class="ed-history">
                <button type="button" class="ed-icon-btn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>${ICONS.undo}</button>
                <button type="button" class="ed-icon-btn" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo" disabled>${ICONS.redo}</button>
              </span>
            </div>
          </div>
          <div class="ed-props" role="group" aria-label="Properties"></div>
          <p class="ed-hint" aria-live="polite"></p>
          <div class="ed-stage" tabindex="-1">
            <div class="ed-page" data-tool="select">
              <canvas class="ed-canvas" aria-label="PDF page"></canvas>
              <div class="ed-covers"></div>
              <div class="ed-runs"></div>
              <div class="ed-layer"></div>
              <svg class="ed-ink" hidden></svg>
              <div class="ed-sel" hidden></div>
            </div>
            <div class="ed-loading" hidden><span class="ed-spinner"></span></div>
          </div>
          <div class="ed-nav">
            <div class="ed-nav-group" role="group" aria-label="Pages">
              <button type="button" class="ed-icon-btn" data-act="prev" aria-label="Previous page" title="Previous page (Page Up)">${ICONS.prev}</button>
              <label class="ed-pagebox">Page <input type="number" class="ed-pagenum" min="1" value="1" aria-label="Page number"> <span class="ed-pagecount">of 1</span></label>
              <button type="button" class="ed-icon-btn" data-act="next" aria-label="Next page" title="Next page (Page Down)">${ICONS.next}</button>
            </div>
            <span class="ed-count" aria-live="polite">No changes yet</span>
            <div class="ed-nav-group" role="group" aria-label="Zoom">
              <button type="button" class="ed-icon-btn" data-act="zoomout" aria-label="Zoom out" title="Zoom out">${ICONS.zoomOut}</button>
              <button type="button" class="ed-zoomval" data-act="fit" title="Fit to width">Fit</button>
              <button type="button" class="ed-icon-btn" data-act="zoomin" aria-label="Zoom in" title="Zoom in">${ICONS.zoomIn}</button>
            </div>
          </div>
          <input type="file" class="ed-file" accept="image/*" hidden>
        </div>
      </div>`;
  }

  function create(root) {
    root.innerHTML = html();
    const q = (sel) => root.querySelector(sel);
    const main = q(".ed-main"), stage = q(".ed-stage"), pageEl = q(".ed-page"), canvas = q(".ed-canvas");
    const layer = q(".ed-layer"), coversEl = q(".ed-covers"), runsEl = q(".ed-runs"), selEl = q(".ed-sel");
    const ink = q(".ed-ink"), propsEl = q(".ed-props"), hintEl = q(".ed-hint"), fileInput = q(".ed-file");

    // Make sure ClientPDF.applyEdits exists on the page too, for when Web Workers are unavailable.
    if (window.ClientPDF && !ClientPDF.applyEdits && !document.querySelector("script[data-edit-ops]")) {
      const s = document.createElement("script");
      s.src = "/static/edit-ops.js";
      s.dataset.editOps = "1";
      document.head.appendChild(s);
    }

    let doc = null;
    let pdfPage = null;
    let pageIndex = 0;
    let W = 612, H = 792; // displayed page size in points
    let fit = 1, zoom = 1, scale = 1; // CSS px per point = fit * zoom
    let renderTask = null, renderToken = 0, renderedIndex = -1;
    let tool = "select";
    let selectedId = null, editingId = null;
    let nextId = 1;
    let drag = null;
    let destroyed = false;
    const objects = new Map(); // page -> [object]
    const els = new Map(); // id -> element
    const runsCache = new Map(); // page -> runs
    const urls = new Set();
    let undoStack = [], redoStack = [];
    let lastKey = null, lastKeyTime = 0;

    const defaults = {
      text: { font: "sans", size: 16, color: "#111827", bold: false, italic: false, align: "left", opacity: 1 },
      rect: { stroke: "#e11d48", fill: null, strokeWidth: 2, opacity: 1 },
      ellipse: { stroke: "#e11d48", fill: null, strokeWidth: 2, opacity: 1 },
      line: { stroke: "#e11d48", strokeWidth: 3, opacity: 1 },
      arrow: { stroke: "#e11d48", strokeWidth: 3, opacity: 1 },
      highlight: { color: "#ffe94d", opacity: 0.5 },
      whiteout: { color: "#ffffff" },
      pen: { stroke: "#2563eb", strokeWidth: 3, opacity: 1 },
      image: { opacity: 1 },
    };

    // ---------- object helpers
    const pageObjs = (p = pageIndex) => {
      if (!objects.has(p)) objects.set(p, []);
      return objects.get(p);
    };
    function find(id) {
      for (const list of objects.values()) {
        const o = list.find((x) => x.id === id);
        if (o) return o;
      }
      return null;
    }
    const selected = () => (selectedId ? find(selectedId) : null);
    function clone(o) {
      const c = { ...o };
      if (o.paths) c.paths = o.paths.map((p) => p.slice());
      if (o.cover) c.cover = { ...o.cover };
      delete c.fresh; delete c.editSnap; delete c.typed;
      return c;
    }
    function bbox(o) {
      if (o.type === "line" || o.type === "arrow") {
        return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
      }
      if (o.type === "pen") {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of o.paths) {
          for (let i = 0; i + 1 < p.length; i += 2) {
            x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
          }
        }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (o.type === "text") return { x: o.x, y: o.y, w: o.w || o.size, h: o.h || o.size * LINE_HEIGHT };
      return { x: o.x, y: o.y, w: o.w, h: o.h };
    }

    // ---------- undo / redo
    function snapshot() {
      const s = [];
      for (const [p, list] of objects) s.push([p, list.map(clone)]);
      return { objects: s, selectedId };
    }
    function restore(s) {
      objects.clear();
      for (const [p, list] of s.objects) objects.set(p, list.map(clone));
      selectedId = s.selectedId && find(s.selectedId) && find(s.selectedId).page === pageIndex ? s.selectedId : null;
      editingId = null;
    }
    /** Saves the state before a change. Changes with the same key in quick succession share one step. */
    function checkpoint(key = null, snap = null) {
      const now = Date.now();
      if (key && key === lastKey && now - lastKeyTime < 1200) { lastKeyTime = now; return; }
      lastKey = key; lastKeyTime = now;
      undoStack.push(snap || snapshot());
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
      updateHistory();
    }
    function undo() {
      if (editingId) commitEdit();
      if (!undoStack.length) return;
      redoStack.push(snapshot());
      restore(undoStack.pop());
      lastKey = null;
      refresh();
    }
    function redo() {
      if (editingId) commitEdit();
      if (!redoStack.length) return;
      undoStack.push(snapshot());
      restore(redoStack.pop());
      lastKey = null;
      refresh();
    }
    function updateHistory() {
      q('[data-act="undo"]').disabled = !undoStack.length;
      q('[data-act="redo"]').disabled = !redoStack.length;
      let n = 0;
      const pages = [];
      for (const [p, list] of [...objects].sort((a, b) => a[0] - b[0])) {
        if (list.length) { n += list.length; pages.push(p + 1); }
      }
      const shown = pages.length > 6 ? `${pages.slice(0, 6).join(", ")}…` : pages.join(", ");
      q(".ed-count").textContent = n ? `${n} change${n > 1 ? "s" : ""} on page${pages.length > 1 ? "s" : ""} ${shown}` : "No changes yet";
    }

    // ---------- coordinates
    function toPt(e) {
      const r = pageEl.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    }
    function visibleCenter() {
      const pr = pageEl.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const top = Math.max(pr.top, sr.top, 0), bottom = Math.min(pr.bottom, sr.bottom, window.innerHeight);
      const left = Math.max(pr.left, sr.left), right = Math.min(pr.right, sr.right);
      const cx = right > left ? (left + right) / 2 : pr.left + pr.width / 2;
      const cy = bottom > top ? (top + bottom) / 2 : pr.top + pr.height / 2;
      return { x: clamp((cx - pr.left) / scale, 0, W), y: clamp((cy - pr.top) / scale, 0, H) };
    }

    // ---------- rendering the page
    async function renderPage() {
      if (!doc || destroyed) return;
      const token = ++renderToken;
      if (renderTask) { renderTask.cancel(); renderTask = null; }
      const loading = q(".ed-loading");
      const spin = setTimeout(() => { if (token === renderToken) loading.hidden = false; }, 150);
      try {
        const page = await doc.getPage(pageIndex + 1);
        if (token !== renderToken) return;
        if (pdfPage && pdfPage !== page) pdfPage.cleanup();
        pdfPage = page;
        const base = page.getViewport({ scale: 1 });
        const avail = Math.max(stage.clientWidth - (window.innerWidth < 600 ? 16 : 40), 200);
        const newFit = clamp(avail / base.width, 0.1, 4);
        const newScale = newFit * zoom;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: newScale * ratio });
        // Draw off-screen first so the old page stays up until the new one is ready.
        const off = document.createElement("canvas");
        off.width = Math.floor(vp.width);
        off.height = Math.floor(vp.height);
        const ctx = off.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, off.width, off.height);
        renderTask = page.render({ canvasContext: ctx, viewport: vp });
        await renderTask.promise;
        renderTask = null;
        if (token !== renderToken) return;
        // Switch size and scale only now, so the overlay never disagrees with the picture.
        W = base.width; H = base.height; fit = newFit; scale = newScale;
        renderedIndex = pageIndex;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d").drawImage(off, 0, 0);
        canvas.style.width = `${W * scale}px`;
        canvas.style.height = `${H * scale}px`;
        pageEl.style.width = `${W * scale}px`;
        pageEl.style.height = `${H * scale}px`;
        ink.setAttribute("viewBox", `0 0 ${W} ${H}`);
        q(".ed-pagenum").value = pageIndex + 1;
        q(".ed-zoomval").textContent = zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`;
        q('[data-act="prev"]').disabled = pageIndex === 0;
        q('[data-act="next"]').disabled = pageIndex >= doc.numPages - 1;
        refresh();
        if (tool === "edittext") loadRuns();
      } catch (err) {
        if (err && err.name === "RenderingCancelledException") return;
        if (token === renderToken) toast(`Couldn't show this page: ${err.message || err}`);
      } finally {
        clearTimeout(spin);
        if (token === renderToken) loading.hidden = true;
      }
    }

    function goTo(i) {
      if (!doc) return;
      i = clamp(i, 0, doc.numPages - 1);
      if (editingId) commitEdit();
      if (i === pageIndex) { q(".ed-pagenum").value = i + 1; return; }
      pageIndex = i;
      selectedId = null;
      runsEl.innerHTML = "";
      stage.scrollTop = 0;
      renderPage();
    }
    function setZoom(z) {
      zoom = clamp(z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
      renderPage();
    }

    // ---------- drawing objects in the overlay
    function shapeSvg(o) {
      const b = bbox(o);
      if (o.type === "line" || o.type === "arrow" || o.type === "pen") {
        const sw = Math.max(o.strokeWidth || 1, 0.5);
        const pad = sw * 2 + 6;
        const vb = [b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2];
        const hit = Math.max(sw, 12 / scale);
        let body = "", hitD = "";
        if (o.type === "pen") {
          hitD = o.paths.map((p) => {
            const pts = [];
            for (let i = 0; i + 1 < p.length; i += 2) pts.push(`${r2(p[i])} ${r2(p[i + 1])}`);
            if (pts.length === 1) pts.push(pts[0]);
            return `M${pts.join("L")}`;
          }).join("");
          body = `<path d="${hitD}" stroke="${o.stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${o.opacity}"/>`;
        } else {
          let { x1, y1, x2, y2 } = o;
          let head = "";
          let ex = x2, ey = y2;
          if (o.type === "arrow") {
            const len = Math.hypot(x2 - x1, y2 - y1) || 1;
            const hl = Math.min(Math.max(sw * 4, 8), len * 0.6);
            const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
            const bx = x2 - ux * hl, by = y2 - uy * hl, half = hl * 0.5;
            ex = x2 - ux * hl * 0.6; ey = y2 - uy * hl * 0.6;
            head = `<path d="M${x2} ${y2}L${bx - uy * half} ${by + ux * half}L${bx + uy * half} ${by - ux * half}Z" fill="${o.stroke}"/>`;
          }
          hitD = `M${x1} ${y1}L${x2} ${y2}`;
          body = `<g opacity="${o.opacity}"><path d="M${x1} ${y1}L${ex} ${ey}" stroke="${o.stroke}" stroke-width="${sw}" stroke-linecap="round"/>${head}</g>`;
        }
        return {
          box: { x: vb[0], y: vb[1], w: vb[2], h: vb[3] },
          svg: `<svg viewBox="${vb.join(" ")}" width="100%" height="100%" overflow="visible">${body}<path class="ed-hit" d="${hitD}" stroke="transparent" stroke-width="${hit}" fill="none" stroke-linecap="round"/></svg>`,
        };
      }
      const sw = o.stroke && o.strokeWidth > 0 ? o.strokeWidth : 0;
      const fill = o.fill || "none";
      const stroke = sw ? `stroke="${o.stroke}" stroke-width="${sw}"` : "";
      const shape = o.type === "ellipse"
        ? `<ellipse cx="${b.w / 2}" cy="${b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" fill="${fill}" ${stroke}/>`
        : `<rect x="0" y="0" width="${b.w}" height="${b.h}" fill="${fill}" ${stroke}/>`;
      return { box: b, svg: `<svg viewBox="0 0 ${b.w} ${b.h}" width="100%" height="100%" overflow="visible" preserveAspectRatio="none"><g opacity="${o.opacity}">${shape}</g></svg>` };
    }

    function textFont(o, s = scale) {
      return `${o.italic ? "italic " : ""}${o.bold ? "700 " : "400 "}${o.size * s}px/${LINE_HEIGHT} ${FONT_CSS[o.font] || FONT_CSS.sans}`;
    }

    function place(el, b) {
      el.style.left = `${b.x * scale}px`;
      el.style.top = `${b.y * scale}px`;
      el.style.width = `${Math.max(b.w, 0) * scale}px`;
      el.style.height = `${Math.max(b.h, 0) * scale}px`;
    }

    function makeEl(o) {
      const el = document.createElement("div");
      el.className = `ed-obj ed-${o.type}`;
      el.dataset.id = o.id;
      if (o.type === "text") {
        const inner = document.createElement("div");
        inner.className = "ed-text-inner";
        inner.spellcheck = false;
        inner.addEventListener("input", () => onTextInput(o.id, inner));
        inner.addEventListener("blur", (e) => onTextBlur(o.id, e));
        inner.addEventListener("paste", (e) => {
          // Keep pasted text plain.
          e.preventDefault();
          const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
          document.execCommand("insertText", false, t);
        });
        el.appendChild(inner);
      } else if (o.type === "image") {
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        el.appendChild(img);
      }
      return el;
    }

    function updateEl(el, o) {
      el.classList.toggle("is-selected", o.id === selectedId);
      if (o.type === "text") {
        const inner = el.firstChild;
        if (o.id !== editingId && inner.textContent !== o.text) inner.textContent = o.text;
        inner.style.font = textFont(o);
        inner.style.color = o.color;
        inner.style.textAlign = o.align;
        inner.style.opacity = o.opacity;
        el.style.left = `${o.x * scale}px`;
        el.style.top = `${o.y * scale}px`;
        el.style.width = "";
        el.style.height = "";
        el.classList.toggle("is-editing", o.id === editingId);
        el.classList.toggle("is-raster", !winAnsi(o.text || ""));
        return;
      }
      if (o.type === "image") {
        const img = el.firstChild;
        if (img.getAttribute("src") !== o.url) img.src = o.url;
        img.style.opacity = o.opacity;
        place(el, o);
        return;
      }
      if (o.type === "highlight") {
        el.style.background = o.color;
        el.style.opacity = o.opacity;
        place(el, o);
        return;
      }
      if (o.type === "whiteout") {
        el.style.background = o.color;
        place(el, o);
        return;
      }
      const { box, svg } = shapeSvg(o);
      el.innerHTML = svg;
      place(el, box);
    }

    function measureText(o, el) {
      o.w = el.offsetWidth / scale;
      o.h = el.offsetHeight / scale;
    }

    function renderObjects() {
      const list = pageObjs();
      const seen = new Set();
      list.forEach((o, i) => {
        let el = els.get(o.id);
        if (!el) { el = makeEl(o); els.set(o.id, el); }
        if (layer.children[i] !== el) layer.insertBefore(el, layer.children[i] || null);
        updateEl(el, o);
        if (o.type === "text") measureText(o, el);
        seen.add(o.id);
      });
      for (const [id, el] of els) {
        if (!seen.has(id)) { el.remove(); els.delete(id); }
      }
      // Boxes hiding text that is being replaced.
      coversEl.innerHTML = list.filter((o) => o.type === "text" && o.cover).map((o) => {
        const c = o.cover;
        return `<div class="ed-cover" style="left:${c.x * scale}px;top:${c.y * scale}px;width:${c.w * scale}px;height:${c.h * scale}px;background:${c.color}"></div>`;
      }).join("");
      renderRuns();
      renderSelection();
    }

    function renderSelection() {
      const o = selected();
      if (!o || o.page !== pageIndex) { selEl.hidden = true; return; }
      const b = bbox(o);
      const line = o.type === "line" || o.type === "arrow";
      selEl.hidden = false;
      selEl.className = `ed-sel${line ? " is-line" : ""}${o.id === editingId ? " is-editing" : ""}`;
      const pad = o.type === "pen" ? (o.strokeWidth || 1) / 2 + 2 : 0;
      place(selEl, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 });
      if (o.id === editingId) { selEl.innerHTML = ""; return; }
      let handles;
      if (line) {
        handles = [["p1", o.x1 - b.x, o.y1 - b.y], ["p2", o.x2 - b.x, o.y2 - b.y]];
        handles = handles.map(([h, x, y]) => `<span class="ed-h ed-h-pt" data-h="${h}" style="left:${x * scale}px;top:${y * scale}px"></span>`);
      } else {
        const names = o.type === "text" ? ["nw", "ne", "sw", "se"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
        handles = names.map((h) => `<span class="ed-h ed-h-${h}" data-h="${h}"></span>`);
      }
      selEl.innerHTML = handles.join("");
    }

    function refresh() {
      if (!doc) return;
      renderObjects();
      renderProps();
      updateHistory();
    }

    // ---------- existing text (pdf.js text content)
    async function loadRuns() {
      if (!doc || !pdfPage) return;
      const p = pageIndex;
      if (!runsCache.has(p)) {
        try {
          runsCache.set(p, await textRuns(pdfPage, p));
        } catch (e) {
          runsCache.set(p, []);
        }
        if (runsCache.size > 12) runsCache.delete(runsCache.keys().next().value);
      }
      if (p !== pageIndex) return;
      renderRuns();
      if (tool === "edittext") {
        setHint(runsCache.get(p).length ? HINTS.edittext
          : "No editable text on this page. It may be a scanned image: use White-out and Add text instead, or run OCR first.");
      }
    }

    function fontInfo(page, fontName, style) {
      let obj = null;
      try { if (page.commonObjs.has(fontName)) obj = page.commonObjs.get(fontName); } catch (e) { /* not loaded */ }
      const name = `${(obj && obj.name) || ""} ${(style && style.fontFamily) || ""}`.toLowerCase();
      const plain = name.replace(/^[a-z]{6}\+/, "");
      let family = "sans";
      if ((obj && obj.isMonospace) || /courier|mono|consol|menlo|typewriter/.test(plain)) family = "mono";
      else if ((obj && obj.isSerifFont) || (/times|georgia|garamond|cambria|palatino|book ?antiqua|minion|serif|roman|baskerville|caslon|didot|bodoni|century|charter/.test(plain) && !/sans/.test(plain))) family = "serif";
      const bold = !!(obj && (obj.bold || obj.black)) || /bold|black|heavy|semibold|demi/.test(plain);
      const italic = !!(obj && obj.italic) || /italic|oblique/.test(plain);
      return { family, bold, italic };
    }

    async function textRuns(page, p) {
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const tx = mul(vp.transform, it.transform);
        const size = Math.hypot(tx[2], tx[3]);
        if (size < 1 || Math.abs(tx[1]) > 0.02 * size || tx[0] <= 0) continue; // only upright, horizontal text
        const style = content.styles[it.fontName] || {};
        items.push({
          str: it.str, x: tx[4], base: tx[5], w: it.width, size, fontName: it.fontName,
          asc: clamp(style.ascent || 0.8, 0.6, 1.1), desc: clamp(-(style.descent || -0.22), 0.12, 0.4), style,
        });
      }
      // Join pieces of the same line and font into one editable run.
      const runs = [];
      for (const it of items) {
        const last = runs[runs.length - 1];
        const gap = last ? it.x - (last.x + last.w) : 0;
        if (last && last.fontName === it.fontName && Math.abs(last.base - it.base) < it.size * 0.15
            && Math.abs(last.size - it.size) < 0.6 && gap > -it.size * 0.3 && gap < it.size * 0.9) {
          const space = gap > it.size * 0.12 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? " " : "";
          last.text += space + it.str;
          last.w = it.x + it.w - last.x;
        } else {
          runs.push({ ...it, text: it.str });
        }
      }
      return runs.map((r, i) => {
        const text = r.text.replace(/\s+$/, "");
        return { id: `${p}:${i}`, text, x: r.x, base: r.base, w: r.w, size: r.size, asc: r.asc, desc: r.desc,
          ...fontInfo(page, r.fontName, r.style) };
      });
    }

    function renderRuns() {
      const runs = runsCache.get(pageIndex);
      if (tool !== "edittext" || !runs) { runsEl.innerHTML = ""; runsEl.hidden = true; return; }
      const used = new Set(pageObjs().filter((o) => o.runId).map((o) => o.runId));
      runsEl.hidden = false;
      runsEl.innerHTML = runs.filter((r) => !used.has(r.id)).map((r) => {
        const top = r.base - r.asc * r.size;
        return `<div class="ed-run" data-run="${r.id}" title="Click to edit" style="left:${(r.x - 1) * scale}px;top:${(top - 1) * scale}px;width:${(r.w + 2) * scale}px;height:${((r.asc + r.desc) * r.size + 2) * scale}px"></div>`;
      }).join("");
    }

    /** Background and ink colour of a text run, sampled from the rendered page. */
    function sampleColors(box) {
      const k = canvas.width / W;
      const x = Math.max(Math.floor(box.x * k) - 2, 0), y = Math.max(Math.floor(box.y * k) - 2, 0);
      const w = Math.min(Math.ceil(box.w * k) + 4, canvas.width - x), h = Math.min(Math.ceil(box.h * k) + 4, canvas.height - y);
      const out = { bg: "#ffffff", ink: "#000000" };
      if (w < 3 || h < 3) return out;
      let data;
      try { data = canvas.getContext("2d").getImageData(x, y, w, h).data; } catch (e) { return out; }
      // Background: the most common colour around the edge of the box (averaged within its bucket).
      const buckets = new Map();
      const px = (i, j) => (j * w + i) * 4;
      const note = (o) => {
        const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
        const b = buckets.get(key) || [0, 0, 0, 0];
        b[0] += data[o]; b[1] += data[o + 1]; b[2] += data[o + 2]; b[3]++;
        buckets.set(key, b);
      };
      for (let i = 0; i < w; i++) { note(px(i, 0)); note(px(i, h - 1)); }
      for (let j = 1; j < h - 1; j++) { note(px(0, j)); note(px(w - 1, j)); }
      let top = [255, 255, 255, 0];
      for (const b of buckets.values()) if (b[3] > top[3]) top = b;
      const bg = top[3] ? [top[0] / top[3], top[1] / top[3], top[2] / top[3]] : [255, 255, 255];
      if (bg.every((v) => v >= 244)) bg.fill(255);
      let maxD = 0;
      const dist = (o) => Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]);
      for (let o = 0; o < data.length; o += 4) maxD = Math.max(maxD, dist(o));
      const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
      out.bg = hex(bg);
      if (maxD < 60) return out;
      const sum = [0, 0, 0];
      let n = 0;
      for (let o = 0; o < data.length; o += 4) {
        if (dist(o) >= maxD * 0.8) { sum[0] += data[o]; sum[1] += data[o + 1]; sum[2] += data[o + 2]; n++; }
      }
      const inkC = sum.map((v) => v / n);
      // Near-black anti-aliased ink reads as black.
      out.ink = inkC.every((v) => v < 60) ? "#000000" : hex(inkC);
      return out;
    }

    function convertRun(runId) {
      const run = (runsCache.get(pageIndex) || []).find((r) => r.id === runId);
      if (!run) return;
      const cover = { x: run.x - 1, y: run.base - run.asc * run.size - 1, w: run.w + 2, h: (run.asc + run.desc) * run.size + 2 };
      const { bg, ink } = sampleColors(cover);
      const snap = snapshot();
      checkpoint(null, snap);
      const o = {
        id: nextId++, type: "text", page: pageIndex, x: run.x, y: run.base - baselineOffset(run.family) * run.size,
        size: Math.round(run.size * 10) / 10, text: run.text, font: run.family, bold: run.bold, italic: run.italic,
        color: ink, align: "left", opacity: 1, cover: { ...cover, color: bg }, runId, origText: run.text, fresh: snap,
      };
      pageObjs().push(o);
      selectedId = o.id;
      refresh();
      enterEdit(o);
    }

    // ---------- text editing
    function enterEdit(o) {
      if (o.type !== "text") return;
      editingId = o.id;
      selectedId = o.id;
      refresh();
      const el = els.get(o.id);
      if (!el) return;
      const inner = el.firstChild;
      inner.contentEditable = "plaintext-only";
      if (inner.contentEditable !== "plaintext-only") inner.contentEditable = "true";
      inner.setAttribute("role", "textbox");
      inner.setAttribute("aria-multiline", "true");
      inner.setAttribute("aria-label", "Text");
      inner.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(inner);
      range.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      o.editSnap = snapshot();
      o.typed = false;
    }

    function onTextInput(id, inner) {
      const o = find(id);
      if (!o) return;
      if (!o.typed && !o.fresh) checkpoint(null, o.editSnap);
      o.typed = true;
      o.text = inner.innerText.replace(/\r/g, "").replace(/\n$/, "");
      measureText(o, els.get(id));
      renderSelection();
      updateRasterNote(o);
    }

    function onTextBlur(id, e) {
      if (editingId !== id) return;
      // Changing a property keeps the box in edit mode; anything else finishes the edit.
      if (e.relatedTarget && propsEl.contains(e.relatedTarget)) return;
      commitEdit();
    }

    function commitEdit() {
      const o = editingId && find(editingId);
      editingId = null;
      if (!o) return;
      const el = els.get(o.id);
      if (el) {
        const inner = el.firstChild;
        inner.contentEditable = "false";
        inner.removeAttribute("role");
        if (document.activeElement === inner) inner.blur();
      }
      o.text = (o.text || "").replace(/\s+$/, "");
      const unchanged = !o.text.trim() ? !o.cover : o.cover && o.text === o.origText && !o.changed;
      if (o.fresh && unchanged) {
        // Nothing was really changed: drop the box and its undo step.
        removeObj(o);
        if (undoStack[undoStack.length - 1] === o.fresh) undoStack.pop();
        if (selectedId === o.id) selectedId = null;
      }
      delete o.fresh;
      delete o.editSnap;
      refresh();
    }

    function removeObj(o) {
      const list = objects.get(o.page) || [];
      const i = list.indexOf(o);
      if (i >= 0) list.splice(i, 1);
      // Image object URLs are kept until destroy(): undo may bring the image back.
    }

    // ---------- creating objects
    function newObj(type, extra) {
      return { id: nextId++, type, page: pageIndex, ...defaults[type], ...extra };
    }

    async function addImageFile(file, at) {
      if (!doc) return;
      let bytes = new Uint8Array(await file.arrayBuffer());
      let bmp;
      try {
        bmp = await createImageBitmap(new Blob([bytes], { type: file.type }));
      } catch (e) {
        toast("This image format isn't supported. Try a PNG or JPG.");
        return;
      }
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      let mime = isPng ? "image/png" : "image/jpeg";
      if (!isPng && !isJpg) {
        // WebP, GIF, BMP, SVG and friends become PNG.
        const c = document.createElement("canvas");
        const k = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
        c.width = Math.max(1, Math.round(bmp.width * k));
        c.height = Math.max(1, Math.round(bmp.height * k));
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        const blob = await new Promise((res) => c.toBlob(res, "image/png"));
        if (!blob) { toast("Couldn't convert this image. Try a PNG or JPG."); return; }
        bytes = new Uint8Array(await blob.arrayBuffer());
        mime = "image/png";
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      urls.add(url);
      const aspect = bmp.width / bmp.height;
      let w = Math.min(W * 0.45, bmp.width * 0.75);
      let h = w / aspect;
      if (h > H * 0.6) { h = H * 0.6; w = h * aspect; }
      const c = at || visibleCenter();
      checkpoint();
      const o = newObj("image", { x: clamp(c.x - w / 2, 0, W - w), y: clamp(c.y - h / 2, 0, H - h), w, h, bytes, mime, url, aspect });
      pageObjs().push(o);
      selectedId = o.id;
      setTool("select", { keepSelection: true });
      stage.focus({ preventScroll: true });
    }

    function addText(at, text = "") {
      const snap = snapshot();
      checkpoint(null, snap);
      const d = defaults.text;
      const o = newObj("text", { x: at.x, y: at.y - (d.size * LINE_HEIGHT) / 2, text, fresh: snap });
      o.x = clamp(o.x, 0, Math.max(W - 20, 0));
      o.y = clamp(o.y, 0, Math.max(H - d.size, 0));
      pageObjs().push(o);
      selectedId = o.id;
      refresh();
      enterEdit(o);
      return o;
    }

    // ---------- pointer interaction
    function onDown(e) {
      if (!doc || (e.pointerType === "mouse" && e.button !== 0)) return;
      const editEl = editingId && els.get(editingId);
      if (editEl && editEl.contains(e.target)) return; // caret placement inside the text box
      if (editingId) commitEdit();
      const p = toPt(e);
      const handle = e.target.closest(".ed-h");
      const objEl = e.target.closest(".ed-obj");
      const runEl = e.target.closest(".ed-run");
      const obj = objEl && find(Number(objEl.dataset.id));
      const sel = selected();
      const interactive = tool === "select" || tool === "edittext" || (tool === "text" && obj && obj.type === "text");
      if (handle && sel) {
        drag = { mode: "resize", handle: handle.dataset.h, id: sel.id, start: p, orig: clone(sel), origBox: bbox(sel), before: snapshot() };
      } else if (obj && interactive) {
        const wasSel = selectedId === obj.id;
        selectedId = obj.id;
        refresh();
        drag = { mode: "move", id: obj.id, start: p, orig: clone(obj), before: snapshot(), wasSel };
      } else if (runEl && tool === "edittext") {
        e.preventDefault();
        convertRun(runEl.dataset.run);
        return;
      } else if (tool === "select" || tool === "edittext") {
        if (selectedId) { selectedId = null; refresh(); }
        return;
      } else if (tool === "text") {
        drag = { mode: "text", start: p };
      } else if (BOX_TYPES.has(tool)) {
        drag = { mode: "box", start: p };
      } else if (tool === "line" || tool === "arrow") {
        drag = { mode: "line", start: p };
      } else if (tool === "pen") {
        drag = { mode: "pen", start: p, pts: [r2(p.x), r2(p.y)] };
        ink.hidden = false;
        ink.innerHTML = "";
      }
      if (!drag) return;
      drag.moved = false;
      e.preventDefault();
      try { pageEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    }

    function onMove(e) {
      if (!drag) return;
      const p = toPt(e);
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
      const first = !drag.moved;
      drag.moved = true;
      const o = drag.id ? find(drag.id) : null;

      if (drag.mode === "move" && o) {
        if (first) checkpoint(null, drag.before);
        let mx = dx, my = dy;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; }
        translate(o, drag.orig, mx, my);
        o.changed = true;
        renderObjects();
        return;
      }
      if (drag.mode === "resize" && o) {
        if (first) checkpoint(null, drag.before);
        resize(o, drag, p, e.shiftKey);
        o.changed = true;
        renderObjects();
        return;
      }
      if (drag.mode === "box") {
        if (first) {
          checkpoint();
          const n = newObj(tool, { x: drag.start.x, y: drag.start.y, w: 1, h: 1 });
          pageObjs().push(n);
          drag.id = n.id;
          selectedId = n.id;
        }
        const n = find(drag.id);
        let w = dx, h = dy;
        if (e.shiftKey && n.type !== "highlight") { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        n.x = Math.min(drag.start.x, drag.start.x + w); n.y = Math.min(drag.start.y, drag.start.y + h);
        n.w = Math.abs(w); n.h = Math.abs(h);
        renderObjects();
        return;
      }
      if (drag.mode === "line") {
        if (first) {
          checkpoint();
          const n = newObj(tool, { x1: drag.start.x, y1: drag.start.y, x2: p.x, y2: p.y });
          pageObjs().push(n);
          drag.id = n.id;
          selectedId = n.id;
        }
        const n = find(drag.id);
        const end = e.shiftKey ? snap45(drag.start, p) : p;
        n.x2 = end.x; n.y2 = end.y;
        renderObjects();
        return;
      }
      if (drag.mode === "pen") {
        const pts = drag.pts;
        const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
        if (Math.hypot(p.x - lx, p.y - ly) * scale >= 1.5) {
          pts.push(r2(p.x), r2(p.y));
          const d = defaults.pen;
          let path = "";
          for (let i = 0; i < pts.length; i += 2) path += `${i ? "L" : "M"}${pts[i]} ${pts[i + 1]}`;
          ink.innerHTML = `<path d="${path}" stroke="${d.stroke}" stroke-width="${d.strokeWidth}" opacity="${d.opacity}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
      }
    }

    function onUp(e) {
      if (!drag) return;
      const d = drag;
      drag = null;
      try { pageEl.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      if (e.type === "pointercancel" && d.mode !== "pen") { refresh(); return; }
      const o = d.id ? find(d.id) : null;
      if (d.mode === "move") {
        if (!d.moved && d.wasSel && o && o.type === "text") enterEdit(o);
        else refresh();
        return;
      }
      if (d.mode === "resize") { refresh(); return; }
      if (d.mode === "text") {
        if (!d.moved) { setTool("select"); addText(d.start); }
        return;
      }
      if (d.mode === "box") {
        if (!o) {
          const size = { rect: [120, 80], ellipse: [120, 80], highlight: [140, 16], whiteout: [120, 24] }[tool] || [100, 60];
          checkpoint();
          const n = newObj(tool, { x: d.start.x - size[0] / 2, y: d.start.y - size[1] / 2, w: size[0], h: size[1] });
          pageObjs().push(n);
          selectedId = n.id;
        } else if (o.w < 2 || o.h < 2) {
          o.w = Math.max(o.w, 4); o.h = Math.max(o.h, 4);
        }
      } else if (d.mode === "line") {
        if (!o) {
          checkpoint();
          const n = newObj(tool, { x1: d.start.x - 50, y1: d.start.y, x2: d.start.x + 50, y2: d.start.y });
          pageObjs().push(n);
          selectedId = n.id;
        }
      } else if (d.mode === "pen") {
        ink.hidden = true;
        ink.innerHTML = "";
        if (d.pts.length >= 2) {
          checkpoint();
          pageObjs().push(newObj("pen", { paths: [d.pts] }));
        }
        selectedId = null;
      }
      if (!STICKY_TOOLS.has(tool)) setTool("select", { keepSelection: true });
      else refresh();
    }

    function snap45(a, p) {
      const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(p.x - a.x, p.y - a.y);
      return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }

    function translate(o, orig, dx, dy) {
      const b = bbox(orig);
      // Keep at least part of the object on the page.
      dx = clamp(dx, -b.x - b.w + 8, W - 8 - b.x);
      dy = clamp(dy, -b.y - b.h + 8, H - 8 - b.y);
      if (o.type === "line" || o.type === "arrow") {
        o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy;
      } else if (o.type === "pen") {
        o.paths = orig.paths.map((p) => p.map((v, i) => r2(v + (i % 2 ? dy : dx))));
      } else {
        o.x = orig.x + dx; o.y = orig.y + dy;
      }
    }

    function resize(o, d, p, shift) {
      const h = d.handle;
      const orig = d.orig;
      if (h === "p1" || h === "p2") {
        const anchor = h === "p1" ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 };
        const pt = shift ? snap45(anchor, p) : p;
        if (h === "p1") { o.x1 = pt.x; o.y1 = pt.y; } else { o.x2 = pt.x; o.y2 = pt.y; }
        return;
      }
      const b = d.origBox;
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
      const MIN = 4;
      if (h.includes("w")) x0 = Math.min(b.x + dx, x1 - MIN);
      if (h.includes("e")) x1 = Math.max(b.x + b.w + dx, x0 + MIN);
      if (h.includes("n")) y0 = Math.min(b.y + dy, y1 - MIN);
      if (h.includes("s")) y1 = Math.max(b.y + b.h + dy, y0 + MIN);
      // Images (and text) keep their shape unless Shift is held; other shapes keep it with Shift.
      const lock = o.type === "text" || (o.type === "image" ? !shift : shift);
      if (lock && b.w > 0 && b.h > 0) {
        const ratio = b.w / b.h;
        let w = x1 - x0, hh = y1 - y0;
        if (h.length === 2) {
          if (w / ratio > hh) hh = w / ratio; else w = hh * ratio;
          if (h.includes("w")) x0 = x1 - w; else x1 = x0 + w;
          if (h.includes("n")) y0 = y1 - hh; else y1 = y0 + hh;
        } else if (h === "e" || h === "w") {
          hh = w / ratio; const cy = b.y + b.h / 2; y0 = cy - hh / 2; y1 = cy + hh / 2;
        } else {
          w = hh * ratio; const cx = b.x + b.w / 2; x0 = cx - w / 2; x1 = cx + w / 2;
        }
      }
      const nb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (o.type === "text") {
        const k = nb.w / (b.w || 1);
        o.size = clamp(Math.round(orig.size * k * 10) / 10, 4, 400);
        const real = o.size / orig.size;
        o.x = h.includes("w") ? b.x + b.w - b.w * real : b.x;
        o.y = h.includes("n") ? b.y + b.h - b.h * real : b.y;
      } else if (o.type === "pen") {
        const kx = b.w ? nb.w / b.w : 1, ky = b.h ? nb.h / b.h : 1;
        o.paths = orig.paths.map((pp) => pp.map((v, i) => r2(i % 2 ? nb.y + (v - b.y) * ky : nb.x + (v - b.x) * kx)));
      } else {
        Object.assign(o, nb);
      }
    }

    pageEl.addEventListener("pointerdown", onDown);
    pageEl.addEventListener("pointermove", onMove);
    pageEl.addEventListener("pointerup", onUp);
    pageEl.addEventListener("pointercancel", onUp);
    pageEl.addEventListener("dblclick", (e) => {
      const objEl = e.target.closest(".ed-obj");
      const o = objEl && find(Number(objEl.dataset.id));
      if (o && o.type === "text" && editingId !== o.id) enterEdit(o);
    });
    pageEl.addEventListener("dragover", (e) => {
      if (doc && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); e.stopPropagation(); }
    });
    pageEl.addEventListener("drop", (e) => {
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      addImageFile(files[0], toPt(e));
    });

    // ---------- toolbar, properties
    function setHint(text) { hintEl.textContent = text; }

    function setTool(id, { keepSelection = false } = {}) {
      if (id === "image") { fileInput.click(); return; }
      if (editingId) commitEdit();
      tool = id;
      if (!keepSelection) selectedId = null;
      root.querySelectorAll(".ed-tool").forEach((b) => {
        const on = b.dataset.tool === id;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      pageEl.dataset.tool = id;
      setHint(HINTS[id] || "");
      if (id === "edittext") loadRuns();
      refresh();
    }

    function field(label, inner, cls = "") {
      return `<label class="ed-field ${cls}"><span>${label}</span>${inner}</label>`;
    }
    const colorIn = (prop, value, label) => field(label, `<input type="color" data-prop="${prop}" value="${value || "#000000"}" aria-label="${label}">`, "ed-color");
    const rangeIn = (prop, value, min, max, step, label, fmt) => field(label,
      `<input type="range" data-prop="${prop}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"><output>${fmt(value)}</output>`, "ed-range");
    const pct = (v) => `${Math.round(v * 100)}%`;
    const ptf = (v) => `${Number(v).toFixed(v < 10 ? 1 : 0)}`;

    function renderProps() {
      const o = selected();
      const type = o ? o.type : (defaults[tool] ? tool : null);
      if (!type) {
        propsEl.innerHTML = `<span class="ed-props-empty">${tool === "edittext" ? "Pick a line of text on the page." : "Select an object to change its style, or pick a tool above."}</span>`;
        return;
      }
      const v = o || defaults[type];
      const parts = [];
      if (type === "text") {
        parts.push(field("Font", `<select data-prop="font" aria-label="Font">${Object.keys(FONT_CSS).map((f) => `<option value="${f}"${v.font === f ? " selected" : ""}>${FONT_LABEL[f]}</option>`).join("")}</select>`));
        parts.push(field("Size", `<input type="number" data-prop="size" min="4" max="400" step="0.5" value="${v.size}" aria-label="Font size">`, "ed-num"));
        parts.push(colorIn("color", v.color, "Colour"));
        parts.push(`<div class="ed-seg" role="group" aria-label="Style">
          <button type="button" data-toggle="bold" aria-pressed="${!!v.bold}" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
          <button type="button" data-toggle="italic" aria-pressed="${!!v.italic}" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button></div>`);
        parts.push(`<div class="ed-seg" role="group" aria-label="Alignment">${["left", "center", "right"].map((a) => `<button type="button" data-align="${a}" aria-pressed="${v.align === a}" title="Align ${a}" aria-label="Align ${a}">${alignIcon(a)}</button>`).join("")}</div>`);
        parts.push(rangeIn("opacity", v.opacity, 0.1, 1, 0.05, "Opacity", pct));
        if (o && o.cover) parts.push(colorIn("coverColor", o.cover.color, "Background"));
      } else if (type === "rect" || type === "ellipse") {
        parts.push(colorIn("stroke", v.stroke || "#000000", "Border"));
        parts.push(rangeIn("strokeWidth", v.strokeWidth, 0, 20, 0.5, "Width", ptf));
        parts.push(`<label class="ed-field ed-check"><input type="checkbox" data-prop="fillOn"${v.fill ? " checked" : ""}><span>Fill</span></label>`);
        parts.push(colorIn("fill", v.fill || "#fde68a", "Fill colour").replace("<input", `<input${v.fill ? "" : " disabled"}`));
        parts.push(rangeIn("opacity", v.opacity, 0.1, 1, 0.05, "Opacity", pct));
      } else if (type === "line" || type === "arrow" || type === "pen") {
        parts.push(colorIn("stroke", v.stroke, "Colour"));
        parts.push(rangeIn("strokeWidth", v.strokeWidth, 0.5, 20, 0.5, "Width", ptf));
        parts.push(rangeIn("opacity", v.opacity, 0.1, 1, 0.05, "Opacity", pct));
      } else if (type === "highlight") {
        parts.push(colorIn("color", v.color, "Colour"));
        parts.push(rangeIn("opacity", v.opacity, 0.1, 1, 0.05, "Strength", pct));
      } else if (type === "whiteout") {
        parts.push(colorIn("color", v.color, "Colour"));
      } else if (type === "image") {
        parts.push(rangeIn("opacity", v.opacity, 0.1, 1, 0.05, "Opacity", pct));
        parts.push(`<span class="ed-props-note">Corners keep the shape. Hold Shift to stretch.</span>`);
      }
      if (o) {
        parts.push(`<div class="ed-obj-actions">
          ${o.type === "text" && o.id !== editingId ? `<button type="button" class="ed-icon-btn" data-act="edit" title="Edit text" aria-label="Edit text">${ICONS.edit}</button>` : ""}
          <button type="button" class="ed-icon-btn" data-act="dup" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${ICONS.copy}</button>
          <button type="button" class="ed-icon-btn" data-act="front" title="Bring to front" aria-label="Bring to front">${ICONS.front}</button>
          <button type="button" class="ed-icon-btn" data-act="back" title="Send to back" aria-label="Send to back">${ICONS.back}</button>
          <button type="button" class="ed-icon-btn ed-danger" data-act="delete" title="Delete (Del)" aria-label="Delete">${ICONS.trash}</button>
        </div>`);
      }
      propsEl.innerHTML = parts.join("") + `<p class="ed-raster-note" hidden>This text has characters the standard PDF fonts can't draw, so it will be saved as a sharp image of the text. It will look right but won't be selectable.</p>`;
      if (o && o.type === "text") updateRasterNote(o);
    }

    function updateRasterNote(o) {
      const note = propsEl.querySelector(".ed-raster-note");
      if (note) note.hidden = winAnsi(o.text || "");
    }

    function alignIcon(a) {
      const rows = a === "left" ? ["M4 6h16", "M4 10h10", "M4 14h16", "M4 18h10"]
        : a === "center" ? ["M4 6h16", "M7 10h10", "M4 14h16", "M7 18h10"]
          : ["M4 6h16", "M10 10h10", "M4 14h16", "M10 18h10"];
      return I(`<path d="${rows.join(" ")}"/>`);
    }

    function applyProp(key, value) {
      const o = selected();
      const target = o || defaults[tool];
      if (!target) return;
      const type = o ? o.type : tool;
      if (o) { checkpoint(`prop:${o.id}:${key}`); o.changed = true; delete o.fresh; }
      if (key === "coverColor") { if (o && o.cover) o.cover.color = value; }
      else if (key === "fillOn") target.fill = value ? (target.lastFill || "#fde68a") : null;
      else if (key === "fill") { target.fill = value; target.lastFill = value; }
      else target[key] = value;
      // New objects of this kind start with the latest style.
      if (o && defaults[type] && key in defaults[type]) defaults[type][key] = o[key];
      if (o) renderObjects();
    }

    propsEl.addEventListener("input", (e) => {
      const t = e.target;
      const key = t.dataset.prop;
      if (!key) return;
      let value = t.type === "checkbox" ? t.checked : t.value;
      if (t.type === "range" || t.type === "number") {
        value = Number(value);
        if (!Number.isFinite(value) || (key === "size" && value < 1)) return;
        const out = t.parentElement.querySelector("output");
        if (out) out.textContent = key === "opacity" ? pct(value) : ptf(value);
      }
      applyProp(key, value);
      if (key === "fillOn") renderProps();
    });
    propsEl.addEventListener("change", (e) => {
      if (e.target.dataset.prop === "font") applyProp("font", e.target.value);
    });
    // Buttons in the properties bar don't take focus from a text box being edited.
    propsEl.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
    propsEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.toggle) {
        const o = selected() || defaults.text;
        applyProp(b.dataset.toggle, !o[b.dataset.toggle]);
        renderProps();
      } else if (b.dataset.align) {
        applyProp("align", b.dataset.align);
        renderProps();
      } else if (b.dataset.act) {
        action(b.dataset.act);
      }
    });

    function action(act) {
      const o = selected();
      switch (act) {
        case "undo": undo(); break;
        case "redo": redo(); break;
        case "prev": goTo(pageIndex - 1); break;
        case "next": goTo(pageIndex + 1); break;
        case "zoomin": setZoom(ZOOMS.find((z) => z > zoom + 0.01) || zoom); break;
        case "zoomout": setZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.01) || zoom); break;
        case "fit": setZoom(1); break;
        case "edit": if (o) enterEdit(o); break;
        case "delete": deleteSelected(); break;
        case "dup": duplicate(); break;
        case "front":
        case "back": {
          if (!o) break;
          if (editingId) commitEdit();
          checkpoint();
          const list = pageObjs(o.page);
          list.splice(list.indexOf(o), 1);
          if (act === "front") list.push(o); else list.unshift(o);
          refresh();
          break;
        }
        default: break;
      }
    }

    function deleteSelected() {
      const o = selected();
      if (!o) return;
      if (editingId) { editingId = null; }
      checkpoint();
      removeObj(o);
      selectedId = null;
      refresh();
    }

    function duplicate() {
      const o = selected();
      if (!o) return;
      if (editingId) commitEdit();
      checkpoint();
      const c = clone(o);
      c.id = nextId++;
      delete c.cover; delete c.runId; delete c.origText; delete c.fresh;
      translate(c, clone(o), 12, 12);
      pageObjs(o.page).push(c);
      selectedId = c.id;
      refresh();
    }

    root.querySelector(".ed-tools").addEventListener("click", (e) => {
      const b = e.target.closest(".ed-tool");
      if (b) setTool(b.dataset.tool);
    });
    main.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b && !propsEl.contains(b)) action(b.dataset.act);
    });
    q(".ed-pagenum").addEventListener("change", (e) => goTo(Number(e.target.value) - 1));
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0];
      fileInput.value = "";
      if (f) addImageFile(f).catch((err) => toast(err.message));
    });

    // ---------- keyboard and clipboard
    const TYPING = "textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], "
      + "input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button])";
    const visible = () => doc && root.isConnected && root.offsetParent !== null;
    function onKey(e) {
      if (!visible()) return;
      const t = e.target;
      const mod = e.ctrlKey || e.metaKey;
      if (editingId) {
        const editEl = els.get(editingId);
        if (editEl && editEl.contains(t)) {
          if (e.key === "Escape" || (e.key === "Enter" && mod)) {
            e.preventDefault(); e.stopPropagation(); commitEdit();
          } else if (mod && (e.key === "b" || e.key === "i")) {
            e.preventDefault();
            const o = find(editingId);
            applyProp(e.key === "b" ? "bold" : "italic", !o[e.key === "b" ? "bold" : "italic"]);
            renderProps();
          }
          return;
        }
      }
      if (t && t.closest && t.closest(TYPING)) return;
      // Only handle keys aimed at the editor or the page in general, not other dialogs.
      if (t && t !== document.body && !root.contains(t) && !t.closest(".modal-card")) return;
      const key = e.key.toLowerCase();
      const o = selected();
      if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod && key === "d" && o) { e.preventDefault(); duplicate(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && o) { e.preventDefault(); deleteSelected(); return; }
      if (e.key === "Escape" && (o || tool !== "select")) {
        e.preventDefault(); e.stopPropagation();
        if (o) { selectedId = null; refresh(); } else setTool("select");
        return;
      }
      if (e.key === "Enter" && o && o.type === "text" && !t.closest("button")) { e.preventDefault(); enterEdit(o); return; }
      if (o && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        checkpoint(`nudge:${o.id}`);
        translate(o, clone(o), d[0], d[1]);
        o.changed = true;
        refresh();
        return;
      }
      if (e.key === "PageDown") { e.preventDefault(); goTo(pageIndex + 1); return; }
      if (e.key === "PageUp") { e.preventDefault(); goTo(pageIndex - 1); return; }
      if (!mod && !e.altKey && key.length === 1) {
        const tl = TOOLS.find((x) => x.key === key);
        if (tl) { e.preventDefault(); setTool(tl.id); }
      }
    }
    function onPaste(e) {
      if (!visible() || editingId) return;
      const t = e.target;
      if (t && t.closest && t.closest(TYPING)) return;
      const items = [...((e.clipboardData && e.clipboardData.items) || [])];
      const img = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (img) { e.preventDefault(); addImageFile(img.getAsFile()); return; }
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (text && text.trim()) {
        e.preventDefault();
        const c = visibleCenter();
        const o = addText(c, text.replace(/\r\n?/g, "\n"));
        delete o.fresh;
        commitEdit();
        selectedId = o.id;
        refresh();
      }
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("paste", onPaste);

    let resizeTimer = null;
    let lastWidth = 0;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      const w = stage.clientWidth;
      if (!doc || Math.abs(w - lastWidth) < 4) return;
      lastWidth = w;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderPage, 150);
    }) : null;
    if (ro) ro.observe(stage);

    // ---------- public API
    async function setPdf(bytes) {
      if (doc) { renderToken++; await doc.destroy().catch(() => {}); }
      doc = null; pdfPage = null;
      objects.clear(); els.forEach((el) => el.remove()); els.clear(); runsCache.clear();
      undoStack = []; redoStack = []; selectedId = null; editingId = null; pageIndex = 0; zoom = 1;
      doc = await PdfRender.open(bytes);
      if (destroyed) { doc.destroy(); return; }
      q(".ed-empty").hidden = true;
      main.hidden = false;
      q(".ed-pagecount").textContent = `of ${doc.numPages}`;
      q(".ed-pagenum").max = doc.numPages;
      lastWidth = stage.clientWidth;
      setTool(tool === "image" ? "select" : tool);
      await renderPage();
    }

    async function rasterText(o) {
      const lines = o.text.split("\n");
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = textFont(o, 1);
      const widthPt = Math.max(...lines.map((l) => probe.measureText(l).width), 1);
      const padPt = o.size * 0.25;
      const wPt = widthPt + padPt * 2;
      const hPt = lines.length * LINE_HEIGHT * o.size + o.size * 0.2;
      const k = clamp(Math.min(4096 / wPt, 4096 / hPt), 1, 4); // pixels per point
      const c = document.createElement("canvas");
      c.width = Math.ceil(wPt * k);
      c.height = Math.ceil(hPt * k);
      const ctx = c.getContext("2d");
      ctx.font = textFont(o, k);
      ctx.fillStyle = o.color;
      ctx.textBaseline = "alphabetic";
      const off = baselineOffset(o.font) * o.size;
      lines.forEach((line, i) => {
        const lw = probe.measureText(line).width;
        let x = padPt;
        if (o.align === "center") x += (widthPt - lw) / 2;
        else if (o.align === "right") x += widthPt - lw;
        ctx.fillText(line, x * k, (i * LINE_HEIGHT * o.size + off) * k);
      });
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), w: c.width / k, h: c.height / k, padPt };
    }

    async function toEdit(o) {
      const base = { page: o.page, type: o.type };
      const num = (v) => r2(Number(v));
      switch (o.type) {
        case "text": {
          const text = (o.text || "").replace(/\t/g, "    ").replace(/\s+$/, "");
          if (!text && !o.cover) return null;
          const e = { ...base, x: num(o.x), y: num(o.y), size: o.size, text, font: o.font, bold: !!o.bold, italic: !!o.italic,
            color: o.color, align: o.align, opacity: o.opacity, lineHeight: LINE_HEIGHT };
          if (o.cover) e.cover = { x: num(o.cover.x), y: num(o.cover.y), w: num(o.cover.w), h: num(o.cover.h), color: o.cover.color };
          if (text && !winAnsi(text)) {
            const r = await rasterText(o);
            e.raster = { bytes: r.bytes, w: r.w, h: r.h };
            e.x = num(o.x - r.padPt);
          }
          return e;
        }
        case "image": return { ...base, x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h), bytes: o.bytes, mime: o.mime, opacity: o.opacity };
        case "rect":
        case "ellipse":
          return { ...base, x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h), stroke: o.strokeWidth > 0 ? o.stroke : null,
            fill: o.fill || null, strokeWidth: o.strokeWidth, opacity: o.opacity };
        case "line":
        case "arrow":
          return { ...base, x1: num(o.x1), y1: num(o.y1), x2: num(o.x2), y2: num(o.y2), stroke: o.stroke, strokeWidth: o.strokeWidth, opacity: o.opacity };
        case "highlight": return { ...base, x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h), color: o.color, opacity: o.opacity };
        case "whiteout": return { ...base, x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h), color: o.color };
        case "pen": return { ...base, paths: o.paths.map((p) => p.slice()), stroke: o.stroke, strokeWidth: o.strokeWidth, opacity: o.opacity };
        default: return null;
      }
    }

    /** Plain, structured-clonable edit list for ClientPDF.applyEdits. */
    async function edits() {
      if (editingId) commitEdit();
      if (!doc) throw new ClientPDF.UserError("Add a PDF first.");
      const out = [];
      for (const p of [...objects.keys()].sort((a, b) => a - b)) {
        for (const o of objects.get(p)) {
          const e = await toEdit(o);
          if (e) out.push(e);
        }
      }
      if (!out.length) throw new ClientPDF.UserError("Make at least one change first: pick a tool above and click on the page.");
      return out;
    }

    function destroy() {
      destroyed = true;
      renderToken++;
      if (renderTask) renderTask.cancel();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("paste", onPaste);
      if (ro) ro.disconnect();
      clearTimeout(resizeTimer);
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (doc) doc.destroy();
      doc = null;
    }

    setHint(HINTS.select);
    // A small window into the editor for automated tests.
    const debug = { state: () => ({ pageIndex, renderedIndex, numPages: doc ? doc.numPages : 0, scale, W, H, tool, selectedId, editingId,
      objects: [...objects.values()].flat().map((o) => ({ ...o, bytes: undefined })), undo: undoStack.length, redo: redoStack.length }),
    toScreen: (x, y) => { const r = pageEl.getBoundingClientRect(); return { x: r.left + x * scale, y: r.top + y * scale }; },
    runs: () => runsCache.get(pageIndex) || [] };
    root.__edit = debug;

    return { setPdf, edits, destroy };
  }

  return { create };
})();
