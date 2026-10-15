// Background Remover: cuts the person or object out of a photo and saves it see-through (PNG),
// on white, or on any colour (handy for passport and exam photos).
// The model (a small U²-Net, 44 MB) and ONNX Runtime Web live in /static/vendor/bg-remove/ and
// are downloaded only the first time this tool is used. It all runs on the device, in a worker.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/bg-remove.css?v=25" }));

const BgRemove = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const SIZE = 320;            // what the model looks at
  const MAX_SIDE = 4096;       // bigger photos are scaled down to this, so phones don't run out of memory
  const SWATCHES = [
    ["#ffffff", "White"], ["#d9ecff", "Light blue"], ["#1e5bbd", "Blue"], ["#d62828", "Red"], ["#e9e9e9", "Light grey"], ["#111111", "Black"],
  ];
  // Edge softness: mask values below lo become clear, above hi solid, in between see-through.
  const EDGES = { soft: [0.02, 0.98], normal: [0.15, 0.85], sharp: [0.4, 0.6] };

  let worker = null;
  let seq = 0;
  const waiting = new Map();
  let onProgress = null;

  function getWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("/static/bg-remove-worker.js?v=25", { type: "module" });
    } catch (e) {
      throw UserError("This browser can't run the background remover. Try a recent Chrome, Edge, Firefox or Safari.");
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { if (onProgress) onProgress(m); return; }
      const job = waiting.get(m.id);
      if (!job) return;
      waiting.delete(m.id);
      if (m.type === "error") job.reject(UserError(friendly(m.message)));
      else job.resolve(m);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      const err = UserError("The background remover couldn't start. Check your connection and try again.");
      waiting.forEach((j) => j.reject(err));
      waiting.clear();
      stop();
    };
    return worker;
  }
  function friendly(msg) {
    if (/download|fetch|network|load/i.test(msg)) return "Couldn't download the background remover. Check your connection and try again.";
    if (/memory|allocation|bad_alloc/i.test(msg)) return "This device ran out of memory. Close other tabs and try again.";
    return "Couldn't remove the background from this picture. Try another photo.";
  }
  function ask(msg, transfer) {
    const w = getWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, ...msg }, transfer || []);
    });
  }
  function stop() {
    if (worker) worker.terminate();
    worker = null;
  }

  /** The cut-out mask for a picture, as a canvas the picture's size whose alpha is the mask. */
  async function maskFor(src) {
    const small = ImageKit.draw(src, SIZE, SIZE);
    const rgba = small.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    const r = await ask({ type: "mask", rgba: rgba.buffer }, [rgba.buffer]);
    const m = new Uint8Array(r.mask);
    const img = new ImageData(SIZE, SIZE);
    for (let i = 0; i < m.length; i++) { const k = i * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = m[i]; }
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    c.getContext("2d").putImageData(img, 0, 0);
    return ImageKit.draw(c, src.width, src.height); // smooth upscale to full size
  }

  /** Applies the edge setting to the full-size mask and returns the cut-out (transparent) picture. */
  function cutOut(src, mask, edge) {
    const [lo, hi] = EDGES[edge] || EDGES.normal;
    const w = src.width, h = src.height;
    const m = document.createElement("canvas");
    m.width = w; m.height = h;
    const mg = m.getContext("2d", { willReadFrequently: true });
    mg.drawImage(mask, 0, 0);
    const img = mg.getImageData(0, 0, w, h);
    const d = img.data;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.min(1, Math.max(0, (v / 255 - lo) / (hi - lo))) * 255);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0, i = 3; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const a = lut[d[i]];
        d[i] = a;
        if (a > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    mg.putImageData(img, 0, 0);
    const out = ImageKit.draw(src, w, h);
    const g = out.getContext("2d");
    g.globalCompositeOperation = "destination-in";
    g.drawImage(m, 0, 0);
    return { canvas: out, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
  }

  /** The final picture: background behind the cut-out, optionally trimmed to the subject. */
  function compose(cut, { bg, trim }) {
    let sx = 0, sy = 0, sw = cut.canvas.width, sh = cut.canvas.height;
    if (trim && cut.box) {
      const pad = Math.round(Math.max(cut.box.x1 - cut.box.x0, cut.box.y1 - cut.box.y0) * 0.04);
      sx = Math.max(0, cut.box.x0 - pad); sy = Math.max(0, cut.box.y0 - pad);
      sw = Math.min(cut.canvas.width, cut.box.x1 + 1 + pad) - sx;
      sh = Math.min(cut.canvas.height, cut.box.y1 + 1 + pad) - sy;
    }
    return ImageKit.draw(cut.canvas, sw, sh, { background: bg || null, sx, sy, sw, sh });
  }

  const configHtml = `<div id="bgrRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="bgr">
        <div class="bgr-wrap" id="bgrWrap" hidden>
          <div>
            <div class="bgr-stage" id="bgrStage">
              <canvas id="bgrView"></canvas>
              <canvas id="bgrBefore" class="bgr-before"></canvas>
              <div class="bgr-busy" id="bgrBusy" hidden>
                <span class="bgr-spin" aria-hidden="true"></span>
                <span id="bgrBusyText">Finding the subject…</span>
                <progress id="bgrBar" max="1" hidden></progress>
              </div>
            </div>
            <div class="sign-row">
              <button type="button" class="btn btn-xs" id="bgrCompare">Hold to see the original</button>
            </div>
          </div>
          <div class="bgr-side">
            <div class="form-group">
              <span class="form-label">Background</span>
              <div class="bgr-bgs" role="radiogroup" aria-label="Background">
                <label class="bgr-bg"><input type="radio" name="bgrBg" value="none" checked><span>See-through</span></label>
                <label class="bgr-bg"><input type="radio" name="bgrBg" value="white"><span>White</span></label>
                <label class="bgr-bg"><input type="radio" name="bgrBg" value="colour"><span>Colour</span></label>
              </div>
            </div>
            <div class="bgr-colours" id="bgrColours" hidden>
              ${SWATCHES.map(([c, n]) => `<button type="button" class="bgr-sw" data-c="${c}" style="background:${c}" title="${n}" aria-label="${n}" aria-pressed="false"></button>`).join("")}
              <input type="color" id="bgrPick" class="bgr-pick" value="#d9ecff" aria-label="Pick any colour">
            </div>
            <div class="form-group">
              <label class="form-label" for="bgrEdge">Edges</label>
              <select id="bgrEdge" class="form-select">
                <option value="soft">Soft (hair, fur)</option>
                <option value="normal" selected>Normal</option>
                <option value="sharp">Sharp (objects, logos)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="bgrFmt">Save as</label>
              <select id="bgrFmt" class="form-select">
                <option value="png" selected>PNG</option>
                <option value="jpeg">JPG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
            <label class="checkbox-group"><input type="checkbox" id="bgrTrim"> Trim the empty space around it</label>
            <p class="bgr-info" id="bgrInfo"></p>
          </div>
        </div>
        <p class="drop-hint">Works best on photos of people, pets, products and cars. The picture never leaves your device. The first time, the tool downloads about 55 MB; after that it opens quickly.</p>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let src = null, mask = null, cut = null, name = "image", note = "";
    let token = 0;

    function bg() {
      const v = root.querySelector('input[name="bgrBg"]:checked').value;
      return v === "white" ? "#ffffff" : v === "colour" ? $("bgrPick").value : null;
    }
    function busy(text, frac) {
      $("bgrBusy").hidden = !text;
      if (!text) return;
      $("bgrBusyText").textContent = text;
      $("bgrBar").hidden = frac == null;
      if (frac != null) $("bgrBar").value = frac;
    }
    function info(text, bad) {
      $("bgrInfo").textContent = text;
      $("bgrInfo").className = `bgr-info${bad ? " bad" : ""}`;
    }
    function fit(canvas, view) {
      const s = Math.min(1, 640 / canvas.width, 480 / canvas.height);
      view.width = Math.max(1, Math.round(canvas.width * s));
      view.height = Math.max(1, Math.round(canvas.height * s));
      view.getContext("2d").drawImage(canvas, 0, 0, view.width, view.height);
    }

    function render() {
      if (!src || !mask) return;
      cut = cutOut(src, mask, $("bgrEdge").value);
      const out = compose(cut, { bg: bg(), trim: $("bgrTrim").checked });
      fit(out, $("bgrView"));
      const fmt = $("bgrFmt").value;
      const msg = !cut.box ? "No clear subject was found, so nothing is left. Try a photo with a clear person or object."
        : !bg() && fmt === "jpeg" ? "JPG can't be see-through, so it will be saved on white. Choose PNG or WebP to keep it see-through."
          : `${out.width}×${out.height} px${note}`;
      info(msg, !cut.box);
    }

    async function setFile(file) {
      const my = ++token;
      name = ImageKit.stem(file.name);
      const bmp = await ImageKit.decode(file);
      if (my !== token) return;
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      note = s < 1 ? `, scaled down from ${bmp.width}×${bmp.height}` : "";
      src = ImageKit.draw(bmp, bmp.width * s, bmp.height * s);
      mask = cut = null;
      $("bgrWrap").hidden = false;
      fit(src, $("bgrView"));
      fit(src, $("bgrBefore"));
      info("");
      busy("Finding the subject…");
      onProgress = (p) => {
        if (my !== token) return;
        if (p.preparing) busy("Getting the background remover ready…");
        else busy(`Downloading the background remover, only the first time… ${Math.round(p.received / 1048576)} of ${Math.round(p.total / 1048576)} MB`, p.received / p.total);
      };
      try {
        const m = await maskFor(src);
        if (my !== token) return;
        mask = m;
        busy("");
        render();
      } catch (e) {
        if (my !== token) return;
        busy("");
        info(e.message || "Couldn't remove the background.", true);
        throw e;
      }
    }

    root.addEventListener("change", (e) => {
      if (e.target.name === "bgrBg") $("bgrColours").hidden = e.target.value !== "colour";
      render();
    });
    $("bgrPick").addEventListener("input", () => {
      root.querySelectorAll(".bgr-sw").forEach((b) => b.setAttribute("aria-pressed", "false"));
      render();
    });
    root.querySelectorAll(".bgr-sw").forEach((b) => b.addEventListener("click", () => {
      $("bgrPick").value = b.dataset.c;
      root.querySelectorAll(".bgr-sw").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    }));
    const stage = $("bgrStage"), cmp = $("bgrCompare");
    const show = (on) => stage.classList.toggle("show-before", on);
    cmp.addEventListener("pointerdown", () => show(true));
    ["pointerup", "pointerleave", "pointercancel", "blur"].forEach((ev) => cmp.addEventListener(ev, () => show(false)));
    cmp.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") show(true); });
    cmp.addEventListener("keyup", () => show(false));

    async function result() {
      if (!src) throw UserError("Add a photo first.");
      if (!mask) throw UserError("Still working on this photo. Wait a moment and try again.");
      const out = compose(cut || cutOut(src, mask, $("bgrEdge").value), { bg: bg(), trim: $("bgrTrim").checked });
      const fmt = $("bgrFmt").value;
      const f = ImageKit.FORMATS[fmt];
      const bytes = await ImageKit.encode(out, fmt, 0.92);
      const filename = `${name}_no_background.${f.ext}`;
      return { bytes, filename, mime: f.mime,
        message: `Done! ${out.width}×${out.height} px, ${ImageKit.kb(bytes.length)}. Downloaded ${filename}. Nothing was uploaded.` };
    }

    return {
      setFile, result,
      destroy: () => { token++; onProgress = null; stop(); },
    };
  }

  return { configHtml, create, EDGES };
})();

TOOLS.push({
  id: "remove-bg",
  slug: "remove-background",
  aliases: ["background-remover", "remove-bg", "transparent-background", "passport-photo-background"],
  name: "Background Remover",
  desc: "Remove the background from a photo in one tap. Save it see-through, on white, or on any colour for passport and exam photos.",
  keywords: "remove background remove bg background remover erase background transparent png cut out photo cutout white background blue background passport photo background change background colour color product photo",
  category: "image",
  badge: "New",
  accept: "image/*,.heic,.heif",
  acceptLabel: "a photo",
  wide: true,
  actionLabel: "Save picture",
  caption: "Cut out in one tap",
  configHtml: BgRemove.configHtml,
  onOpen: (ctx) => { ctx.bgr = BgRemove.create(ctx.el("bgrRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.bgr.setFile(ctx.files[0]).catch(() => {}),
  onClose: (ctx) => ctx.bgr && ctx.bgr.destroy(),
  run: (ctx) => ctx.bgr.result(),
});
