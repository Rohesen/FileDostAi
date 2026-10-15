// Watermark Images: puts your name, website or logo on photos, in a corner or tiled across,
// for many photos at once. Runs in the browser; nothing is uploaded.

const WatermarkImage = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const POS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

  /** Draws the watermark on a copy of src. o: { kind, text, logo, color, opacity, size, angle, pos } */
  function stamp(src, o) {
    const out = ImageKit.draw(src, src.width, src.height);
    const g = out.getContext("2d");
    const W = out.width, H = out.height, base = Math.min(W, H);
    let mark;
    if (o.kind === "logo") {
      if (!o.logo) return out;
      const w = Math.max(8, W * (o.size / 100) * 1.6);
      mark = ImageKit.draw(o.logo, w, (w * o.logo.height) / o.logo.width);
    } else {
      const text = (o.text || "").trim();
      if (!text) return out;
      const fs = Math.max(10, base * (o.size / 100) * 0.55);
      mark = document.createElement("canvas");
      const mg = mark.getContext("2d");
      const font = `700 ${fs}px Geist, "Segoe UI", Arial, sans-serif`;
      mg.font = font;
      mark.width = Math.ceil(mg.measureText(text).width + fs * 0.4);
      mark.height = Math.ceil(fs * 1.4);
      mg.font = font;
      mg.textBaseline = "middle";
      // A soft outline keeps the text readable on light and dark parts of the photo.
      mg.lineWidth = Math.max(1, fs / 14);
      mg.strokeStyle = luminance(o.color) > 0.5 ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.45)";
      mg.strokeText(text, fs * 0.2, mark.height / 2);
      mg.fillStyle = o.color;
      mg.fillText(text, fs * 0.2, mark.height / 2);
    }
    g.globalAlpha = o.opacity;
    const rad = (o.angle * Math.PI) / 180;
    const put = (cx, cy) => { g.save(); g.translate(cx, cy); g.rotate(rad); g.drawImage(mark, -mark.width / 2, -mark.height / 2); g.restore(); };
    if (o.pos === "tile") {
      const stepX = mark.width * 1.6 + base * 0.06, stepY = mark.height * 3 + base * 0.06;
      for (let y = -stepY, row = 0; y < H + stepY; y += stepY, row++) {
        for (let x = (row % 2 ? stepX / 2 : 0) - stepX; x < W + stepX; x += stepX) put(x, y);
      }
    } else {
      const m = base * 0.035;
      const bw = Math.abs(mark.width * Math.cos(rad)) + Math.abs(mark.height * Math.sin(rad));
      const bh = Math.abs(mark.width * Math.sin(rad)) + Math.abs(mark.height * Math.cos(rad));
      const [v, h] = o.pos;
      const cx = h === "l" ? m + bw / 2 : h === "r" ? W - m - bw / 2 : W / 2;
      const cy = v === "t" ? m + bh / 2 : v === "b" ? H - m - bh / 2 : H / 2;
      put(cx, cy);
    }
    g.globalAlpha = 1;
    return out;
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const configHtml = `<div id="wiRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="wi">
        <div class="bgr-bgs" role="radiogroup" aria-label="Watermark type">
          <label class="bgr-bg"><input type="radio" name="wiKind" value="text" checked><span>Text</span></label>
          <label class="bgr-bg"><input type="radio" name="wiKind" value="logo"><span>Logo</span></label>
        </div>
        <div class="form-group" id="wiTextRow"><input type="text" id="wiText" class="form-input" maxlength="80" value="© ${new Date().getFullYear()} Your Name" aria-label="Watermark text"></div>
        <div class="form-group" id="wiLogoRow" hidden>
          <input type="file" id="wiLogo" accept="image/png,image/webp,image/jpeg,image/svg+xml" class="form-input">
          <p class="drop-hint">A PNG with a see-through background looks best.</p>
        </div>
        <div class="wi-grid">
          <div class="form-group">
            <span class="form-label">Position</span>
            <div class="wi-pos" role="radiogroup" aria-label="Position">
              ${POS.map((p) => `<label><input type="radio" name="wiPos" value="${p}" ${p === "br" ? "checked" : ""}><span aria-label="${p}"></span></label>`).join("")}
            </div>
            <label class="checkbox-group"><input type="checkbox" id="wiTile"> Repeat across the whole photo</label>
          </div>
          <div class="wi-sliders">
            <label class="form-label" for="wiSize">Size</label><input type="range" id="wiSize" min="2" max="40" value="10">
            <label class="form-label" for="wiOpacity">See-through</label><input type="range" id="wiOpacity" min="10" max="100" value="60">
            <label class="form-label" for="wiAngle">Angle</label><input type="range" id="wiAngle" min="-90" max="90" value="0">
            <label class="form-label" for="wiColor">Colour</label><input type="color" id="wiColor" class="bgr-pick" value="#ffffff">
          </div>
        </div>
        <div class="wi-preview" id="wiPreview" hidden><canvas id="wiView"></canvas><p class="bgr-info" id="wiInfo"></p></div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let files = [], first = null, logo = null, timer = null;

    function opts() {
      const kind = root.querySelector('input[name="wiKind"]:checked').value;
      return {
        kind, text: $("wiText").value, logo, color: $("wiColor").value,
        opacity: Number($("wiOpacity").value) / 100, size: Number($("wiSize").value), angle: Number($("wiAngle").value),
        pos: $("wiTile").checked ? "tile" : root.querySelector('input[name="wiPos"]:checked').value,
      };
    }
    function preview() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!first) return;
        const s = Math.min(1, 760 / first.width, 480 / first.height);
        const small = ImageKit.draw(first, first.width * s, first.height * s);
        const out = stamp(small, opts());
        const v = $("wiView");
        v.width = out.width; v.height = out.height;
        v.getContext("2d").drawImage(out, 0, 0);
        $("wiInfo").textContent = files.length > 1 ? `Preview of the first photo. All ${files.length} get the same watermark.` : "";
      }, 60);
    }
    root.addEventListener("input", preview);
    root.addEventListener("change", (e) => {
      if (e.target.name === "wiKind") {
        const logoKind = e.target.value === "logo";
        $("wiTextRow").hidden = logoKind; $("wiLogoRow").hidden = !logoKind;
        if (logoKind && $("wiSize").value === "10") $("wiSize").value = "18";
      }
      if (e.target.id === "wiTile") {
        if (e.target.checked && $("wiAngle").value === "0") $("wiAngle").value = "-30";
        if (e.target.checked && Number($("wiOpacity").value) > 40) $("wiOpacity").value = "30";
      }
      preview();
    });
    $("wiLogo").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { const b = await ImageKit.decode(f); logo = ImageKit.draw(b, b.width, b.height); } catch (err) { showToast(err.message, "error"); }
      preview();
    });

    async function setFiles(list) {
      files = list;
      const b = await ImageKit.decode(list[0]);
      first = ImageKit.draw(b, b.width, b.height);
      $("wiPreview").hidden = false;
      preview();
    }

    async function run(ctx) {
      if (!files.length) throw UserError("Add photos first.");
      const o = opts();
      if (o.kind === "text" && !o.text.trim()) throw UserError("Type the watermark text.");
      if (o.kind === "logo" && !o.logo) throw UserError("Choose your logo picture.");
      const made = [];
      for (let i = 0; i < files.length; i++) {
        ctx.progress(i / files.length, `Watermarking ${i + 1} of ${files.length}…`);
        const f = files[i];
        const b = await ImageKit.decode(f);
        const out = stamp(ImageKit.draw(b, b.width, b.height), o);
        const fmt = /png/.test(f.type) ? "png" : /webp/.test(f.type) ? "webp" : "jpeg";
        made.push({ filename: `${ImageKit.stem(f.name)}_watermarked.${ImageKit.FORMATS[fmt].ext}`, bytes: await ImageKit.encode(out, fmt, 0.92), mime: ImageKit.FORMATS[fmt].mime });
      }
      const r = await ImageKit.zipOf(made, "watermarked_photos.zip");
      return { ...r, message: `Done! Watermarked ${made.length} photo${made.length === 1 ? "" : "s"}. Downloaded ${r.filename}. Nothing was uploaded.` };
    }
    return { setFiles, run, destroy: () => clearTimeout(timer) };
  }

  return { configHtml, create, stamp };
})();

TOOLS.push({
  id: "watermark-image",
  slug: "watermark-image",
  aliases: ["add-watermark-to-photo", "image-watermark", "photo-watermark", "add-logo-to-photo"],
  name: "Watermark Images",
  desc: "Put your name, website or logo on photos, in a corner or repeated across. Many photos at once.",
  keywords: "add watermark to photo image watermark photo watermark add logo to image watermark maker copyright text on photo protect photos batch watermark",
  category: "image",
  badge: "New",
  accept: "image/*,.heic,.heif",
  acceptLabel: "photos",
  multipleFiles: true,
  wide: true,
  actionLabel: "Watermark & save",
  caption: "Your name on every photo",
  configHtml: WatermarkImage.configHtml,
  onOpen: (ctx) => { ctx.wi = WatermarkImage.create(ctx.el("wiRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.wi.setFiles(ctx.files),
  onClose: (ctx) => ctx.wi && ctx.wi.destroy(),
  run: (ctx) => ctx.wi.run(ctx),
});
