// Crop PDF: drag a box on the page preview; the four margins go to ClientPDF.crop.

const CropTool = (() => {
  function create(root) {
    root.innerHTML = `
      <div class="crop-wrap" id="cropWrap" hidden>
        <div class="sign-row">
          <button type="button" class="btn btn-xs" id="cropPrev" aria-label="Previous page">◀</button>
          <span id="cropLabel">Page 1</span>
          <button type="button" class="btn btn-xs" id="cropNext" aria-label="Next page">▶</button>
          <button type="button" class="btn btn-xs" id="cropAuto" style="margin-left:auto;">Trim white margins</button>
          <button type="button" class="btn btn-xs" id="cropReset">Reset</button>
        </div>
        <div class="crop-stage" id="cropStage">
          <canvas id="cropCanvas"></canvas>
          <div class="crop-box" id="cropBox">
            ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `<span class="crop-handle h-${h}" data-h="${h}"></span>`).join("")}
          </div>
        </div>
        <p class="drop-hint" id="cropSize"></p>
        <div class="radio-row">
          <label class="checkbox-group"><input type="radio" name="cropPages" value="all" checked> Crop every page the same way</label>
          <label class="checkbox-group"><input type="radio" name="cropPages" value="each"> Different crop for each page</label>
          <label class="checkbox-group"><input type="radio" name="cropPages" value="one"> Only this page</label>
        </div>
        <div class="crop-each" id="cropEach" hidden>
          <p class="drop-hint">Pick a page below, drag its box, then move to the next page. Pages you don't touch stay as they are.</p>
          <div class="crop-pages" id="cropPages" role="group" aria-label="Pages"></div>
          <div class="sign-row crop-copy">
            <span>Use this page's crop on:</span>
            <button type="button" class="btn btn-xs" data-copy="all">All pages</button>
            <button type="button" class="btn btn-xs" data-copy="odd">Odd pages</button>
            <button type="button" class="btn btn-xs" data-copy="even">Even pages</button>
          </div>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let doc = null;
    let pageIndex = 0;
    let pagePts = { w: 0, h: 0 };
    // Box as fractions of the displayed page.
    const FULL = { l: 0, t: 0, r: 1, b: 1 };
    let box = { ...FULL };
    // "each" mode: one box per page (null = page left as it is).
    let boxes = [];
    const mode = () => root.querySelector('input[name="cropPages"]:checked').value;
    const isFull = (b) => !b || (b.l < 0.001 && b.t < 0.001 && b.r > 0.999 && b.b > 0.999);
    // The box being edited is kept in `box`; in "each" mode it is saved into boxes[page] on every change.
    function save() { if (mode() === "each") boxes[pageIndex] = isFull(box) ? null : { ...box }; }

    async function setPdf(bytes) {
      if (doc) doc.destroy();
      doc = await PdfRender.open(bytes);
      pageIndex = 0;
      box = { ...FULL };
      boxes = new Array(doc.numPages).fill(null);
      $("cropWrap").hidden = false;
      renderPages();
      await show();
    }

    async function show() {
      if (mode() === "each") box = boxes[pageIndex] ? { ...boxes[pageIndex] } : { ...FULL };
      const page = await doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      pagePts = { w: vp.width, h: vp.height };
      const maxW = Math.min(root.clientWidth || 600, 560);
      await PdfRender.renderPage(page, $("cropCanvas"), { maxWidth: maxW });
      $("cropLabel").textContent = `Page ${pageIndex + 1} of ${doc.numPages}`;
      draw();
    }

    function draw() {
      const el = $("cropBox");
      el.style.left = `${box.l * 100}%`;
      el.style.top = `${box.t * 100}%`;
      el.style.width = `${(box.r - box.l) * 100}%`;
      el.style.height = `${(box.b - box.t) * 100}%`;
      const mm = (pt) => Math.round(pt * 25.4 / 72);
      $("cropSize").textContent = `New size: ${mm((box.r - box.l) * pagePts.w)} × ${mm((box.b - box.t) * pagePts.h)} mm`;
      save();
      renderPages();
    }

    // Page buttons for "each" mode: the current page is outlined, cropped pages are filled.
    function renderPages() {
      const wrap = $("cropPages");
      if (!doc || mode() !== "each") return;
      if (wrap.children.length !== doc.numPages) {
        wrap.innerHTML = Array.from({ length: doc.numPages }, (_, i) =>
          `<button type="button" class="crop-page" data-page="${i}">${i + 1}</button>`).join("");
      }
      [...wrap.children].forEach((b, i) => {
        b.classList.toggle("cropped", !!boxes[i]);
        b.classList.toggle("current", i === pageIndex);
        b.setAttribute("aria-label", `Page ${i + 1}${boxes[i] ? ", cropped" : ""}`);
      });
      const done = boxes.filter(Boolean).length;
      $("cropLabel").textContent = `Page ${pageIndex + 1} of ${doc.numPages}` + (done ? ` · ${done} cropped` : "");
    }
    const go = (i) => { if (doc && i >= 0 && i < doc.numPages && i !== pageIndex) { pageIndex = i; show(); } };
    $("cropPages").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) go(Number(b.dataset.page));
    });
    root.querySelectorAll('input[name="cropPages"]').forEach((r) => r.addEventListener("change", () => {
      const each = mode() === "each";
      $("cropEach").hidden = !each;
      // Switching to per-page: every page starts from the box drawn so far, if any.
      if (each && doc && !boxes.some(Boolean) && !isFull(box)) boxes = boxes.map(() => ({ ...box }));
      draw();
    }));
    root.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", () => {
      const which = btn.dataset.copy;
      boxes = boxes.map((b, i) => {
        const n = i + 1;
        if (which === "all" || (which === "odd" && n % 2) || (which === "even" && !(n % 2))) return isFull(box) ? null : { ...box };
        return b;
      });
      draw();
      if (typeof showToast === "function") showToast(`Crop copied to ${which === "all" ? "every page" : `${which} pages`}.`, "success");
    }));

    // Drag the box or a handle.
    let drag = null;
    $("cropStage").addEventListener("pointerdown", (e) => {
      const stage = $("cropStage").getBoundingClientRect();
      const fx = (e.clientX - stage.left) / stage.width;
      const fy = (e.clientY - stage.top) / stage.height;
      const handle = e.target.dataset.h;
      if (handle) drag = { mode: handle };
      else if (e.target.closest("#cropBox")) drag = { mode: "move", fx, fy, start: { ...box } };
      else { box = { l: fx, t: fy, r: fx, b: fy }; drag = { mode: "se" }; }
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    $("cropStage").addEventListener("pointermove", (e) => {
      if (!drag) return;
      const stage = $("cropStage").getBoundingClientRect();
      const fx = Math.min(Math.max((e.clientX - stage.left) / stage.width, 0), 1);
      const fy = Math.min(Math.max((e.clientY - stage.top) / stage.height, 0), 1);
      if (drag.mode === "move") {
        const w = drag.start.r - drag.start.l;
        const h = drag.start.b - drag.start.t;
        const l = Math.min(Math.max(drag.start.l + fx - drag.fx, 0), 1 - w);
        const t = Math.min(Math.max(drag.start.t + fy - drag.fy, 0), 1 - h);
        box = { l, t, r: l + w, b: t + h };
      } else {
        if (drag.mode.includes("w")) box.l = Math.min(fx, box.r - 0.05);
        if (drag.mode.includes("e")) box.r = Math.max(fx, box.l + 0.05);
        if (drag.mode.includes("n")) box.t = Math.min(fy, box.b - 0.05);
        if (drag.mode.includes("s")) box.b = Math.max(fy, box.t + 0.05);
      }
      draw();
    });
    const stop = () => { drag = null; };
    $("cropStage").addEventListener("pointerup", stop);
    $("cropStage").addEventListener("pointercancel", stop);

    $("cropPrev").addEventListener("click", () => go(pageIndex - 1));
    $("cropNext").addEventListener("click", () => go(pageIndex + 1));
    $("cropReset").addEventListener("click", () => { box = { ...FULL }; draw(); });
    // Finds the content's edges on the preview and crops just outside them.
    $("cropAuto").addEventListener("click", () => {
      const c = $("cropCanvas");
      const { data, width, height } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (data[i] + data[i + 1] + data[i + 2] < 720) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return;
      const pad = 0.015;
      box = {
        l: Math.max(x0 / width - pad, 0), t: Math.max(y0 / height - pad, 0),
        r: Math.min(x1 / width + pad, 1), b: Math.min(y1 / height + pad, 1),
      };
      draw();
    });

    function options() {
      if (!doc) throw new ClientPDF.UserError("Add a PDF first.");
      const margins = (b) => ({ left: b.l, top: b.t, right: 1 - b.r, bottom: 1 - b.b });
      if (mode() === "each") {
        if (!boxes.some(Boolean)) throw new ClientPDF.UserError("Drag on a page to choose the area to keep.");
        return { boxes: boxes.map((b) => (b ? margins(b) : null)) };
      }
      if (isFull(box)) throw new ClientPDF.UserError("Drag on the page to choose the area to keep.");
      return { ...margins(box), pages: mode() === "one" ? String(pageIndex + 1) : "all" };
    }

    return { setPdf, options, destroy: () => doc && doc.destroy() };
  }
  return { create };
})();
