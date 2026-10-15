// Blur Faces & Text: finds faces in a photo by itself, and you drag boxes over anything else
// (number plates, names, phone numbers, addresses). Blur, pixelate or black out, then save.
// Runs in the browser; faces are found with a 1.6 MB model the first time it's used.

const BlurTool = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const MAX_SIDE = 6000;

  let worker = null, seq = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker("/static/face-worker.js?v=27", { type: "module" });
    worker.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.type === "error") job.reject(new Error(e.data.message)); else job.resolve(e.data.faces);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      waiting.forEach((j) => j.reject(new Error("worker failed")));
      waiting.clear();
      stop();
    };
    return worker;
  }
  function stop() { if (worker) worker.terminate(); worker = null; }
  function detect(canvas, sx, sy, sw, sh) {
    const c = ImageKit.draw(canvas, 640, 480, { sx, sy, sw, sh });
    const rgba = c.getContext("2d").getImageData(0, 0, 640, 480).data;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      getWorker().postMessage({ id, rgba: rgba.buffer, threshold: 0.72 }, [rgba.buffer]);
    }).then((faces) => faces.map((f) => ({
      score: f.score,
      // back to fractions of the whole picture
      box: [(sx + f.box[0] * sw) / canvas.width, (sy + f.box[1] * sh) / canvas.height, (sx + f.box[2] * sw) / canvas.width, (sy + f.box[3] * sh) / canvas.height],
    })));
  }
  const overlap = (a, b) => {
    const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    return inter / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]) || 1);
  };

  /** Faces as boxes in picture fractions. Big photos are also searched in four overlapping parts, for small faces. */
  async function findFaces(src) {
    const all = await detect(src, 0, 0, src.width, src.height);
    if (Math.max(src.width, src.height) > 1400) {
      const w = src.width * 0.6, h = src.height * 0.6;
      for (const [x, y] of [[0, 0], [src.width - w, 0], [0, src.height - h], [src.width - w, src.height - h]]) all.push(...(await detect(src, x, y, w, h)));
    }
    all.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const f of all) if (keep.every((k) => overlap(k.box, f.box) < 0.4)) keep.push(f);
    // A little bigger than the detector's box, so hair line and chin are covered.
    return keep.map(({ box: [x0, y0, x1, y1] }) => {
      const w = x1 - x0, h = y1 - y0;
      return { x0: Math.max(0, x0 - w * 0.12), y0: Math.max(0, y0 - h * 0.18), x1: Math.min(1, x1 + w * 0.12), y1: Math.min(1, y1 + h * 0.1), face: true };
    });
  }

  /** Draws the picture with every box hidden in the chosen style. */
  function render(src, boxes, { style, strength }) {
    const out = ImageKit.draw(src, src.width, src.height);
    const g = out.getContext("2d");
    const base = Math.max(src.width, src.height);
    for (const b of boxes) {
      const x = b.x0 * src.width, y = b.y0 * src.height, w = (b.x1 - b.x0) * src.width, h = (b.y1 - b.y0) * src.height;
      if (w < 1 || h < 1) continue;
      g.save();
      g.beginPath();
      if (b.face && style !== "black") g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else g.rect(x, y, w, h);
      g.clip();
      if (style === "black") {
        g.fillStyle = "#000";
        g.fillRect(x, y, w, h);
      } else if (style === "pixel") {
        const cell = Math.max(4, Math.round(Math.min(w, h) / (4 + (1 - strength) * 14)));
        const tw = Math.max(1, Math.round(w / cell)), th = Math.max(1, Math.round(h / cell));
        const t = ImageKit.draw(src, tw, th, { sx: x, sy: y, sw: w, sh: h });
        g.imageSmoothingEnabled = false;
        g.drawImage(t, 0, 0, tw, th, x, y, w, h);
      } else {
        const r = Math.max(4, Math.round(Math.max(Math.min(w, h) * (0.12 + 0.3 * strength), base * 0.004)));
        // Blur a copy that's larger than the box, so the edges don't fade to see-through.
        const pad = r * 3;
        const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
        const sw = Math.min(src.width, x + w + pad) - sx, sh = Math.min(src.height, y + h + pad) - sy;
        const t = document.createElement("canvas");
        t.width = Math.ceil(sw); t.height = Math.ceil(sh);
        const tg = t.getContext("2d");
        tg.filter = `blur(${r}px)`;
        // Two passes: a strong blur can still show outlines after one.
        tg.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
        const t2 = document.createElement("canvas");
        t2.width = t.width; t2.height = t.height;
        const t2g = t2.getContext("2d");
        t2g.filter = `blur(${r}px)`;
        t2g.drawImage(t, 0, 0);
        g.drawImage(t2, sx, sy);
      }
      g.restore();
    }
    return out;
  }

  const configHtml = `<div id="blRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="bl">
        <div class="bl-bar">
          <div class="bl-styles" role="radiogroup" aria-label="How to hide">
            <label class="bgr-bg"><input type="radio" name="blStyle" value="blur" checked><span>Blur</span></label>
            <label class="bgr-bg"><input type="radio" name="blStyle" value="pixel"><span>Pixelate</span></label>
            <label class="bgr-bg"><input type="radio" name="blStyle" value="black"><span>Black box</span></label>
          </div>
          <label class="bl-strength">Strength <input type="range" id="blStrength" min="0" max="100" value="60"></label>
        </div>
        <div class="bl-stage-wrap" id="blWrap" hidden>
          <div class="bl-stage" id="blStage"><canvas id="blView"></canvas><div class="bl-boxes" id="blBoxes"></div>
            <div class="bgr-busy" id="blBusy" hidden><span class="bgr-spin" aria-hidden="true"></span><span>Looking for faces…</span></div>
          </div>
          <div class="sign-row">
            <button type="button" class="btn btn-xs" id="blFind">Find faces again</button>
            <button type="button" class="btn btn-xs" id="blClear">Remove all boxes</button>
            <span class="bgr-info" id="blInfo"></span>
          </div>
          <p class="drop-hint">Drag on the picture to hide anything else, like a number plate, name or phone number. Drag a box to move it, its corner to resize it, or tap its × to remove it.</p>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let src = null, boxes = [], name = "image", type = "image/jpeg", token = 0;
    const opts = () => ({ style: root.querySelector('input[name="blStyle"]:checked').value, strength: Number($("blStrength").value) / 100 });

    function draw() {
      if (!src) return;
      const v = $("blView");
      const s = Math.min(1, 900 / src.width, 560 / src.height);
      const small = ImageKit.draw(src, src.width * s, src.height * s);
      const scaled = boxes.map((b) => ({ ...b }));
      const out = render(small, scaled, opts());
      v.width = out.width; v.height = out.height;
      v.getContext("2d").drawImage(out, 0, 0);
      $("blBoxes").innerHTML = boxes.map((b, i) => `
        <div class="bl-box${b.face ? " face" : ""}" data-i="${i}" style="left:${b.x0 * 100}%;top:${b.y0 * 100}%;width:${(b.x1 - b.x0) * 100}%;height:${(b.y1 - b.y0) * 100}%">
          <button type="button" class="bl-x" data-x="${i}" aria-label="Remove this box">×</button><span class="bl-h" data-h="${i}"></span>
        </div>`).join("");
      const faces = boxes.filter((b) => b.face).length;
      $("blInfo").textContent = `${faces} face${faces === 1 ? "" : "s"} found${boxes.length > faces ? `, ${boxes.length - faces} box${boxes.length - faces === 1 ? "" : "es"} added` : ""}`;
    }

    async function find() {
      const my = ++token;
      $("blBusy").hidden = false;
      try {
        const faces = await findFaces(src);
        if (my !== token) return;
        boxes = boxes.filter((b) => !b.face).concat(faces);
        if (!faces.length) showToast("No faces found. Drag on the picture to cover what you want hidden.", "info");
      } catch (e) {
        if (my !== token) return;
        console.warn(e);
        showToast("Couldn't look for faces in this browser. You can still drag boxes over them.", "error");
      } finally {
        if (my === token) { $("blBusy").hidden = true; draw(); }
      }
    }

    async function setFile(file) {
      name = ImageKit.stem(file.name);
      type = file.type;
      const bmp = await ImageKit.decode(file);
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      src = ImageKit.draw(bmp, bmp.width * s, bmp.height * s);
      boxes = [];
      $("blWrap").hidden = false;
      draw();
      await find();
    }

    // Drag to add, move or resize boxes.
    const stage = $("blStage");
    let drag = null;
    const frac = (e) => {
      const r = $("blView").getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    stage.addEventListener("pointerdown", (e) => {
      if (!src) return;
      if (e.target.dataset.x !== undefined) { boxes.splice(Number(e.target.dataset.x), 1); draw(); return; }
      const [fx, fy] = frac(e);
      if (e.target.dataset.h !== undefined) drag = { mode: "size", i: Number(e.target.dataset.h) };
      else if (e.target.closest(".bl-box")) {
        const i = Number(e.target.closest(".bl-box").dataset.i);
        drag = { mode: "move", i, fx, fy, start: { ...boxes[i] } };
      } else {
        boxes.push({ x0: fx, y0: fy, x1: fx, y1: fy, face: false });
        drag = { mode: "new", i: boxes.length - 1, fx, fy };
      }
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const [fx, fy] = frac(e);
      const b = boxes[drag.i];
      if (drag.mode === "new") Object.assign(b, { x0: Math.min(fx, drag.fx), y0: Math.min(fy, drag.fy), x1: Math.max(fx, drag.fx), y1: Math.max(fy, drag.fy) });
      else if (drag.mode === "size") Object.assign(b, { x1: Math.max(b.x0 + 0.01, fx), y1: Math.max(b.y0 + 0.01, fy) });
      else {
        const s = drag.start, w = s.x1 - s.x0, h = s.y1 - s.y0;
        const x0 = Math.min(Math.max(0, s.x0 + fx - drag.fx), 1 - w), y0 = Math.min(Math.max(0, s.y0 + fy - drag.fy), 1 - h);
        Object.assign(b, { x0, y0, x1: x0 + w, y1: y0 + h });
      }
      draw();
    });
    const end = () => {
      if (drag && drag.mode === "new") {
        const b = boxes[drag.i];
        if (b.x1 - b.x0 < 0.01 || b.y1 - b.y0 < 0.01) boxes.splice(drag.i, 1);
      }
      drag = null;
      draw();
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    $("blFind").addEventListener("click", () => src && find());
    $("blClear").addEventListener("click", () => { boxes = []; draw(); });
    root.addEventListener("change", draw);
    $("blStrength").addEventListener("input", draw);

    async function run() {
      if (!src) throw UserError("Add a photo first.");
      if (!boxes.length) throw UserError("Nothing is covered yet. Drag on the picture over what you want hidden.");
      const out = render(src, boxes, opts());
      const fmt = /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpeg";
      const bytes = await ImageKit.encode(out, fmt, 0.92);
      const f = ImageKit.FORMATS[fmt];
      const filename = `${name}_blurred.${f.ext}`;
      return { bytes, filename, mime: f.mime, message: `Done! Hid ${boxes.length} area${boxes.length === 1 ? "" : "s"}. Downloaded ${filename}. Nothing was uploaded.` };
    }

    return { setFile, run, destroy: () => { token++; stop(); } };
  }

  return { configHtml, create, render, findFaces };
})();

TOOLS.push({
  id: "blur-image",
  slug: "blur-face",
  aliases: ["blur-faces", "blur-image", "pixelate-image", "blur-number-plate", "censor-photo", "blur-text-in-image"],
  name: "Blur Faces & Text",
  desc: "Hide faces, number plates, names and phone numbers in a photo. Faces are found for you; blur, pixelate or black out.",
  keywords: "blur face blur faces in photo pixelate face blur image blur number plate hide face censor photo redact image blur text in image black out privacy anonymize",
  category: "security",
  badge: "Privacy",
  accept: "image/*,.heic,.heif",
  acceptLabel: "a photo",
  wide: true,
  actionLabel: "Save picture",
  caption: "Hide faces and plates",
  configHtml: BlurTool.configHtml,
  onOpen: (ctx) => { ctx.bl = BlurTool.create(ctx.el("blRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.bl.setFile(ctx.files[0]),
  onClose: (ctx) => ctx.bl && ctx.bl.destroy(),
  run: (ctx) => ctx.bl.run(ctx),
});
