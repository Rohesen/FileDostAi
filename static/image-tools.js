// Image tools that run in the browser: convert between formats, hit an exact file size,
// set DPI, and compress any file. Nothing here uploads anything except PDFs sent to the
// server's PDF compressor.

const ImageKit = (() => {
  const FORMATS = {
    jpeg: { mime: "image/jpeg", ext: "jpg", label: "JPG", lossy: true },
    png: { mime: "image/png", ext: "png", label: "PNG" },
    webp: { mime: "image/webp", ext: "webp", label: "WebP", lossy: true },
    avif: { mime: "image/avif", ext: "avif", label: "AVIF", lossy: true },
    bmp: { mime: "image/bmp", ext: "bmp", label: "BMP" },
    ico: { mime: "image/x-icon", ext: "ico", label: "ICO (icon)" },
    pdf: { mime: "application/pdf", ext: "pdf", label: "PDF" },
  };
  const supported = {};

  const err = (msg) => new ClientPDF.UserError(msg);

  function blobOf(canvas, mime, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  }

  /** True when this browser can save canvases in that format (AVIF and WebP vary). */
  async function canEncode(fmt) {
    const f = FORMATS[fmt];
    if (!f) return false;
    if (["bmp", "ico", "pdf", "png", "jpeg"].includes(fmt)) return true;
    if (!(fmt in supported)) {
      const c = document.createElement("canvas");
      c.width = c.height = 2;
      const b = await blobOf(c, f.mime, 0.8);
      supported[fmt] = !!b && b.type === f.mime;
    }
    return supported[fmt];
  }

  // ----- HEIC / HEIF (iPhone photos) -----
  // Safari reads HEIC itself; other browsers get libheif (WebAssembly, no eval, so it works under
  // the site's strict Content-Security-Policy), loaded only when a HEIC actually shows up.
  const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];

  /** True for HEIC/HEIF files, by name, type, or the "ftyp" brand in the first bytes. */
  async function isHeic(file) {
    if (/\.(heic|heif)$/i.test(file.name || "") || /^image\/hei[cf]/i.test(file.type || "")) return true;
    if (/\.avif$/i.test(file.name || "") || file.type === "image/avif") return false;
    let b;
    try { b = new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch (e) { return false; }
    if (b.length < 16 || String.fromCharCode(...b.subarray(4, 8)) !== "ftyp") return false;
    const size = Math.min(new DataView(b.buffer).getUint32(0), b.length);
    const brands = [String.fromCharCode(...b.subarray(8, 12))];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(String.fromCharCode(...b.subarray(o, o + 4)));
    if (brands.includes("avif") || brands.includes("avis")) return false; // AVIF: browsers read it natively
    return brands.some((x) => HEIC_BRANDS.includes(x));
  }

  let heicLoader = null;
  function loadHeic() {
    if (!heicLoader) {
      heicLoader = new Promise((resolve, reject) => {
        const ready = () => Promise.resolve(window.libheif()).then(resolve, () => reject(err("Couldn't start the HEIC reader.")));
        if (window.libheif) return ready();
        const s = document.createElement("script");
        s.src = "/static/vendor/libheif-bundle.js?v=13";
        s.async = true;
        s.onload = () => (window.libheif ? ready() : reject(err("Couldn't start the HEIC reader.")));
        s.onerror = () => { heicLoader = null; s.remove(); reject(err("Couldn't load the HEIC reader. Check your connection and try again.")); };
        document.head.append(s);
      }).catch((e) => { heicLoader = null; throw e; });
    }
    return heicLoader;
  }

  /** HEIC/HEIF to a JPEG (or PNG) Blob. Several pictures in one file (bursts, live photos): the first one. */
  async function heicToBlob(file, { type = "image/jpeg", quality = 0.92 } = {}) {
    const lib = await loadHeic();
    const bad = () => err(`${file.name} looks like a HEIC photo but couldn't be read. It may be damaged, or use a HEIC variant this reader doesn't know.`);
    let images;
    try {
      images = new lib.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    } catch (e) { throw bad(); }
    if (!images || !images.length) throw bad();
    const img = images[0];
    const w = img.get_width(), h = img.get_height();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    const pixels = g.createImageData(w, h);
    try {
      await new Promise((resolve, reject) => img.display(pixels, (out) => (out ? resolve() : reject(bad()))));
    } finally {
      images.forEach((i) => { try { i.free(); } catch (e) { /* already freed */ } });
    }
    g.putImageData(pixels, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, type, quality));
    if (!blob) throw bad();
    return blob;
  }

  async function nativeBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { return null; }
  }

  /**
   * Returns something every browser can read: the same file for normal images, a JPEG File for
   * HEIC/HEIF. Use before code that reads image bytes directly (e.g. putting photos in a PDF).
   */
  async function normalize(file, { quality = 0.92 } = {}) {
    if (!(await isHeic(file))) return file;
    const blob = await heicToBlob(file, { type: "image/jpeg", quality });
    return new File([blob], `${stem(file.name || "photo")}.jpg`, { type: "image/jpeg" });
  }

  /** Decodes any image the browser can read, with phone photos turned the right way up. HEIC included. */
  async function decode(file) {
    if (await isHeic(file)) {
      const native = await nativeBitmap(file); // Safari 17+
      if (native) return native;
      const blob = await heicToBlob(file, { type: "image/png" });
      const bmp = await nativeBitmap(blob);
      if (bmp) return bmp;
      throw err(`${file.name} is a HEIC photo that couldn't be read in this browser.`);
    }
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // SVG and a few others only load through <img>.
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || 1024;
        c.height = img.naturalHeight || 1024;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        return c;
      } catch (e2) {
        throw err(`${file.name} isn't an image this browser can read.`);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  /** Same as decode: an ImageBitmap or canvas you can drawImage() from. */
  const toDrawable = (file) => decode(file);

  /** Draws src into a new canvas of w×h (white behind transparent parts when asked). */
  function draw(src, w, h, { background = null, sx = 0, sy = 0, sw = src.width, sh = src.height } = {}) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const g = c.getContext("2d");
    if (background) { g.fillStyle = background; g.fillRect(0, 0, c.width, c.height); }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // ----- encoders the browser doesn't have -----

  function bmp(canvas) {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const row = Math.ceil((w * 3) / 4) * 4;
    const size = 54 + row * h;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d;
    v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
    v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true);
    v.setUint32(34, row * h, true); v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * row;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = data[i + 3] / 255; // flatten onto white
        out[o++] = Math.round(data[i + 2] * a + 255 * (1 - a));
        out[o++] = Math.round(data[i + 1] * a + 255 * (1 - a));
        out[o++] = Math.round(data[i] * a + 255 * (1 - a));
      }
    }
    return out;
  }

  async function ico(canvas) {
    const s = Math.min(256, Math.max(canvas.width, canvas.height));
    const scale = s / Math.max(canvas.width, canvas.height);
    const sq = document.createElement("canvas");
    sq.width = sq.height = s;
    const w = canvas.width * scale, h = canvas.height * scale;
    sq.getContext("2d").drawImage(canvas, (s - w) / 2, (s - h) / 2, w, h);
    const png = new Uint8Array(await (await blobOf(sq, "image/png")).arrayBuffer());
    const out = new Uint8Array(22 + png.length);
    const v = new DataView(out.buffer);
    v.setUint16(2, 1, true); v.setUint16(4, 1, true);
    out[6] = s >= 256 ? 0 : s; out[7] = s >= 256 ? 0 : s;
    v.setUint16(10, 1, true); v.setUint16(12, 32, true);
    v.setUint32(14, png.length, true); v.setUint32(18, 22, true);
    out.set(png, 22);
    return out;
  }

  // ----- DPI and size padding -----

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function pngChunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  }
  function insertAfterIhdr(png, chunk) {
    const at = 8 + 25; // signature + IHDR
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, at)); out.set(chunk, at); out.set(png.subarray(at), at + chunk.length);
    return out;
  }

  /** Writes the DPI into a JPEG (JFIF header) or PNG (pHYs chunk). */
  function setDpi(bytes, fmt, dpi) {
    if (!dpi) return bytes;
    if (fmt === "jpeg" && bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.subarray(6, 10)) === "JFIF") {
      const out = bytes.slice();
      out[13] = 1; // dots per inch
      out[14] = dpi >> 8; out[15] = dpi & 255; out[16] = dpi >> 8; out[17] = dpi & 255;
      return out;
    }
    if (fmt === "png") {
      const ppm = Math.round(dpi / 0.0254);
      const body = new Uint8Array(9);
      const v = new DataView(body.buffer);
      v.setUint32(0, ppm); v.setUint32(4, ppm); body[8] = 1;
      return insertAfterIhdr(bytes, pngChunk("pHYs", body));
    }
    return bytes;
  }

  /** Grows a JPEG/PNG to at least `min` bytes with an invisible comment, for forms with a minimum size. */
  function padTo(bytes, fmt, min) {
    let need = min - bytes.length;
    if (need <= 0) return bytes;
    if (fmt === "jpeg") {
      const parts = [];
      while (need > 0) {
        const n = Math.min(65533, Math.max(need - 4, 1));
        const seg = new Uint8Array(4 + n);
        seg[0] = 0xff; seg[1] = 0xfe; seg[2] = (n + 2) >> 8; seg[3] = (n + 2) & 255;
        seg.fill(0x20, 4);
        parts.push(seg);
        need -= seg.length;
      }
      const total = parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(bytes.length + total);
      out.set(bytes.subarray(0, 2));
      let o = 2;
      for (const p of parts) { out.set(p, o); o += p.length; }
      out.set(bytes.subarray(2), o);
      return out;
    }
    if (fmt === "png") {
      const body = new Uint8Array(Math.max(need - 12, 9));
      body.set([67, 111, 109, 109, 101, 110, 116, 0]); // "Comment\0"
      body.fill(0x20, 8);
      return insertAfterIhdr(bytes, pngChunk("tEXt", body));
    }
    return bytes;
  }

  /** Saves a canvas in any supported format. */
  async function encode(canvas, fmt, quality = 0.9, { dpi = 0 } = {}) {
    if (fmt === "bmp") return bmp(canvas);
    if (fmt === "ico") return ico(canvas);
    const f = FORMATS[fmt];
    if (!(await canEncode(fmt))) throw err(`This browser can't save ${f.label} images. Try Chrome or Edge, or pick another format.`);
    let src = canvas;
    if (fmt === "jpeg") src = draw(canvas, canvas.width, canvas.height, { background: "#ffffff" });
    const blob = await blobOf(src, f.mime, f.lossy ? quality : undefined);
    if (!blob) throw err("The image is too large for this browser to save. Make it smaller first.");
    return setDpi(new Uint8Array(await blob.arrayBuffer()), fmt, dpi);
  }

  /**
   * Saves the canvas as close to [minKB, maxKB] as possible: highest quality that fits, then
   * (when allowed) smaller pixel size; pads up to the minimum when the image is tiny.
   * Returns { bytes, width, height, quality, note }.
   */
  async function fitSize(canvas, fmt, { minKB = 0, maxKB = 0, dpi = 0, allowShrink = false, onStep } = {}) {
    const max = maxKB * 1024, min = minKB * 1024;
    const lossy = FORMATS[fmt].lossy;
    let c = canvas, note = "";
    for (let attempt = 0; attempt < 14; attempt++) {
      if (onStep) onStep(attempt);
      if (!max) break;
      if (lossy) {
        let best = null, lo = 0.05, hi = 0.97;
        const top = await encode(c, fmt, hi, { dpi });
        if (top.length <= max) return finish(top, c, hi);
        for (let i = 0; i < 8; i++) {
          const q = (lo + hi) / 2;
          const b = await encode(c, fmt, q, { dpi });
          if (b.length <= max) { best = { b, q }; lo = q; } else hi = q;
        }
        if (!best) {
          const b = await encode(c, fmt, 0.05, { dpi });
          if (b.length <= max) best = { b, q: 0.05 };
        }
        if (best) return finish(best.b, c, best.q);
      } else {
        const b = await encode(c, fmt, 1, { dpi });
        if (b.length <= max) return finish(b, c, 1);
      }
      if (!allowShrink) {
        throw err(`Even at the lowest quality this is over ${maxKB} KB at ${c.width}×${c.height} px. Use fewer pixels, or save as JPG.`);
      }
      c = draw(c, c.width * 0.85, c.height * 0.85);
      note = ` Pixel size reduced to ${c.width}×${c.height} to fit.`;
    }
    return finish(await encode(c, fmt, 0.9, { dpi }), c, 0.9);

    function finish(bytes, cv, q) {
      let n = note;
      if (min && bytes.length < min) {
        const padded = padTo(bytes, fmt, min);
        if (padded.length >= min) { bytes = padded; n += " A blank comment was added to reach the minimum size; the picture is unchanged."; }
      }
      return { bytes, width: cv.width, height: cv.height, quality: q, note: n.trim() };
    }
  }

  function kb(n) { return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
  function stem(name) { return name.replace(/\.[^.]+$/, "") || "image"; }
  function isPdfFile(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name); }
  function isImage(f) { return f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif)$/i.test(f.name); }

  async function zipOf(items, name) {
    if (items.length === 1) return items[0];
    const zip = new JSZip();
    const used = new Set();
    for (const it of items) {
      let n = it.filename, i = 2;
      while (used.has(n)) n = it.filename.replace(/(\.[^.]+)?$/, `_${i++}$1`);
      used.add(n);
      zip.file(n, it.bytes);
    }
    return { bytes: await zip.generateAsync({ type: "uint8array" }), filename: name, mime: "application/zip" };
  }

  return { FORMATS, canEncode, decode, toDrawable, normalize, isHeic, heicToBlob, loadHeic, draw, encode, fitSize, setDpi, padTo, kb, stem, isPdfFile, isImage, zipOf };
})();

// ---------- Image converter: any image or PDF to any image format or PDF ----------

const ImageConvert = {
  configHtml: `
    <div class="grid-2">
      <div class="form-group">
        <label class="form-label" for="icFormat">Convert to</label>
        <select id="icFormat" class="form-select">
          <option value="jpeg">JPG</option>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
          <option value="avif">AVIF</option>
          <option value="pdf">PDF (one page per image)</option>
          <option value="bmp">BMP</option>
          <option value="ico">ICO (website icon)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="icQuality">Quality <span id="icQualityVal">90%</span></label>
        <input type="range" id="icQuality" min="10" max="100" value="90" class="form-range">
      </div>
    </div>
    <div class="grid-2">
      <div class="form-group">
        <label class="form-label" for="icWidth">Width in pixels (optional)</label>
        <input type="number" id="icWidth" class="form-input" min="1" max="20000" placeholder="Keep original">
      </div>
      <div class="form-group">
        <label class="form-label" for="icDpi">PDF pages to image at</label>
        <select id="icDpi" class="form-select"><option value="96">96 dpi</option><option value="150" selected>150 dpi</option><option value="300">300 dpi</option></select>
      </div>
    </div>
    <p class="drop-hint">Takes JPG, PNG, WebP, GIF, BMP, AVIF, HEIC (iPhone), SVG, ICO and PDF. Several files come back as one ZIP. Nothing is uploaded.</p>`,

  onInput(ctx, id) {
    if (id === "icQuality") ctx.el("icQualityVal").textContent = `${ctx.value("icQuality")}%`;
  },

  async run(ctx) {
    const fmt = ctx.value("icFormat");
    const quality = Number(ctx.value("icQuality")) / 100;
    const width = Number(ctx.value("icWidth")) || 0;
    const dpi = Number(ctx.value("icDpi"));
    const sized = (src) => {
      if (!width || width === src.width) return ImageKit.draw(src, src.width, src.height);
      return ImageKit.draw(src, width, (src.height * width) / src.width);
    };
    // Every input becomes one or more canvases.
    const pictures = []; // { canvas, name }
    for (let i = 0; i < ctx.files.length; i++) {
      const f = ctx.files[i];
      ctx.progress(i / ctx.files.length * 0.6, `Reading ${f.name} (${i + 1} of ${ctx.files.length})`);
      if (ImageKit.isPdfFile(f)) {
        if (fmt === "pdf") throw new ClientPDF.UserError(`${f.name} is already a PDF.`);
        const doc = await PdfRender.open(ctx.buffers[i]);
        for (let p = 1; p <= doc.numPages; p++) {
          const c = document.createElement("canvas");
          await PdfRender.renderPage(await doc.getPage(p), c, { scale: dpi / 72 });
          pictures.push({ canvas: sized(c), name: `${ImageKit.stem(f.name)}_page${p}` });
        }
        doc.destroy();
      } else {
        pictures.push({ canvas: sized(await ImageKit.decode(f)), name: ImageKit.stem(f.name) });
      }
    }
    if (fmt === "pdf") {
      ctx.progress(0.7, "Building the PDF");
      const imgs = [];
      for (const p of pictures) imgs.push({ bytes: await ImageKit.encode(p.canvas, "jpeg", quality), type: "image/jpeg" });
      const out = await PdfWorker.run("imagesToPdf", imgs);
      out.filename = pictures.length === 1 ? `${pictures[0].name}.pdf` : "images.pdf";
      return out;
    }
    const f = ImageKit.FORMATS[fmt];
    const items = [];
    for (let i = 0; i < pictures.length; i++) {
      ctx.progress(0.6 + (i / pictures.length) * 0.35, `Saving ${f.label} ${i + 1} of ${pictures.length}`);
      items.push({ bytes: await ImageKit.encode(pictures[i].canvas, fmt, quality), filename: `${pictures[i].name}.${f.ext}`, mime: f.mime });
    }
    return ImageKit.zipOf(items, `converted_${f.ext}.zip`);
  },
};

// ---------- Compress any file ----------

const AnyCompress = {
  configHtml: `
    <div class="grid-2">
      <div class="form-group">
        <label class="form-label" for="acLevel">How much</label>
        <select id="acLevel" class="form-select">
          <option value="light">Light: best quality</option>
          <option value="balanced" selected>Balanced</option>
          <option value="strong">Strong: smallest file</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="acTarget">Target size in KB (optional)</label>
        <input type="number" id="acTarget" class="form-input" min="1" placeholder="e.g. 100">
      </div>
    </div>
    <p class="drop-hint">Photos are re-saved smaller, PDFs are compressed on the server (never stored), Word, Excel and
      PowerPoint files get their pictures shrunk, and anything else is zipped. Images and Office files stay on your device.</p>`,

  async compressImage(file, level, targetKB) {
    const src = await ImageKit.decode(file);
    const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
    let fmt = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpeg";
    const maxSide = { light: 4000, balanced: 2400, strong: 1600 }[level];
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    let c = ImageKit.draw(src, src.width * s, src.height * s);
    if (fmt === "png" && !hasAlpha(c)) fmt = "jpeg"; // photos saved as PNG shrink a lot as JPG
    const ext = ImageKit.FORMATS[fmt].ext;
    const name = `${ImageKit.stem(file.name)}_compressed.${ext}`;
    if (targetKB) {
      const r = await ImageKit.fitSize(c, fmt, { maxKB: targetKB, allowShrink: true });
      return { bytes: r.bytes, filename: name, mime: ImageKit.FORMATS[fmt].mime, note: r.note };
    }
    const q = { light: 0.85, balanced: 0.72, strong: 0.55 }[level];
    if (fmt === "png" && level !== "light") c = ImageKit.draw(c, c.width * (level === "strong" ? 0.7 : 0.85), c.height * (level === "strong" ? 0.7 : 0.85));
    return { bytes: await ImageKit.encode(c, fmt, q), filename: name, mime: ImageKit.FORMATS[fmt].mime };
  },

  // .docx/.xlsx/.pptx/.odt... are ZIP files: shrink the pictures inside and re-zip tighter.
  async compressOffice(file, buffer, level) {
    const zip = await JSZip.loadAsync(buffer);
    const maxSide = { light: 2400, balanced: 1600, strong: 1100 }[level];
    const q = { light: 0.85, balanced: 0.72, strong: 0.6 }[level];
    const media = Object.keys(zip.files).filter((n) => /(media|Pictures)\/[^/]+\.(jpe?g|png)$/i.test(n));
    for (const n of media) {
      const data = await zip.file(n).async("uint8array");
      if (data.length < 60 * 1024) continue;
      const isPng = /\.png$/i.test(n);
      try {
        const bmp = await createImageBitmap(new Blob([data], { type: isPng ? "image/png" : "image/jpeg" }));
        const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const c = ImageKit.draw(bmp, bmp.width * s, bmp.height * s);
        const out = await ImageKit.encode(c, isPng ? "png" : "jpeg", q);
        if (out.length < data.length) zip.file(n, out);
      } catch (e) { /* leave pictures the browser can't read */ }
    }
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
    const ext = file.name.match(/\.[^.]+$/)[0];
    return { bytes, filename: `${ImageKit.stem(file.name)}_compressed${ext}`, mime: file.type || "application/octet-stream" };
  },

  async compressPdf(file, level, ctx) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("level", { light: "low", balanced: "medium", strong: "extreme" }[level]);
    const r = await serverRequest("/api/compress", fd, ctx, { quiet: true, label: `Compressing ${file.name} on the server…` });
    return { bytes: r.bytes, filename: `${ImageKit.stem(file.name)}_compressed.pdf`, mime: "application/pdf" };
  },

  async zipOther(file, buffer) {
    const zip = new JSZip();
    zip.file(file.name, buffer);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
    return { bytes, filename: `${file.name}.zip`, mime: "application/zip" };
  },

  async run(ctx) {
    const level = ctx.value("acLevel");
    const targetKB = Number(ctx.value("acTarget")) || 0;
    const items = [];
    const notes = [];
    let before = 0, after = 0;
    for (let i = 0; i < ctx.files.length; i++) {
      const f = ctx.files[i];
      ctx.progress(i / ctx.files.length * 0.95, `Compressing ${f.name} (${i + 1} of ${ctx.files.length})`);
      let out;
      if (ImageKit.isPdfFile(f)) out = await AnyCompress.compressPdf(f, targetKB ? "strong" : level, ctx);
      else if (ImageKit.isImage(f) && !/\.(gif|svg|ico)$/i.test(f.name)) out = await AnyCompress.compressImage(f, level, targetKB);
      else if (/\.(docx|xlsx|pptx|odt|ods|odp|docm|xlsm|pptm)$/i.test(f.name)) out = await AnyCompress.compressOffice(f, ctx.buffers[i], level);
      else out = await AnyCompress.zipOther(f, ctx.buffers[i]);
      if (out.bytes.length >= f.size && !out.filename.endsWith(".zip")) {
        notes.push(`${f.name} was already as small as it gets, so it's unchanged.`);
        out = { bytes: ctx.buffers[i], filename: f.name, mime: f.type || "application/octet-stream" };
      }
      if (out.note) notes.push(out.note);
      if (targetKB && out.bytes.length > targetKB * 1024) notes.push(`${f.name} could only get down to ${ImageKit.kb(out.bytes.length)}.`);
      before += f.size;
      after += out.bytes.length;
      items.push(out);
    }
    const result = await ImageKit.zipOf(items, "compressed_files.zip");
    const pct = before ? Math.round((1 - after / before) * 100) : 0;
    result.message = `Done! ${ImageKit.kb(before)} → ${ImageKit.kb(after)}${pct > 0 ? ` (${pct}% smaller)` : ""}. Downloaded ${result.filename}.` +
      (notes.length ? " " + notes.join(" ") : "");
    return result;
  },
};

function hasAlpha(canvas) {
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true;
  return false;
}

// ---------- HEIC to JPG (iPhone photos); registered as a tool in form-kit.js ----------

const HeicConvert = {
  configHtml: `
    <div class="grid-2">
      <div class="form-group">
        <label class="form-label" for="hcFormat">Save as</label>
        <select id="hcFormat" class="form-select">
          <option value="jpeg" selected>JPG (works everywhere)</option>
          <option value="png">PNG (bigger, no quality loss)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="hcQuality">JPG quality <span id="hcQualityVal">90%</span></label>
        <input type="range" id="hcQuality" min="40" max="100" value="90" class="form-range">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="hcMax">Longest side (optional)</label>
      <select id="hcMax" class="form-select">
        <option value="0" selected>Keep full size</option>
        <option value="3000">3000 px</option>
        <option value="2000">2000 px (good for email and WhatsApp)</option>
        <option value="1280">1280 px (small)</option>
      </select>
    </div>
    <p class="drop-hint">Add as many iPhone HEIC or HEIF photos as you like. One photo comes back as a JPG; several come
      back as one ZIP. The first time, the HEIC reader (about 1.3 MB) is loaded. Nothing is uploaded.</p>`,

  onInput(ctx, id) {
    if (id === "hcQuality") ctx.el("hcQualityVal").textContent = `${ctx.value("hcQuality")}%`;
  },

  async run(ctx) {
    const fmt = ctx.value("hcFormat") === "png" ? "png" : "jpeg";
    const quality = Number(ctx.value("hcQuality")) / 100 || 0.9;
    const maxSide = Number(ctx.value("hcMax")) || 0;
    const f = ImageKit.FORMATS[fmt];
    const items = [];
    const skipped = [];
    for (let i = 0; i < ctx.files.length; i++) {
      if (ctx.signal && ctx.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const file = ctx.files[i];
      ctx.progress(i / ctx.files.length * 0.95, `Converting ${file.name} (${i + 1} of ${ctx.files.length})`);
      let src;
      try {
        src = await ImageKit.decode(file);
      } catch (e) {
        if (ctx.files.length === 1) throw e;
        skipped.push(file.name);
        continue;
      }
      const s = maxSide ? Math.min(1, maxSide / Math.max(src.width, src.height)) : 1;
      const c = ImageKit.draw(src, src.width * s, src.height * s, { background: fmt === "jpeg" ? "#ffffff" : null });
      if (src.close) src.close();
      items.push({ bytes: await ImageKit.encode(c, fmt, quality), filename: `${ImageKit.stem(file.name)}.${f.ext}`, mime: f.mime });
    }
    if (!items.length) throw new ClientPDF.UserError("None of these files could be read as photos.");
    const result = await ImageKit.zipOf(items, `heic_to_${f.ext}.zip`);
    const size = items.reduce((n, it) => n + it.bytes.length, 0);
    result.message = `Done! ${items.length} photo${items.length > 1 ? "s" : ""} saved as ${f.label} (${ImageKit.kb(size)}). Downloaded ${result.filename}.` +
      (skipped.length ? ` Skipped (couldn't read): ${skipped.join(", ")}.` : "") + " Nothing was uploaded.";
    return result;
  },
};
