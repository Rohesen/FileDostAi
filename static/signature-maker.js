// Signature Maker: draw a signature, type it in a handwriting font, or clean up a photo of one
// signed on paper, then download it as a see-through PNG (or on white as JPG) for forms,
// documents and email. Runs in the browser; nothing is uploaded.

const SignatureMaker = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const FONTS = ["Dancing Script", "Great Vibes", "Caveat"];
  const INKS = [["#111827", "Black"], ["#1d3fbf", "Blue"], ["#0b5e2e", "Green"], ["#b91c1c", "Red"]];

  const configHtml = `<div id="smRoot"></div>`;

  /** Crops to the ink, with a small margin. Returns null when there's no ink. */
  function trim(src, margin = 8) {
    const { width, height } = src;
    const d = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0, i = 3; y < height; y++) {
      for (let x = 0; x < width; x++, i += 4) {
        if (d[i] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null;
    x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
    x1 = Math.min(width - 1, x1 + margin); y1 = Math.min(height - 1, y1 + margin);
    return ImageKit.draw(src, x1 - x0 + 1, y1 - y0 + 1, { sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 });
  }

  /**
   * A photo of a signature on paper → ink only, background see-through. The paper's brightness is
   * measured around each spot (so shadows and uneven light don't turn grey), and the ink gets
   * the chosen colour or keeps its own.
   */
  function cleanPhoto(src, { strength = 0.5, ink = null } = {}) {
    const maxSide = 2000;
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = ImageKit.draw(src, src.width * s, src.height * s, { background: "#ffffff" });
    const w = c.width, h = c.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    // Paper brightness: a heavily blurred copy.
    const bgc = document.createElement("canvas");
    bgc.width = w; bgc.height = h;
    const bg = bgc.getContext("2d", { willReadFrequently: true });
    bg.filter = `blur(${Math.max(8, Math.round(Math.max(w, h) / 40))}px)`;
    bg.drawImage(c, 0, 0);
    const p = bg.getImageData(0, 0, w, h).data;
    const rgb = ink ? [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16)) : null;
    const lo = 0.06 + 0.12 * (1 - strength), hi = lo + 0.22;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const paper = Math.max(40, 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]);
      const dark = 1 - lum / paper;                       // 0 = like the paper, 1 = black
      const a = Math.min(1, Math.max(0, (dark - lo) / (hi - lo)));
      if (rgb) { d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; } else {
        // Deepen the ink's own colour so it doesn't look washed out.
        d[i] *= 0.7; d[i + 1] *= 0.7; d[i + 2] *= 0.7;
      }
      d[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function create(root) {
    root.innerHTML = `
      <div class="sm">
        <div class="sign-tabs" role="tablist">
          <button type="button" class="sign-tab active" data-tab="draw" role="tab">Draw</button>
          <button type="button" class="sign-tab" data-tab="type" role="tab">Type</button>
          <button type="button" class="sign-tab" data-tab="photo" role="tab">From a photo</button>
        </div>
        <div class="sign-panel" data-panel="draw">
          <canvas id="smPad" class="sig-pad sm-pad" width="900" height="300" aria-label="Draw your signature here"></canvas>
          <div class="sign-row">
            <label class="checkbox-group">Pen
              <select id="smWidth" class="select-sm"><option value="3">Fine</option><option value="5" selected>Medium</option><option value="8">Bold</option></select>
            </label>
            <button type="button" class="btn btn-xs" id="smUndo">Undo</button>
            <button type="button" class="btn btn-xs" id="smClear">Clear</button>
          </div>
        </div>
        <div class="sign-panel" data-panel="type" hidden>
          <input type="text" id="smText" class="form-input" placeholder="Type your name" maxlength="60" autocomplete="name">
          <div class="sm-fonts" id="smFonts">
            ${FONTS.map((f, i) => `<button type="button" class="sm-font${i ? "" : " active"}" data-font="${f}" style="font-family:'${f}',cursive">Your Name</button>`).join("")}
          </div>
        </div>
        <div class="sign-panel" data-panel="photo" hidden>
          <p class="drop-hint">Sign on plain white paper, take a straight photo in good light, and add it above. The paper is removed and only the ink is kept.</p>
          <label class="form-label" for="smStrength">Clean-up</label>
          <input type="range" id="smStrength" min="0" max="100" value="50" aria-label="How much faint marks are removed">
          <div class="sm-scale"><span>Keep faint strokes</span><span>Remove more marks</span></div>
        </div>

        <div class="form-group">
          <span class="form-label">Ink colour</span>
          <div class="sm-inks" id="smInks">
            ${INKS.map(([c, n], i) => `<button type="button" class="bgr-sw sm-ink" data-c="${c}" style="background:${c}" title="${n}" aria-label="${n}" aria-pressed="${i === 0}"></button>`).join("")}
            <label class="checkbox-group sm-own" id="smOwnWrap" hidden><input type="checkbox" id="smOwn"> Keep the photo's own ink colour</label>
          </div>
        </div>

        <div class="sm-preview-wrap">
          <div class="sm-preview" id="smPreview"><span class="drop-hint" id="smEmpty">Your signature will show here.</span><canvas id="smOut" hidden></canvas></div>
          <p class="bgr-info" id="smInfo"></p>
        </div>

        <div class="sign-row sm-save">
          <select id="smSize" class="select-sm" aria-label="Size">
            <option value="0" selected>Natural size</option>
            <option value="350x150">350×150 px (JEE, NEET, CUET forms)</option>
            <option value="400x200">400×200 px (SSC forms)</option>
            <option value="600x300">600×300 px (UPSC forms)</option>
            <option value="600x200">600×200 px (email, documents)</option>
          </select>
          <button type="button" class="btn btn-primary btn-xs" id="smPng">${Icons.ui("download")} PNG, see-through</button>
          <button type="button" class="btn btn-xs" id="smJpg">${Icons.ui("download")} JPG on white</button>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let tab = "draw", ink = INKS[0][0], font = FONTS[0], photo = null;
    const shared = { drop: document.getElementById("dropZone"), exec: document.getElementById("btnExecute") };
    const showDrop = () => { if (shared.drop) shared.drop.style.display = tab === "photo" ? "" : "none"; };
    if (shared.exec) shared.exec.style.display = "none";
    showDrop();

    // --- drawing pad: smooth strokes kept as points, so Undo can redraw them.
    const pad = $("smPad"), pg = pad.getContext("2d");
    let strokes = [], current = null;
    const point = (e) => {
      const r = pad.getBoundingClientRect();
      return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height), e.pressure || 0.5];
    };
    function drawStroke(g, s, color) {
      const pts = s.pts;
      g.strokeStyle = color; g.fillStyle = color; g.lineCap = "round"; g.lineJoin = "round";
      if (pts.length === 1) { g.beginPath(); g.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2); g.fill(); return; }
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = i > 1 ? [(pts[i - 2][0] + pts[i - 1][0]) / 2, (pts[i - 2][1] + pts[i - 1][1]) / 2] : pts[0];
        const [x1, y1] = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
        g.lineWidth = s.width * (0.75 + 0.5 * pts[i][2]);
        g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], x1, y1); g.stroke();
      }
    }
    function redrawPad() {
      pg.clearRect(0, 0, pad.width, pad.height);
      // a faint line to sign on
      pg.strokeStyle = "rgba(120,130,150,.35)"; pg.lineWidth = 2; pg.setLineDash([10, 8]);
      pg.beginPath(); pg.moveTo(40, pad.height * 0.72); pg.lineTo(pad.width - 40, pad.height * 0.72); pg.stroke(); pg.setLineDash([]);
      strokes.forEach((s) => drawStroke(pg, s, ink));
      if (current) drawStroke(pg, current, ink);
    }
    pad.addEventListener("pointerdown", (e) => {
      pad.setPointerCapture(e.pointerId);
      current = { width: Number($("smWidth").value), pts: [point(e)] };
      redrawPad();
      e.preventDefault();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!current) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach((ev) => current.pts.push(point(ev)));
      redrawPad();
    });
    const end = () => { if (current) { strokes.push(current); current = null; render(); } };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
    $("smUndo").addEventListener("click", () => { strokes.pop(); redrawPad(); render(); });
    $("smClear").addEventListener("click", () => { strokes = []; redrawPad(); render(); });

    root.querySelectorAll(".sign-tab").forEach((b) => b.addEventListener("click", () => {
      tab = b.dataset.tab;
      root.querySelectorAll(".sign-tab").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", String(x === b)); });
      root.querySelectorAll(".sign-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
      $("smOwnWrap").hidden = tab !== "photo";
      showDrop();
      render();
    }));
    root.querySelectorAll(".sm-font").forEach((b) => b.addEventListener("click", () => {
      font = b.dataset.font;
      root.querySelectorAll(".sm-font").forEach((x) => x.classList.toggle("active", x === b));
      render();
    }));
    $("smText").addEventListener("input", () => {
      const t = $("smText").value.trim() || "Your Name";
      root.querySelectorAll(".sm-font").forEach((b) => { b.textContent = t; });
      render();
    });
    root.querySelectorAll(".sm-ink").forEach((b) => b.addEventListener("click", () => {
      ink = b.dataset.c;
      root.querySelectorAll(".sm-ink").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $("smOwn").checked = false;
      redrawPad();
      render();
    }));
    $("smOwn").addEventListener("change", render);
    $("smStrength").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 120); });
    let timer = null;

    /** The signature as a trimmed, see-through canvas, or null. */
    function signature() {
      if (tab === "draw") {
        if (!strokes.length) return null;
        const c = document.createElement("canvas");
        c.width = pad.width; c.height = pad.height;
        strokes.forEach((s) => drawStroke(c.getContext("2d"), s, ink));
        return trim(c);
      }
      if (tab === "type") {
        const text = $("smText").value.trim();
        if (!text) return null;
        const c = document.createElement("canvas");
        const g = c.getContext("2d");
        const f = `${font === "Great Vibes" ? 400 : 600} 120px '${font}', cursive`;
        g.font = f;
        c.width = Math.ceil(g.measureText(text).width) + 80;
        c.height = 220;
        g.font = f;
        g.fillStyle = ink;
        g.textBaseline = "middle";
        g.fillText(text, 40, 110);
        return trim(c);
      }
      if (!photo) return null;
      return trim(cleanPhoto(photo, { strength: Number($("smStrength").value) / 100, ink: $("smOwn").checked ? null : ink }), 10);
    }

    function sized(c) {
      const v = $("smSize").value;
      if (v === "0") return c;
      const [W, H] = v.split("x").map(Number);
      // Fit inside the box, centred, with a little space around.
      const out = document.createElement("canvas");
      out.width = W; out.height = H;
      const s = Math.min((W * 0.92) / c.width, (H * 0.86) / c.height);
      const w = c.width * s, h = c.height * s;
      const g = out.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(c, (W - w) / 2, (H - h) / 2, w, h);
      return out;
    }

    let last = null;
    function render() {
      const c = signature();
      last = c;
      $("smEmpty").hidden = !!c;
      $("smOut").hidden = !c;
      $("smPng").disabled = $("smJpg").disabled = !c;
      if (!c) { $("smInfo").textContent = tab === "photo" && !photo ? "Add a photo of your signature above." : ""; return; }
      const out = $("smOut");
      const s = Math.min(1, 520 / c.width, 180 / c.height);
      out.width = Math.max(1, Math.round(c.width * s)); out.height = Math.max(1, Math.round(c.height * s));
      out.getContext("2d").drawImage(c, 0, 0, out.width, out.height);
      const z = sized(c);
      $("smInfo").textContent = `${z.width}×${z.height} px`;
    }
    $("smSize").addEventListener("change", render);

    async function save(fmt) {
      if (!last) throw UserError("Draw, type or add your signature first.");
      const c = sized(last);
      const bytes = await ImageKit.encode(c, fmt, 0.95);
      const f = ImageKit.FORMATS[fmt];
      const filename = `signature.${f.ext}`;
      downloadBlob(new Blob([bytes], { type: f.mime }), filename);
      showToast(`Done! ${c.width}×${c.height} px, ${ImageKit.kb(bytes.length)}. Downloaded ${filename}. Nothing was uploaded.`, "success");
      if (typeof Feedback !== "undefined") Feedback.askForRating(TOOLS.find((t) => t.id === "signature-maker"));
    }
    const guard = (fn) => () => fn().catch((e) => showToast(e.message || "Couldn't save the signature.", "error"));
    $("smPng").addEventListener("click", guard(() => save("png")));
    $("smJpg").addEventListener("click", guard(() => save("jpeg")));

    async function setFile(file) {
      const bmp = await ImageKit.decode(file);
      photo = ImageKit.draw(bmp, bmp.width, bmp.height);
      if (tab !== "photo") root.querySelector('.sign-tab[data-tab="photo"]').click();
      else render();
    }

    // Fonts load on first use; redraw once they're ready so the preview isn't in a fallback font.
    if (document.fonts) Promise.all(FONTS.map((f) => document.fonts.load(`${f === "Great Vibes" ? 400 : 600} 120px '${f}'`))).then(render).catch(() => {});
    redrawPad();
    render();
    return {
      setFile, render,
      destroy: () => {
        clearTimeout(timer);
        if (shared.drop) shared.drop.style.display = "";
        if (shared.exec) shared.exec.style.display = "";
      },
    };
  }

  return { configHtml, create, cleanPhoto, trim };
})();

TOOLS.push({
  id: "signature-maker",
  slug: "signature-maker",
  aliases: ["signature-creator", "signature-generator", "online-signature", "transparent-signature", "digital-signature-maker"],
  name: "Signature Maker",
  desc: "Draw or type your signature, or clean up a photo of one, and download it as a see-through PNG for forms and documents.",
  keywords: "signature maker signature creator signature generator draw signature online type signature handwritten signature transparent signature png digital signature image e signature sign photo remove background from signature exam form signature",
  category: "edit",
  badge: "New",
  accept: "image/*,.heic,.heif",
  acceptLabel: "a photo of your signature",
  wide: true,
  caption: "Draw, type or snap it",
  configHtml: SignatureMaker.configHtml,
  onOpen: (ctx) => { ctx.sm = SignatureMaker.create(ctx.el("smRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.sm.setFile(ctx.files[0]),
  onClose: (ctx) => ctx.sm && ctx.sm.destroy(),
  run: async () => { throw new ClientPDF.UserError("Use the Download buttons under the preview."); },
});
