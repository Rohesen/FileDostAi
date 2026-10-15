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
          <label class="checkbox-group"><input type="radio" name="cropPages" value="one"> Only this page</label>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let doc = null;
    let pageIndex = 0;
    let pagePts = { w: 0, h: 0 };
    // Box as fractions of the displayed page.
    let box = { l: 0, t: 0, r: 1, b: 1 };

    async function setPdf(bytes) {
      if (doc) doc.destroy();
      doc = await PdfRender.open(bytes);
      pageIndex = 0;
      box = { l: 0, t: 0, r: 1, b: 1 };
      $("cropWrap").hidden = false;
      await show();
    }

    async function show() {
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
    }

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

    $("cropPrev").addEventListener("click", () => { if (doc && pageIndex > 0) { pageIndex--; show(); } });
    $("cropNext").addEventListener("click", () => { if (doc && pageIndex < doc.numPages - 1) { pageIndex++; show(); } });
    $("cropReset").addEventListener("click", () => { box = { l: 0, t: 0, r: 1, b: 1 }; draw(); });
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
      const margins = { left: box.l, top: box.t, right: 1 - box.r, bottom: 1 - box.b };
      if (Object.values(margins).every((m) => m < 0.001)) throw new ClientPDF.UserError("Drag on the page to choose the area to keep.");
      const only = root.querySelector('input[name="cropPages"]:checked').value === "one";
      return { ...margins, pages: only ? String(pageIndex + 1) : "all" };
    }

    return { setPdf, options, destroy: () => doc && doc.destroy() };
  }
  return { create };
})();
