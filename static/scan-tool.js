// Scan to PDF: take or add photos of paper pages, find the page edges, straighten them,
// clean them up and save one PDF. Everything runs in the browser. The pixel work runs in a
// Worker (OffscreenCanvas); without one it runs on the page in small slices so it never freezes.
//
// Used by tools.js: ScanTool.create(rootEl) -> { setFiles(File[]), pages(), destroy() }.
// pages() resolves to [{ bytes: Uint8Array, type: "image/jpeg" | "image/png" }], one per page.

const ScanTool = (() => {
  const DISPLAY_MAX = 1600; // long edge kept in memory per page, for editing and previews
  const DETECT_MAX = 480; // long edge used to find the page edges
  const PREVIEW_MAX = 1100; // long edge of the on-screen result
  const OUTPUT_MAX = 2500; // long edge of each page in the PDF
  const JPEG_QUALITY = 0.85;
  const PAPERS = { fit: 0, a4: 297 / 210, letter: 11 / 8.5 };
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const FILTERS = [
    { id: "original", label: "Original" },
    { id: "enhanced", label: "Enhanced" },
    { id: "gray", label: "Grayscale" },
    { id: "bw", label: "B&W" },
  ];

  /* ======================================================================
   * Image core. Pure functions on RGBA arrays. It is also turned into a
   * Worker with Function#toString, so it must not use anything from outside.
   * ==================================================================== */
  function scanCore() {
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const FULL_Q = [[0, 0], [1, 0], [1, 1], [0, 1]];

    // ---------- helpers for detection ----------
    function grayOf(rgba, n) {
      const g = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      return g;
    }

    // Separable box blur; two passes are close to a Gaussian.
    function boxBlur(src, w, h, r) {
      const tmp = new Float32Array(w * h);
      const out = new Float32Array(w * h);
      const norm = 1 / (2 * r + 1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = acc * norm;
          acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = acc * norm;
          acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
        }
      }
      return out;
    }

    function sobel(g, w, h) {
      const n = w * h;
      const gx = new Float32Array(n);
      const gy = new Float32Array(n);
      const mag = new Float32Array(n);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
          const d = g[i - 1], f = g[i + 1];
          const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
          const sx = c + 2 * f + r - (a + 2 * d + p);
          const sy = p + 2 * q + r - (a + 2 * b + c);
          gx[i] = sx;
          gy[i] = sy;
          mag[i] = Math.sqrt(sx * sx + sy * sy);
        }
      }
      return { gx, gy, mag, w, h, thr: 0 };
    }

    function otsu(g) {
      const hist = new Float64Array(256);
      for (let i = 0; i < g.length; i++) hist[clamp(g[i] | 0, 0, 255)]++;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, best = -1, t = 128;
      for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        const wF = g.length - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const diff = sumB / wB - (sum - sumB) / wF;
        const between = wB * wF * diff * diff;
        if (between > best) { best = between; t = i; }
      }
      return t;
    }

    function percentile(arr, p) {
      const step = Math.max(1, Math.floor(arr.length / 30000));
      const s = [];
      for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
      s.sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0;
    }

    // 3x3 dilation (grow = true) or erosion.
    function morph(mask, w, h, grow) {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = grow ? 0 : 1;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const m = yy < 0 || yy >= h || xx < 0 || xx >= w ? 0 : mask[yy * w + xx];
              if (grow && m) v = 1;
              if (!grow && !m) v = 0;
            }
          }
          out[y * w + x] = v;
        }
      }
      return out;
    }

    // Largest 4-connected region of the mask; returns its boundary pixels and size.
    function largestComponent(mask, w, h) {
      const n = w * h;
      const lab = new Int32Array(n);
      const stack = new Int32Array(n);
      let cur = 0, best = 0, bestSize = 0;
      for (let s = 0; s < n; s++) {
        if (!mask[s] || lab[s]) continue;
        cur++;
        let sp = 0, size = 0;
        stack[sp++] = s;
        lab[s] = cur;
        while (sp) {
          const i = stack[--sp];
          size++;
          const x = i % w;
          if (x > 0 && mask[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; stack[sp++] = i - 1; }
          if (x < w - 1 && mask[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; stack[sp++] = i + 1; }
          if (i >= w && mask[i - w] && !lab[i - w]) { lab[i - w] = cur; stack[sp++] = i - w; }
          if (i < n - w && mask[i + w] && !lab[i + w]) { lab[i + w] = cur; stack[sp++] = i + w; }
        }
        if (size > bestSize) { bestSize = size; best = cur; }
      }
      if (!best) return null;
      const pts = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (lab[i] !== best) continue;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
              lab[i - 1] !== best || lab[i + 1] !== best || lab[i - w] !== best || lab[i + w] !== best) {
            pts.push([x + 0.5, y + 0.5]);
          }
        }
      }
      return { pts, size: bestSize };
    }

    const cross3 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    function convexHull(points) {
      const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (pts.length < 3) return pts;
      const lower = [];
      for (const p of pts) {
        while (lower.length >= 2 && cross3(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
      }
      const upper = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross3(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
      }
      upper.pop();
      lower.pop();
      return lower.concat(upper);
    }

    // Reduce a convex hull to 4 points by repeatedly dropping the vertex that adds the least area.
    function hullToQuad(hull) {
      if (!hull || hull.length < 4) return null;
      const pts = hull.slice();
      while (pts.length > 4) {
        let mi = 0, ma = Infinity;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = Math.abs(cross3(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]));
          if (a < ma) { ma = a; mi = i; }
        }
        pts.splice(mi, 1);
      }
      return pts;
    }

    // Clockwise (on screen) starting at the corner whose next edge points most to the right,
    // so a slightly rotated page keeps its top edge on top.
    function orderCorners(q) {
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
      const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
      let start = 0, best = -Infinity;
      for (let i = 0; i < 4; i++) {
        const a = s[i], b = s[(i + 1) % 4];
        const dx = (b[0] - a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
        if (dx > best) { best = dx; start = i; }
      }
      return [0, 1, 2, 3].map((k) => s[(start + k) % 4].slice());
    }

    function polyArea(q) {
      let a = 0;
      for (let i = 0; i < q.length; i++) {
        const p = q[i], r = q[(i + 1) % q.length];
        a += p[0] * r[1] - r[0] * p[1];
      }
      return Math.abs(a) / 2;
    }

    function isReasonable(q, w, h) {
      if (!q || q.length !== 4 || q.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) return false;
      if (polyArea(q) < 0.1 * w * h) return false;
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
        const cr = cross3(a, b, c);
        if (!sign) sign = Math.sign(cr);
        else if (Math.sign(cr) !== sign) return false;
        const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        if (lu < 0.12 * Math.min(w, h) || lv < 0.12 * Math.min(w, h)) return false;
        if (Math.abs((ux * vx + uy * vy) / (lu * lv)) > 0.85) return false; // angle outside ~32..148 degrees
      }
      return true;
    }

    // Fit a line to strong edge pixels along each side, then intersect neighbouring lines.
    function refine(q, ed, band) {
      const { gx, gy, mag, w, h, thr } = ed;
      const lines = [];
      for (let s = 0; s < 4; s++) {
        const P = q[s], Q = q[(s + 1) % 4];
        const dx = Q[0] - P[0], dy = Q[1] - P[1];
        const L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
        const x0 = clamp(Math.floor(Math.min(P[0], Q[0]) - band), 1, w - 2);
        const x1 = clamp(Math.ceil(Math.max(P[0], Q[0]) + band), 1, w - 2);
        const y0 = clamp(Math.floor(Math.min(P[1], Q[1]) - band), 1, h - 2);
        const y1 = clamp(Math.ceil(Math.max(P[1], Q[1]) + band), 1, h - 2);
        let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, cnt = 0;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = y * w + x;
            const m = mag[i];
            if (m <= thr) continue;
            const px = x + 0.5 - P[0], py = y + 0.5 - P[1];
            const t = (px * ux + py * uy) / L;
            if (t < 0.08 || t > 0.92) continue;
            if (Math.abs(px * nx + py * ny) > band) continue;
            if (Math.abs(gx[i] * nx + gy[i] * ny) < 0.8 * m) continue;
            const X = x + 0.5, Y = y + 0.5;
            sw += m; sx += m * X; sy += m * Y; sxx += m * X * X; syy += m * Y * Y; sxy += m * X * Y; cnt++;
          }
        }
        if (cnt < 8) { lines.push([P[0], P[1], ux, uy]); continue; }
        const mx = sx / sw, my = sy / sw;
        const cxx = sxx / sw - mx * mx, cyy = syy / sw - my * my, cxy = sxy / sw - mx * my;
        const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        let lx = Math.cos(ang), ly = Math.sin(ang);
        if (lx * ux + ly * uy < 0) { lx = -lx; ly = -ly; }
        lines.push([mx, my, lx, ly]);
      }
      const out = [];
      for (let c = 0; c < 4; c++) {
        const a = lines[(c + 3) % 4], b = lines[c];
        const det = a[2] * b[3] - a[3] * b[2];
        let p = q[c];
        if (Math.abs(det) > 1e-6) {
          const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / det;
          const cand = [a[0] + t * a[2], a[1] + t * a[3]];
          if (Math.hypot(cand[0] - p[0], cand[1] - p[1]) < 2.5 * band) p = cand;
        }
        out.push([p[0], p[1]]);
      }
      return out;
    }

    // Share of points along the 4 sides that sit on a strong edge running the same way.
    function support(q, ed) {
      const { gx, gy, mag, w, h, thr } = ed;
      const N = 48;
      let total = 0, minS = 1;
      for (let s = 0; s < 4; s++) {
        const P = q[s], Q = q[(s + 1) % 4];
        const dx = Q[0] - P[0], dy = Q[1] - P[1];
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;
        let hits = 0;
        for (let k = 0; k < N; k++) {
          const t = 0.06 + (0.88 * k) / (N - 1);
          const x = P[0] + t * dx, y = P[1] + t * dy;
          for (let o = -3; o <= 3; o++) {
            const xi = Math.floor(x + o * nx), yi = Math.floor(y + o * ny);
            if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
            const i = yi * w + xi;
            const m = mag[i];
            if (m > thr && Math.abs(gx[i] * nx + gy[i] * ny) > 0.75 * m) { hits++; break; }
          }
        }
        const sc = hits / N;
        total += sc;
        minS = Math.min(minS, sc);
      }
      return 0.6 * (total / 4) + 0.4 * minS;
    }

    /**
     * Finds the page in a small RGBA image.
     * Returns { corners: [[x,y] x4] in pixels (clockwise from top-left) or null, confidence 0..1 }.
     */
    function detect(rgba, w, h) {
      const n = w * h;
      const g0 = grayOf(rgba, n);
      const r = Math.max(1, Math.round(Math.max(w, h) / 240));
      const g = boxBlur(boxBlur(g0, w, h, r), w, h, r);
      const ed = sobel(g, w, h);
      ed.thr = clamp(0.3 * percentile(ed.mag, 0.985), 14, 120);

      const regions = [];
      const keep = (c) => { if (c && c.size > 0.06 * n && c.size < 0.97 * n) regions.push(c.pts); };

      // 1) The page is usually brighter than what it lies on.
      const t = otsu(g);
      let sb = 0, nb = 0;
      for (let i = 0; i < n; i++) if (g[i] > t) { sb += g[i]; nb++; }
      const hi = nb ? sb / nb : 255;
      for (const thr of [t, (t + hi) / 2, t - (hi - t) * 0.4]) {
        const mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) mask[i] = g[i] > thr ? 1 : 0;
        keep(largestComponent(morph(mask, w, h, false), w, h));
      }

      // 2) The largest area closed off by strong edges (works for light-on-light too).
      const edge = new Uint8Array(n);
      for (let i = 0; i < n; i++) edge[i] = ed.mag[i] > ed.thr ? 1 : 0;
      const wall = morph(edge, w, h, true);
      const outside = new Uint8Array(n);
      const stack = new Int32Array(n);
      let sp = 0;
      const seed = (i) => { if (!wall[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (sp) {
        const i = stack[--sp];
        const x = i % w;
        if (x > 0) seed(i - 1);
        if (x < w - 1) seed(i + 1);
        if (i >= w) seed(i - w);
        if (i < n - w) seed(i + w);
      }
      const inside = new Uint8Array(n);
      for (let i = 0; i < n; i++) inside[i] = !wall[i] && !outside[i] ? 1 : 0;
      keep(largestComponent(inside, w, h));

      const diag = Math.hypot(w, h);
      let best = null;
      for (const pts of regions) {
        const quad = hullToQuad(convexHull(pts));
        if (!quad) continue;
        let q = orderCorners(quad);
        q = refine(q, ed, Math.max(2.5, diag * 0.025));
        q = refine(q, ed, Math.max(1.5, diag * 0.012));
        if (!isReasonable(q, w, h)) continue;
        const s = support(q, ed);
        const score = s * (0.7 + 0.3 * Math.sqrt(polyArea(q) / n));
        if (!best || score > best.score) best = { q, s, score };
      }
      if (!best || best.s < 0.4) return { corners: null, confidence: best ? best.s : 0 };
      return { corners: best.q, confidence: best.s };
    }

    // ---------- geometry ----------
    function solve(A, b) {
      const n = b.length;
      for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]];
        [b[c], b[p]] = [b[p], b[c]];
        for (let r = 0; r < n; r++) {
          if (r === c) continue;
          const f = A[r][c] / A[c][c];
          if (!f) continue;
          for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
          b[r] -= f * b[c];
        }
      }
      return b.map((v, i) => v / A[i][i]);
    }

    // 3x3 homography (h33 = 1) taking the 4 `from` points to the 4 `to` points.
    function homography(from, to) {
      const A = [], b = [];
      for (let i = 0; i < 4; i++) {
        const [x, y] = from[i], [X, Y] = to[i];
        A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
      }
      return solve(A, b);
    }

    const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dotV = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // Real width/height of a photographed rectangle (Zhang & He, "Whiteboard scanning"),
    // estimating the camera's focal length from the quad. Falls back to the affine estimate.
    function aspect(q, sw, sh) {
      const u0 = sw / 2, v0 = sh / 2;
      const m = (p) => [p[0] - u0, p[1] - v0, 1];
      const m1 = m(q[0]), m2 = m(q[1]), m4 = m(q[2]), m3 = m(q[3]);
      const k2 = dotV(crossV(m1, m4), m3) / dotV(crossV(m2, m4), m3);
      const k3 = dotV(crossV(m1, m4), m2) / dotV(crossV(m3, m4), m2);
      const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
      const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
      const affine = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (n3[0] ** 2 + n3[1] ** 2));
      if (Math.abs(n2[2]) > 1e-4 && Math.abs(n3[2]) > 1e-4) {
        const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
        const f = Math.sqrt(f2);
        const big = Math.max(sw, sh);
        if (f2 > 0 && f > 0.3 * big && f < 5 * big) {
          const r = Math.sqrt(((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / ((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2));
          if (isFinite(r) && r > 0) return r;
        }
      }
      return affine;
    }

    function isFull(c) {
      return c.every((p, i) => Math.abs(p[0] - FULL_Q[i][0]) < 1e-6 && Math.abs(p[1] - FULL_Q[i][1]) < 1e-6);
    }

    // Output size in source pixels for corners q (pixels).
    function docSize(q, sw, sh, full) {
      if (full) return { W: sw, H: sh };
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const W0 = Math.max(d(q[0], q[1]), d(q[3], q[2]), 1);
      const H0 = Math.max(d(q[0], q[3]), d(q[1], q[2]), 1);
      const simple = W0 / H0;
      let r = aspect(q, sw, sh);
      if (!(r > 0) || r / simple > 1.6 || r / simple < 0.625) r = simple;
      const W = Math.max(W0, H0 * r);
      return { W, H: W / r };
    }

    // Perspective warp with bilinear sampling. src is RGBA sw x sh, q the 4 corners in it.
    async function warp(src, sw, sh, q, W, H, pause) {
      const hm = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
      const out = new Uint8ClampedArray(W * H * 4);
      if (!hm) return out.fill(255);
      const [a, b, c, d, e, f, g, h] = hm;
      const maxX = sw - 1, maxY = sh - 1;
      for (let y = 0; y < H; y++) {
        const v = y + 0.5;
        let o = y * W * 4;
        for (let x = 0; x < W; x++, o += 4) {
          const u = x + 0.5;
          const den = g * u + h * v + 1;
          let sx = (a * u + b * v + c) / den - 0.5;
          let sy = (d * u + e * v + f) / den - 0.5;
          if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
          if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
          const x0 = sx | 0, y0 = sy | 0;
          const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
          const fx = sx - x0, fy = sy - y0;
          const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
          out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
          out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
          out[o + 3] = 255;
        }
        if ((y & 31) === 31) await pause();
      }
      return out;
    }

    // ---------- filters ----------
    function lumaOf(d, n) {
      const L = new Uint8Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (77 * d[j] + 150 * d[j + 1] + 29 * d[j + 2]) >> 8;
      return L;
    }

    // Brightness of the paper across the page (a coarse grid), so shadows and uneven light can be evened out.
    function paperLevels(L, w, h) {
      const s = Math.max(8, Math.round(Math.max(w, h) / 40));
      const gw = Math.ceil(w / s), gh = Math.ceil(h / s);
      let grid = new Float32Array(gw * gh);
      const hist = new Uint32Array(64);
      for (let by = 0; by < gh; by++) {
        for (let bx = 0; bx < gw; bx++) {
          hist.fill(0);
          let n = 0;
          const yEnd = Math.min(h, (by + 1) * s), xEnd = Math.min(w, (bx + 1) * s);
          for (let y = by * s; y < yEnd; y += 2) for (let x = bx * s; x < xEnd; x += 2) { hist[L[y * w + x] >> 2]++; n++; }
          let k = 63, acc = 0;
          const want = n * 0.08;
          while (k > 0 && acc + hist[k] < want) { acc += hist[k]; k--; }
          grid[by * gw + bx] = k * 4 + 2;
        }
      }
      const filt = (src, useMax) => {
        const out = new Float32Array(src.length);
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            let acc = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const yy = y + dy, xx = x + dx;
                if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
                const v = src[yy * gw + xx];
                if (useMax) acc = Math.max(acc, v); else { acc += v; cnt++; }
              }
            }
            out[y * gw + x] = useMax ? acc : acc / cnt;
          }
        }
        return out;
      };
      grid = filt(grid, true);
      const sorted = Array.from(grid).sort((a, b) => a - b);
      const paper = Math.max(60, sorted[Math.floor(sorted.length * 0.9)]);
      for (let i = 0; i < grid.length; i++) if (grid[i] < paper * 0.55) grid[i] = paper; // a dark picture, not paper in shade
      grid = filt(filt(grid, false), false);
      const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xt = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const fx = clamp((x + 0.5) / s - 0.5, 0, gw - 1);
        xi0[x] = fx | 0; xi1[x] = Math.min(gw - 1, xi0[x] + 1); xt[x] = fx - xi0[x];
      }
      return function row(y, out) {
        const fy = clamp((y + 0.5) / s - 0.5, 0, gh - 1);
        const y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < w; x++) {
          const a = grid[y0 * gw + xi0[x]] * (1 - xt[x]) + grid[y0 * gw + xi1[x]] * xt[x];
          const b = grid[y1 * gw + xi0[x]] * (1 - xt[x]) + grid[y1 * gw + xi1[x]] * xt[x];
          out[x] = a * (1 - ty) + b * ty;
        }
      };
    }

    // A hairline of the table can show at the very edge after straightening; scans have paper there.
    function whiteBorder(d, w, h) {
      const b = Math.max(1, Math.round(Math.min(w, h) * 0.003));
      for (let y = 0; y < h; y++) {
        const edgeRow = y < b || y >= h - b;
        for (let x = 0; x < w; x++) {
          if (!edgeRow && x >= b && x < w - b) { x = w - b - 1; continue; }
          const j = (y * w + x) * 4;
          d[j] = d[j + 1] = d[j + 2] = 255;
        }
      }
    }

    async function applyFilter(d, w, h, filter, pause) {
      if (filter === "original") return d;
      const n = w * h;
      const L = lumaOf(d, n);
      const row = paperLevels(L, w, h);
      const bg = new Float32Array(w);
      // Even out the lighting: the paper becomes about white everywhere.
      for (let y = 0; y < h; y++) {
        row(y, bg);
        for (let x = 0, i = y * w, j = i * 4; x < w; x++, i++, j += 4) {
          const gain = clamp(250 / bg[x], 0.9, 3);
          const r = d[j] * gain, g = d[j + 1] * gain, b = d[j + 2] * gain;
          d[j] = r; d[j + 1] = g; d[j + 2] = b;
          L[i] = Math.min(255, (77 * r + 150 * g + 29 * b) / 256);
        }
        if ((y & 63) === 63) await pause();
      }

      if (filter === "bw") {
        // Adaptive threshold against the local mean (integral image).
        const rad = Math.max(8, Math.round(Math.min(w, h) / 30));
        const W1 = w + 1;
        const integ = new Uint32Array(W1 * (h + 1));
        for (let y = 0; y < h; y++) {
          let acc = 0;
          for (let x = 0; x < w; x++) {
            acc += L[y * w + x];
            integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + acc;
          }
        }
        for (let y = 0; y < h; y++) {
          const ya = Math.max(0, y - rad), yb = Math.min(h, y + rad + 1);
          for (let x = 0; x < w; x++) {
            const xa = Math.max(0, x - rad), xb = Math.min(w, x + rad + 1);
            const sum = integ[yb * W1 + xb] - integ[ya * W1 + xb] - integ[yb * W1 + xa] + integ[ya * W1 + xa];
            const mean = sum / ((xb - xa) * (yb - ya));
            const v = L[y * w + x];
            const ink = v < mean * 0.86 - 2 || v < 70 ? 0 : 255;
            const j = (y * w + x) * 4;
            d[j] = d[j + 1] = d[j + 2] = ink;
          }
          if ((y & 63) === 63) await pause();
        }
        whiteBorder(d, w, h);
        return d;
      }

      // Levels: black point from the darkest 0.7%, white point near paper, gentle contrast curve.
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[L[i]]++;
      let bp = 0, acc = 0;
      while (bp < 255 && acc + hist[bp] < n * 0.007) acc += hist[bp++];
      bp = Math.min(bp, 100);
      const wp = 238;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(clamp((v - bp) / (wp - bp), 0, 1), 1.2);
      const gray = filter === "gray";
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        if (gray) {
          d[j] = d[j + 1] = d[j + 2] = lut[L[i]];
        } else {
          const l = L[i];
          d[j] = lut[clamp(Math.round(l + (d[j] - l) * 1.25), 0, 255)];
          d[j + 1] = lut[clamp(Math.round(l + (d[j + 1] - l) * 1.25), 0, 255)];
          d[j + 2] = lut[clamp(Math.round(l + (d[j + 2] - l) * 1.25), 0, 255)];
        }
      }
      whiteBorder(d, w, h);
      return d;
    }

    // Quarter turns clockwise.
    function rotate(data, w, h, rot) {
      rot = ((rot % 360) + 360) % 360;
      if (!rot) return { data, w, h };
      const W = rot === 180 ? w : h, H = rot === 180 ? h : w;
      const out = new Uint8ClampedArray(W * H * 4);
      const a = new Uint32Array(data.buffer, data.byteOffset, w * h);
      const b = new Uint32Array(out.buffer);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = a[y * w + x];
          if (rot === 90) b[x * W + (h - 1 - y)] = v;
          else if (rot === 180) b[(h - 1 - y) * W + (w - 1 - x)] = v;
          else b[(w - 1 - x) * W + y] = v;
        }
      }
      return { data: out, w: W, h: H };
    }

    // Centre the image on white paper of ratio R (long side / short side).
    function pad(img, R) {
      const { data, w, h } = img;
      let W = w, H = h;
      if (h >= w) { if (h / w > R) W = Math.round(h / R); else H = Math.round(w * R); }
      else if (w / h > R) H = Math.round(w / R); else W = Math.round(h * R);
      if (W === w && H === h) return img;
      const out = new Uint8ClampedArray(W * H * 4).fill(255);
      const ox = Math.floor((W - w) / 2), oy = Math.floor((H - h) / 2);
      for (let y = 0; y < h; y++) out.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * W + ox) * 4);
      return { data: out, w: W, h: H };
    }

    /**
     * The whole page pipeline. source: ImageBitmap or canvas.
     * opts: { corners (normalised), rot, filter, paperRatio (0 = fit), maxEdge }.
     * env: { canvas(w,h), pause() }.
     */
    async function render(source, opts, env) {
      const sw = source.width, sh = source.height;
      const full = isFull(opts.corners);
      const q = opts.corners.map(([x, y]) => [x * sw, y * sh]);
      let { W, H } = docSize(q, sw, sh, full);
      const R = opts.paperRatio || 0;
      if (R) {
        const long = Math.max(W, H), short = Math.min(W, H);
        if (Math.abs(long / short / R - 1) < 0.1) { if (W >= H) W = H * R; else H = W * R; } // it is that paper: fill it
      }
      const scale = Math.min(1, opts.maxEdge / Math.max(W, H));
      const W2 = Math.max(1, Math.round(W * scale)), H2 = Math.max(1, Math.round(H * scale));
      // Read the source at about 1.25x the needed density: sharper and lighter than the full photo.
      const s = Math.min(1, scale * 1.25);
      const cw = Math.max(1, Math.round(sw * s)), ch = Math.max(1, Math.round(sh * s));
      const c = env.canvas(cw, ch);
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.drawImage(source, 0, 0, cw, ch);
      const src = cx.getImageData(0, 0, cw, ch).data;
      c.width = c.height = 1;
      const qs = opts.corners.map(([x, y]) => [x * cw, y * ch]);
      const data = await warp(src, cw, ch, qs, W2, H2, env.pause);
      await applyFilter(data, W2, H2, opts.filter, env.pause);
      let img = rotate(data, W2, H2, opts.rot || 0);
      if (R) img = pad(img, R);
      return img;
    }

    // render() plus, when opts.encode, JPEG/PNG encoding. Returns { result, transfer }.
    async function renderJob(source, opts, env) {
      const img = await render(source, opts, env);
      if (!opts.encode) return { result: { w: img.w, h: img.h, buffer: img.data.buffer }, transfer: [img.data.buffer] };
      const c = env.canvas(img.w, img.h);
      c.getContext("2d").putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
      let bytes = await env.encode(c, "image/jpeg", opts.quality);
      let type = "image/jpeg";
      if (opts.filter === "bw") {
        const png = await env.encode(c, "image/png");
        if (png.length < bytes.length) { bytes = png; type = "image/png"; }
      }
      c.width = c.height = 1;
      return { result: { bytes, type, w: img.w, h: img.h }, transfer: [bytes.buffer] };
    }

    // detect() on a source drawn at opts.w x opts.h. Returns { result, transfer }.
    async function detectJob(source, opts, env) {
      const c = env.canvas(opts.w, opts.h);
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "medium";
      cx.drawImage(source, 0, 0, opts.w, opts.h);
      const result = detect(cx.getImageData(0, 0, opts.w, opts.h).data, opts.w, opts.h);
      c.width = c.height = 1;
      return { result, transfer: [] };
    }

    return { detect, detectJob, homography, aspect, docSize, warp, applyFilter, rotate, pad, render, renderJob, orderCorners, isFull };
  }

  const Core = scanCore();

  /* ======================================================================
   * Runner: does the page pipeline in a Worker when it can, else on the page.
   * ==================================================================== */
  const mainEnv = (() => {
    let last = 0;
    return {
      canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; },
      pause() {
        const now = performance.now();
        if (now - last < 30) return undefined;
        return new Promise((r) => setTimeout(r, 0)).then(() => { last = performance.now(); });
      },
      encode(c, type, q) {
        return new Promise((resolve, reject) => c.toBlob((b) => {
          if (!b) return reject(new Error("Couldn't encode the page image."));
          b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject);
        }, type, q));
      },
    };
  })();

  const Runner = (() => {
    let worker = null, url = null, broken = false, seq = 0;
    const pending = new Map();

    function source() {
      return `"use strict";
const Core = (${scanCore.toString()})();
const env = {
  canvas: (w, h) => new OffscreenCanvas(w, h),
  pause: () => undefined,
  encode: async (c, type, quality) => new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer()),
};
self.onmessage = async (e) => {
  const { id, kind, source, opts } = e.data;
  try {
    const { result, transfer } = await (kind === "detect" ? Core.detectJob : Core.renderJob)(source, opts, env);
    if (source && source.close) source.close();
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, message: String((err && err.message) || err) });
  }
};`;
    }

    function stop() {
      if (worker) worker.terminate();
      worker = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    }

    function fail(err) {
      broken = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      stop();
    }

    function start() {
      if (worker || broken) return worker;
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
        broken = true;
        return null;
      }
      try {
        url = URL.createObjectURL(new Blob([source()], { type: "text/javascript" }));
        worker = new Worker(url);
        worker.onmessage = ({ data }) => {
          const p = pending.get(data.id);
          if (!p) return;
          pending.delete(data.id);
          if (data.ok) p.resolve(data.result); else p.reject(new Error(data.message));
        };
        worker.onerror = (e) => { if (e.preventDefault) e.preventDefault(); fail(new Error("worker failed")); };
      } catch (e) {
        broken = true;
        stop();
      }
      return worker;
    }

    function post(w, kind, src, opts) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try {
          w.postMessage({ id, kind, source: src, opts }, src instanceof ImageBitmap ? [src] : []);
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    }

    // getSource() returns a fresh ImageBitmap (or canvas) the job may consume.
    // kind: "render" (the page pipeline) or "detect" (find the page edges).
    async function run(kind, getSource, opts) {
      const w = start();
      if (w) {
        const src = await getSource();
        try {
          return await post(w, kind, src, opts);
        } catch (e) {
          if (e && e.cancelled) throw e;
          broken = true; // run this and later jobs on the page instead
          stop();
        }
      }
      const src = await getSource();
      try {
        return (await (kind === "detect" ? Core.detectJob : Core.renderJob)(src, opts, mainEnv)).result;
      } finally {
        if (src && src.close) src.close();
      }
    }

    function reset() {
      const err = new Error("cancelled");
      err.cancelled = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      stop();
    }

    return {
      render: (getSource, opts) => run("render", getSource, opts),
      detect: (getSource, opts) => run("detect", getSource, opts),
      reset,
      usingWorker: () => !!worker,
    };
  })();

  /* ======================================================================
   * Helpers
   * ==================================================================== */
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function userError(message) {
    const e = new Error(message);
    e.userFacing = true;
    return e;
  }

  function toast(msg, type = "error") {
    if (typeof showToast === "function") showToast(msg, type);
  }

  // Decodes a photo upright (EXIF orientation applied). Returns an ImageBitmap when possible.
  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* try <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext("2d").drawImage(img, 0, 0);
      if (typeof createImageBitmap === "function") {
        try { return await createImageBitmap(c); } catch (e) { /* use the canvas */ }
      }
      return c;
    } catch (e) {
      throw userError(`Couldn't read "${file.name}". Try a JPG or PNG photo.`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toBitmap(canvas) {
    return typeof createImageBitmap === "function" ? createImageBitmap(canvas) : canvas;
  }

  // Normalised point <-> on-screen orientation after quarter turns clockwise.
  function rotN([x, y], rot) {
    if (rot === 90) return [1 - y, x];
    if (rot === 180) return [1 - x, 1 - y];
    if (rot === 270) return [y, 1 - x];
    return [x, y];
  }
  function unrotN([x, y], rot) {
    if (rot === 90) return [y, 1 - x];
    if (rot === 180) return [1 - x, 1 - y];
    if (rot === 270) return [1 - y, x];
    return [x, y];
  }

  const clone = (q) => q.map((p) => p.slice());
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function canUseCamera() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  const ICONS = {
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    images: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 8l1.2 2.8L16 12l-2.8 1.2L12 16l-1.2-2.8L8 12l2.8-1.2z"/></svg>',
    full: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };

  function template() {
    return `
      <div class="scan">
        <div class="scan-bar">
          <button type="button" class="scan-btn scan-btn-primary" id="scanCameraBtn" data-act="camera">${ICONS.camera}<span>Use camera</span></button>
          <button type="button" class="scan-btn" id="scanAddBtn" data-act="pick">${ICONS.images}<span>Add photos</span></button>
          <input type="file" id="scanCaptureInput" accept="image/*" capture="environment" hidden>
          <input type="file" id="scanPickInput" accept="image/*" multiple hidden>
          <div class="scan-paper" role="radiogroup" aria-label="Page size">
            <span class="scan-paper-label">Page size</span>
            <div class="scan-seg">
              <button type="button" role="radio" data-act="paper" data-paper="fit" aria-checked="true">Fit</button>
              <button type="button" role="radio" data-act="paper" data-paper="a4" aria-checked="false">A4</button>
              <button type="button" role="radio" data-act="paper" data-paper="letter" aria-checked="false">Letter</button>
            </div>
          </div>
        </div>

        <div class="scan-empty" id="scanEmpty">
          <div class="scan-empty-art" aria-hidden="true">
            <div class="scan-empty-page"><i></i><i></i><i class="s"></i><i></i><i class="s"></i></div>
            <span class="c tl"></span><span class="c tr"></span><span class="c br"></span><span class="c bl"></span>
          </div>
          <p class="scan-empty-title">Point your camera at a page</p>
          <p class="scan-empty-text">We find the page edges, straighten it and clean it up. Capture as many pages as you like, or add photos you already have. Nothing leaves your device.</p>
        </div>

        <div class="scan-work" id="scanWork" hidden>
          <div class="scan-strip-wrap">
            <div class="scan-strip" id="scanStrip" role="list" aria-label="Pages"></div>
          </div>
          <div class="scan-viewtabs" role="tablist">
            <button type="button" role="tab" data-act="view" data-view="edit" aria-selected="false">Corners</button>
            <button type="button" role="tab" data-act="view" data-view="result" aria-selected="true">Result</button>
          </div>
          <div class="scan-panes" id="scanPanes" data-view="result">
            <section class="scan-pane scan-pane-edit" aria-label="Adjust corners">
              <div class="scan-pane-head">
                <span class="scan-pane-title">Corners</span>
                <span class="scan-status" id="scanStatus"></span>
              </div>
              <div class="scan-stage" id="scanStage">
                <div class="scan-stage-inner" id="scanInner">
                  <canvas id="scanCanvas"></canvas>
                  <svg class="scan-quad" id="scanQuad" aria-hidden="true">
                    <path class="scan-shade" id="scanShade" fill-rule="evenodd"></path>
                    <polygon class="scan-outline" id="scanOutline"></polygon>
                  </svg>
                  ${[0, 1, 2, 3].map((i) => `<button type="button" class="scan-handle" data-i="${i}" aria-label="Corner ${i + 1} of 4. Drag, or use the arrow keys."><span></span></button>`).join("")}
                  <canvas class="scan-loupe" id="scanLoupe" hidden></canvas>
                </div>
                <div class="scan-loading" id="scanEditLoading"><div class="spinner"></div></div>
              </div>
              <div class="scan-actions">
                <button type="button" class="scan-chip" data-act="auto" title="Use the detected page edges">${ICONS.auto}<span>Auto</span></button>
                <button type="button" class="scan-chip" data-act="full" title="Keep the whole photo">${ICONS.full}<span>Whole photo</span></button>
                <button type="button" class="scan-chip" data-act="rotate" title="Rotate 90°">${ICONS.rotate}<span>Rotate</span></button>
              </div>
            </section>
            <section class="scan-pane scan-pane-result" aria-label="Result">
              <div class="scan-pane-head">
                <span class="scan-pane-title">Result</span>
                <span class="scan-status" id="scanPageInfo"></span>
              </div>
              <div class="scan-result" id="scanResult">
                <canvas id="scanPreview"></canvas>
                <div class="scan-loading" id="scanBusy"><div class="spinner"></div></div>
              </div>
              <div class="scan-filters" role="radiogroup" aria-label="Look">
                ${FILTERS.map((f) => `<button type="button" role="radio" class="scan-filter" data-act="filter" data-filter="${f.id}" aria-checked="false"><span class="scan-swatch sw-${f.id}"></span>${f.label}</button>`).join("")}
              </div>
              <div class="scan-actions">
                <button type="button" class="scan-chip" data-act="left" aria-label="Move page earlier">${ICONS.left}</button>
                <button type="button" class="scan-chip" data-act="right" aria-label="Move page later">${ICONS.right}</button>
                <button type="button" class="scan-chip" data-act="filter-all">Use look on all pages</button>
                <button type="button" class="scan-chip scan-chip-danger" data-act="delete">${ICONS.trash}<span>Delete</span></button>
              </div>
            </section>
          </div>
        </div>
      </div>`;
  }

  /* ======================================================================
   * The tool UI
   * ==================================================================== */
  let nextId = 1;

  function create(root) {
    root.innerHTML = template();
    const $ = (id) => root.querySelector(`#${id}`);
    const st = { pages: [], sel: null, paper: "fit", view: "result", destroyed: false, queue: Promise.resolve(), layout: null };
    const els = {
      empty: $("scanEmpty"), work: $("scanWork"), strip: $("scanStrip"), panes: $("scanPanes"),
      stage: $("scanStage"), inner: $("scanInner"), canvas: $("scanCanvas"), shade: $("scanShade"),
      outline: $("scanOutline"), quad: $("scanQuad"), loupe: $("scanLoupe"), status: $("scanStatus"),
      editLoading: $("scanEditLoading"), preview: $("scanPreview"), busy: $("scanBusy"), info: $("scanPageInfo"),
      result: $("scanResult"), pick: $("scanPickInput"), capture: $("scanCaptureInput"),
    };
    const handles = Array.from(root.querySelectorAll(".scan-handle"));
    if (!canUseCamera()) $("scanCameraBtn").querySelector("span").textContent = "Take photo";

    // ---------- files ----------
    function isImage(f) {
      return f && (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name || ""));
    }

    function addFiles(files) {
      files = Array.from(files).filter(isImage);
      if (!files.length) return;
      if (typeof addFilesToTool === "function" && root.isConnected) addFilesToTool(files);
      else setFiles([...st.pages.map((p) => p.file), ...files]);
    }

    function setFiles(files) {
      if (st.destroyed) return;
      files = Array.from(files || []).filter(isImage);
      const old = new Map(st.pages.map((p) => [p.file, p]));
      const next = files.map((f) => old.get(f) || newPage(f));
      const fresh = next.filter((p) => !old.has(p.file));
      for (const p of st.pages) if (!next.includes(p)) p.disposed = true;
      st.pages = next;
      if (fresh.length) select(fresh[fresh.length - 1], true);
      else if (!next.includes(st.sel)) select(next[0] || null);
      renderAll();
    }

    function newPage(file) {
      const p = {
        id: nextId++, file, w: 0, h: 0, display: null, auto: clone(FULL), corners: clone(FULL),
        found: false, confidence: 0, rot: 0, filter: "enhanced", preview: null, thumb: makeCanvas(1, 1),
        ver: 0, busy: true, error: null, disposed: false, justAdded: false,
      };
      p.ready = st.queue = st.queue.then(() => loadPage(p));
      return p;
    }

    async function loadPage(p) {
      if (p.disposed || st.destroyed) return;
      try {
        let bmp = await decodeImage(p.file);
        p.w = bmp.width;
        p.h = bmp.height;
        const s = Math.min(1, DISPLAY_MAX / Math.max(p.w, p.h));
        const d = makeCanvas(p.w * s, p.h * s);
        if (s < 1 && bmp instanceof ImageBitmap) {
          // Let the browser shrink a 12 MP photo off the main thread.
          try {
            const small = await createImageBitmap(bmp, { resizeWidth: d.width, resizeHeight: d.height, resizeQuality: "high" });
            bmp.close();
            bmp = small;
          } catch (e) { /* draw it below */ }
        }
        if (p.disposed || st.destroyed) { if (bmp.close) bmp.close(); return; }
        const dctx = d.getContext("2d");
        dctx.imageSmoothingQuality = "high";
        dctx.drawImage(bmp, 0, 0, d.width, d.height);
        if (bmp.close) bmp.close();
        p.display = d;
        await detectPage(p);
      } catch (e) {
        if (p.disposed || st.destroyed || e.cancelled) return;
        p.error = e.userFacing ? e.message : `Couldn't read "${p.file.name}".`;
        p.busy = false;
        toast(p.error);
      }
      if (p.disposed || st.destroyed) return;
      if (p === st.sel && p.justAdded && p.display) setView(p.found ? "result" : "edit");
      renderStrip();
      if (p === st.sel) renderEditor();
      renderPreview(p);
    }

    async function detectPage(p) {
      const d = p.display;
      const s = Math.min(1, DETECT_MAX / Math.max(d.width, d.height));
      const w = Math.max(1, Math.round(d.width * s)), h = Math.max(1, Math.round(d.height * s));
      const res = await Runner.detect(() => toBitmap(d), { w, h });
      p.found = !!res.corners;
      p.confidence = res.confidence;
      p.auto = res.corners ? res.corners.map(([x, y]) => [clamp01(x / w), clamp01(y / h)]) : clone(FULL);
      p.corners = clone(p.auto);
      ScanTool._lastCorners = p.auto.map(([x, y]) => [x * p.w, y * p.h]);
    }

    function jobOpts(p, maxEdge, encode) {
      return {
        corners: p.corners, rot: p.rot, filter: p.filter, paperRatio: PAPERS[st.paper] || 0,
        maxEdge, encode, quality: JPEG_QUALITY,
      };
    }

    async function renderPreview(p) {
      if (!p || !p.display || p.disposed || st.destroyed) return;
      const v = ++p.ver;
      p.busy = true;
      updateBusy();
      try {
        const out = await Runner.render(() => toBitmap(p.display), jobOpts(p, PREVIEW_MAX, false));
        if (v !== p.ver || p.disposed || st.destroyed) return;
        const c = p.preview || makeCanvas(1, 1);
        c.width = out.w;
        c.height = out.h;
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(out.buffer), out.w, out.h), 0, 0);
        p.preview = c;
        drawThumb(p);
        if (p === st.sel) drawResult();
      } catch (e) {
        if (!st.destroyed && v === p.ver && !e.cancelled) toast(`Couldn't process "${p.file.name}": ${e.message}`);
      } finally {
        if (v === p.ver) { p.busy = false; updateBusy(); }
      }
    }

    let previewTimer = null;
    function schedulePreview(p, delay = 220) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => renderPreview(p), delay);
    }

    async function pages() {
      if (!st.pages.length) throw userError("Add or take a photo first.");
      await Promise.all(st.pages.map((p) => p.ready));
      const bad = st.pages.find((p) => !p.display);
      if (bad) throw userError(`Couldn't read "${bad.file.name}". Remove it and try again.`);
      const out = [];
      const list = st.pages.slice();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (typeof setProcessingLabel === "function") setProcessingLabel(`Straightening page ${i + 1} of ${list.length}...`);
        const r = await Runner.render(() => decodeImage(p.file), jobOpts(p, OUTPUT_MAX, true));
        // Real paper sizes in points, so A4 prints as A4 (landscape pages keep their turn).
        const size = { a4: [595.28, 841.89], letter: [612, 792] }[st.paper];
        const page = { bytes: r.bytes, type: r.type };
        if (size) page.pageSize = r.w > r.h ? [size[1], size[0]] : size;
        out.push(page);
      }
      if (typeof setProcessingLabel === "function") setProcessingLabel("Building your PDF...");
      return out;
    }

    // ---------- page list ----------
    function syncAppOrder() {
      // Keep the app's file list in the same order as the pages.
      try {
        if (typeof currentFiles !== "undefined" && Array.isArray(currentFiles) &&
            currentFiles.length === st.pages.length && st.pages.every((p) => currentFiles.includes(p.file))) {
          currentFiles.splice(0, currentFiles.length, ...st.pages.map((p) => p.file));
          if (typeof updateSelectedFilesUI === "function") updateSelectedFilesUI();
        }
      } catch (e) { /* the app shell is optional */ }
    }

    function movePage(from, to) {
      if (to < 0 || to >= st.pages.length || from === to) return;
      const [p] = st.pages.splice(from, 1);
      st.pages.splice(to, 0, p);
      syncAppOrder();
      renderStrip();
      updateInfo();
    }

    function deletePage(p) {
      const i = st.pages.indexOf(p);
      if (i < 0) return;
      p.disposed = true;
      st.pages.splice(i, 1);
      if (st.sel === p) select(st.pages[Math.min(i, st.pages.length - 1)] || null);
      try {
        // Also drop it from the app's file list (that calls setFiles again with the same pages).
        if (typeof currentFiles !== "undefined" && typeof removeFile === "function") {
          const idx = currentFiles.indexOf(p.file);
          if (idx >= 0) removeFile(idx);
        }
      } catch (e) { /* not in the app shell */ }
      renderAll();
    }

    function select(p, justAdded = false) {
      st.sel = p;
      if (p) p.justAdded = justAdded;
      if (p && justAdded && p.display) setView(p.found ? "result" : "edit");
    }

    // ---------- rendering ----------
    function renderAll() {
      const has = st.pages.length > 0;
      els.empty.hidden = has;
      els.work.hidden = !has;
      root.dataset.pages = String(st.pages.length);
      renderStrip();
      renderEditor();
      drawResult();
      updateInfo();
      updateBusy();
    }

    function drawThumb(p) {
      if (!p.preview) return;
      const s = Math.min(152 / p.preview.width, 200 / p.preview.height);
      p.thumb.width = Math.max(1, Math.round(p.preview.width * s));
      p.thumb.height = Math.max(1, Math.round(p.preview.height * s));
      const c = p.thumb.getContext("2d");
      c.imageSmoothingQuality = "high";
      c.drawImage(p.preview, 0, 0, p.thumb.width, p.thumb.height);
      const el = els.strip.querySelector(`[data-id="${p.id}"]`);
      if (el) el.classList.add("loaded");
    }

    function renderStrip() {
      els.strip.innerHTML = "";
      st.pages.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = "scan-thumb" + (p === st.sel ? " active" : "") + (p.preview ? " loaded" : "") + (p.error ? " failed" : "") + (p.busy ? " busy" : "");
        el.dataset.id = p.id;
        el.setAttribute("role", "listitem");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "scan-thumb-btn";
        btn.setAttribute("aria-label", `Page ${i + 1}${p === st.sel ? " (selected)" : ""}`);
        btn.dataset.act = "select";
        btn.appendChild(p.thumb);
        const spin = document.createElement("span");
        spin.className = "scan-thumb-spin";
        btn.appendChild(spin);
        const num = document.createElement("span");
        num.className = "scan-thumb-num";
        num.textContent = String(i + 1);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "scan-thumb-del";
        del.dataset.act = "delete-one";
        del.setAttribute("aria-label", `Delete page ${i + 1}`);
        del.innerHTML = ICONS.close;
        el.append(btn, num, del);
        els.strip.appendChild(el);
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "scan-thumb-add";
      add.dataset.act = "camera";
      add.innerHTML = `${ICONS.plus}<span>Add page</span>`;
      els.strip.appendChild(add);
      const active = els.strip.querySelector(".scan-thumb.active");
      if (active) {
        const sr = els.strip.getBoundingClientRect(), ar = active.getBoundingClientRect();
        if (ar.left < sr.left || ar.right > sr.right) els.strip.scrollLeft += ar.left - sr.left - 12;
      }
    }

    function updateInfo() {
      const p = st.sel;
      const i = st.pages.indexOf(p);
      els.info.textContent = p ? `Page ${i + 1} of ${st.pages.length}` : "";
      root.querySelectorAll(".scan-filter").forEach((b) => b.setAttribute("aria-checked", String(!!p && b.dataset.filter === p.filter)));
      root.querySelectorAll('[data-act="paper"]').forEach((b) => b.setAttribute("aria-checked", String(b.dataset.paper === st.paper)));
      const left = root.querySelector('[data-act="left"]'), right = root.querySelector('[data-act="right"]');
      if (left) left.disabled = i <= 0;
      if (right) right.disabled = i < 0 || i >= st.pages.length - 1;
      if (p && p.display) {
        els.status.textContent = p.found ? "Edges found. Drag a corner to adjust." : "No clear edges. Drag the corners to crop.";
        els.status.classList.toggle("warn", !p.found);
      } else {
        els.status.textContent = p && p.error ? p.error : "";
      }
    }

    function updateBusy() {
      const p = st.sel;
      els.busy.classList.toggle("on", !!(p && (p.busy || !p.preview) && !p.error));
      els.editLoading.classList.toggle("on", !!(p && !p.display && !p.error));
      st.pages.forEach((q) => {
        const el = els.strip.querySelector(`[data-id="${q.id}"]`);
        if (el) el.classList.toggle("busy", !!q.busy);
      });
    }

    function availHeight() {
      const narrow = window.innerWidth < 720;
      return Math.max(220, Math.min(window.innerHeight * (narrow ? 0.5 : 0.56), 600));
    }

    function renderEditor() {
      const p = st.sel;
      updateInfo();
      updateBusy();
      const ready = !!(p && p.display);
      els.inner.style.visibility = ready ? "visible" : "hidden";
      if (!ready) { els.inner.style.width = "100%"; els.inner.style.height = "260px"; st.layout = null; return; }
      const rot = p.rot;
      const dw = rot % 180 ? p.display.height : p.display.width;
      const dh = rot % 180 ? p.display.width : p.display.height;
      const availW = els.stage.clientWidth || 320;
      const s = Math.min(availW / dw, availHeight() / dh);
      const cw = Math.max(1, Math.floor(dw * s)), ch = Math.max(1, Math.floor(dh * s));
      els.inner.style.width = `${cw}px`;
      els.inner.style.height = `${ch}px`;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const k = Math.max(1, Math.min(dw / cw, dpr * 1.5));
      const c = els.canvas;
      c.width = Math.max(1, Math.round(cw * k));
      c.height = Math.max(1, Math.round(ch * k));
      const ctx = c.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingQuality = "high";
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const iw = rot % 180 ? c.height : c.width, ih = rot % 180 ? c.width : c.height;
      ctx.drawImage(p.display, -iw / 2, -ih / 2, iw, ih);
      st.layout = { cw, ch, rot };
      els.quad.setAttribute("viewBox", `0 0 ${cw} ${ch}`);
      positionHandles();
    }

    function toView(pt) {
      const { cw, ch, rot } = st.layout;
      const [x, y] = rotN(pt, rot);
      return [x * cw, y * ch];
    }

    function fromView(x, y) {
      const { cw, ch, rot } = st.layout;
      return unrotN([clamp01(x / cw), clamp01(y / ch)], rot);
    }

    function positionHandles() {
      const p = st.sel;
      if (!p || !st.layout) return;
      const pts = p.corners.map(toView);
      handles.forEach((h, i) => {
        h.style.left = `${pts[i][0]}px`;
        h.style.top = `${pts[i][1]}px`;
      });
      els.outline.setAttribute("points", pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" "));
      const { cw, ch } = st.layout;
      els.shade.setAttribute("d", `M0 0H${cw}V${ch}H0Z M${pts.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(" L")}Z`);
      root.dataset.corners = JSON.stringify(p.corners.map(([x, y]) => [Math.round(x * p.w), Math.round(y * p.h)]));
    }

    function drawResult() {
      const p = st.sel;
      const c = els.preview;
      if (!p || !p.preview) { c.width = 1; c.height = 1; c.style.width = "0px"; c.style.height = "0px"; return; }
      const availW = els.result.clientWidth || 320;
      const s = Math.min(availW / p.preview.width, availHeight() / p.preview.height, 1.5);
      const cw = Math.max(1, Math.floor(p.preview.width * s)), ch = Math.max(1, Math.floor(p.preview.height * s));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.style.width = `${cw}px`;
      c.style.height = `${ch}px`;
      c.width = Math.min(p.preview.width, Math.round(cw * dpr));
      c.height = Math.min(p.preview.height, Math.round(ch * dpr));
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(p.preview, 0, 0, c.width, c.height);
    }

    function setView(v) {
      st.view = v;
      els.panes.dataset.view = v;
      root.querySelectorAll('[data-act="view"]').forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    }

    // ---------- loupe ----------
    function drawLoupe(i) {
      const p = st.sel;
      const L = 116;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const lo = els.loupe;
      lo.width = L * dpr;
      lo.height = L * dpr;
      const [vx, vy] = toView(p.corners[i]);
      const { cw } = st.layout;
      // Just above the corner (below it near the top), clear of the finger.
      lo.style.left = `${Math.min(Math.max(vx - L / 2, -8), cw - L + 8)}px`;
      lo.style.top = `${vy - L - 40 >= -8 ? vy - L - 40 : vy + 40}px`;
      const zoom = 3;
      const k = els.canvas.width / cw;
      const half = L / (2 * zoom);
      const ctx = lo.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0b0f19";
      ctx.fillRect(0, 0, lo.width, lo.height);
      const sx = (vx - half) * k, sy = (vy - half) * k, sz = 2 * half * k;
      const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy);
      const cx1 = Math.min(els.canvas.width, sx + sz), cy1 = Math.min(els.canvas.height, sy + sz);
      if (cx1 > cx0 && cy1 > cy0) {
        const f = (L * dpr) / sz;
        ctx.drawImage(els.canvas, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx) * f, (cy0 - sy) * f, (cx1 - cx0) * f, (cy1 - cy0) * f);
      }
      ctx.scale(dpr, dpr);
      const map = (pt) => { const [x, y] = toView(pt); return [(x - vx) * zoom + L / 2, (y - vy) * zoom + L / 2]; };
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.beginPath();
      p.corners.forEach((pt, j) => { const [x, y] = map(pt); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L / 2 - 9, L / 2); ctx.lineTo(L / 2 + 9, L / 2);
      ctx.moveTo(L / 2, L / 2 - 9); ctx.lineTo(L / 2, L / 2 + 9);
      ctx.stroke();
      lo.hidden = false;
    }

    // ---------- corner handles ----------
    let drag = null;
    handles.forEach((h, i) => {
      h.addEventListener("pointerdown", (e) => {
        const p = st.sel;
        if (!p || !st.layout || drag) return;
        e.preventDefault();
        try { h.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
        const r = els.inner.getBoundingClientRect();
        const [vx, vy] = toView(p.corners[i]);
        drag = { i, id: e.pointerId, dx: vx - (e.clientX - r.left), dy: vy - (e.clientY - r.top) };
        h.classList.add("dragging");
        drawLoupe(i);
      });
      h.addEventListener("pointermove", (e) => {
        if (!drag || drag.id !== e.pointerId || drag.i !== i) return;
        const r = els.inner.getBoundingClientRect();
        st.sel.corners[i] = fromView(e.clientX - r.left + drag.dx, e.clientY - r.top + drag.dy);
        positionHandles();
        drawLoupe(i);
      });
      const end = (e) => {
        if (!drag || drag.id !== e.pointerId) return;
        drag = null;
        h.classList.remove("dragging");
        els.loupe.hidden = true;
        renderPreview(st.sel);
      };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
      h.addEventListener("keydown", (e) => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!step || !st.sel || !st.layout) return;
        e.preventDefault();
        const amt = (e.shiftKey ? 0.02 : 0.004) * Math.max(st.layout.cw, st.layout.ch);
        const [vx, vy] = toView(st.sel.corners[i]);
        st.sel.corners[i] = fromView(vx + step[0] * amt, vy + step[1] * amt);
        positionHandles();
        schedulePreview(st.sel, 350);
      });
    });

    // ---------- reorder by dragging thumbnails ----------
    let tdrag = null;
    let suppressClick = false;
    function startThumbDrag() {
      if (!tdrag) return;
      tdrag.active = true;
      tdrag.el.classList.add("dragging");
      try { tdrag.el.setPointerCapture(tdrag.id); } catch (err) { /* ignore */ }
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (err) { /* ignore */ }
    }
    els.strip.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".scan-thumb");
      if (!el || e.target.closest(".scan-thumb-del") || e.button > 0) return;
      tdrag = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, from: Array.from(els.strip.querySelectorAll(".scan-thumb")).indexOf(el), to: -1 };
      if (e.pointerType === "touch") tdrag.timer = setTimeout(startThumbDrag, 280);
    });
    els.strip.addEventListener("pointermove", (e) => {
      if (!tdrag || tdrag.id !== e.pointerId) return;
      const dx = e.clientX - tdrag.x0;
      if (!tdrag.active) {
        if (Math.hypot(dx, e.clientY - tdrag.y0) < 8) return;
        if (e.pointerType === "touch") { clearTimeout(tdrag.timer); tdrag = null; return; } // a scroll, not a drag
        startThumbDrag();
      }
      tdrag.el.style.transform = `translateX(${dx}px)`;
      const thumbs = Array.from(els.strip.querySelectorAll(".scan-thumb"));
      let slot = thumbs.length; // insertion slot among the original positions
      for (let i = 0; i < thumbs.length; i++) {
        if (thumbs[i] === tdrag.el) continue;
        const r = thumbs[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { slot = i; break; }
      }
      tdrag.to = slot > tdrag.from ? slot - 1 : slot;
      thumbs.forEach((t, i) => t.classList.toggle("drop-mark", i === slot && tdrag.to !== tdrag.from));
      els.strip.classList.toggle("drop-end", slot === thumbs.length && tdrag.to !== tdrag.from);
    });
    const endThumbDrag = (e) => {
      if (!tdrag || tdrag.id !== e.pointerId) return;
      clearTimeout(tdrag.timer);
      const t = tdrag;
      tdrag = null;
      if (!t.active) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      els.strip.classList.remove("drop-end");
      if (t.to >= 0 && t.to !== t.from) movePage(t.from, t.to);
      else renderStrip();
    };
    els.strip.addEventListener("pointerup", endThumbDrag);
    els.strip.addEventListener("pointercancel", endThumbDrag);
    els.strip.addEventListener("touchmove", (e) => { if (tdrag && tdrag.active) e.preventDefault(); }, { passive: false });

    // ---------- buttons ----------
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || !root.contains(b) || b.disabled) return;
      const p = st.sel;
      switch (b.dataset.act) {
        case "camera": openCamera(); return;
        case "pick": els.pick.click(); return;
        case "paper":
          st.paper = b.dataset.paper;
          updateInfo();
          st.pages.forEach((q) => renderPreview(q));
          return;
        case "view": setView(b.dataset.view); renderEditor(); drawResult(); return;
        case "select": {
          if (suppressClick) return;
          const id = Number(b.closest(".scan-thumb").dataset.id);
          select(st.pages.find((q) => q.id === id) || null);
          renderStrip(); renderEditor(); drawResult();
          return;
        }
        case "delete-one": {
          const id = Number(b.closest(".scan-thumb").dataset.id);
          const q = st.pages.find((x) => x.id === id);
          if (q) deletePage(q);
          return;
        }
        default: break;
      }
      if (!p) return;
      switch (b.dataset.act) {
        case "auto": p.corners = clone(p.auto); positionHandles(); renderPreview(p); break;
        case "full": p.corners = clone(FULL); positionHandles(); renderPreview(p); break;
        case "rotate": p.rot = (p.rot + 90) % 360; renderEditor(); renderPreview(p); break;
        case "left": movePage(st.pages.indexOf(p), st.pages.indexOf(p) - 1); break;
        case "right": movePage(st.pages.indexOf(p), st.pages.indexOf(p) + 1); break;
        case "delete": deletePage(p); break;
        case "filter": p.filter = b.dataset.filter; updateInfo(); renderPreview(p); break;
        case "filter-all":
          st.pages.forEach((q) => { if (q.filter !== p.filter) { q.filter = p.filter; renderPreview(q); } });
          toast(`Every page now uses ${FILTERS.find((f) => f.id === p.filter).label}.`, "success");
          break;
        default: break;
      }
    });

    for (const input of [els.pick, els.capture]) {
      input.addEventListener("change", () => {
        if (input.files && input.files.length) addFiles(input.files);
        input.value = "";
      });
    }

    let raf = 0;
    const relayout = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (!st.destroyed && st.pages.length) { renderEditor(); drawResult(); } });
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(relayout) : null;
    if (ro) ro.observe(root);
    window.addEventListener("resize", relayout);

    /* ---------------------------- camera ---------------------------- */
    const cam = { el: null, stream: null, timer: 0, shots: 0, smooth: null, busy: false, opening: false, detecting: false };

    function camTemplate() {
      return `
        <div class="scan-cam-view">
          <video class="scan-cam-video" playsinline muted autoplay></video>
          <canvas class="scan-cam-outline"></canvas>
          <div class="scan-cam-flash"></div>
        </div>
        <div class="scan-cam-top">
          <span class="scan-cam-hint" aria-live="polite">Starting camera...</span>
          <button type="button" class="scan-cam-x" data-cam="close" aria-label="Close camera">${ICONS.close}</button>
        </div>
        <div class="scan-cam-bar">
          <div class="scan-cam-last"><canvas></canvas><span class="scan-cam-count">0</span></div>
          <button type="button" class="scan-shutter" id="scanShutter" data-cam="shoot" aria-label="Take photo"><span></span></button>
          <button type="button" class="scan-cam-done" id="scanCamDone" data-cam="close">Done</button>
        </div>`;
    }

    async function openCamera() {
      if (!canUseCamera()) { els.capture.click(); return; }
      if (cam.el || cam.opening) return;
      cam.opening = true;
      const el = document.createElement("div");
      el.className = "scan-cam";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", "Camera");
      el.innerHTML = camTemplate();
      document.body.appendChild(el);
      cam.el = el;
      cam.shots = 0;
      el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-cam]");
        if (!b) return;
        if (b.dataset.cam === "shoot") shoot();
        else closeCamera();
      });
      window.addEventListener("keydown", camKeys, true);
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        });
      } catch (e) {
        cam.opening = false;
        if (cam.el === el) closeCamera();
        if (!st.destroyed) {
          toast(e && e.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser, or use Add photos."
            : "Couldn't start the camera. You can still add photos.");
        }
        return;
      }
      cam.opening = false;
      if (st.destroyed || cam.el !== el) { stream.getTracks().forEach((t) => t.stop()); return; }
      cam.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (track && track.applyConstraints) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      const video = el.querySelector("video");
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* the autoplay attribute covers it */ }
      el.querySelector(".scan-cam-hint").textContent = "Fit the page in the frame";
      el.classList.add("live");
      ScanTool._camera = { active: true };
      cam.timer = setInterval(liveOutline, 180);
      el.querySelector(".scan-shutter").focus();
    }

    function camKeys(e) {
      if (!cam.el) return;
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); closeCamera(); }
    }

    function closeCamera() {
      clearInterval(cam.timer);
      cam.timer = 0;
      if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
      cam.stream = null;
      cam.smooth = null;
      if (cam.el) cam.el.remove();
      cam.el = null;
      window.removeEventListener("keydown", camKeys, true);
      ScanTool._camera = { active: false };
    }

    async function liveOutline() {
      const el = cam.el;
      if (!el || cam.detecting) return;
      const video = el.querySelector("video");
      const out = el.querySelector(".scan-cam-outline");
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const s = Math.min(1, 320 / Math.max(vw, vh));
      const w = Math.round(vw * s), h = Math.round(vh * s);
      let res;
      cam.detecting = true;
      try {
        res = await Runner.detect(() => {
          if (typeof createImageBitmap === "function") return createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
          const c = makeCanvas(w, h);
          c.getContext("2d").drawImage(video, 0, 0, w, h);
          return c;
        }, { w, h });
      } catch (e) {
        return;
      } finally {
        cam.detecting = false;
      }
      if (cam.el !== el) return;
      const q = res.corners ? res.corners.map(([x, y]) => [x / w, y / h]) : null;
      if (q) cam.smooth = cam.smooth ? cam.smooth.map((p, i) => [p[0] * 0.5 + q[i][0] * 0.5, p[1] * 0.5 + q[i][1] * 0.5]) : q;
      else cam.smooth = null;
      // Map video pixels to the element (object-fit: contain).
      const r = video.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      out.width = Math.round(r.width * dpr);
      out.height = Math.round(r.height * dpr);
      const k = Math.min(r.width / vw, r.height / vh);
      const ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2;
      const ctx = out.getContext("2d");
      ctx.clearRect(0, 0, out.width, out.height);
      el.querySelector(".scan-cam-hint").textContent = cam.smooth ? "Page found. Hold still and tap the shutter." : "Fit the page in the frame";
      el.classList.toggle("found", !!cam.smooth);
      if (!cam.smooth) return;
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      cam.smooth.forEach(([x, y], i) => {
        const px = ox + x * vw * k, py = oy + y * vh * k;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(99, 102, 241, 0.18)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#22d3ee";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    async function shoot() {
      const el = cam.el;
      if (!el || cam.busy) return;
      const video = el.querySelector("video");
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      cam.busy = true;
      try {
        const c = makeCanvas(vw, vh);
        c.getContext("2d").drawImage(video, 0, 0, vw, vh);
        const flash = el.querySelector(".scan-cam-flash");
        flash.classList.remove("go");
        void flash.offsetWidth;
        flash.classList.add("go");
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw new Error("capture failed");
        cam.shots++;
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const file = new File([blob], `scan-${stamp}-${cam.shots}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
        const last = el.querySelector(".scan-cam-last canvas");
        const ts = 112 / Math.max(vw, vh);
        last.width = Math.round(vw * ts);
        last.height = Math.round(vh * ts);
        last.getContext("2d").drawImage(c, 0, 0, last.width, last.height);
        el.querySelector(".scan-cam-count").textContent = String(cam.shots);
        el.querySelector(".scan-cam-last").classList.add("has");
        el.querySelector(".scan-cam-done").textContent = `Done (${cam.shots})`;
        addFiles([file]);
      } catch (e) {
        toast("Couldn't take the photo. Try again.");
      } finally {
        cam.busy = false;
      }
    }

    function destroy() {
      st.destroyed = true;
      closeCamera();
      clearTimeout(previewTimer);
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", relayout);
      st.pages.forEach((p) => { p.disposed = true; p.display = null; p.preview = null; });
      st.pages = [];
      Runner.reset();
      if (ScanTool._active === api) ScanTool._active = null;
    }

    const api = {
      setFiles,
      pages,
      destroy,
      // Test hooks.
      _state: () => ({
        paper: st.paper,
        selected: st.pages.indexOf(st.sel),
        view: st.view,
        worker: Runner.usingWorker(),
        camera: !!cam.stream,
        pages: st.pages.map((p) => ({
          name: p.file.name, w: p.w, h: p.h, found: p.found, confidence: p.confidence, rot: p.rot, filter: p.filter,
          loaded: !!p.display, busy: p.busy, previewed: !!p.preview, error: p.error,
          corners: p.corners.map(([x, y]) => [x * p.w, y * p.h]),
          auto: p.auto.map(([x, y]) => [x * p.w, y * p.h]),
          preview: p.preview ? [p.preview.width, p.preview.height] : null,
        })),
      }),
    };
    ScanTool._active = api;
    renderAll();
    return api;
  }

  return { create, _core: Core, _lastCorners: null, _active: null, _camera: { active: false } };
})();
