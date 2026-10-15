// Background Remover: cuts the person or object out of a photo and saves it see-through (PNG),
// on white, or on any colour (handy for passport and exam photos).
// Two models (U²-Net "silueta" and ISNet) find the subject. By default they run on our server
// (/api/remove-background, nothing to download; the photo is not stored), which sends back only
// the mask. Visitors who want the photo to stay on their device can run the same models in a
// worker instead: ONNX Runtime Web and the models (90 MB) then download once from
// /static/vendor/bg-remove/. Edges, colours and trimming always happen in the browser.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/bg-remove.css?v=27" }));

const BgRemove = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const SMALL = 320, BIG = 1024; // what the two models look at
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
      worker = new Worker("/static/bg-remove-worker.js?v=27", { type: "module" });
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

  const pixels = (src, size) => ImageKit.draw(src, size, size).getContext("2d").getImageData(0, 0, size, size).data;

  /** Drops loose specks: keeps only solid areas at least 4% the size of the biggest one.
      m: size×size values 0..255, changed in place. */
  function dropSpecks(m, size) {
    const n = size * size, label = new Int32Array(n), areas = [0], stack = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (m[i] < 128 || label[i]) continue;
      const id = areas.length;
      let top = 0, area = 0;
      stack[top++] = i; label[i] = id;
      while (top) {
        const p = stack[--top]; area++;
        const x = p % size, y = (p - x) / size;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const q = ny * size + nx;
          if (!label[q] && m[q] >= 128) { label[q] = id; stack[top++] = q; }
        }
      }
      areas.push(area);
    }
    const big = areas.reduce((a, b) => Math.max(a, b), 0);
    if (!big) return m;
    const keep = areas.map((a) => a >= big * 0.04);
    // Pixels next to a kept area keep their soft edge; everything else that is loose goes.
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (label[i] && keep[label[i]]) near[i] = 1;
    for (let pass = 0; pass < 3; pass++) {
      const prev = near.slice();
      for (let i = 0; i < n; i++) {
        if (prev[i]) continue;
        const x = i % size;
        if ((x > 0 && prev[i - 1]) || (x < size - 1 && prev[i + 1]) || (i >= size && prev[i - size]) || (i < n - size && prev[i + size])) near[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) if (!near[i]) m[i] = 0;
    return m;
  }

  /** Asks the server for the mask: sends a copy of the photo at most 1600 px wide or tall. */
  async function serverMask(src) {
    const s = Math.min(1, 1600 / Math.max(src.width, src.height));
    const jpg = await ImageKit.encode(ImageKit.draw(src, src.width * s, src.height * s, { background: "#ffffff" }), "jpeg", 0.92);
    const form = new FormData();
    form.append("file", new Blob([jpg], { type: "image/jpeg" }), "photo.jpg");
    let res;
    try {
      res = await fetch("/api/remove-background", { method: "POST", body: form });
    } catch (e) {
      throw UserError("Couldn't reach the server. Check your connection, or choose \"On this device\".");
    }
    if (!res.ok) {
      let detail = `The server couldn't do this right now (${res.status}).`;
      try { const j = await res.json(); if (typeof j.detail === "string") detail = j.detail; } catch (e) { /* not json */ }
      throw UserError(detail);
    }
    const bmp = await createImageBitmap(await res.blob());
    const c = ImageKit.draw(bmp, bmp.width, bmp.height);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const m = new Uint8Array(c.width * c.height);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
    return { m, size: c.width };
  }

  /** The cut-out mask for a picture, as a canvas the picture's size whose alpha is the mask. */
  async function maskFor(src, onDevice = false) {
    let m, size;
    if (onDevice) {
      const small = pixels(src, SMALL), big = pixels(src, BIG);
      const r = await ask({ type: "mask", rgba: small.buffer, big: big.buffer }, [small.buffer, big.buffer]);
      m = new Uint8Array(r.mask); size = r.size;
    } else {
      ({ m, size } = await serverMask(src));
      dropSpecks(m, size);
    }
    const img = new ImageData(size, size);
    for (let i = 0; i < m.length; i++) { const k = i * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = m[i]; }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").putImageData(img, 0, 0);
    return ImageKit.draw(c, src.width, src.height); // smooth resize to full size
  }

  /** Exam and ID photos often carry a plain strip with the name and date under (or over) the photo.
      It isn't background to the model, but it is to the visitor. Finds such a strip: plain colour
      edge to edge at the very bottom or top, ending at a straight line where the photo starts.
      Returns { top, bottom } in pixels of src (0 when there is none). */
  function captionStrips(src) {
    const w = Math.min(400, src.width), h = Math.max(1, Math.round((src.height * w) / src.width));
    const d = ImageKit.draw(src, w, h).getContext("2d").getImageData(0, 0, w, h).data;
    const px = (x, y) => (y * w + x) * 4;
    const near = (i, c, tol) => Math.abs(d[i] - c[0]) <= tol && Math.abs(d[i + 1] - c[1]) <= tol && Math.abs(d[i + 2] - c[2]) <= tol;
    const match = (y, c) => { let n = 0; for (let x = 0; x < w; x++) if (near(px(x, y), c, 36)) n++; return n / w; };
    function find(edge, step) {
      // The outermost two rows must be one plain colour.
      const c = [0, 0, 0];
      for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) c[k] += (d[px(x, edge) + k] + d[px(x, edge + step) + k]) / (2 * w);
      if (match(edge, c) < 0.9 || match(edge + step, c) < 0.9) return 0;
      let y = edge, sum = 0, rows = 0;
      while (y >= 0 && y < h && match(y, c) >= 0.3) { sum += match(y, c); rows++; y += step; }
      const inner = y, outer = y - step; // first photo row, last strip row
      if (rows < h * 0.03 || rows > h * 0.4 || sum / rows < 0.6) return 0;
      const p1 = inner + step;
      if (p1 < 0 || p1 >= h || match(inner, c) >= 0.5 || match(p1, c) >= 0.5) return 0;
      // A straight edge: most columns change sharply between the strip and the photo.
      let sharp = 0;
      for (let x = 0; x < w; x++) {
        const a = px(x, outer), b = px(x, inner);
        if (Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]) > 60) sharp++;
      }
      if (sharp / w < 0.6) return 0;
      return Math.min(src.height, Math.ceil(((rows + 1) * src.height) / h));
    }
    return { bottom: find(h - 1, -1), top: find(0, 1) };
  }

  /** Clears the mask over caption strips (mask is a canvas the picture's size). */
  function clearStrips(mask, strips) {
    const g = mask.getContext("2d");
    if (strips.bottom) g.clearRect(0, mask.height - strips.bottom, mask.width, strips.bottom);
    if (strips.top) g.clearRect(0, 0, mask.width, strips.top);
    return mask;
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
              <label class="form-label" for="bgrWhere">Run on</label>
              <select id="bgrWhere" class="form-select">
                <option value="server" selected>Our server (fast, nothing to download)</option>
                <option value="device">This device (photo never leaves it, 90 MB download once)</option>
              </select>
            </div>
            <label class="checkbox-group" id="bgrStripRow" hidden><input type="checkbox" id="bgrKeepStrip"> Keep the name &amp; date strip</label>
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
        <p class="drop-hint">Works best on photos of people, pets, products and cars. Photos sent to our server are processed in memory and never stored. Choose "This device" to keep the photo on your phone or computer.</p>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let src = null, mask = null, cut = null, name = "image", note = "", file = null, strips = { top: 0, bottom: 0 }, rawMask = null;
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

    function applyStrips() {
      const found = strips.top || strips.bottom;
      $("bgrStripRow").hidden = !found;
      mask = found && !$("bgrKeepStrip").checked ? clearStrips(ImageKit.draw(rawMask, rawMask.width, rawMask.height), strips) : rawMask;
    }
    function render() {
      if (!src || !mask) return;
      cut = cutOut(src, mask, $("bgrEdge").value);
      const out = compose(cut, { bg: bg(), trim: $("bgrTrim").checked });
      fit(out, $("bgrView"));
      const fmt = $("bgrFmt").value;
      const msg = !cut.box ? "No clear subject was found, so nothing is left. Try a photo with a clear person or object."
        : !bg() && fmt === "jpeg" ? "JPG can't be see-through, so it will be saved on white. Choose PNG or WebP to keep it see-through."
          : `${out.width}×${out.height} px${note}${(strips.top || strips.bottom) && !$("bgrKeepStrip").checked ? ". The name and date strip was removed too." : ""}`;
      info(msg, !cut.box);
    }

    async function setFile(f) {
      file = f;
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
        const m = await maskFor(src, $("bgrWhere").value === "device");
        if (my !== token) return;
        rawMask = m;
        strips = captionStrips(src);
        applyStrips();
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
      if (e.target.id === "bgrWhere") { if (file) setFile(file).catch(() => {}); return; }
      if (e.target.id === "bgrKeepStrip" && rawMask) applyStrips();
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

  return { configHtml, create, EDGES, _strips: captionStrips };
})();

TOOLS.push({
  id: "remove-bg",
  slug: "remove-background",
  aliases: ["background-remover", "remove-bg", "transparent-background", "passport-photo-background"],
  name: "Background Remover",
  desc: "Remove the background from a photo in one tap. Save it see-through, on white, or on any colour for passport and exam photos.",
  keywords: "remove background remove bg background remover erase background transparent png cut out photo cutout white background blue background passport photo background change background colour color product photo",
  category: "image",
  server: true, // runs on our server by default (the visitor can pick "This device")
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
