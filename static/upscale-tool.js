// Image Upscaler: makes a small or blurry photo 2× or 4× bigger and sharper with Real-ESRGAN,
// right in the browser (the 4.9 MB model is downloaded the first time). The picture is cut into
// overlapping tiles so big photos fit in memory and the progress bar moves. Nothing is uploaded.

const Upscaler = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const TILE = 128;        // input pixels per tile side
  const PAD = 12;          // overlap so tile edges don't show
  const MAX_AI_PIXELS = 2_000_000;   // bigger photos get the fast resize instead
  const MAX_OUT_SIDE = 12000;

  let worker = null, seq = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("/static/upscale-worker.js?v=26", { type: "module" });
    } catch (e) {
      throw UserError("This browser can't run the upscaler. Try a recent Chrome, Edge, Firefox or Safari.");
    }
    worker.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.type === "error") {
        job.reject(UserError(/download|fetch|load/i.test(e.data.message)
          ? "Couldn't download the upscaler. Check your connection and try again."
          : /memory|alloc/i.test(e.data.message) ? "This device ran out of memory. Try 2×, a smaller photo, or close other tabs." : "Couldn't upscale this picture. Try another photo."));
      } else job.resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      const err = UserError("The upscaler couldn't start. Check your connection and try again.");
      waiting.forEach((j) => j.reject(err));
      waiting.clear();
      stop();
    };
    return worker;
  }
  function ask(msg, transfer) {
    const w = getWorker(), id = ++seq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); w.postMessage({ id, ...msg }, transfer || []); });
  }
  function stop() {
    if (worker) worker.terminate();
    worker = null;
    waiting.forEach((j) => j.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })));
    waiting.clear();
  }

  /** 4× AI upscale of a canvas, tile by tile. onTile(done, total). */
  async function ai(src, { onTile, signal } = {}) {
    const w = src.width, h = src.height;
    const g = src.getContext("2d", { willReadFrequently: true });
    const out = document.createElement("canvas");
    out.width = w * 4; out.height = h * 4;
    const og = out.getContext("2d");
    const cols = Math.ceil(w / TILE), rows = Math.ceil(h / TILE);
    let done = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (signal && signal.aborted) { stop(); throw Object.assign(new Error("Cancelled"), { name: "AbortError" }); }
        const x0 = c * TILE, y0 = r * TILE;
        const x1 = Math.min(w, x0 + TILE), y1 = Math.min(h, y0 + TILE);
        const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD);
        const px1 = Math.min(w, x1 + PAD), py1 = Math.min(h, y1 + PAD);
        const tw = px1 - px0, th = py1 - py0;
        const rgba = g.getImageData(px0, py0, tw, th).data;
        const res = await ask({ type: "tile", rgba: rgba.buffer, w: tw, h: th }, [rgba.buffer]);
        const tile = new ImageData(new Uint8ClampedArray(res.rgba), tw * 4, th * 4);
        // Keep only the tile's own area, not the overlap.
        og.putImageData(tile, px0 * 4, py0 * 4, (x0 - px0) * 4, (y0 - py0) * 4, (x1 - x0) * 4, (y1 - y0) * 4);
        if (onTile) onTile(++done, rows * cols);
      }
    }
    return out;
  }

  /** Smooth resize plus a light sharpen, for photos too big for the AI on a phone. */
  function classic(src, scale) {
    const out = ImageKit.draw(src, src.width * scale, src.height * scale);
    const g = out.getContext("2d");
    const blur = document.createElement("canvas");
    blur.width = out.width; blur.height = out.height;
    const bg = blur.getContext("2d");
    bg.filter = `blur(${Math.max(1, scale * 0.6)}px)`;
    bg.drawImage(out, 0, 0);
    const a = g.getImageData(0, 0, out.width, out.height), b = bg.getImageData(0, 0, out.width, out.height);
    const k = 0.6;
    for (let i = 0; i < a.data.length; i += 4) {
      a.data[i] += (a.data[i] - b.data[i]) * k;
      a.data[i + 1] += (a.data[i + 1] - b.data[i + 1]) * k;
      a.data[i + 2] += (a.data[i + 2] - b.data[i + 2]) * k;
    }
    g.putImageData(a, 0, 0);
    return out;
  }

  /** Puts the original alpha channel (scaled smoothly) back onto an upscaled picture. */
  function keepAlpha(src, out) {
    const sg = src.getContext("2d", { willReadFrequently: true });
    const d = sg.getImageData(0, 0, src.width, src.height).data;
    let clear = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { clear = true; break; }
    if (!clear) return out;
    const mask = ImageKit.draw(src, out.width, out.height);
    const g = out.getContext("2d");
    g.globalCompositeOperation = "destination-in";
    g.drawImage(mask, 0, 0);
    g.globalCompositeOperation = "source-over";
    return out;
  }

  const configHtml = `<div id="upRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="up">
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label" for="upScale">Make it</label>
            <select id="upScale" class="form-select"><option value="2" selected>2× bigger</option><option value="4">4× bigger</option></select>
          </div>
          <div class="form-group">
            <label class="form-label" for="upFmt">Save as</label>
            <select id="upFmt" class="form-select"><option value="auto" selected>Same as the photo</option><option value="png">PNG</option><option value="jpeg">JPG</option><option value="webp">WebP</option></select>
          </div>
        </div>
        <p class="up-info" id="upInfo">Add a photo. Small, blurry or blocky pictures (old photos, WhatsApp images, screenshots) gain the most.</p>
        <div class="up-compare" id="upCompare" hidden>
          <div class="up-frame" id="upFrame">
            <canvas id="upAfter"></canvas>
            <canvas id="upBefore" class="up-before"></canvas>
            <span class="up-tag up-tag-l">Before</span><span class="up-tag up-tag-r">After</span>
            <span class="up-line" id="upLine"></span>
          </div>
          <input type="range" id="upSlide" min="0" max="100" value="50" aria-label="Slide to compare before and after">
        </div>
        <p class="drop-hint">Runs on your device. The first time, the tool downloads about 16 MB. A 1000×1000 photo takes around a minute on a phone.</p>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let src = null, name = "image", type = "image/jpeg", last = null;

    function info() {
      if (!src) return;
      const s = Number($("upScale").value);
      const big = src.width * src.height > MAX_AI_PIXELS;
      $("upInfo").textContent = `${src.width}×${src.height} px → ${src.width * s}×${src.height * s} px` +
        (big ? ". This photo is already large, so it gets a fast sharpened resize instead of the AI." : "");
    }
    async function setFile(file) {
      name = ImageKit.stem(file.name);
      type = file.type;
      const bmp = await ImageKit.decode(file);
      src = ImageKit.draw(bmp, bmp.width, bmp.height);
      last = null;
      $("upCompare").hidden = true;
      if (Math.max(src.width, src.height) * Number($("upScale").value) > MAX_OUT_SIDE) $("upScale").value = "2";
      info();
    }
    $("upScale").addEventListener("change", info);

    function showCompare(out) {
      const view = (c, el) => {
        const s = Math.min(1, 640 / out.width, 440 / out.height);
        el.width = Math.round(out.width * s); el.height = Math.round(out.height * s);
        const g = el.getContext("2d");
        g.imageSmoothingEnabled = c !== src;  // the "before" is shown as the blocky original really is
        g.drawImage(c, 0, 0, el.width, el.height);
      };
      view(out, $("upAfter"));
      view(src, $("upBefore"));
      $("upCompare").hidden = false;
      slide();
    }
    function slide() {
      const v = $("upSlide").value;
      $("upBefore").style.clipPath = `inset(0 ${100 - v}% 0 0)`;
      $("upLine").style.left = `${v}%`;
    }
    $("upSlide").addEventListener("input", slide);

    async function run(ctx) {
      if (!src) throw UserError("Add a photo first.");
      const scale = Number($("upScale").value);
      if (Math.max(src.width, src.height) * scale > MAX_OUT_SIDE) throw UserError(`That would be over ${MAX_OUT_SIDE} pixels wide. Choose 2×, or use a smaller photo.`);
      let out;
      if (src.width * src.height > MAX_AI_PIXELS) {
        ctx.progress(0.3, "Resizing and sharpening…");
        out = classic(src, scale);
      } else {
        ctx.progress(0.02, "Getting the upscaler ready (about 16 MB, only the first time)…");
        await ask({ type: "load" });
        out = await ai(src, {
          signal: ctx.signal,
          onTile: (d, n) => ctx.progress(0.05 + 0.85 * (d / n), `Sharpening… part ${d} of ${n}`),
        });
        if (scale === 2) out = ImageKit.draw(out, src.width * 2, src.height * 2);
      }
      out = keepAlpha(src, out);
      showCompare(out);
      let fmt = $("upFmt").value;
      if (fmt === "auto") fmt = /png|gif|bmp|svg/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpeg";
      ctx.progress(0.95, "Saving…");
      const bytes = await ImageKit.encode(out, fmt, 0.93);
      const f = ImageKit.FORMATS[fmt];
      const filename = `${name}_${scale}x.${f.ext}`;
      last = { bytes, filename, mime: f.mime,
        message: `Done! ${out.width}×${out.height} px, ${ImageKit.kb(bytes.length)}. Downloaded ${filename}. Nothing was uploaded.` };
      return last;
    }

    return { setFile, run, destroy: stop };
  }

  return { configHtml, create, ai, classic };
})();

TOOLS.push({
  id: "upscale-image",
  slug: "image-upscaler",
  aliases: ["upscale-image", "image-enhancer", "enhance-photo", "unblur-image", "increase-image-resolution", "ai-upscale"],
  name: "Image Upscaler",
  desc: "Make a small or blurry photo 2× or 4× bigger and sharper with on-device AI. Free, nothing is uploaded.",
  keywords: "image upscaler upscale image enhance photo image enhancer unblur image increase resolution ai upscale hd photo sharpen blurry photo improve quality 4k super resolution",
  category: "image",
  badge: "New",
  accept: "image/*,.heic,.heif",
  acceptLabel: "a photo",
  wide: true,
  actionLabel: "Upscale",
  caption: "Sharper, bigger photos",
  configHtml: Upscaler.configHtml,
  onOpen: (ctx) => { ctx.up = Upscaler.create(ctx.el("upRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.up.setFile(ctx.files[0]),
  onClose: (ctx) => ctx.up && ctx.up.destroy(),
  run: (ctx) => ctx.up.run(ctx),
});
