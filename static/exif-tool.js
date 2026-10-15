// Remove EXIF and Location: shows what a photo gives away (GPS location, camera, phone model,
// date, editing app, author) and saves a clean copy. JPG, PNG and WebP are cleaned without
// re-encoding, so the picture is untouched; other formats are re-saved. Runs in the browser.

const ExifTool = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ascii = (b, s, n) => { let t = ""; for (let i = 0; i < n && s + i < b.length; i++) t += String.fromCharCode(b[s + i]); return t; };

  // ---------- Reading EXIF (TIFF structure) ----------

  const TAGS0 = { 0x010f: "Camera maker", 0x0110: "Camera / phone model", 0x0131: "Editing app", 0x0132: "Date changed", 0x013b: "Author", 0x8298: "Copyright" };
  const TAGS_EXIF = { 0x9003: "Date taken", 0xa434: "Lens", 0xa431: "Camera serial number", 0xa435: "Lens serial number", 0xa430: "Camera owner" };

  /** Parses a TIFF block (the body of an EXIF segment). Returns { items, orientation, gps }. */
  function readTiff(b) {
    const out = { items: [], orientation: 1, gps: null };
    if (b.length < 8) return out;
    const le = b[0] === 0x49;
    const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216 : b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    function ifd(off) {
      const tags = {};
      if (off <= 0 || off + 2 > b.length) return tags;
      const n = Math.min(u16(off), 500);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > b.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = (SIZE[type] || 1) * count;
        const at = size > 4 ? u32(e + 8) : e + 8;
        if (at + size > b.length) continue;
        tags[tag] = { type, count, at };
      }
      return tags;
    }
    const str = (t) => ascii(b, t.at, t.count).replace(/\0[\s\S]*$/, "").trim();
    const rat = (at) => { const d = u32(at + 4); return d ? u32(at) / d : 0; };
    const ifd0 = ifd(u32(4));
    for (const [tag, label] of Object.entries(TAGS0)) {
      const t = ifd0[tag];
      if (t && t.type === 2) { const v = str(t); if (v) out.items.push([label, v]); }
    }
    if (ifd0[0x0112]) out.orientation = u16(ifd0[0x0112].at) || 1;
    if (ifd0[0x8769]) {
      const ex = ifd(u32(ifd0[0x8769].at));
      for (const [tag, label] of Object.entries(TAGS_EXIF)) {
        const t = ex[tag];
        if (t && t.type === 2) { const v = str(t); if (v) out.items.push([label, v]); }
      }
    }
    if (ifd0[0x8825]) {
      const g = ifd(u32(ifd0[0x8825].at));
      const dms = (t) => (t && t.type === 5 && t.count >= 3 ? rat(t.at) + rat(t.at + 8) / 60 + rat(t.at + 16) / 3600 : null);
      let lat = dms(g[2]), lon = dms(g[4]);
      if (lat != null && lon != null && (lat || lon)) {
        if (g[1] && String.fromCharCode(b[g[1].at]) === "S") lat = -lat;
        if (g[3] && String.fromCharCode(b[g[3].at]) === "W") lon = -lon;
        out.gps = { lat, lon };
      } else if (Object.keys(g).length) out.items.push(["GPS data", "present"]);
    }
    return out;
  }

  /** Minimal EXIF holding only the orientation, so a sideways phone photo still shows upright. */
  function orientationExif(o) {
    const t = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
    const len = body.length + 2;
    return new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...body]);
  }

  // ---------- Per format: find and strip ----------

  function jpeg(b) {
    const found = { items: [], gps: null, kinds: new Set() };
    const keep = [b.subarray(0, 2)];
    let orientation = 1, i = 2, removed = 0;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const m = b[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { keep.push(b.subarray(i, i + 2)); i += 2; continue; }
      if (m === 0xda) break; // image data follows; copy the rest as is
      const len = (b[i + 2] << 8) | b[i + 3];
      const seg = b.subarray(i, i + 2 + len);
      const id = ascii(b, i + 4, 30);
      let drop = false;
      if (m === 0xe1 && id.startsWith("Exif\0")) {
        const r = readTiff(b.subarray(i + 10, i + 2 + len));
        found.items.push(...r.items);
        if (r.gps) found.gps = r.gps;
        orientation = r.orientation;
        found.kinds.add("EXIF");
        drop = true;
      } else if (m === 0xe1) { found.kinds.add("XMP"); drop = true; }
      else if (m === 0xed) { found.kinds.add("IPTC"); drop = true; }
      else if (m === 0xfe) { found.kinds.add("Comment"); drop = true; }
      else if (m >= 0xe3 && m <= 0xef && m !== 0xee) { found.kinds.add("Maker data"); drop = true; } // APP3-APP15 except Adobe (APP14)
      if (drop) removed += seg.length; else keep.push(seg);
      i += 2 + len;
    }
    if (orientation > 1 && orientation <= 8) keep.splice(1, 0, orientationExif(orientation));
    keep.push(b.subarray(i));
    return { found, clean: concat(keep), removed, lossless: true };
  }

  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();

  function png(b) {
    const found = { items: [], gps: null, kinds: new Set() };
    const keep = [b.subarray(0, 8)];
    let i = 8, removed = 0;
    while (i + 12 <= b.length) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = ascii(b, i + 4, 4);
      const chunk = b.subarray(i, i + 12 + len);
      if (/^(tEXt|zTXt|iTXt|eXIf|tIME)$/.test(type)) {
        if (type === "eXIf") {
          const r = readTiff(b.subarray(i + 8, i + 8 + len));
          found.items.push(...r.items);
          if (r.gps) found.gps = r.gps;
          found.kinds.add("EXIF");
        } else if (type === "tIME") found.kinds.add("Date changed");
        else {
          const key = ascii(b, i + 8, Math.min(len, 79)).split("\0")[0];
          found.kinds.add(/XML:com.adobe.xmp/.test(key) ? "XMP" : "Text notes");
          if (type === "tEXt" && !/XML/.test(key)) {
            const val = ascii(b, i + 8 + key.length + 1, Math.min(120, len - key.length - 1));
            if (val.trim()) found.items.push([key, val.trim()]);
          }
        }
        removed += chunk.length;
      } else keep.push(chunk);
      if (type === "IEND") break;
      i += 12 + len;
    }
    return { found, clean: concat(keep), removed, lossless: true };
  }

  function webp(b) {
    const found = { items: [], gps: null, kinds: new Set() };
    const keep = [];
    let i = 12, removed = 0;
    while (i + 8 <= b.length) {
      const type = ascii(b, i, 4);
      const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
      const size = 8 + len + (len & 1);
      const chunk = b.subarray(i, i + size);
      if (type === "EXIF") {
        let body = b.subarray(i + 8, i + 8 + len);
        if (ascii(body, 0, 6) === "Exif\0\0") body = body.subarray(6);
        const r = readTiff(body);
        found.items.push(...r.items);
        if (r.gps) found.gps = r.gps;
        found.kinds.add("EXIF");
        removed += size;
      } else if (type === "XMP ") { found.kinds.add("XMP"); removed += size; }
      else keep.push(type === "VP8X" ? clearVp8x(chunk) : chunk);
      i += size;
    }
    const body = concat(keep);
    const head = new Uint8Array(12);
    head.set(b.subarray(0, 12));
    const total = body.length + 4;
    head[4] = total & 255; head[5] = (total >> 8) & 255; head[6] = (total >> 16) & 255; head[7] = (total >>> 24) & 255;
    return { found, clean: concat([head, body]), removed, lossless: true };
  }
  function clearVp8x(chunk) {
    const c = chunk.slice();
    c[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
    return c;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function kind(b) {
    if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "png";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
    return "other";
  }

  /** { found, clean, ext, mime, lossless } for one file. */
  async function inspect(file) {
    const b = new Uint8Array(await file.arrayBuffer());
    const k = kind(b);
    if (k === "jpeg") return { ...jpeg(b), ext: "jpg", mime: "image/jpeg" };
    if (k === "png") return { ...png(b), ext: "png", mime: "image/png" };
    if (k === "webp") return { ...webp(b), ext: "webp", mime: "image/webp" };
    // HEIC, TIFF, AVIF, GIF, BMP...: re-save; the browser keeps none of the metadata.
    const bmp = await ImageKit.decode(file);
    const c = ImageKit.draw(bmp, bmp.width, bmp.height);
    const heic = await ImageKit.isHeic(file);
    const fmt = heic || /jpe?g|heic|heif|tiff?|avif/i.test(file.type + file.name) ? "jpeg" : "png";
    const clean = await ImageKit.encode(c, fmt, 0.95);
    const found = { items: [], gps: null, kinds: new Set(["Any metadata (this format is re-saved)"]) };
    return { found, clean, removed: 0, lossless: false, ext: fmt === "jpeg" ? "jpg" : "png", mime: ImageKit.FORMATS[fmt].mime };
  }

  // ---------- The tool ----------

  const configHtml = `<div id="exRoot"><p class="drop-hint">Add photos to see what they reveal. Up to 200 at once.</p></div>`;

  function create(root) {
    let report = [];
    let token = 0;
    async function setFiles(files) {
      const my = ++token;
      root.innerHTML = `<p class="drop-hint">Checking ${files.length} photo${files.length === 1 ? "" : "s"}…</p>`;
      const rows = [];
      for (const f of files) {
        try { rows.push({ file: f, ...(await inspect(f)) }); } catch (e) { rows.push({ file: f, error: e.message || "Couldn't read this file." }); }
        if (my !== token) return;
      }
      report = rows;
      const located = rows.filter((r) => r.found && r.found.gps).length;
      root.innerHTML = `
        <div class="ex">
          ${located ? `<div class="ex-alert">${Icons.ui("warn")} <span><strong>${located} photo${located === 1 ? " shows" : "s show"} where ${located === 1 ? "it was" : "they were"} taken.</strong> Anyone you send ${located === 1 ? "it" : "them"} to can see the location.</span></div>` : ""}
          ${rows.map((r) => `
            <section class="ex-file">
              <div class="ex-name">${esc(r.file.name)}</div>
              ${r.error ? `<p class="ex-none bad">${esc(r.error)}</p>` : summary(r)}
            </section>`).join("")}
        </div>`;
    }
    function summary(r) {
      const f = r.found;
      const items = [...f.items];
      if (f.gps) items.unshift(["Location (GPS)", `${f.gps.lat.toFixed(5)}, ${f.gps.lon.toFixed(5)}`]);
      const kinds = [...f.kinds].filter((k) => k !== "EXIF");
      if (!items.length && !kinds.length) return `<p class="ex-none">${Icons.ui("lock")} Nothing hidden found. It's already clean.</p>`;
      return `<dl class="ex-list">${items.map(([k, v]) => `<dt${k.startsWith("Location") ? ' class="ex-gps"' : ""}>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
        ${kinds.length ? `<dt>Also</dt><dd>${esc(kinds.join(", "))}</dd>` : ""}</dl>`;
    }
    async function run(ctx) {
      if (!report.length) throw UserError("Add photos first.");
      const ok = report.filter((r) => !r.error);
      if (!ok.length) throw UserError("None of these files could be read.");
      const named = ok.map((r) => ({ name: `${ImageKit.stem(r.file.name)}.${r.ext}`, bytes: r.clean, mime: r.mime }));
      const dirty = ok.filter((r) => r.found.gps || r.found.items.length || r.found.kinds.size).length;
      const msg = `Done! Removed hidden data from ${dirty} of ${ok.length} photo${ok.length === 1 ? "" : "s"}. Nothing was uploaded.`;
      if (named.length === 1) return { bytes: named[0].bytes, filename: named[0].name, mime: named[0].mime, message: msg.replace("Done!", `Done! Downloaded ${named[0].name}.`) };
      const zipped = await ImageKit.zipOf(named.map((n) => ({ filename: n.name, bytes: n.bytes })), "photos_clean.zip");
      return { ...zipped, message: msg };
    }
    return { setFiles, run };
  }

  return { configHtml, create, inspect, readTiff, jpeg, png, webp };
})();

TOOLS.push({
  id: "remove-exif",
  slug: "remove-exif",
  aliases: ["exif-remover", "remove-location-from-photo", "remove-metadata-from-photo", "exif-viewer", "photo-metadata-remover", "remove-gps-from-photo"],
  name: "Remove Photo Location & EXIF",
  desc: "See what a photo gives away (GPS location, phone model, date) and save a clean copy. The picture itself is not changed.",
  keywords: "exif remover remove exif remove location from photo gps metadata photo metadata remover exif viewer exif data camera model date taken privacy strip metadata jpg png",
  category: "security",
  badge: "Privacy",
  accept: "image/*,.heic,.heif",
  acceptLabel: "photos",
  multipleFiles: true,
  actionLabel: "Remove & save",
  caption: "Hide where it was taken",
  configHtml: ExifTool.configHtml,
  onOpen: (ctx) => { ctx.ex = ExifTool.create(ctx.el("exRoot")); },
  onFiles: (ctx) => ctx.files.length && ctx.ex.setFiles(ctx.files),
  run: (ctx) => ctx.ex.run(ctx),
});
