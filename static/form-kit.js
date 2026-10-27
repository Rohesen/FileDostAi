// Exam & Govt Form Kit: a guided checklist of every upload a form asks for (photo, signature,
// thumb impression, certificates), each saved at the form's pixel size, KB range, format and DPI,
// then downloaded one by one or as a ZIP. Also registers the HEIC to JPG tool (HeicConvert lives
// in image-tools.js). Everything runs in the browser; nothing is uploaded.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/form-kit.css?v=34" }));

const FormKit = (() => {
  const P = (typeof PhotoTool !== "undefined" && PhotoTool.PRESETS) || {};
  const UserError = (msg) => new ClientPDF.UserError(msg);

  // ----- What each form asks for. Typical values from recent notices; they change, so every
  // slot's numbers can be edited, and the UI says to check the official notice. -----

  // Photo/signature slots take their numbers from the photo resizer presets so both tools agree.
  function preset(key, extra) {
    const p = P[key] || {};
    return { w: p.w || 0, h: p.h || 0, min: p.min || 0, max: p.max || 0, dpi: p.dpi || 0, out: p.fmt || "jpeg", file: p.file || "Photo", ...extra };
  }
  const photo = (key, extra) => preset(key, { kind: "photo", name: "Photograph", ...extra });
  const sign = (key, extra) => preset(key, { kind: "sign", name: "Signature", ...extra });
  const pdf = (name, file, min, max, extra) => ({ kind: "doc", name, file, out: "pdf", w: 0, h: 0, min, max, dpi: 0, ...extra });

  const FORMS = {
    jee: {
      label: "JEE Main (NTA)",
      slots: [
        photo("jee-photo", { hint: "Recent colour photo, face about 80% of the picture, plain white background, ears visible." }),
        sign("jee-sign", { hint: "Sign with a black or blue pen on plain white paper." }),
        pdf("Category certificate (SC / ST / OBC-NCL / EWS)", "Category_certificate", 50, 300, { optional: true }),
        pdf("PwD certificate", "PwD_certificate", 50, 300, { optional: true }),
      ],
    },
    neet: {
      label: "NEET UG (NTA)",
      slots: [
        photo("neet-photo", { name: "Passport-size photograph" }),
        photo("neet-postcard", { name: "Postcard-size photograph (4×6 in)", hint: "Same photo session as the passport photo, showing face and shoulders." }),
        sign("neet-sign"),
        sign("neet-thumb", { kind: "thumb", name: "Left hand thumb impression", file: "Left_thumb", hint: "Press your left thumb in blue or black ink on white paper, then photograph it." }),
        pdf("Category certificate (SC / ST / OBC-NCL / EWS)", "Category_certificate", 50, 300, { optional: true }),
        pdf("Citizenship certificate (if asked)", "Citizenship_certificate", 50, 300, { optional: true }),
        pdf("PwD certificate", "PwD_certificate", 50, 300, { optional: true }),
      ],
    },
    cuet: {
      label: "CUET UG (NTA)",
      slots: [
        photo("cuet-photo"),
        sign("cuet-sign"),
        pdf("Category certificate (SC / ST / OBC-NCL / EWS)", "Category_certificate", 50, 300, { optional: true }),
        pdf("PwD certificate", "PwD_certificate", 50, 300, { optional: true }),
      ],
    },
    ssc: {
      label: "SSC (CGL, CHSL, MTS, GD…)",
      note: "SSC's new portal may also take a live photo with your webcam during the application.",
      slots: [
        photo("ssc-photo", { hint: "Without cap or spectacles, plain light background." }),
        sign("ssc-sign"),
      ],
    },
    upsc: {
      label: "UPSC (CSE, NDA, CDS…)",
      slots: [
        photo("upsc-photo"),
        sign("upsc-sign", { hint: "UPSC sometimes asks for the signature three times in one image; check the notice." }),
        pdf("Photo ID card (Aadhaar, PAN, voter ID…)", "Photo_ID", 0, 300),
      ],
    },
    passport: {
      label: "Passport (India)",
      note: "For a passport application your photo is usually taken at the Passport Seva Kendra. The photo here is the standard 35×45 mm print size, for forms and visas that ask you to upload one.",
      slots: [
        photo("passport", { name: "Passport photo (35×45 mm)", hint: "Plain white background, face straight on, no glasses glare." }),
        pdf("Proof of address", "Address_proof", 0, 1024),
        pdf("Proof of date of birth", "DOB_proof", 0, 1024),
        pdf("Aadhaar card", "Aadhaar", 0, 1024, { optional: true }),
      ],
    },
    nsp: {
      label: "Scholarship (NSP)",
      slots: [
        photo("custom", { w: 350, h: 450, min: 0, max: 200, dpi: 0, file: "Photograph" }),
        pdf("Income certificate", "Income_certificate", 0, 200),
        pdf("Caste / category certificate", "Caste_certificate", 0, 200, { optional: true }),
        pdf("Previous year marksheet", "Marksheet", 0, 200),
        pdf("Fee receipt / bonafide certificate", "Fee_receipt", 0, 200, { optional: true }),
        pdf("Bank passbook (first page)", "Bank_passbook", 0, 200, { optional: true }),
      ],
    },
    kyc: {
      label: "Bank KYC",
      note: "Every bank sets its own limits. These are common ones.",
      slots: [
        photo("custom", { w: 350, h: 450, min: 0, max: 100, dpi: 0, file: "Photograph" }),
        sign("custom", { w: 350, h: 150, min: 0, max: 50, dpi: 0, file: "Signature" }),
        { kind: "card", name: "PAN card", file: "PAN_card", out: "jpeg", w: 0, h: 0, min: 0, max: 200, dpi: 0, hint: "Photograph the card flat on a dark table, filling the frame." },
        pdf("Aadhaar card (front and back)", "Aadhaar", 0, 500),
        pdf("Address proof (if different)", "Address_proof", 0, 500, { optional: true }),
      ],
    },
    custom: {
      label: "Custom (set your own sizes)",
      slots: [
        photo("custom", { w: 350, h: 450, min: 10, max: 100, dpi: 0, file: "Photo" }),
        sign("custom", { w: 350, h: 150, min: 10, max: 50, dpi: 0, file: "Signature" }),
        pdf("Document", "Document", 0, 300),
      ],
    },
  };

  const FMT_LABEL = { jpeg: "JPG", png: "PNG", pdf: "PDF" };
  const MAX_FREE_SIDE = 1200; // longest side for slots with no fixed pixel size
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kbText = (n) => { const k = n / 1024; return k < 10 ? `${k.toFixed(1)} KB` : `${Math.round(k)} KB`; };

  function specText(s) {
    const parts = [FMT_LABEL[s.out] || s.out.toUpperCase()];
    if (s.out !== "pdf") parts.push(s.w && s.h ? `${s.w}×${s.h} px` : s.w ? `${s.w} px wide` : s.h ? `${s.h} px tall` : "any pixel size");
    if (s.min && s.max) parts.push(`${s.min}–${s.max} KB`);
    else if (s.max) parts.push(`up to ${s.max >= 1024 ? `${+(s.max / 1024).toFixed(1)} MB` : `${s.max} KB`}`);
    else if (s.min) parts.push(`at least ${s.min} KB`);
    if (s.dpi && s.out !== "pdf") parts.push(`${s.dpi} dpi`);
    return parts.join(" · ");
  }

  // ----- Image clean-up -----

  /** Grey level of the paper under every pixel, ignoring thin ink: a brightest-neighbour, heavily blurred copy. */
  function paperLevel(canvas) {
    const small = document.createElement("canvas");
    const s = 24 / Math.max(canvas.width, canvas.height);
    small.width = Math.max(2, Math.round(canvas.width * s));
    small.height = Math.max(2, Math.round(canvas.height * s));
    const g = small.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, 0, 0, small.width, small.height);
    // Ink pulls a cell darker; take the brightest of each cell's neighbours so the paper wins.
    const d = g.getImageData(0, 0, small.width, small.height).data;
    const lum = new Float32Array(small.width * small.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const out = new Uint8ClampedArray(lum.length * 4);
    for (let y = 0; y < small.height; y++) {
      for (let x = 0; x < small.width; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < small.width && yy < small.height) m = Math.max(m, lum[yy * small.width + xx]);
        }
        const o = (y * small.width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = m; out[o + 3] = 255;
      }
    }
    g.putImageData(new ImageData(out, small.width, small.height), 0, 0);
    const big = document.createElement("canvas");
    big.width = canvas.width; big.height = canvas.height;
    const bg = big.getContext("2d");
    bg.imageSmoothingEnabled = true;
    bg.imageSmoothingQuality = "high";
    bg.drawImage(small, 0, 0, big.width, big.height);
    return bg.getImageData(0, 0, big.width, big.height).data;
  }

  /**
   * Signature / thumb clean-up: the paper becomes pure white (even with shadows from a phone
   * photo), the ink gets darker, edges stay smooth. The ink keeps its colour (blue stays blue).
   */
  function cleanInk(canvas) {
    const g = canvas.getContext("2d");
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const paper = paperLevel(canvas);
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const ratio = lum / Math.max(paper[i], 40); // 1 = paper, lower = ink
      // 0 = full ink, 1 = paper; anything above 0.82 of the paper level counts as paper.
      let t = (ratio - 0.45) / (0.82 - 0.45);
      t = Math.min(Math.max(t, 0), 1);
      t = t * t * (3 - 2 * t); // smooth edges
      const k = 0.55; // how much darker the ink gets
      d[i] = d[i] * k * (1 - t) + 255 * t;
      d[i + 1] = d[i + 1] * k * (1 - t) + 255 * t;
      d[i + 2] = d[i + 2] * k * (1 - t) + 255 * t;
    }
    g.putImageData(img, 0, 0);
  }

  /** Lighter clean-up for documents: whitens the paper and evens out shadows, keeps the text as is. */
  function whitenPaper(canvas) {
    const g = canvas.getContext("2d");
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const paper = paperLevel(canvas);
    for (let i = 0; i < d.length; i += 4) {
      const s = 255 / (Math.max(paper[i], 60) * 0.94);
      for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] * s);
    }
    g.putImageData(img, 0, 0);
  }

  /**
   * Photo background to white. Estimates the wall colour (allowing a gentle light gradient) from
   * the top, left and right edges, flood-fills from those edges through pixels close to it (so the
   * face and clothes are left alone even if similar in colour), then blends that area to white
   * with a soft edge.
   * Limits: works best on a plain, evenly lit wall; busy backgrounds won't clear fully.
   * Returns the fraction of the picture that was whitened.
   */
  function whiteBackground(canvas) {
    const W = canvas.width, H = canvas.height;
    const g = canvas.getContext("2d");
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const band = Math.max(2, Math.round(Math.min(W, H) * 0.03));
    // Wall colour as a gentle gradient (a plane per channel fitted to the edge pixels), so
    // light falling off across the wall still counts as wall.
    const xs = [], ys = [], cs = [];
    const take = (x, y) => { const o = (y * W + x) * 4; xs.push(x / W); ys.push(y / H); cs.push([d[o], d[o + 1], d[o + 2]]); };
    for (let y = 0; y < band; y++) for (let x = 0; x < W; x += 2) take(x, y);
    for (let y = band; y < H * 0.75; y += 2) for (let x = 0; x < band; x++) { take(x, y); take(W - 1 - x, y); }
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i]; }
    const M = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    const solve = (rhs) => {
      const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(M);
      if (Math.abs(D) < 1e-9) return [rhs[0] / n, 0, 0];
      return [0, 1, 2].map((k) => det(M.map((row, r) => row.map((v, c) => (c === k ? rhs[r] : v)))) / D);
    };
    const plane = [0, 1, 2].map((ch) => {
      let a = 0, bx = 0, by = 0;
      for (let i = 0; i < n; i++) { a += cs[i][ch]; bx += xs[i] * cs[i][ch]; by += ys[i] * cs[i][ch]; }
      return solve([a, bx, by]);
    });
    const wall = (x, y, ch) => plane[ch][0] + plane[ch][1] * (x / W) + plane[ch][2] * (y / H);
    // How much the wall itself varies (texture, noise): sets the tolerance.
    const devs = cs.map((c, i) => Math.hypot(c[0] - (plane[0][0] + plane[0][1] * xs[i] + plane[0][2] * ys[i]),
      c[1] - (plane[1][0] + plane[1][1] * xs[i] + plane[1][2] * ys[i]), c[2] - (plane[2][0] + plane[2][1] * xs[i] + plane[2][2] * ys[i]))).sort((p, q) => p - q);
    const spread = devs[Math.floor(devs.length * 0.8)] || 0;
    const tol = Math.min(Math.max(spread * 2.5 + 14, 22), 60);
    const dist = (p) => {
      const x = p % W, y = (p - x) / W, o = p * 4;
      return Math.hypot(d[o] - wall(x, y, 0), d[o + 1] - wall(x, y, 1), d[o + 2] - wall(x, y, 2));
    };

    const mask = new Uint8Array(W * H);
    const stack = [];
    const tryP = (p) => { if (!mask[p] && dist(p) < tol) { mask[p] = 1; stack.push(p); } };
    for (let x = 0; x < W; x++) tryP(x);
    for (let y = 0; y < H; y++) { tryP(y * W); tryP(y * W + W - 1); }
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      if (x > 0) tryP(p - 1);
      if (x < W - 1) tryP(p + 1);
      if (y > 0) tryP(p - W);
      if (y < H - 1) tryP(p + W);
    }
    let count = 0;
    for (let p = 0; p < mask.length; p++) count += mask[p];
    // Soft edge: blur the mask a little (two box-blur passes).
    let a = Float32Array.from(mask);
    const r = Math.max(1, Math.round(Math.min(W, H) / 220));
    for (let pass = 0; pass < 2; pass++) {
      const t = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        let s = 0, n = 0;
        for (let x = -r; x < W + r; x++) {
          if (x + r < W) { s += a[y * W + x + r]; n++; }
          if (x - r - 1 >= 0) { s -= a[y * W + x - r - 1]; n--; }
          if (x >= 0 && x < W) t[y * W + x] = s / n;
        }
      }
      const u = new Float32Array(W * H);
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let y = -r; y < H + r; y++) {
          if (y + r < H) { s += t[(y + r) * W + x]; n++; }
          if (y - r - 1 >= 0) { s -= t[(y - r - 1) * W + x]; n--; }
          if (y >= 0 && y < H) u[y * W + x] = s / n;
        }
      }
      a = u;
    }
    for (let p = 0; p < W * H; p++) {
      const k = Math.max(a[p], mask[p]);
      if (!k) continue;
      const o = p * 4;
      d[o] += (255 - d[o]) * k; d[o + 1] += (255 - d[o + 1]) * k; d[o + 2] += (255 - d[o + 2]) * k;
    }
    g.putImageData(img, 0, 0);
    return count / (W * H);
  }

  // ----- Geometry -----

  /** Crops or pads src to w×h. mode: "fill" (crop the centre), "top" (crop, keep the head), "fit" (whole picture on white). */
  function shape(src, w, h, mode) {
    if (mode === "fit") {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h);
      g.imageSmoothingQuality = "high";
      const s = Math.min(w / src.width, h / src.height);
      g.drawImage(src, (w - src.width * s) / 2, (h - src.height * s) / 2, src.width * s, src.height * s);
      return c;
    }
    const r = w / h, pr = src.width / src.height;
    let sw = src.width, sh = src.height, sx = 0, sy = 0;
    if (pr > r) { sw = sh * r; sx = (src.width - sw) / 2; } else { sh = sw / r; sy = mode === "top" ? (src.height - sh) * 0.2 : (src.height - sh) / 2; }
    return ImageKit.draw(src, w, h, { background: "#ffffff", sx, sy, sw, sh });
  }

  function targetSize(spec, src) {
    const { w, h } = spec;
    if (w && h) return { w, h, fixed: true };
    if (w) return { w, h: Math.round((src.height * w) / src.width), fixed: true };
    if (h) return { w: Math.round((src.width * h) / src.height), h, fixed: true };
    const s = Math.min(1, MAX_FREE_SIDE / Math.max(src.width, src.height));
    return { w: Math.round(src.width * s), h: Math.round(src.height * s), fixed: false };
  }

  function rotate(src) {
    const c = document.createElement("canvas");
    c.width = src.height; c.height = src.width;
    const g = c.getContext("2d");
    g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0);
    return c;
  }

  // ----- PDF output -----

  /** Adds an unused stream so the PDF reaches at least minBytes (for portals with a minimum size). */
  async function padPdf(bytes, minBytes) {
    if (bytes.length >= minBytes) return bytes;
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    let out = bytes;
    for (let i = 0; i < 3 && out.length < minBytes; i++) {
      const need = minBytes - out.length + 200;
      doc.context.register(doc.context.stream(new Uint8Array(need).fill(0x20)));
      out = await doc.save({ useObjectStreams: false });
    }
    return out;
  }

  async function jpegsToPdf(pages) {
    const doc = await PDFLib.PDFDocument.create();
    for (const p of pages) {
      const img = await doc.embedJpg(p.jpg);
      const page = doc.addPage([p.wPt, p.hPt]);
      page.drawImage(img, { x: 0, y: 0, width: p.wPt, height: p.hPt });
    }
    return doc.save();
  }

  /**
   * Squeezes page pictures into one PDF under maxKB: lowers JPEG quality and, when that isn't
   * enough, pixel size, until it fits. pages: [{ canvas, wPt, hPt }]. Returns { bytes, quality, scale }.
   * JPEG size grows roughly with the pixel count, so the scale is predicted rather than searched,
   * which keeps this to a handful of encodes even for big scans on a phone.
   */
  async function canvasesToPdf(pages, { minKB = 0, maxKB = 0 } = {}) {
    const max = maxKB * 1024;
    const budget = max - (900 + pages.length * 450); // room for the PDF structure
    const scaled = new Map();
    const pagesAt = (scale) => {
      if (scale >= 0.999) return pages.map((p) => p.canvas);
      if (!scaled.has(scale)) scaled.set(scale, pages.map((p) => ImageKit.draw(p.canvas, p.canvas.width * scale, p.canvas.height * scale, { background: "#ffffff" })));
      return scaled.get(scale);
    };
    const encodeAll = async (scale, q) => {
      const cs = pagesAt(scale);
      const out = [];
      for (let i = 0; i < cs.length; i++) out.push({ jpg: await ImageKit.encode(cs[i], "jpeg", q), wPt: pages[i].wPt, hPt: pages[i].hPt });
      return out;
    };
    const total = (enc) => enc.reduce((n, e) => n + e.jpg.length, 0);
    if (max && budget <= 0) throw UserError(`${maxKB} KB is too small for a PDF with ${pages.length} pages.`);

    let chosen = null;
    let scale = 1;
    const topQ = 0.85, floorQ = 0.4;
    let enc = await encodeAll(scale, topQ);
    if (!max || total(enc) <= budget) chosen = { enc, q: topQ, scale };
    let high = { q: topQ, size: total(enc) };
    for (let round = 0; !chosen && round < 4; round++) {
      const low = await encodeAll(scale, floorQ);
      const lowSize = total(low);
      if (lowSize <= budget) {
        // Fits at this size: guess the best quality from how size changed with quality
        // (roughly straight on a log scale), check, and refine twice.
        let best = { enc: low, q: floorQ, scale };
        let lo = { q: floorQ, size: lowSize }, hi = high;
        for (let i = 0; i < 3 && hi.q - lo.q > 0.03; i++) {
          let q = lo.q + (hi.q - lo.q) * Math.log(budget / lo.size) / Math.log(hi.size / lo.size);
          q = Math.min(Math.max(q, lo.q + 0.02), hi.q - 0.02);
          const e = await encodeAll(scale, q);
          const sz = total(e);
          if (sz <= budget) { best = { enc: e, q, scale }; lo = { q, size: sz }; if (sz > budget * 0.93) break; } else hi = { q, size: sz };
        }
        chosen = best;
        break;
      }
      // Too big even at low quality: shrink the pixels by about the amount needed.
      if (scale <= 0.15 + 1e-6) break;
      const ratio = Math.max(0.15, scale * Math.sqrt(budget / lowSize) * 0.97) / scale;
      scale = Math.round(scale * ratio * 1000) / 1000;
      high = { q: topQ, size: high.size * ratio * ratio }; // estimate; corrected by the checks above
    }
    if (!chosen) throw UserError(`Couldn't get this under ${maxKB} KB even at low quality. Try fewer pages, or a closer photo of just the document.`);
    let bytes = await jpegsToPdf(chosen.enc);
    if (max && bytes.length > max) {
      // The structure estimate was a little off: one more notch down.
      bytes = await jpegsToPdf(await encodeAll(chosen.scale, Math.max(0.3, chosen.q - 0.15)));
      if (bytes.length > max) throw UserError(`Couldn't get this under ${maxKB} KB. Try fewer pages.`);
    }
    if (minKB) bytes = await padPdf(bytes, minKB * 1024);
    return { bytes, quality: chosen.q, scale: chosen.scale };
  }

  /** Renders every page of a PDF at dpi into canvases (capped so phones don't run out of memory). */
  async function pdfPages(bytes, dpi = 150) {
    const doc = await PdfRender.open(bytes);
    const out = [];
    const cap = doc.numPages > 6 ? 2.5e6 : 4.5e6;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      let scale = dpi / 72;
      if (base.width * base.height * scale * scale > cap) scale = Math.sqrt(cap / (base.width * base.height));
      const c = document.createElement("canvas");
      await PdfRender.renderPage(page, c, { scale });
      out.push({ canvas: c, wPt: base.width, hPt: base.height });
      page.cleanup();
    }
    await doc.destroy();
    return out;
  }

  // ----- One slot of the checklist -----

  function slotHtml(spec, i, custom) {
    const isPhoto = spec.kind === "photo";
    const imgOut = spec.out !== "pdf";
    return `
      <div class="fk-slot" data-i="${i}">
        <div class="fk-head">
          <span class="fk-mark" aria-hidden="true">${i + 1}</span>
          <div class="fk-title">
            <div class="fk-name">${esc(spec.name)}${spec.optional ? ` <span class="fk-opt">optional</span>` : ""}</div>
            <div class="fk-spec">${esc(specText(spec))}</div>
            ${spec.hint ? `<div class="fk-hint">${esc(spec.hint)}</div>` : ""}
          </div>
        </div>
        <div class="fk-body">
          <div class="fk-thumb" data-role="thumb"><span>No file yet</span></div>
          <div class="fk-ctrls">
            <div class="fk-pick">
              <label class="btn btn-xs fk-btn">${Icons.ui("folder")} Choose file<input type="file" data-role="file" accept="image/*,.heic,.heif,application/pdf,.pdf" hidden></label>
              <label class="btn btn-xs fk-btn">${Icons.ui("camera")} Camera<input type="file" data-role="file" accept="image/*" capture="${isPhoto ? "user" : "environment"}" hidden></label>
            </div>
            <div class="fk-opts" data-role="opts" hidden>
              ${isPhoto ? `<label class="checkbox-group"><input type="checkbox" data-opt="bg"> <span>Make background white <span class="fk-small">(works best on a plain wall; check the preview)</span></span></label>` : ""}
              ${spec.kind === "sign" || spec.kind === "thumb" ? `<label class="checkbox-group"><input type="checkbox" data-opt="clean" checked> <span>Clean up: white paper, darker ink</span></label>` : ""}
              ${spec.kind === "doc" || spec.kind === "card" ? `<label class="checkbox-group"><input type="checkbox" data-opt="paper"> <span>Whiten the paper (for phone photos of documents)</span></label>` : ""}
              <div class="fk-row">
                ${imgOut && spec.w && spec.h ? `<select class="form-select fk-sel" data-opt="fit" aria-label="How to fit the picture">
                  <option value="${isPhoto ? "top" : "fill"}" selected>Crop to shape</option>
                  ${isPhoto ? `<option value="fill">Crop from the centre</option>` : ""}
                  <option value="fit">Whole picture, white edges</option>
                </select>` : ""}
                <button type="button" class="btn btn-xs" data-act="rotate">${Icons.ui("rotate")} Rotate</button>
              </div>
            </div>
            <div class="fk-result" data-role="result"></div>
            <div class="fk-actions" data-role="actions" hidden>
              <button type="button" class="btn btn-xs fk-dl" data-act="download">${Icons.ui("download")} Download</button>
              <button type="button" class="btn btn-xs" data-act="clear">Remove</button>
            </div>
            <details class="fk-edit">
              <summary>Change size or format</summary>
              <div class="fk-grid">
                ${custom ? `<label class="fk-field fk-wide">Name<input class="form-input" data-spec="name" value="${esc(spec.name)}"></label>` : ""}
                <label class="fk-field">Save as<select class="form-select" data-spec="out">
                  ${["jpeg", "png", "pdf"].map((f) => `<option value="${f}" ${spec.out === f ? "selected" : ""}>${FMT_LABEL[f]}</option>`).join("")}
                </select></label>
                <label class="fk-field">DPI<input class="form-input" type="number" min="0" max="1200" data-spec="dpi" value="${spec.dpi || ""}" placeholder="—"></label>
                <label class="fk-field">Width px<input class="form-input" type="number" min="0" max="8000" data-spec="w" value="${spec.w || ""}" placeholder="Any"></label>
                <label class="fk-field">Height px<input class="form-input" type="number" min="0" max="8000" data-spec="h" value="${spec.h || ""}" placeholder="Any"></label>
                <label class="fk-field">Min KB<input class="form-input" type="number" min="0" data-spec="min" value="${spec.min || ""}" placeholder="None"></label>
                <label class="fk-field">Max KB<input class="form-input" type="number" min="0" data-spec="max" value="${spec.max || ""}" placeholder="None"></label>
              </div>
            </details>
          </div>
        </div>
      </div>`;
  }

  const emptySlot = (spec) => ({ spec: { ...spec }, src: null, pdf: null, first: null, firstScale: null, rendered: null, file: null, pages: 0, rot: 0, out: null, error: "", opts: null, fit: null, version: 0 });

  function create(root) {
    root.innerHTML = `
      <div class="fk">
        <div class="form-group">
          <label class="form-label" for="fkForm">Which form are you filling?</label>
          <select id="fkForm" class="form-select">
            ${Object.entries(FORMS).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join("")}
          </select>
          <p class="fk-warn">These are typical sizes from recent notices. <b>Always check the official notice</b> and change a size below if it differs.</p>
          <p class="fk-note" id="fkNote" hidden></p>
        </div>
        <div class="fk-progress" id="fkProgress"></div>
        <div class="fk-list" id="fkList"></div>
        <div class="fk-foot" id="fkFoot"></div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let formKey = "jee";
    let slots = [];
    let queue = Promise.resolve();
    let alive = true;

    function build() {
      const form = FORMS[formKey];
      slots = form.slots.map(emptySlot);
      $("fkNote").hidden = !form.note;
      $("fkNote").textContent = form.note || "";
      renderList();
    }

    function renderList() {
      const custom = formKey === "custom";
      $("fkList").innerHTML = slots.map((s, i) => slotHtml(s.spec, i, custom)).join("");
      $("fkFoot").innerHTML = custom ? `<button type="button" class="btn btn-xs" id="fkAdd">+ Add another document</button>` : "";
      slots.forEach((s, i) => { if (s.src || s.pdf) { showOpts(i); paint(i); } });
      progress();
    }

    const slotEl = (i) => $("fkList").querySelector(`.fk-slot[data-i="${i}"]`);
    const part = (i, role) => slotEl(i).querySelector(`[data-role="${role}"]`);

    function showOpts(i) {
      part(i, "opts").hidden = false;
      const s = slots[i];
      const sel = slotEl(i).querySelector('[data-opt="fit"]');
      if (sel && s.fit && [...sel.options].some((o) => o.value === s.fit)) sel.value = s.fit;
      slotEl(i).querySelectorAll("input[data-opt]").forEach((cb) => { if (s.opts && cb.dataset.opt in s.opts) cb.checked = s.opts[cb.dataset.opt]; });
    }

    function progress() {
      const need = slots.filter((s) => !s.spec.optional);
      const done = need.filter((s) => s.out).length;
      const extra = slots.filter((s) => s.spec.optional && s.out).length;
      $("fkProgress").innerHTML = `<div class="fk-bar"><span style="width:${need.length ? (done / need.length) * 100 : 0}%"></span></div>
        <span>${done} of ${need.length} required ready${extra ? ` · ${extra} optional` : ""}</span>`;
    }

    // ----- loading a file into a slot -----
    async function setFile(i, file) {
      const s = slots[i];
      Object.assign(s, { file, src: null, pdf: null, first: null, firstScale: null, rendered: null, pages: 0, rot: 0, out: null, error: "", opts: null, fit: null });
      const v = ++s.version;
      part(i, "result").className = "fk-result";
      part(i, "result").textContent = "Reading…";
      part(i, "actions").hidden = true;
      try {
        if (ImageKit.isPdfFile(file)) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const doc = await PdfRender.open(bytes);
          const page = await doc.getPage(1);
          const base = page.getViewport({ scale: 1 });
          // Page 1 is the picture when a slot wants an image; otherwise it's just the thumbnail.
          const c = document.createElement("canvas");
          await PdfRender.renderPage(page, c, { scale: s.spec.out === "pdf" ? Math.min(1, 300 / base.width) : 200 / 72 });
          s.pages = doc.numPages;
          await doc.destroy();
          if (v !== s.version) return;
          s.pdf = bytes;
          s.first = c;
          s.firstScale = s.spec.out === "pdf" ? "thumb" : "full";
        } else {
          const bmp = await ImageKit.decode(file);
          const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
          const c = ImageKit.draw(bmp, bmp.width * k, bmp.height * k, { background: "#ffffff" });
          if (bmp.close) bmp.close();
          if (v !== s.version) return;
          s.src = c;
        }
      } catch (e) {
        if (v !== s.version) return;
        s.file = null;
        s.error = e instanceof ClientPDF.UserError ? e.message : `Couldn't read ${file.name}.`;
        paint(i);
        return;
      }
      // Tell the app shell there is something to process, so the main button works.
      if (typeof addFilesToTool === "function") Promise.resolve(addFilesToTool([file])).catch(() => {});
      showOpts(i);
      process(i);
    }

    function readOpts(i) {
      const el = slotEl(i);
      const s = slots[i];
      s.opts = {};
      el.querySelectorAll("input[data-opt]").forEach((cb) => { s.opts[cb.dataset.opt] = cb.checked; });
      const sel = el.querySelector('[data-opt="fit"]');
      s.fit = sel ? sel.value : "fill";
    }

    function process(i) {
      const s = slots[i];
      if (!s.src && !s.pdf) return Promise.resolve();
      readOpts(i);
      const v = ++s.version;
      s.out = null;
      s.error = "";
      paint(i);
      progress();
      const job = queue.then(async () => {
        if (!alive || v !== s.version) return;
        let out;
        try {
          out = await produce(s);
        } catch (e) {
          if (v !== s.version || !alive) return;
          if (!(e instanceof ClientPDF.UserError)) console.warn(e);
          s.error = e instanceof ClientPDF.UserError ? e.message : `Something went wrong: ${e.message}`;
          if (slots[i] === s) paint(i);
          return;
        }
        if (v !== s.version || !alive) return;
        s.out = out;
        if (slots[i] === s) { paint(i); progress(); }
      });
      queue = job.catch(() => {});
      return job;
    }

    async function produce(s) {
      const spec = s.spec;
      const done = (bytes, extra) => {
        const f = ImageKit.FORMATS[extra.fmt || "pdf"];
        return { bytes, filename: `${spec.file}.${f.ext}`, mime: f.mime, ...extra };
      };
      if (spec.min && spec.max && spec.min > spec.max) throw UserError("Minimum KB is bigger than maximum KB.");
      if (spec.out === "pdf") {
        if (s.pdf && !s.rot && !s.opts.paper) {
          // Keep the original when it already fits: text stays sharp and selectable.
          const len = s.pdf.length;
          if ((!spec.max || len <= spec.max * 1024) && (!spec.min || len >= spec.min * 1024)) {
            return done(s.pdf, { pages: s.pages, note: "Already the right size, kept as is." });
          }
          if (spec.min && len < spec.min * 1024) {
            return done(await padPdf(s.pdf, spec.min * 1024), { pages: s.pages, note: "Padded up to the minimum size; the pages are unchanged." });
          }
        }
        let pages;
        if (s.pdf) {
          // Fewer pixels when the KB budget per page is tight: faster, and it would shrink anyway.
          const perPage = spec.max ? spec.max / s.pages : Infinity;
          const dpi = perPage >= 150 ? 150 : perPage >= 60 ? 120 : 96;
          if (!s.rendered || s.rendered.dpi !== dpi) s.rendered = { dpi, pages: await pdfPages(s.pdf, dpi) };
          pages = s.rendered.pages.map((p) => ({ ...p, canvas: ImageKit.draw(p.canvas, p.canvas.width, p.canvas.height) }));
          if (s.rot) {
            pages = pages.map((p) => {
              let c = p.canvas;
              for (let k = 0; k < s.rot; k++) c = rotate(c);
              return { canvas: c, wPt: s.rot % 2 ? p.hPt : p.wPt, hPt: s.rot % 2 ? p.wPt : p.hPt };
            });
          }
        } else {
          let c = s.src;
          for (let k = 0; k < s.rot; k++) c = rotate(c);
          const k = Math.min(1, 1754 / Math.max(c.width, c.height)); // about A4 at 150 dpi
          c = ImageKit.draw(c, c.width * k, c.height * k, { background: "#ffffff" });
          pages = [{ canvas: c, wPt: (c.width * 72) / 150, hPt: (c.height * 72) / 150 }];
        }
        if (s.opts.paper) pages.forEach((p) => whitenPaper(p.canvas));
        const r = await canvasesToPdf(pages, { minKB: spec.min, maxKB: spec.max });
        const note = s.pdf ? "Pages were saved as pictures to fit the size, so their text can't be selected." : "";
        return done(r.bytes, { pages: pages.length, note, preview: pages[0].canvas });
      }
      // Image output
      if (!s.src && s.firstScale !== "full") {
        const doc = await PdfRender.open(s.pdf);
        const c = document.createElement("canvas");
        await PdfRender.renderPage(await doc.getPage(1), c, { scale: 200 / 72 });
        await doc.destroy();
        s.first = c;
        s.firstScale = "full";
      }
      let src = s.src || s.first;
      for (let k = 0; k < s.rot; k++) src = rotate(src);
      const t = targetSize(spec, src);
      const c = t.fixed && spec.w && spec.h ? shape(src, t.w, t.h, s.fit) : ImageKit.draw(src, t.w, t.h, { background: "#ffffff" });
      let note = "";
      if (s.opts.bg && whiteBackground(c) < 0.08) note = "Couldn't find a plain background to whiten. A plain wall works best.";
      if (s.opts.clean) cleanInk(c);
      if (s.opts.paper) whitenPaper(c);
      const fmt = spec.out === "png" ? "png" : "jpeg";
      const r = await ImageKit.fitSize(c, fmt, { minKB: spec.min, maxKB: spec.max, dpi: spec.dpi, allowShrink: !t.fixed });
      return done(r.bytes, { width: r.width, height: r.height, note: [note, r.note].filter(Boolean).join(" "), preview: c, fmt });
    }

    function paint(i) {
      const s = slots[i];
      const el = slotEl(i);
      if (!el) return;
      const res = part(i, "result");
      const thumb = part(i, "thumb");
      el.classList.toggle("is-done", !!s.out);
      el.classList.toggle("is-bad", !!s.error);
      el.querySelector(".fk-mark").textContent = s.out ? "✓" : s.error ? "!" : String(i + 1);
      const pv = (s.out && s.out.preview) || s.src || s.first;
      if (pv) {
        const c = document.createElement("canvas");
        const k = Math.min(1, 220 / pv.width, 220 / pv.height);
        c.width = Math.max(1, Math.round(pv.width * k)); c.height = Math.max(1, Math.round(pv.height * k));
        c.getContext("2d").drawImage(pv, 0, 0, c.width, c.height);
        thumb.innerHTML = "";
        thumb.append(c);
        const pages = (s.out && s.out.pages) || s.pages;
        if (pages > 1) thumb.insertAdjacentHTML("beforeend", `<span class="fk-pages">${pages} pages</span>`);
      } else {
        thumb.innerHTML = "<span>No file yet</span>";
      }
      if (s.error) {
        res.className = "fk-result bad";
        res.textContent = s.error;
      } else if (s.out) {
        const spec = s.spec;
        const size = s.out.bytes.length;
        const ok = (!spec.min || size >= spec.min * 1024) && (!spec.max || size <= spec.max * 1024);
        res.className = `fk-result ${ok ? "ok" : "bad"}`;
        const dims = s.out.width ? `${s.out.width}×${s.out.height} px · ` : s.out.pages ? `${s.out.pages} page${s.out.pages > 1 ? "s" : ""} · ` : "";
        res.innerHTML = `<b>${ok ? "✓" : "✗"} ${esc(s.out.filename)}</b> <span>${dims}${kbText(size)}</span>` +
          (s.out.note ? `<small>${esc(s.out.note)}</small>` : "");
      } else {
        res.className = "fk-result";
        res.textContent = s.src || s.pdf ? "Working…" : "";
      }
      part(i, "actions").hidden = !s.out;
    }

    function redrawSlot(i) {
      const s = slots[i];
      const old = slotEl(i);
      const open = old.querySelector(".fk-edit").open;
      old.outerHTML = slotHtml(s.spec, i, formKey === "custom");
      slotEl(i).querySelector(".fk-edit").open = open;
      if (s.src || s.pdf) { showOpts(i); paint(i); }
    }

    // ----- events -----
    $("fkForm").addEventListener("change", () => { formKey = $("fkForm").value; build(); });
    root.addEventListener("change", (e) => {
      const el = e.target;
      const slot = el.closest(".fk-slot");
      if (!slot) return;
      const i = Number(slot.dataset.i);
      const s = slots[i];
      if (el.dataset.role === "file") {
        if (el.files && el.files[0]) setFile(i, el.files[0]);
        el.value = "";
      } else if (el.dataset.opt) {
        process(i);
      } else if (el.dataset.spec) {
        const key = el.dataset.spec;
        if (key === "name") {
          s.spec.name = el.value.trim() || "Document";
          s.spec.file = s.spec.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "Document";
          slot.querySelector(".fk-name").textContent = s.spec.name;
        } else if (key === "out") {
          s.spec.out = el.value;
        } else {
          s.spec[key] = Math.max(0, Number(el.value) || 0);
        }
        slot.querySelector(".fk-spec").textContent = specText(s.spec);
        if (key === "out" || key === "w" || key === "h") redrawSlot(i); // the fit options depend on these
        process(i);
      }
    });
    root.addEventListener("click", (e) => {
      if (e.target.id === "fkAdd") {
        const n = slots.length + 1;
        slots.push(emptySlot(pdf(`Document ${n}`, `Document_${n}`, 0, 300)));
        renderList();
        return;
      }
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const i = Number(b.closest(".fk-slot").dataset.i);
      const s = slots[i];
      if (b.dataset.act === "rotate") { s.rot = (s.rot + 1) % 4; process(i); }
      if (b.dataset.act === "download" && s.out) save(s.out);
      if (b.dataset.act === "clear") {
        const v = s.version + 1;
        Object.assign(s, emptySlot(s.spec), { version: v });
        redrawSlot(i);
        progress();
      }
    });

    function save(out) {
      const blob = new Blob([out.bytes], { type: out.mime });
      if (typeof downloadBlob === "function") return downloadBlob(blob, out.filename);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: out.filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function result(ctx) {
      if (ctx && ctx.progress) ctx.progress(0.2, "Finishing your files…");
      let pending = null;
      while (pending !== queue) { pending = queue; await pending; } // wait for every slot still working
      const ready = slots.filter((s) => s.out);
      if (!ready.length) throw UserError("Add at least one photo or document to the checklist first.");
      const zip = new JSZip();
      const used = new Set();
      for (const s of ready) {
        let n = s.out.filename, k = 2;
        while (used.has(n.toLowerCase())) n = s.out.filename.replace(/(\.[^.]+)$/, `_${k++}$1`);
        used.add(n.toLowerCase());
        zip.file(n, s.out.bytes);
      }
      if (ctx && ctx.progress) ctx.progress(0.8, "Making the ZIP…");
      const bytes = await zip.generateAsync({ type: "uint8array" });
      const missing = slots.filter((s) => !s.out && !s.spec.optional).map((s) => s.spec.name);
      const label = FORMS[formKey].label.replace(/\s*\(.*\)$/, "").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
      const filename = `${label}_documents.zip`;
      return {
        bytes, filename, mime: "application/zip",
        message: `Done! ${ready.length} file${ready.length > 1 ? "s" : ""} in ${filename}.` +
          (missing.length ? ` Still missing: ${missing.join(", ")}.` : "") + " Nothing was uploaded.",
      };
    }

    build();
    return {
      result,
      destroy() { alive = false; },
      get slots() { return slots; },
      setForm(k) { $("fkForm").value = k; formKey = k; build(); },
      whenIdle: async () => { let p = null; while (p !== queue) { p = queue; await p; } },
    };
  }

  return { FORMS, create, cleanInk, whiteBackground, whitenPaper, canvasesToPdf, padPdf, specText };
})();

// ---------- Register the tools ----------

TOOLS.push({
  id: "exam-form-kit",
  slug: "exam-form-kit",
  name: "Exam & Govt Form Kit",
  desc: "Every photo, signature, thumb impression and certificate for JEE, NEET, CUET, SSC, UPSC, passport, scholarship or bank KYC forms, at the exact size. Download one by one or as a ZIP.",
  keywords: "exam form documents jee main neet ug cuet ssc cgl chsl upsc nda passport seva nsp national scholarship portal bank kyc photo signature thumb impression left thumb category certificate obc sc st ews pwd certificate kb resize compress pdf under 300 kb 200 kb 50 kb 20 kb white background signature cleanup nta application form upload government form india",
  icon: "🎓",
  category: "image",
  badge: "India forms",
  caption: "Every upload, exact size",
  scene: "check",
  accept: "image/*,.heic,.heif,application/pdf,.pdf",
  acceptLabel: "photos or PDFs",
  multipleFiles: true,
  wide: true,
  actionLabel: "Download all as ZIP",
  configHtml: `<div id="formKitRoot"></div>`,
  onOpen(ctx) {
    const dz = document.getElementById("dropZone");
    if (dz) dz.style.display = "none"; // each checklist slot has its own file picker
    ctx.formKit = FormKit.create(ctx.el("formKitRoot"));
  },
  onClose(ctx) {
    const dz = document.getElementById("dropZone");
    if (dz) dz.style.display = "";
    if (ctx && ctx.formKit) ctx.formKit.destroy();
  },
  run: (ctx) => ctx.formKit.result(ctx),
});

TOOLS.push({
  id: "heic-to-jpg",
  slug: "heic-to-jpg",
  aliases: ["heic-to-jpeg", "heif-to-jpg", "heic-to-png"],
  name: "HEIC to JPG",
  desc: "Turn iPhone HEIC and HEIF photos into JPG (or PNG) that every website and form accepts. Many photos at once.",
  keywords: "heic to jpg heic to jpeg heif iphone photo convert heic converter apple photos ios image open heic on windows heic to png",
  icon: "📱",
  category: "image",
  badge: "iPhone",
  caption: "iPhone photos → JPG",
  flip: ["HEIC", "JPG"],
  accept: ".heic,.heif,image/heic,image/heif,image/*",
  acceptLabel: "HEIC photos",
  multipleFiles: true,
  actionLabel: "Convert & download",
  configHtml: HeicConvert.configHtml,
  onInput: HeicConvert.onInput,
  run: HeicConvert.run,
});
