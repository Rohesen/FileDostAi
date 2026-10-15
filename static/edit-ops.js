// Edit PDF: applies the objects drawn in the Edit PDF tool (edit-tool.js) to the PDF with pdf-lib.
// Runs in the Web Worker (pdf-worker.js), on the page as a fallback, and under Node for tests.
// It never touches the DOM.
//
// Coordinates are PDF points in the page as the reader sees it (after /Rotate), measured from
// the TOP-LEFT corner, y growing downwards. A transformation matrix maps that space onto the
// page's own coordinates, so rotated pages work for every kind of object.
//
// edits: [{ page: 0-based, type, ... }] where type is one of
//   text      { x, y, size, text, font: "sans"|"serif"|"mono", bold, italic, color: "#rrggbb",
//               align: "left"|"center"|"right", opacity, lineHeight (em, default 1.2),
//               raster?: { bytes: Uint8Array PNG, w, h }   picture of the text (any script)
//               cover?:  { x, y, w, h, color }             box hiding text that is being replaced }
//   image     { x, y, w, h, bytes: Uint8Array, mime: "image/png"|"image/jpeg", opacity }
//   rect, ellipse { x, y, w, h, stroke: "#rrggbb"|null, fill: "#rrggbb"|null, strokeWidth, opacity }
//   line, arrow   { x1, y1, x2, y2, stroke, strokeWidth, opacity }
//   highlight { x, y, w, h, color, opacity }   (multiply blend, so text under it stays dark)
//   whiteout  { x, y, w, h, color }            (opaque box, white by default)
//   pen       { paths: [[x0, y0, x1, y1, ...], ...], stroke, strokeWidth, opacity }

(function (root) {
  "use strict";

  const PDFLib = root.PDFLib;
  const {
    PDFDocument, StandardFonts, rgb, BlendMode, LineCapStyle, LineJoinStyle,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, setLineJoin,
  } = PDFLib;
  const UserError = (root.ClientPDF && root.ClientPDF.UserError) || class UserError extends Error {};

  // Font metrics (ascent, descent in em) of the browser fonts the editor previews with
  // (Arial / Times New Roman / Courier New and their metric-compatible Liberation twins).
  // Text is placed so its baseline matches the preview's CSS line box. Keep in sync with edit-tool.js.
  const METRICS = { sans: [0.905, 0.212], serif: [0.891, 0.216], mono: [0.833, 0.3] };
  function baselineOffset(font, lineHeight) {
    const [a, d] = METRICS[font] || METRICS.sans;
    return (lineHeight - (a + d)) / 2 + a;
  }

  const FONT_NAMES = {
    sans: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
    serif: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
    mono: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
  };

  const num = (v, d = 0) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp01 = (v, d = 1) => Math.min(Math.max(num(v, d), 0), 1);

  function color(hex, fallback = "#000000") {
    let h = String(hex || fallback).trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}$/i.test(h)) return color(fallback);
    return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  }

  async function load(bytes) {
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      throw new UserError("This file doesn't look like a valid PDF.");
    }
    if (doc.isEncrypted) throw new UserError("This PDF is password protected. Use Unlock PDF first.");
    return doc;
  }

  /** Size of the page as displayed, and the matrix from displayed (bottom-left, y up) to page space. */
  function pageFrame(page) {
    const box = page.getCropBox();
    const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
    const { x: bx, y: by, width: bw, height: bh } = box;
    switch (rot) {
      case 90: return { W: bh, H: bw, m: [0, 1, -1, 0, bx + bw, by] };
      case 180: return { W: bw, H: bh, m: [-1, 0, 0, -1, bx + bw, by + bh] };
      case 270: return { W: bh, H: bw, m: [0, -1, 1, 0, bx, by + bh] };
      default: return { W: bw, H: bh, m: [1, 0, 0, 1, bx, by] };
    }
  }

  async function applyEdits(bytes, edits) {
    if (!Array.isArray(edits) || !edits.length) throw new UserError("Make at least one change to the PDF first.");
    const doc = await load(bytes);
    const pages = doc.getPages();
    const fonts = new Map();
    const images = new Map();

    async function font(e) {
      const family = FONT_NAMES[e.font] ? e.font : "sans";
      const name = FONT_NAMES[family][(e.bold ? 1 : 0) + (e.italic ? 2 : 0)];
      if (!fonts.has(name)) fonts.set(name, await doc.embedFont(StandardFonts[name]));
      return fonts.get(name);
    }
    async function image(data, mime) {
      if (!images.has(data)) {
        let img;
        try {
          img = mime === "image/jpeg" ? await doc.embedJpg(data) : await doc.embedPng(data);
        } catch (err) {
          throw new UserError("One of the images couldn't be read. Try a PNG or JPG file.");
        }
        images.set(data, img);
      }
      return images.get(data);
    }

    // Group by page, keeping the order (later objects are drawn on top).
    const byPage = new Map();
    for (const e of edits) {
      const p = num(e && e.page, -1);
      if (!Number.isInteger(p) || p < 0 || p >= pages.length) throw new UserError(`Page ${p + 1} doesn't exist in this PDF.`);
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(e);
    }

    for (const [p, list] of byPage) {
      const page = pages[p];
      const { H, m } = pageFrame(page);
      const Y = (y) => H - num(y); // top-left y to bottom-left y
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));

      // Boxes that hide replaced text go first, so they never cover anything added on top.
      for (const e of list) {
        if (e.type === "text" && e.cover) {
          const c = e.cover;
          page.drawRectangle({ x: num(c.x), y: Y(num(c.y) + num(c.h)), width: num(c.w), height: num(c.h), color: color(c.color, "#ffffff") });
        }
      }

      for (const e of list) {
        const opacity = clamp01(e.opacity, 1);
        switch (e.type) {
          case "text": await drawText(page, e, Y, opacity); break;
          case "image": {
            const img = await image(e.bytes, e.mime);
            page.drawImage(img, { x: num(e.x), y: Y(num(e.y) + num(e.h)), width: num(e.w), height: num(e.h), opacity });
            break;
          }
          case "rect":
          case "whiteout":
          case "highlight": {
            const base = { x: num(e.x), y: Y(num(e.y) + num(e.h)), width: num(e.w), height: num(e.h) };
            if (e.type === "whiteout") page.drawRectangle({ ...base, color: color(e.color, "#ffffff") });
            else if (e.type === "highlight") {
              page.drawRectangle({ ...base, color: color(e.color, "#ffe94d"), opacity: clamp01(e.opacity, 0.5), blendMode: BlendMode.Multiply });
            } else page.drawRectangle({ ...base, ...paint(e, opacity) });
            break;
          }
          case "ellipse":
            page.drawEllipse({
              x: num(e.x) + num(e.w) / 2, y: Y(num(e.y) + num(e.h) / 2),
              xScale: Math.abs(num(e.w)) / 2, yScale: Math.abs(num(e.h)) / 2, ...paint(e, opacity),
            });
            break;
          case "line":
          case "arrow": drawLine(page, e, Y, opacity); break;
          case "pen": drawPen(page, e, Y, opacity); break;
          default: throw new UserError(`Unknown edit "${e.type}".`);
        }
      }
      page.pushOperators(popGraphicsState());
    }

    async function drawText(page, e, Y, opacity) {
      const size = Math.max(num(e.size, 12), 1);
      const lh = num(e.lineHeight, 1.2);
      if (e.raster && e.raster.bytes) {
        const img = await image(e.raster.bytes, "image/png");
        const w = num(e.raster.w), h = num(e.raster.h);
        page.drawImage(img, { x: num(e.x), y: Y(num(e.y) + h), width: w, height: h, opacity });
        return;
      }
      const text = String(e.text || "").replace(/\r\n?/g, "\n");
      if (!text.trim()) return;
      const f = await font(e);
      const lines = text.split("\n");
      for (const line of lines) {
        try {
          f.encodeText(line);
        } catch (err) {
          throw new UserError("Some text has characters the standard PDF fonts can't draw. Edit that text box again so it can be saved as an image.");
        }
      }
      const widths = lines.map((l) => f.widthOfTextAtSize(l, size));
      const boxW = Math.max(...widths);
      const off = baselineOffset(e.font, lh) * size;
      lines.forEach((line, i) => {
        if (!line) return;
        let x = num(e.x);
        if (e.align === "center") x += (boxW - widths[i]) / 2;
        else if (e.align === "right") x += boxW - widths[i];
        page.drawText(line, { x, y: Y(num(e.y) + i * lh * size + off), size, font: f, color: color(e.color), opacity });
      });
    }

    function paint(e, opacity) {
      const out = {};
      if (e.fill) Object.assign(out, { color: color(e.fill), opacity });
      if (e.stroke && num(e.strokeWidth, 0) > 0) {
        Object.assign(out, { borderColor: color(e.stroke), borderWidth: num(e.strokeWidth), borderOpacity: opacity });
      }
      return out;
    }

    function drawLine(page, e, Y, opacity) {
      const w = Math.max(num(e.strokeWidth, 2), 0.1);
      const x1 = num(e.x1), y1 = Y(e.y1), x2 = num(e.x2), y2 = Y(e.y2);
      const c = color(e.stroke);
      let ex = x2, ey = y2;
      if (e.type === "arrow") {
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const head = Math.min(Math.max(w * 4, 8), len * 0.6);
        const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        const bx = x2 - ux * head, by = y2 - uy * head;
        const half = head * 0.5;
        // Stop the shaft inside the head so its round end doesn't poke out of the tip.
        ex = x2 - ux * head * 0.6; ey = y2 - uy * head * 0.6;
        // drawSvgPath flips y around its origin, so negate y with the origin at (0, 0).
        const pts = [[x2, y2], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
        page.drawSvgPath(`M ${pts.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join(" L ")} Z`, { x: 0, y: 0, color: c, opacity });
      }
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: ex, y: ey }, thickness: w, color: c, opacity, lineCap: LineCapStyle.Round });
    }

    function drawPen(page, e, Y, opacity) {
      const paths = (e.paths || []).filter((p) => p && p.length >= 2);
      if (!paths.length) return;
      let d = "";
      for (const p of paths) {
        const pts = [];
        for (let i = 0; i + 1 < p.length; i += 2) pts.push(`${num(p[i]).toFixed(2)} ${(-Y(p[i + 1])).toFixed(2)}`);
        if (pts.length === 1) pts.push(pts[0]); // a dot
        d += `M ${pts.join(" L ")} `;
      }
      page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
      page.drawSvgPath(d, {
        x: 0, y: 0, borderColor: color(e.stroke), borderWidth: Math.max(num(e.strokeWidth, 2), 0.1),
        borderOpacity: opacity, borderLineCap: LineCapStyle.Round,
      });
      page.pushOperators(popGraphicsState());
    }

    return { bytes: await doc.save(), filename: "edited.pdf", mime: "application/pdf" };
  }

  if (root.ClientPDF) root.ClientPDF.applyEdits = applyEdits;
  if (typeof module === "object" && module.exports) module.exports = { applyEdits, baselineOffset, METRICS };
})(typeof self !== "undefined" ? self : globalThis);
