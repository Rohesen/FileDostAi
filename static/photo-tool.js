// Photo & signature resizer for exam and job forms (JEE, NEET, SSC, UPSC, passport):
// crop to the right shape, exact pixels, DPI and a file size between min and max KB.
// Runs in the browser; the photo is never uploaded.

const PhotoTool = (() => {
  // Typical requirements. Forms change every year, so every field stays editable.
  const PRESETS = {
    custom: { label: "Custom size", w: 0, h: 0, min: 0, max: 0, fmt: "jpeg", dpi: 0 },
    "jee-photo": { label: "JEE Main photo (10–300 KB, 3.5×4.5 cm)", w: 350, h: 450, min: 10, max: 300, fmt: "jpeg", dpi: 254, file: "Photograph" },
    "jee-sign": { label: "JEE Main signature (10–50 KB)", w: 350, h: 150, min: 10, max: 50, fmt: "jpeg", dpi: 254, file: "Signature", sign: true },
    "neet-photo": { label: "NEET passport photo (10–200 KB, 3.5×4.5 cm)", w: 350, h: 450, min: 10, max: 200, fmt: "jpeg", dpi: 254, file: "Photograph" },
    "neet-sign": { label: "NEET signature (4–30 KB)", w: 350, h: 150, min: 4, max: 30, fmt: "jpeg", dpi: 254, file: "Signature", sign: true },
    "ssc-photo": { label: "SSC photo (20–50 KB, 3.5×4.5 cm)", w: 350, h: 450, min: 20, max: 50, fmt: "jpeg", dpi: 254, file: "Photograph" },
    "ssc-sign": { label: "SSC signature (10–20 KB, 4×2 cm)", w: 400, h: 200, min: 10, max: 20, fmt: "jpeg", dpi: 254, file: "Signature", sign: true },
    "upsc-photo": { label: "UPSC photo (20–200 KB, square)", w: 600, h: 600, min: 20, max: 200, fmt: "jpeg", dpi: 0, file: "Photograph" },
    "upsc-sign": { label: "UPSC signature (20–100 KB)", w: 600, h: 300, min: 20, max: 100, fmt: "jpeg", dpi: 0, file: "Signature", sign: true },
    "neet-postcard": { label: "NEET postcard-size photo (10–200 KB, 4×6 in)", w: 600, h: 900, min: 10, max: 200, fmt: "jpeg", dpi: 150, file: "Postcard_photo" },
    "neet-thumb": { label: "NEET left thumb impression (10–200 KB)", w: 0, h: 0, min: 10, max: 200, fmt: "jpeg", dpi: 0, file: "Left_thumb", sign: true },
    "cuet-photo": { label: "CUET photo (10–200 KB, 3.5×4.5 cm)", w: 350, h: 450, min: 10, max: 200, fmt: "jpeg", dpi: 254, file: "Photograph" },
    "cuet-sign": { label: "CUET signature (4–30 KB)", w: 350, h: 150, min: 4, max: 30, fmt: "jpeg", dpi: 254, file: "Signature", sign: true },
    passport: { label: "Passport photo (35×45 mm, 300 dpi)", w: 413, h: 531, min: 0, max: 0, fmt: "jpeg", dpi: 300, file: "Passport_photo" },
    "ten-kb": { label: "Any photo under 20 KB", w: 0, h: 0, min: 0, max: 20, fmt: "jpeg", dpi: 0 },
    "fifty-kb": { label: "Any photo under 50 KB", w: 0, h: 0, min: 0, max: 50, fmt: "jpeg", dpi: 0 },
  };

  function create(root) {
    root.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="ptPreset">Made for</label>
        <select id="ptPreset" class="form-select">
          ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === "jee-photo" ? "selected" : ""}>${p.label}</option>`).join("")}
        </select>
        <p class="drop-hint">Typical sizes. Always check the latest official notice and change the numbers below if they differ.</p>
      </div>
      <div class="pt-wrap" id="ptWrap" hidden>
        <div class="pt-stage-col">
          <div class="crop-stage pt-stage" id="ptStage">
            <canvas id="ptCanvas"></canvas>
            <div class="crop-box" id="ptBox"><span class="crop-handle h-se" data-h="se"></span><span class="crop-handle h-nw" data-h="nw"></span></div>
          </div>
          <div class="sign-row">
            <button type="button" class="btn btn-xs" id="ptRotate">${Icons.ui("rotate")} Rotate</button>
            <button type="button" class="btn btn-xs" id="ptFit">Whole picture</button>
            <span class="drop-hint">Drag the box to choose what to keep.</span>
          </div>
        </div>
        <div class="pt-preview-col">
          <canvas id="ptPreview" class="pt-preview"></canvas>
          <p class="pt-result" id="ptResult">Working out the size…</p>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label" for="ptW">Width (px)</label><input type="number" id="ptW" class="form-input" min="0" max="10000" placeholder="Any"></div>
        <div class="form-group"><label class="form-label" for="ptH">Height (px)</label><input type="number" id="ptH" class="form-input" min="0" max="10000" placeholder="Any"></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label class="form-label" for="ptMin">Minimum KB</label><input type="number" id="ptMin" class="form-input" min="0" placeholder="None"></div>
        <div class="form-group"><label class="form-label" for="ptMax">Maximum KB</label><input type="number" id="ptMax" class="form-input" min="0" placeholder="None"></div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label" for="ptFmt">Save as</label>
          <select id="ptFmt" class="form-select"><option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="pdf">PDF</option></select>
        </div>
        <div class="form-group"><label class="form-label" for="ptDpi">DPI (optional)</label><input type="number" id="ptDpi" class="form-input" min="0" max="1200" placeholder="Leave as is"></div>
      </div>
      <label class="checkbox-group"><input type="checkbox" id="ptClean"> Clean signature: make the paper pure white and the ink darker</label>
      <label class="checkbox-group"><input type="checkbox" id="ptStamp"> Add name and date under the photo (some forms ask for this)</label>
      <div class="grid-2" id="ptStampFields" hidden>
        <div class="form-group"><input type="text" id="ptName" class="form-input" maxlength="40" placeholder="Your name"></div>
        <div class="form-group"><input type="date" id="ptDate" class="form-input"></div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let src = null;          // decoded picture (canvas), already rotated
    let box = { l: 0, t: 0, r: 1, b: 1 }; // crop box as fractions of the picture
    let last = null;         // latest finished output
    let timer = null;
    $("ptDate").valueAsDate = new Date();

    function preset() { return PRESETS[$("ptPreset").value]; }
    function applyPreset() {
      const p = preset();
      $("ptW").value = p.w || ""; $("ptH").value = p.h || "";
      $("ptMin").value = p.min || ""; $("ptMax").value = p.max || "";
      $("ptFmt").value = p.fmt; $("ptDpi").value = p.dpi || "";
      $("ptClean").checked = !!p.sign;
      fitBox();
    }
    function ratio() {
      const w = Number($("ptW").value), h = Number($("ptH").value);
      return w > 0 && h > 0 ? w / h : 0;
    }
    // Largest centred box with the target shape.
    function fitBox() {
      if (!src) return;
      const r = ratio();
      if (!r) { box = { l: 0, t: 0, r: 1, b: 1 }; draw(); return; }
      const pr = src.width / src.height;
      let w = 1, h = 1;
      if (pr > r) w = r / pr; else h = pr / r;
      box = { l: (1 - w) / 2, t: (1 - h) / 2, r: (1 + w) / 2, b: (1 + h) / 2 };
      draw();
    }

    async function setFile(file) {
      const bmp = await ImageKit.decode(file);
      src = ImageKit.draw(bmp, bmp.width, bmp.height);
      $("ptWrap").hidden = false;
      const c = $("ptCanvas");
      const s = Math.min(1, 420 / src.width, 420 / src.height);
      c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      fitBox();
    }

    function draw() {
      const el = $("ptBox");
      el.style.left = `${box.l * 100}%`; el.style.top = `${box.t * 100}%`;
      el.style.width = `${(box.r - box.l) * 100}%`; el.style.height = `${(box.b - box.t) * 100}%`;
      schedule();
    }

    // Drag the box, or a corner to resize it (keeping the shape).
    let drag = null;
    $("ptStage").addEventListener("pointerdown", (e) => {
      if (!src) return;
      const st = $("ptStage").getBoundingClientRect();
      const fx = (e.clientX - st.left) / st.width, fy = (e.clientY - st.top) / st.height;
      drag = { mode: e.target.dataset.h || "move", fx, fy, start: { ...box } };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    $("ptStage").addEventListener("pointermove", (e) => {
      if (!drag) return;
      const st = $("ptStage").getBoundingClientRect();
      const fx = Math.min(Math.max((e.clientX - st.left) / st.width, 0), 1);
      const fy = Math.min(Math.max((e.clientY - st.top) / st.height, 0), 1);
      const s = drag.start;
      if (drag.mode === "move") {
        const w = s.r - s.l, h = s.b - s.t;
        const l = Math.min(Math.max(s.l + fx - drag.fx, 0), 1 - w);
        const t = Math.min(Math.max(s.t + fy - drag.fy, 0), 1 - h);
        box = { l, t, r: l + w, b: t + h };
      } else {
        const r = ratio(), pr = src.width / src.height;
        const anchorX = drag.mode === "se" ? s.l : s.r, anchorY = drag.mode === "se" ? s.t : s.b;
        let w = Math.max(Math.abs(fx - anchorX), 0.05), h = Math.max(Math.abs(fy - anchorY), 0.05);
        if (r) {
          // keep the shape: height in picture fractions = width * pr / r
          h = (w * pr) / r;
          const room = drag.mode === "se" ? 1 - anchorY : anchorY;
          if (h > room) { h = room; w = (h * r) / pr; }
          const roomX = drag.mode === "se" ? 1 - anchorX : anchorX;
          if (w > roomX) { w = roomX; h = (w * pr) / r; }
        }
        box = drag.mode === "se"
          ? { l: anchorX, t: anchorY, r: anchorX + w, b: anchorY + h }
          : { l: anchorX - w, t: anchorY - h, r: anchorX, b: anchorY };
      }
      draw();
    });
    const stop = () => { drag = null; };
    $("ptStage").addEventListener("pointerup", stop);
    $("ptStage").addEventListener("pointercancel", stop);

    $("ptRotate").addEventListener("click", () => {
      if (!src) return;
      const c = document.createElement("canvas");
      c.width = src.height; c.height = src.width;
      const g = c.getContext("2d");
      g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0);
      src = c;
      const v = $("ptCanvas");
      const s = Math.min(1, 420 / src.width, 420 / src.height);
      v.width = Math.round(src.width * s); v.height = Math.round(src.height * s);
      v.getContext("2d").drawImage(src, 0, 0, v.width, v.height);
      fitBox();
    });
    $("ptFit").addEventListener("click", () => { box = { l: 0, t: 0, r: 1, b: 1 }; draw(); });
    $("ptPreset").addEventListener("change", applyPreset);
    $("ptStamp").addEventListener("change", () => { $("ptStampFields").hidden = !$("ptStamp").checked; schedule(); });
    root.addEventListener("input", (e) => {
      if (e.target.id === "ptW" || e.target.id === "ptH") fitBox(); else schedule();
    });
    root.addEventListener("change", (e) => { if (e.target.type === "checkbox") schedule(); });

    // Builds the final picture: crop, resize, clean, stamp.
    function picture() {
      const sx = box.l * src.width, sy = box.t * src.height;
      const sw = (box.r - box.l) * src.width, sh = (box.b - box.t) * src.height;
      let w = Number($("ptW").value) || 0, h = Number($("ptH").value) || 0;
      if (!w && !h) { w = sw; h = sh; } else if (!w) w = (sw * h) / sh; else if (!h) h = (sh * w) / sw;
      const c = ImageKit.draw(src, w, h, { background: "#ffffff", sx, sy, sw, sh });
      const g = c.getContext("2d");
      if ($("ptClean").checked) {
        const img = g.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 150) { d[i] = d[i + 1] = d[i + 2] = 255; } else {
            const k = 0.6; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
          }
        }
        g.putImageData(img, 0, 0);
      }
      if ($("ptStamp").checked && ($("ptName").value || $("ptDate").value)) {
        const band = Math.round(c.height * 0.16);
        g.fillStyle = "#ffffff"; g.fillRect(0, c.height - band, c.width, band);
        g.fillStyle = "#000000"; g.textAlign = "center"; g.textBaseline = "middle";
        const date = $("ptDate").value ? $("ptDate").value.split("-").reverse().join("/") : "";
        const lines = [$("ptName").value.toUpperCase(), date].filter(Boolean);
        const fs = Math.max(8, Math.floor(band / (lines.length + 0.6)));
        g.font = `bold ${fs}px Arial, sans-serif`;
        lines.forEach((t, i) => g.fillText(t, c.width / 2, c.height - band + (band / (lines.length + 1)) * (i + 1), c.width - 6));
      }
      return c;
    }

    async function build() {
      if (!src) throw new ClientPDF.UserError("Add a photo first.");
      const c = picture();
      const fmt = $("ptFmt").value;
      const dpi = Number($("ptDpi").value) || 0;
      const minKB = Number($("ptMin").value) || 0, maxKB = Number($("ptMax").value) || 0;
      const fixed = Number($("ptW").value) > 0 || Number($("ptH").value) > 0;
      if (minKB && maxKB && minKB > maxKB) throw new ClientPDF.UserError("Minimum KB is bigger than maximum KB.");
      if (fmt === "pdf") {
        const jpg = await ImageKit.fitSize(c, "jpeg", { maxKB: maxKB ? Math.max(maxKB - 2, 1) : 0, allowShrink: !fixed });
        const pdf = await PdfWorker.run("imagesToPdf", [{ bytes: jpg.bytes, type: "image/jpeg" }]);
        return { bytes: pdf.bytes, width: jpg.width, height: jpg.height, note: jpg.note, fmt, canvas: c };
      }
      const r = await ImageKit.fitSize(c, fmt, { minKB, maxKB, dpi, allowShrink: !fixed });
      return { ...r, fmt, canvas: c };
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!src) return;
        try {
          last = await build();
          const pv = $("ptPreview");
          const s = Math.min(1, 220 / last.canvas.width, 260 / last.canvas.height);
          pv.width = Math.round(last.canvas.width * s); pv.height = Math.round(last.canvas.height * s);
          pv.getContext("2d").drawImage(last.canvas, 0, 0, pv.width, pv.height);
          const minKB = Number($("ptMin").value) || 0, maxKB = Number($("ptMax").value) || 0;
          const size = last.bytes.length / 1024;
          const ok = (!minKB || size >= minKB) && (!maxKB || size <= maxKB);
          $("ptResult").className = `pt-result ${ok ? "ok" : "bad"}`;
          $("ptResult").textContent = `${ok ? "✓" : "✗"} ${last.width}×${last.height} px, ${size < 10 ? size.toFixed(1) : Math.round(size)} KB` +
            (minKB || maxKB ? ` (needs ${minKB || 0}–${maxKB || "any"} KB)` : "") + (last.note ? `. ${last.note}` : "");
        } catch (e) {
          last = null;
          $("ptResult").className = "pt-result bad";
          $("ptResult").textContent = e.message;
        }
      }, 250);
    }

    async function result() {
      const r = await build();
      const name = preset().file || "photo";
      const f = ImageKit.FORMATS[r.fmt];
      return { bytes: r.bytes, filename: `${name}.${f.ext}`, mime: f.mime, keepName: !!preset().file,
        message: `Done! ${r.width}×${r.height} px, ${ImageKit.kb(r.bytes.length)}. Downloaded ${name}.${f.ext}. Nothing was uploaded.` };
    }

    applyPreset();
    return { setFile, result, destroy: () => clearTimeout(timer) };
  }
  return { create, PRESETS };
})();
