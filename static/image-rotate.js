// Rotate & Flip Image: turn photos 90°/180° or mirror them, many at once, in the browser.
// Phone photos are first turned the way the camera meant (EXIF), so "right" means right as you see it.

const ImageRotate = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);

  const configHtml = `<div id="irRoot"></div>`;

  const ic = (d, extra = "") => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICONS = {
    left: ic('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>'),
    right: ic('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
    h: ic('<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7z"/><path d="M16 7l5 5-5 5V7z"/>'),
    v: ic('<path d="M3 12h18"/><path d="M7 8l5-5 5 5H7z"/><path d="M7 16l5 5 5-5H7z"/>'),
  };

  function create(root) {
    root.innerHTML = `
      <div class="ir">
        <div class="ir-preview" id="irPreview"><p class="ir-empty">Add photos to see them turn here.</p><canvas id="irCanvas" hidden></canvas></div>
        <div class="ir-buttons">
          <button type="button" class="btn btn-secondary" data-op="left">${ICONS.left} Turn left</button>
          <button type="button" class="btn btn-secondary" data-op="right">${ICONS.right} Turn right</button>
          <button type="button" class="btn btn-secondary" data-op="h">${ICONS.h} Mirror</button>
          <button type="button" class="btn btn-secondary" data-op="v">${ICONS.v} Flip upside down</button>
        </div>
        <p class="drop-hint" id="irState">No change yet. Press the buttons as many times as you like.</p>
        <div class="form-group"><label class="form-label" for="irFmt">Save as</label>
          <select id="irFmt" class="form-select"><option value="same" selected>Same format as the photo</option><option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option></select></div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    // Turn (0, 90, 180, 270 clockwise) and mirror, applied as: mirror first, then turn.
    let turn = 0, mirror = false;
    let first = null, token = 0;

    function describe() {
      const parts = [];
      if (turn) parts.push(turn === 180 ? "turned 180°" : `turned ${turn === 90 ? "right" : "left"} 90°`);
      if (mirror) parts.push("mirrored");
      $("irState").textContent = parts.length ? `Each photo will be ${parts.join(" and ")}.` : "No change yet. Press the buttons as many times as you like.";
    }
    function preview() {
      describe();
      if (!first) return;
      const c = $("irCanvas");
      const k = Math.min(1, 320 / Math.max(first.width, first.height));
      const out = render(first, k);
      c.width = out.width; c.height = out.height;
      c.getContext("2d").drawImage(out, 0, 0);
    }
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-op]");
      if (!b) return;
      const op = b.dataset.op;
      if (op === "right") turn = (turn + 90) % 360;
      else if (op === "left") turn = (turn + 270) % 360;
      else if (op === "h") { mirror = !mirror; turn = (360 - turn) % 360; }
      else if (op === "v") { mirror = !mirror; turn = (540 - turn) % 360; }
      preview();
    });

    /** Draws src mirrored (if set) then turned, scaled by k. */
    function render(src, k = 1) {
      const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
      const side = turn === 90 || turn === 270;
      const c = document.createElement("canvas");
      c.width = side ? h : w; c.height = side ? w : h;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.translate(c.width / 2, c.height / 2);
      g.rotate((turn * Math.PI) / 180);
      if (mirror) g.scale(-1, 1);
      g.drawImage(src, -w / 2, -h / 2, w, h);
      return c;
    }

    async function setFiles(files) {
      const my = ++token;
      try {
        const bmp = await ImageKit.decode(files[0]);
        if (my !== token) return;
        first = bmp;
        $("irCanvas").hidden = false;
        root.querySelector(".ir-empty").hidden = true;
        preview();
      } catch (e) { /* the run reports unreadable files */ }
    }

    async function run(ctx) {
      const files = ctx.files;
      if (!turn && !mirror) throw UserError("Choose a turn or a flip first with the buttons above.");
      const pick = $("irFmt").value;
      const tag = turn && mirror ? "rotated_flipped" : turn ? "rotated" : "flipped";
      const made = [];
      for (let i = 0; i < files.length; i++) {
        ctx.progress(i / files.length, `Turning photo ${i + 1} of ${files.length}…`);
        const file = files[i];
        const src = await ImageKit.decode(file);
        const t = (file.type || "").split("/")[1] || "";
        const ext = (/\.(\w+)$/.exec(file.name) || [])[1] || "";
        let fmt = pick;
        if (fmt === "same") fmt = /jpe?g/i.test(t + ext) ? "jpeg" : /webp/i.test(t + ext) ? "webp" : /heic|heif/i.test(t + ext) ? "jpeg" : "png";
        const bytes = await ImageKit.encode(render(src), fmt, 0.95);
        if (src.close) src.close();
        made.push({ filename: `${ImageKit.stem(file.name)}_${tag}.${ImageKit.FORMATS[fmt].ext}`, bytes, mime: ImageKit.FORMATS[fmt].mime });
      }
      if (made.length === 1) {
        return { ...made[0], message: `Done! Saved ${made[0].filename}. Nothing was uploaded.` };
      }
      const names = new Set();
      made.forEach((m) => { let n = m.filename, k = 2; while (names.has(n)) n = m.filename.replace(/(\.\w+)$/, `_${k++}$1`); names.add(n); m.filename = n; });
      const zipped = await ImageKit.zipOf(made, `photos_${tag}.zip`);
      return { ...zipped, message: `Done! ${made.length} photos ${tag.replace("_", " and ")}, saved in one ZIP. Nothing was uploaded.` };
    }

    return { setFiles, run, destroy() { token++; first = null; } };
  }

  return { configHtml, create };
})();

TOOLS.push({
  id: "rotate-image",
  slug: "rotate-image",
  aliases: ["flip-image", "mirror-image", "rotate-photo", "flip-photo", "rotate-jpg", "mirror-photo", "turn-image"],
  name: "Rotate & Flip Image",
  desc: "Turn photos left, right or upside down, or mirror them, many at once. Saves in the same format.",
  keywords: "rotate image flip image mirror image rotate photo flip photo 90 degrees sideways photo upside down mirror selfie rotate jpg png turn picture",
  category: "image",
  badge: "New",
  accept: "image/*,.heic,.heif",
  acceptLabel: "photos",
  multipleFiles: true,
  actionLabel: "Save photos",
  caption: "Sideways to straight",
  configHtml: ImageRotate.configHtml,
  onOpen: (ctx) => { ctx.ir = ImageRotate.create(ctx.el("irRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.ir.setFiles(ctx.files),
  onClose: (ctx) => ctx.ir && ctx.ir.destroy(),
  run: (ctx) => ctx.ir.run(ctx),
});
