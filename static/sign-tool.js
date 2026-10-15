// Sign PDF: draw, type or upload a signature, then click on the page preview to place it.
// The signature is stamped in the browser with ClientPDF.stampImage; nothing is uploaded.

const SignTool = (() => {
  const FONTS = ["Dancing Script", "Caveat", "Great Vibes"];

  function html() {
    return `
      <div class="sign-tabs" role="tablist">
        <button type="button" class="sign-tab active" data-tab="draw">Draw</button>
        <button type="button" class="sign-tab" data-tab="type">Type</button>
        <button type="button" class="sign-tab" data-tab="upload">Upload image</button>
      </div>
      <div class="sign-panel" data-panel="draw">
        <canvas id="sigPad" class="sig-pad" width="600" height="200" aria-label="Draw your signature here"></canvas>
        <div class="sign-row">
          <label class="checkbox-group">Ink
            <select id="sigInk" class="select-sm"><option value="#111827">Black</option><option value="#1d4ed8">Blue</option></select>
          </label>
          <button type="button" class="btn btn-xs" id="sigClear">Clear</button>
        </div>
      </div>
      <div class="sign-panel" data-panel="type" hidden>
        <input type="text" id="sigText" class="form-input" placeholder="Type your name" maxlength="60">
        <select id="sigFont" class="form-select" style="margin-top:8px;">
          ${FONTS.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join("")}
        </select>
      </div>
      <div class="sign-panel" data-panel="upload" hidden>
        <input type="file" id="sigUpload" accept="image/png,image/jpeg" class="form-input">
        <p class="drop-hint">A PNG with a transparent background looks best.</p>
      </div>
      <div class="sign-place" id="signPlace" hidden>
        <div class="sign-row">
          <button type="button" class="btn btn-xs" id="sigPrev">◀</button>
          <span id="sigPageLabel">Page 1</span>
          <button type="button" class="btn btn-xs" id="sigNext">▶</button>
          <label class="checkbox-group" style="margin-left:auto;">Size
            <input type="range" id="sigSize" min="60" max="320" value="160">
          </label>
        </div>
        <p class="drop-hint">Click on the page where the signature should go. Click again to move it.</p>
        <div class="sign-preview" id="sigPreview"><canvas id="sigPageCanvas"></canvas><img id="sigGhost" alt="" hidden></div>
        <label class="checkbox-group"><input type="checkbox" id="sigAllPages"> Put it on every page in the same spot</label>
      </div>`;
  }

  function create(root) {
    root.innerHTML = html();
    const $ = (id) => root.querySelector(`#${id}`);
    let tab = "draw";
    let uploaded = null; // { bytes, type, url }
    let doc = null;
    let pageIndex = 0;
    let renderInfo = null; // { scale, viewport } of the preview
    let placement = null; // { page, x, y } centre in displayed PDF points

    // --- drawing pad
    const pad = $("sigPad");
    const pctx = pad.getContext("2d");
    let drawing = false;
    let drawn = false;
    function padPoint(e) {
      const r = pad.getBoundingClientRect();
      return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)];
    }
    pad.addEventListener("pointerdown", (e) => {
      drawing = true;
      pad.setPointerCapture(e.pointerId);
      pctx.strokeStyle = $("sigInk").value;
      pctx.lineWidth = 3.5;
      pctx.lineCap = "round";
      pctx.lineJoin = "round";
      pctx.beginPath();
      pctx.moveTo(...padPoint(e));
    });
    pad.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      pctx.lineTo(...padPoint(e));
      pctx.stroke();
      drawn = true;
    });
    pad.addEventListener("pointerup", () => { drawing = false; updateGhost(); });
    $("sigClear").addEventListener("click", () => { pctx.clearRect(0, 0, pad.width, pad.height); drawn = false; updateGhost(); });

    root.querySelectorAll(".sign-tab").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      root.querySelectorAll(".sign-tab").forEach((x) => x.classList.toggle("active", x === b));
      root.querySelectorAll(".sign-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
      updateGhost();
    }));
    $("sigText").addEventListener("input", updateGhost);
    $("sigFont").addEventListener("change", updateGhost);
    $("sigUpload").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      uploaded = { bytes: new Uint8Array(await f.arrayBuffer()), type: f.type === "image/png" ? "image/png" : "image/jpeg", url: URL.createObjectURL(f) };
      updateGhost();
    });

    /** The signature as a tightly cropped PNG canvas, or null if there isn't one yet. */
    function signatureCanvas() {
      if (tab === "draw") return drawn ? trim(pad) : null;
      if (tab === "type") {
        const text = $("sigText").value.trim();
        if (!text) return null;
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        const font = `96px '${$("sigFont").value}', cursive`;
        ctx.font = font;
        c.width = Math.ceil(ctx.measureText(text).width) + 40;
        c.height = 150;
        ctx.font = font;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 20, 75);
        return trim(c);
      }
      return null;
    }

    function trim(src) {
      const ctx = src.getContext("2d");
      const { data, width, height } = ctx.getImageData(0, 0, src.width, src.height);
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 10) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      const pad2 = 6;
      x0 = Math.max(0, x0 - pad2); y0 = Math.max(0, y0 - pad2);
      x1 = Math.min(width - 1, x1 + pad2); y1 = Math.min(height - 1, y1 + pad2);
      const out = document.createElement("canvas");
      out.width = x1 - x0 + 1;
      out.height = y1 - y0 + 1;
      out.getContext("2d").drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    }

    async function signatureImage() {
      if (tab === "upload") {
        if (!uploaded) return null;
        const img = await createImageBitmap(new Blob([uploaded.bytes], { type: uploaded.type }));
        return { bytes: uploaded.bytes, type: uploaded.type, aspect: img.width / img.height, url: uploaded.url };
      }
      const c = signatureCanvas();
      if (!c) return null;
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "image/png", aspect: c.width / c.height, url: c.toDataURL("image/png") };
    }

    // --- page preview and placement
    async function setPdf(bytes) {
      if (doc) doc.destroy();
      doc = await PdfRender.open(bytes);
      pageIndex = 0;
      placement = null;
      $("signPlace").hidden = false;
      await showPage();
    }

    async function showPage() {
      const page = await doc.getPage(pageIndex + 1);
      renderInfo = await PdfRender.renderPage(page, $("sigPageCanvas"), { maxWidth: Math.min(root.clientWidth || 600, 600) });
      $("sigPageLabel").textContent = `Page ${pageIndex + 1} of ${doc.numPages}`;
      updateGhost();
    }

    $("sigPrev").addEventListener("click", () => { if (doc && pageIndex > 0) { pageIndex--; showPage(); } });
    $("sigNext").addEventListener("click", () => { if (doc && pageIndex < doc.numPages - 1) { pageIndex++; showPage(); } });
    $("sigSize").addEventListener("input", updateGhost);
    $("sigPageCanvas").addEventListener("click", (e) => {
      const canvas = e.currentTarget;
      const r = canvas.getBoundingClientRect();
      const ptPerCss = (renderInfo.viewport.width / renderInfo.scale) / r.width;
      placement = {
        page: pageIndex,
        x: (e.clientX - r.left) * ptPerCss,
        y: (r.bottom - e.clientY) * ptPerCss,
      };
      updateGhost();
    });

    async function updateGhost() {
      const ghost = $("sigGhost");
      const canvas = $("sigPageCanvas");
      const sig = await signatureImage().catch(() => null);
      if (!sig || !placement || !renderInfo || (placement.page !== pageIndex && !$("sigAllPages").checked)) {
        ghost.hidden = true;
        return;
      }
      const r = canvas.getBoundingClientRect();
      const cssPerPt = r.width / (renderInfo.viewport.width / renderInfo.scale);
      const w = Number($("sigSize").value) * cssPerPt;
      const h = w / sig.aspect;
      ghost.src = sig.url;
      ghost.style.width = `${w}px`;
      ghost.style.height = `${h}px`;
      ghost.style.left = `${placement.x * cssPerPt - w / 2}px`;
      ghost.style.top = `${r.height - placement.y * cssPerPt - h / 2}px`;
      ghost.hidden = false;
    }
    root.addEventListener("change", (e) => { if (e.target.id === "sigAllPages") updateGhost(); });

    /** Arguments for ClientPDF.stampImage. */
    async function stampArgs() {
      const sig = await signatureImage();
      if (!sig) throw new ClientPDF.UserError("Draw, type or upload your signature first.");
      if (!placement) throw new ClientPDF.UserError("Click on the page where the signature should go.");
      const width = Number($("sigSize").value);
      const height = width / sig.aspect;
      const spot = { x: placement.x - width / 2, y: placement.y - height / 2, width, height };
      const pages = $("sigAllPages").checked ? [...Array(doc.numPages).keys()] : [placement.page];
      return { imageBytes: sig.bytes, imageType: sig.type, placements: pages.map((page) => ({ page, ...spot })) };
    }

    return { setPdf, stampArgs, destroy: () => doc && doc.destroy() };
  }

  return { create, FONTS };
})();
