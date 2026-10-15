// Page grid: thumbnails of every page with drag to reorder, rotate, delete and select.
// Used by Merge, Organize, Rotate, Remove Pages and Split. Thumbnails render lazily with pdf.js.

const PageBoard = (() => {
  const THUMB_WIDTH = 120;

  /**
   * mode "organize": drag to reorder, rotate and delete buttons.
   * mode "select":   click toggles a page's selection (Split).
   * mode "remove":   click marks a page for removal (Remove Pages).
   * mode "rotate":   click turns a page 90° clockwise.
   */
  async function mount(container, { buffers, names = [], mode = "organize", onChange = () => {} }) {
    container.innerHTML = '<p class="board-loading">Loading pages...</p>';
    const docs = [];
    for (const bytes of buffers) docs.push(await PdfRender.open(bytes));

    let pages = [];
    docs.forEach((doc, f) => {
      for (let p = 0; p < doc.numPages; p++) {
        pages.push({ key: `${f}:${p}`, file: f, page: p, rotate: 0, selected: false, removed: false });
      }
    });

    const grid = document.createElement("div");
    grid.className = `page-board mode-${mode}`;
    grid.setAttribute("role", "list");
    const thumbs = new Map(); // key -> canvas, rendered once and reused when cards move
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        drawThumb(entry.target.dataset.key);
      }
    }, { root: null, rootMargin: "200px" });

    async function drawThumb(key) {
      const canvas = thumbs.get(key);
      if (!canvas || canvas.dataset.drawn || canvas.dataset.pending) return;
      canvas.dataset.pending = "1";
      const [f, p] = key.split(":").map(Number);
      try {
        const page = await docs[f].getPage(p + 1);
        await PdfRender.renderPage(page, canvas, { maxWidth: THUMB_WIDTH });
        page.cleanup();
        canvas.dataset.drawn = "1";
      } catch (e) {
        // Leave it blank; it is retried when the card scrolls into view again.
      } finally {
        delete canvas.dataset.pending;
      }
    }

    const multiFile = docs.length > 1;
    let dragKey = null;

    function render() {
      grid.innerHTML = "";
      pages.forEach((pg, idx) => {
        const card = document.createElement("div");
        card.className = "page-card";
        card.setAttribute("role", "listitem");
        card.dataset.key = pg.key;
        if (pg.selected) card.classList.add("is-selected");
        if (pg.removed) card.classList.add("is-removed");
        card.draggable = mode === "organize";

        const frame = document.createElement("div");
        frame.className = "page-thumb";
        let canvas = thumbs.get(pg.key);
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.width = THUMB_WIDTH;
          canvas.height = Math.round(THUMB_WIDTH * 1.3);
          thumbs.set(pg.key, canvas);
        }
        canvas.style.transform = pg.rotate ? `rotate(${pg.rotate}deg)` : "";
        frame.appendChild(canvas);
        if (pg.file < 8 && multiFile) frame.dataset.file = String(pg.file % 8);
        card.appendChild(frame);

        const label = document.createElement("div");
        label.className = "page-label";
        label.textContent = multiFile ? `${shortName(names[pg.file], pg.file)} · p${pg.page + 1}` : `Page ${pg.page + 1}`;
        label.title = names[pg.file] || "";
        card.appendChild(label);

        if (mode === "organize") {
          const tools = document.createElement("div");
          tools.className = "page-tools";
          tools.append(
            button("◀", "Move left", () => move(idx, idx - 1), idx === 0),
            button("⟲", "Turn left", () => { pg.rotate = (pg.rotate + 270) % 360; render(); }),
            button("⟳", "Turn right", () => { pg.rotate = (pg.rotate + 90) % 360; render(); }),
            button("✕", "Delete page", () => { pages.splice(idx, 1); render(); }),
            button("▶", "Move right", () => move(idx, idx + 1), idx === pages.length - 1),
          );
          card.appendChild(tools);
          card.addEventListener("dragstart", (e) => {
            dragKey = pg.key;
            card.classList.add("is-dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", pg.key);
          });
          card.addEventListener("dragend", () => { dragKey = null; card.classList.remove("is-dragging"); });
          card.addEventListener("dragover", (e) => { if (dragKey) { e.preventDefault(); card.classList.add("drop-target"); } });
          card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
          card.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove("drop-target");
            const from = pages.findIndex((x) => x.key === dragKey);
            const rect = card.getBoundingClientRect();
            const after = e.clientX > rect.left + rect.width / 2;
            let to = idx + (after ? 1 : 0);
            if (from < to) to -= 1;
            move(from, to);
          });
        } else {
          card.tabIndex = 0;
          card.setAttribute("aria-pressed", String(mode === "select" ? pg.selected : mode === "remove" ? pg.removed : pg.rotate !== 0));
          const toggle = () => {
            if (mode === "select") pg.selected = !pg.selected;
            else if (mode === "remove") pg.removed = !pg.removed;
            else if (mode === "rotate") pg.rotate = (pg.rotate + 90) % 360;
            render();
          };
          card.addEventListener("click", toggle);
          card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
        }

        grid.appendChild(card);
        if (!canvas.dataset.drawn) observer.observe(card);
      });
      onChange(api);
    }

    function move(from, to) {
      if (from < 0 || to < 0 || to >= pages.length || from === to) return;
      const [item] = pages.splice(from, 1);
      pages.splice(to, 0, item);
      render();
    }

    function button(text, title, onClick, disabled = false) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "page-tool-btn";
      b.textContent = text;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.disabled = disabled;
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    const api = {
      count: () => pages.length,
      totalPages: () => docs.reduce((n, d) => n + d.numPages, 0),
      /** Pages to write, in order, as assemble() plans. */
      plan: () => pages.filter((p) => !p.removed).map(({ file, page, rotate }) => ({ file, page, rotate })),
      selectedPages: () => pages.filter((p) => p.selected).map((p) => p.page),
      removedPages: () => pages.filter((p) => p.removed).map((p) => p.page),
      rotateAll(deg) { pages.forEach((p) => { p.rotate = (p.rotate + deg + 360) % 360; }); render(); },
      reverse() { pages.reverse(); render(); },
      resetOrder() { pages.sort((a, b) => a.file - b.file || a.page - b.page); render(); },
      setSelection(indices) { const s = new Set(indices); pages.forEach((p) => { p.selected = s.has(p.page); }); render(); },
      setRemoved(indices) { const s = new Set(indices); pages.forEach((p) => { p.removed = s.has(p.page); }); render(); },
      destroy() { observer.disconnect(); docs.forEach((d) => d.destroy()); container.innerHTML = ""; },
    };

    container.innerHTML = "";
    container.appendChild(grid);
    render();
    return api;
  }

  function shortName(name, idx) {
    if (!name) return `File ${idx + 1}`;
    const base = name.replace(/\.pdf$/i, "");
    return base.length > 14 ? `${base.slice(0, 12)}…` : base;
  }

  /** Turns 0-based page indices into "1-3, 5". */
  function toRanges(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
      i = j;
    }
    return parts.join(", ");
  }

  return { mount, toRanges };
})();
