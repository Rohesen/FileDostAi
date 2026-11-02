// Live face filters for the Screen Recorder: smooth skin, brighten, warmth, slim face, bigger eyes,
// background blur or a new background, and overlays (hair for bald heads, glasses). Everything runs
// on this device. Face tracking and the person cut-out use Google's MediaPipe models (face
// landmarker + selfie segmenter, Apache 2.0), self-hosted in /static/vendor/mediapipe/ and only
// downloaded when a filter that needs them is turned on. The picture itself is drawn with WebGL,
// so it keeps up with live video.

const FaceFx = (() => {
  const BASE = new URL("/static/vendor/mediapipe/", location.href).href;
  const DEFAULTS = {
    smooth: 0, light: 0, warm: 0, slim: 0, eyes: 0,
    bg: "none", bgColor: "#334155", bgImage: null,
    hair: "none", hairColor: "black", glasses: "none",
  };
  const PRESETS = {
    off: {},
    natural: { smooth: 0.35, light: 0.15, warm: 0.1 },
    fresh: { smooth: 0.55, light: 0.3, warm: 0.2, slim: 0.25, eyes: 0.15 },
    studio: { smooth: 0.45, light: 0.25, warm: 0.1, bg: "studio" },
  };

  // MediaPipe face mesh landmark rings.
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const HOLES = [
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],          // eye
    [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],     // eye
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],                                          // brow
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],                                  // brow
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185], // lips
  ];

  const needsFace = (o) => o.smooth > 0.01 || o.slim > 0.01 || o.eyes > 0.01 || o.hair !== "none" || o.glasses !== "none";
  const needsSeg = (o) => o.bg !== "none";
  const anyOn = (o) => needsFace(o) || needsSeg(o) || Math.abs(o.light) > 0.01 || Math.abs(o.warm) > 0.01;

  // ---------- Models ----------

  let lib = null;        // Promise<{ m, files }>
  const models = { face: null, seg: null };
  const loading = { face: null, seg: null };

  async function fetchWithProgress(url, onBytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); onBytes(b.length); return b; }
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); n += value.length; onBytes(value.length);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Sizes are only for the progress text.
  const SIZES = { wasm: 14.5e6, face: 3.76e6, seg: 0.25e6 };
  let fetched = 0, wanted = 0, onProgress = () => {};
  const bump = (n) => { fetched += n; onProgress(Math.min(1, fetched / Math.max(1, wanted))); };

  function engine() {
    if (!lib) {
      wanted += SIZES.wasm;
      lib = (async () => {
        const [m, wasm] = await Promise.all([
          import(`${BASE}vision_bundle.mjs`),
          fetchWithProgress(`${BASE}wasm/vision_wasm_internal.wasm`, bump),
        ]);
        const files = {
          wasmLoaderPath: `${BASE}wasm/vision_wasm_internal.js`,
          // Both tasks reuse the bytes fetched once here.
          wasmBinaryPath: URL.createObjectURL(new Blob([wasm], { type: "application/wasm" })),
        };
        return { m, files };
      })();
      lib.catch(() => { lib = null; });
    }
    return lib;
  }

  async function create(kind) {
    const file = kind === "face" ? "models/face_landmarker.task" : "models/selfie_segmenter.tflite";
    wanted += SIZES[kind];
    const [{ m, files }, model] = await Promise.all([engine(), fetchWithProgress(BASE + file, bump)]);
    const opts = kind === "face"
      ? { runningMode: "VIDEO", numFaces: 1, minFaceDetectionConfidence: 0.4, minTrackingConfidence: 0.4 }
      : { runningMode: "VIDEO", outputCategoryMask: false, outputConfidenceMasks: true };
    const Cls = kind === "face" ? m.FaceLandmarker : m.ImageSegmenter;
    for (const delegate of ["GPU", "CPU"]) {
      try {
        return await Cls.createFromOptions(files, { ...opts, baseOptions: { modelAssetBuffer: model, delegate } });
      } catch (e) {
        if (delegate === "CPU") throw e;
        console.warn(`FaceFx: ${kind} on GPU failed, using CPU`, e);
      }
    }
  }

  function load(kind) {
    if (models[kind]) return Promise.resolve(models[kind]);
    if (!loading[kind]) {
      loading[kind] = create(kind).then((t) => { models[kind] = t; return t; })
        .finally(() => { loading[kind] = null; });
    }
    return loading[kind];
  }

  // ---------- WebGL ----------

  const VS = `attribute vec2 p; uniform float uFlip; varying vec2 v;
    void main(){ v = p * 0.5 + 0.5; if (uFlip > 0.5) v.y = 1.0 - v.y; gl_Position = vec4(p, 0.0, 1.0); }`;

  // Separable blur of the background, leaving the person out so they don't glow into it.
  const FS_BLUR = `precision mediump float; varying vec2 v;
    uniform sampler2D uSrc, uSeg; uniform vec2 uDir; uniform float uUseSeg;
    void main(){
      vec3 s = vec3(0.0); float ws = 0.0;
      for (int i = -6; i <= 6; i++) {
        float fi = float(i); vec2 uv = v + uDir * fi;
        float w = exp(-fi * fi / 18.0);
        w *= 1.0 - 0.9 * uUseSeg * smoothstep(0.3, 0.7, texture2D(uSeg, uv).r);
        s += texture2D(uSrc, uv).rgb * w; ws += w;
      }
      gl_FragColor = vec4(s / max(ws, 1e-4), 1.0);
    }`;

  const FS_MAIN = `precision highp float; varying vec2 v;
    uniform sampler2D uVid, uFace, uSeg, uBg;
    uniform vec2 uRes;
    uniform vec4 uWa[6]; // centre x, y (px), radius (px), kind: 0 off, 1 push, 2 magnify
    uniform vec4 uWb[6]; // push x, y (px), magnify amount
    uniform float uSmooth, uSmoothR, uLight, uWarm, uBgMode, uFaceOn;
    uniform vec3 uBgColor;

    vec2 warp(vec2 p) {
      vec2 q = p;
      for (int i = 0; i < 6; i++) {
        vec4 a = uWa[i];
        if (a.w < 0.5) continue;
        vec2 d = p - a.xy; float r2 = a.z * a.z; float dd = dot(d, d);
        if (dd >= r2) continue;
        if (a.w < 1.5) { vec2 m = uWb[i].xy; float k = (r2 - dd) / (r2 - dd + dot(m, m)); q -= k * k * m; }
        else { float t = 1.0 - dd / r2; q -= d * uWb[i].z * t * t; }
      }
      return q;
    }

    void main() {
      vec2 uv = warp(v * uRes) / uRes;
      vec3 c0 = texture2D(uVid, uv).rgb;
      vec3 c = c0;
      if (uSmooth > 0.0 && uFaceOn > 0.0) {
        float fm = texture2D(uFace, uv).r * uFaceOn;
        if (fm > 0.01) {
          vec3 s = c0; float ws = 1.0;
          for (int i = 0; i < 16; i++) {
            float fi = float(i);
            float ang = fi * 2.39996; float r = sqrt((fi + 0.5) / 16.0) * uSmoothR;
            vec3 ci = texture2D(uVid, uv + vec2(cos(ang), sin(ang)) * r / uRes).rgb;
            vec3 dc = ci - c0; float w = exp(-dot(dc, dc) * 28.0);
            s += ci * w; ws += w;
          }
          vec3 sm = s / ws;
          c = mix(c0, sm, fm * uSmooth * 0.92);
          c += (c0 - sm) * fm * 0.12;            // keep a little skin texture, so it doesn't look plastic
        }
      }
      if (uLight != 0.0) {
        c = 1.0 - pow(max(1.0 - c, 0.0), vec3(1.0 + uLight));
      }
      if (uWarm != 0.0) c += vec3(0.045, 0.012, -0.05) * uWarm;
      c = clamp(c, 0.0, 1.0);
      if (uBgMode > 0.5) {
        float m = smoothstep(0.35, 0.75, texture2D(uSeg, uv).r);
        vec3 b = uBgMode < 2.5 ? texture2D(uBg, v).rgb : uBgColor;
        c = mix(b, c, m);
      }
      gl_FragColor = vec4(c, 1.0);
    }`;

  function compile(gl, vs, fs) {
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function makeTex(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  function makeFbo(gl, w, h) {
    const tex = makeTex(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  function Renderer() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error("WebGL is not available");
    const main = compile(gl, VS, FS_MAIN);
    const blur = compile(gl, VS, FS_BLUR);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = { vid: makeTex(gl), face: makeTex(gl), seg: makeTex(gl), bg: makeTex(gl) };
    let fboA = null, fboB = null;

    function upload(t, src) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    function uploadGray(t, data, w, h) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
    }
    function bind(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }

    /** Background blur: two separable passes at quarter size (four for "strong"). */
    function blurBg(w, h, strong, useSeg) {
      const bw = Math.max(32, Math.round(w / 4)), bh = Math.max(18, Math.round(h / 4));
      if (!fboA || fboA.w !== bw || fboA.h !== bh) {
        if (fboA) { gl.deleteTexture(fboA.tex); gl.deleteFramebuffer(fboA.fb); gl.deleteTexture(fboB.tex); gl.deleteFramebuffer(fboB.fb); }
        fboA = makeFbo(gl, bw, bh); fboB = makeFbo(gl, bw, bh);
      }
      gl.useProgram(blur.p);
      gl.uniform1f(blur.u.uFlip, 0);
      gl.uniform1i(blur.u.uSrc, 0);
      gl.uniform1i(blur.u.uSeg, 1);
      gl.uniform1f(blur.u.uUseSeg, useSeg ? 1 : 0);
      bind(1, tex.seg);
      gl.viewport(0, 0, bw, bh);
      const step = strong ? 1.6 : 1.0;
      let src = tex.vid;
      for (let k = 0; k < (strong ? 2 : 1); k++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fb); bind(0, src);
        gl.uniform2f(blur.u.uDir, step / bw, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fb); bind(0, fboA.tex);
        gl.uniform2f(blur.u.uDir, 0, step / bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        src = fboB.tex;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return fboB.tex;
    }

    function render(p) {
      const { w, h } = p;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      upload(tex.vid, p.src);
      if (p.faceMask) upload(tex.face, p.faceMask);
      if (p.seg) uploadGray(tex.seg, p.seg.data, p.seg.w, p.seg.h);
      let bgMode = 0, bgTex = tex.bg;
      if (p.bgMode === "blur" || p.bgMode === "blur-strong") {
        bgMode = 1; bgTex = blurBg(w, h, p.bgMode === "blur-strong", !!p.seg);
      } else if (p.bgMode === "image") {
        bgMode = 2;
        if (p.bgImageChanged) upload(tex.bg, p.bgImage);
      } else if (p.bgMode === "color") bgMode = 3;
      if (!p.seg) bgMode = 0;

      gl.useProgram(main.p);
      gl.viewport(0, 0, w, h);
      gl.uniform1f(main.u.uFlip, 1);
      gl.uniform1i(main.u.uVid, 0); bind(0, tex.vid);
      gl.uniform1i(main.u.uFace, 1); bind(1, tex.face);
      gl.uniform1i(main.u.uSeg, 2); bind(2, tex.seg);
      gl.uniform1i(main.u.uBg, 3); bind(3, bgTex);
      gl.uniform2f(main.u.uRes, w, h);
      gl.uniform4fv(main.u.uWa, p.wa);
      gl.uniform4fv(main.u.uWb, p.wb);
      gl.uniform1f(main.u.uSmooth, p.smooth);
      gl.uniform1f(main.u.uSmoothR, p.smoothR);
      gl.uniform1f(main.u.uFaceOn, p.faceOn);
      gl.uniform1f(main.u.uLight, p.light);
      gl.uniform1f(main.u.uWarm, p.warm);
      gl.uniform1f(main.u.uBgMode, bgMode);
      gl.uniform3f(main.u.uBgColor, ...p.bgColor);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    }

    function destroy() {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    }
    return { render, destroy, canvas };
  }

  // ---------- Backgrounds ----------

  /** Built-in backgrounds, drawn once at the camera's size. */
  function drawBackground(kind, w, h, image) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    if (kind === "image" && image) {
      const s = Math.max(w / image.width, h / image.height);
      g.drawImage(image, (w - image.width * s) / 2, (h - image.height * s) / 2, image.width * s, image.height * s);
      return c;
    }
    if (kind === "studio") {
      const r = g.createRadialGradient(w * 0.5, h * 0.42, h * 0.05, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      r.addColorStop(0, "#5b6b86"); r.addColorStop(0.55, "#2c3549"); r.addColorStop(1, "#121722");
      g.fillStyle = r; g.fillRect(0, 0, w, h);
      return c;
    }
    if (kind === "office") {
      // Soft, out-of-focus room: warm window light on the left, shelves and a plant shape.
      const lg = g.createLinearGradient(0, 0, w, 0);
      lg.addColorStop(0, "#d9cbb5"); lg.addColorStop(0.45, "#b9a88f"); lg.addColorStop(1, "#7d6f5d");
      g.fillStyle = lg; g.fillRect(0, 0, w, h);
      g.filter = `blur(${Math.round(h / 40)}px)`;
      g.fillStyle = "rgba(255,250,235,0.75)"; g.fillRect(w * 0.04, h * 0.1, w * 0.22, h * 0.55);
      g.fillStyle = "#5f4b38";
      for (let i = 0; i < 3; i++) g.fillRect(w * 0.66, h * (0.22 + i * 0.2), w * 0.3, h * 0.025);
      const books = ["#8b3a3a", "#2f5d7c", "#c49a3a", "#4f6b3a", "#6b4a7a"];
      for (let i = 0; i < 14; i++) {
        g.fillStyle = books[i % books.length];
        g.fillRect(w * (0.67 + (i % 7) * 0.04), h * (0.12 + Math.floor(i / 7) * 0.2), w * 0.03, h * 0.1);
      }
      g.fillStyle = "#3f6b45";
      g.beginPath(); g.ellipse(w * 0.36, h * 0.62, w * 0.06, h * 0.16, 0, 0, Math.PI * 2); g.fill();
      g.filter = "none";
      return c;
    }
    if (kind === "night") {
      g.fillStyle = "#0b1020"; g.fillRect(0, 0, w, h);
      const cols = ["#f59e0b", "#60a5fa", "#f472b6", "#a78bfa", "#fde68a"];
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 60; i++) {
        const x = rnd() * w, y = h * (0.2 + rnd() * 0.7), r = h * (0.02 + rnd() * 0.06);
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, cols[i % cols.length] + "cc"); rg.addColorStop(1, cols[i % cols.length] + "00");
        g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      return c;
    }
    g.fillStyle = "#334155"; g.fillRect(0, 0, w, h);
    return c;
  }

  // ---------- Overlays ----------

  const HAIR_COLORS = {
    black: ["#0a0908", "#2e2621", "#6a5a4e"],
    darkbrown: ["#1c110b", "#4a2e1e", "#94664a"],
    brown: ["#331f13", "#6e4528", "#c08a5c"],
    grey: ["#4a4744", "#8e8a86", "#e2dfdb"],
  };
  const HAIR_SCALE = 400;           // pixels per face width in the hair drawing
  const HAIR_W = 680, HAIR_H = 560, HAIR_AX = 340, HAIR_AY = 340;
  const hairCache = new Map();

  // Hair outline in face widths, origin at the top of the forehead (landmark 10), y down.
  function hairShape(style) {
    const top = { crop: -0.47, sidepart: -0.52, quiff: -0.66, curly: -0.58 }[style] || -0.5;
    const side = { crop: 0.62, sidepart: 0.63, quiff: 0.6, curly: 0.69 }[style] || 0.62;
    const line = style === "quiff" ? -0.1 : -0.07;     // hairline height at the middle
    const outer = [
      [-side + 0.04, 0.33], [-side, 0.04],
      ["c", -side, -0.3, -0.46, top + 0.02, 0, top],
      ["c", 0.46, top + 0.02, side, -0.3, side, 0.04],
      [side - 0.04, 0.33],
    ];
    // Hairline: sideburns taper to a point, temples recede a little, the front sits at the top
    // of the forehead.
    const hl = [
      [0.53, 0.34], [0.52, 0.1], [0.42, -0.05],
      ["q", 0.25, line - 0.04, 0, line],
      ["q", -0.25, line - 0.04, -0.42, -0.05],
      [-0.52, 0.1], [-0.53, 0.34],
    ];
    const X = (x) => HAIR_AX + x * HAIR_SCALE, Y = (y) => HAIR_AY + y * HAIR_SCALE;
    const trace = (p, pts, start) => {
      let first = start;
      for (const pt of pts) {
        if (pt[0] === "c") p.bezierCurveTo(X(pt[1]), Y(pt[2]), X(pt[3]), Y(pt[4]), X(pt[5]), Y(pt[6]));
        else if (pt[0] === "q") p.quadraticCurveTo(X(pt[1]), Y(pt[2]), X(pt[3]), Y(pt[4]));
        else if (first) { p.moveTo(X(pt[0]), Y(pt[1])); first = false; } else p.lineTo(X(pt[0]), Y(pt[1]));
      }
    };
    const path = new Path2D();
    trace(path, [...outer, ...hl], true);
    path.closePath();
    const hairline = new Path2D();
    trace(hairline, hl, true);
    return { path, hairline, top, side };
  }

  /** Strand direction (unit vector) at a point, in face widths. */
  function flow(style, x, y, rnd) {
    let dx, dy;
    if (style === "sidepart") {
      const part = -0.2;
      if (x >= part) { dx = 1; dy = 0.25 + Math.max(0, x - 0.15) * 2.2 + Math.max(0, y + 0.1) * 1.5; } else { dx = -1; dy = 0.5 + (part - x) * 2.5; }
    } else if (style === "quiff") {
      if (Math.abs(x) < 0.36 && y > -0.62) { dx = x * 0.4; dy = -1; } else { dx = Math.sign(x) * 0.5; dy = y < -0.4 ? -0.4 : -1; }
    } else if (style === "curly") {
      const a = rnd() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a);
    } else {
      // Short crop: grows out from the crown and falls forward at the front.
      dx = x; dy = y + 0.42;
      if (y > -0.25) dy += 0.6;
      if (Math.abs(x) > 0.38) dy += 0.8;
    }
    const n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  }

  function makeHair(style, color) {
    const key = `${style}:${color}`;
    if (hairCache.has(key)) return hairCache.get(key);
    const [dark, mid, light] = HAIR_COLORS[color] || HAIR_COLORS.black;
    const c = document.createElement("canvas");
    c.width = HAIR_W; c.height = HAIR_H;
    const g = c.getContext("2d");
    const { path, hairline, top, side } = hairShape(style);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    g.save();
    g.clip(path);
    // Base: darker at the edges, a little lighter on top, so it has some roundness.
    const base = g.createRadialGradient(HAIR_AX, HAIR_AY + (top + 0.12) * HAIR_SCALE, 0.05 * HAIR_SCALE, HAIR_AX, HAIR_AY, 0.75 * HAIR_SCALE);
    base.addColorStop(0, mid); base.addColorStop(0.7, dark); base.addColorStop(1, dark);
    g.fillStyle = base; g.fillRect(0, 0, HAIR_W, HAIR_H);
    g.restore();
    // Strands may reach a little past the outline, which gives a natural, uneven edge.
    g.save();
    const ox = HAIR_AX, oy = HAIR_AY + (top * 0.45) * HAIR_SCALE;
    g.translate(ox, oy); g.scale(1.045, 1.03); g.translate(-ox, -oy);
    g.clip(path);
    g.setTransform(1, 0, 0, 1, 0, 0);

    const len = { crop: 0.035, sidepart: 0.1, quiff: 0.11, curly: 0.05 }[style] || 0.06;
    const count = { crop: 7000, sidepart: 5000, quiff: 5000, curly: 6000 }[style] || 5000;
    g.lineCap = "round";
    const minX = HAIR_AX - (side + 0.04) * HAIR_SCALE, maxX = HAIR_AX + (side + 0.04) * HAIR_SCALE;
    const minY = HAIR_AY + (top - 0.04) * HAIR_SCALE, maxY = HAIR_AY + 0.36 * HAIR_SCALE;
    for (let i = 0; i < count; i++) {
      const px = minX + rnd() * (maxX - minX), py = minY + rnd() * (maxY - minY);
      if (!g.isPointInPath(path, px, py)) continue;
      let x = (px - HAIR_AX) / HAIR_SCALE, y = (py - HAIR_AY) / HAIR_SCALE;
      // Light from above: lighter strands near the crown, darker at the sides and hairline.
      const lit = Math.max(0, Math.min(1, 1 - (y - top) / 0.45 - Math.abs(x) * 0.7)) * 0.7 + rnd() * 0.3;
      g.strokeStyle = lit > 0.6 ? light : lit > 0.32 ? mid : dark;
      g.globalAlpha = 0.45 + rnd() * 0.5;
      g.lineWidth = 1.3 + rnd() * 1.6;
      g.beginPath();
      g.moveTo(HAIR_AX + x * HAIR_SCALE, HAIR_AY + y * HAIR_SCALE);
      const steps = style === "curly" ? 6 : 4;
      const L = len * (0.6 + rnd() * 0.8);
      let [dx, dy] = flow(style, x, y, rnd);
      for (let s = 0; s < steps; s++) {
        if (style === "curly") { const a = Math.atan2(dy, dx) + 0.55; dx = Math.cos(a); dy = Math.sin(a); } else {
          const f = flow(style, x, y, rnd); dx = f[0] + (rnd() - 0.5) * 0.25; dy = f[1] + (rnd() - 0.5) * 0.25;
        }
        x += dx * L / steps; y += dy * L / steps;
        g.lineTo(HAIR_AX + x * HAIR_SCALE, HAIR_AY + y * HAIR_SCALE);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // Sheen on top.
    const sheen = g.createRadialGradient(HAIR_AX - 0.08 * HAIR_SCALE, HAIR_AY + (top + 0.14) * HAIR_SCALE, 0, HAIR_AX, HAIR_AY + (top + 0.16) * HAIR_SCALE, 0.42 * HAIR_SCALE);
    sheen.addColorStop(0, "rgba(255,255,255,0.16)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = sheen; g.fillRect(0, 0, HAIR_W, HAIR_H);
    g.restore();

    // Soften the hairline and the outline so it blends into the skin and background.
    g.save();
    g.globalCompositeOperation = "destination-out";
    g.filter = "blur(2.5px)";
    g.lineJoin = "round";
    g.globalAlpha = 0.7; g.lineWidth = 7; g.stroke(hairline);
    g.globalAlpha = 0.45; g.lineWidth = 4; g.stroke(path);
    g.globalAlpha = 1; g.filter = "none";
    // Sides thin out towards the ears instead of ending in a hard edge.
    const fade = g.createLinearGradient(0, HAIR_AY + 0.1 * HAIR_SCALE, 0, HAIR_AY + 0.36 * HAIR_SCALE);
    fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = fade; g.fillRect(0, HAIR_AY + 0.1 * HAIR_SCALE, HAIR_W, HAIR_H);
    g.restore();
    hairCache.set(key, c);
    return c;
  }

  function drawHair(g, lm, w, h, style, color) {
    const P = (i) => [lm[i].x * w, lm[i].y * h];
    const L = P(234), R = P(454), A = P(10), C = P(152);
    const fw = Math.hypot(R[0] - L[0], R[1] - L[1]);
    const fh = Math.hypot(C[0] - A[0], C[1] - A[1]);
    // Cheek-to-cheek width shrinks when the head turns, face height doesn't: use both.
    const unit = Math.max(fw, fh / 1.3);
    const ang = Math.atan2(R[1] - L[1], R[0] - L[0]);
    const img = makeHair(style, color);
    g.save();
    g.translate(A[0], A[1]);
    g.rotate(ang);
    g.scale(unit / HAIR_SCALE, unit / HAIR_SCALE);
    g.drawImage(img, -HAIR_AX, -HAIR_AY);
    g.restore();
  }

  function drawGlasses(g, lm, w, h, style) {
    const P = (i) => [lm[i].x * w, lm[i].y * h];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const l = mid(P(33), P(133)), r = mid(P(362), P(263));
    const d = Math.hypot(r[0] - l[0], r[1] - l[1]);
    const ang = Math.atan2(r[1] - l[1], r[0] - l[0]);
    const earL = P(234), earR = P(454);
    g.save();
    g.translate((l[0] + r[0]) / 2, (l[1] + r[1]) / 2);
    g.rotate(ang);
    const half = d / 2;
    const lens = (cx) => {
      const p = new Path2D();
      if (style === "round") p.arc(cx, 0, d * 0.4, 0, Math.PI * 2);
      else if (style === "square") p.roundRect(cx - d * 0.45, -d * 0.3, d * 0.9, d * 0.6, d * 0.12);
      else { // shades: aviator teardrop, wider on the outer side
        const o = Math.sign(cx);
        p.moveTo(cx - o * d * 0.42, -d * 0.24);
        p.quadraticCurveTo(cx, -d * 0.33, cx + o * d * 0.47, -d * 0.25);
        p.bezierCurveTo(cx + o * d * 0.52, d * 0.12, cx + o * d * 0.32, d * 0.4, cx + o * d * 0.02, d * 0.38);
        p.bezierCurveTo(cx - o * d * 0.28, d * 0.36, cx - o * d * 0.44, d * 0.1, cx - o * d * 0.42, -d * 0.24);
        p.closePath();
      }
      return p;
    };
    const left = lens(-half), right = lens(half);
    if (style === "shades") {
      for (const p of [left, right]) {
        const gr = g.createLinearGradient(0, -d * 0.35, 0, d * 0.4);
        gr.addColorStop(0, "rgba(15,18,25,0.92)"); gr.addColorStop(1, "rgba(40,48,62,0.82)");
        g.fillStyle = gr; g.fill(p);
      }
    } else {
      g.fillStyle = "rgba(190,215,255,0.10)";
      g.fill(left); g.fill(right);
    }
    g.strokeStyle = style === "shades" ? "#b8a26a" : "#14110f";
    g.lineWidth = Math.max(1.5, d * (style === "shades" ? 0.035 : 0.055));
    g.lineJoin = "round";
    g.stroke(left); g.stroke(right);
    // Bridge.
    g.beginPath();
    const inner = style === "round" ? half - d * 0.4 : half - d * 0.45;
    g.moveTo(-inner, -d * 0.06);
    g.quadraticCurveTo(0, -d * 0.16, inner, -d * 0.06);
    g.stroke();
    g.restore();
    // Arms towards the ears.
    const toLocal = (p) => p;
    g.save();
    g.strokeStyle = style === "shades" ? "#b8a26a" : "#14110f";
    g.lineWidth = Math.max(1.5, d * 0.045);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const cx = (l[0] + r[0]) / 2, cy = (l[1] + r[1]) / 2;
    const outer = style === "round" ? half + d * 0.4 : half + d * 0.46;
    const ends = [[-outer, -d * 0.1, earL], [outer, -d * 0.1, earR]];
    for (const [x, y, ear] of ends) {
      const sx = cx + x * cos - y * sin, sy = cy + x * sin + y * cos;
      const e = toLocal(ear);
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (e[0] - sx) * 0.85, sy + (e[1] - sy) * 0.85 - d * 0.05); g.stroke();
    }
    g.restore();
  }

  // ---------- The pipeline ----------

  /**
   * One camera's filter chain. process(src, w, h) returns a canvas with the filtered picture (or
   * the source itself when nothing is on), and face, the tracked face box in 0..1 (or null).
   */
  function Pipeline() {
    let opts = { ...DEFAULTS };
    let gl = null, glFailed = false;
    let out = null, outG = null;
    const mask = document.createElement("canvas");
    mask.width = 128; mask.height = 128;
    const mg = mask.getContext("2d");
    let lm = null, lmAt = 0, lastTs = 0;
    let seg = null, segAt = 0;
    let bgCanvas = null, bgKey = "", bgChanged = false;
    let frame = 0, skip = 1, detectMs = 0;
    let status = "", wantFace = false, wantSeg = false;
    const listeners = new Set();
    const setStatus = (s) => { status = s; listeners.forEach((f) => f(s)); };

    function set(o) {
      opts = { ...opts, ...o };
      wantFace = needsFace(opts); wantSeg = needsSeg(opts);
      const need = [];
      if (wantFace && !models.face) need.push("face");
      if (wantSeg && !models.seg) need.push("seg");
      if (need.length) {
        onProgress = (f) => setStatus(`Getting face filters ready (first time only)… ${Math.round(f * 100)}%`);
        setStatus("Getting face filters ready (first time only)…");
        Promise.all(need.map(load)).then(() => setStatus(""), (e) => {
          console.warn(e);
          setStatus("Face filters couldn't start in this browser. Light and warmth still work.");
        });
      }
    }

    function nextTs() { const t = Math.max(lastTs + 1, Math.round(performance.now())); lastTs = t; return t; }

    function detect(src, w, h) {
      const t0 = performance.now();
      if (wantFace && models.face) {
        try {
          const r = models.face.detectForVideo(src, nextTs());
          const f = r.faceLandmarks && r.faceLandmarks[0];
          if (f) {
            if (lm && lm.length === f.length) {
              // Smooth out jitter: move most of the way to the new points.
              for (let i = 0; i < f.length; i++) { lm[i].x += (f[i].x - lm[i].x) * 0.65; lm[i].y += (f[i].y - lm[i].y) * 0.65; }
            } else lm = f.map((p) => ({ x: p.x, y: p.y }));
            lmAt = performance.now();
          }
        } catch (e) { console.warn(e); }
      }
      if (wantSeg && models.seg) {
        try {
          const r = models.seg.segmentForVideo(src, nextTs());
          const masks = r.confidenceMasks || [];
          const m = masks[masks.length - 1];
          if (m) {
            const a = m.getAsFloat32Array();
            if (!seg || seg.w !== m.width || seg.h !== m.height) seg = { w: m.width, h: m.height, data: new Uint8Array(m.width * m.height) };
            const d = seg.data;
            for (let i = 0; i < a.length; i++) d[i] = (d[i] * 0.4 + a[i] * 255 * 0.6) | 0;  // a little temporal smoothing
            segAt = performance.now();
          }
          if (r.close) r.close();
        } catch (e) { console.warn(e); }
      }
      detectMs = detectMs * 0.8 + (performance.now() - t0) * 0.2;
      // Slow device: track every 2nd or 3rd frame and reuse the result in between.
      skip = detectMs > 40 ? 3 : detectMs > 22 ? 2 : 1;
    }

    function drawMask() {
      mg.clearRect(0, 0, 128, 128);
      mg.filter = "blur(2px)";
      mg.fillStyle = "#fff";
      const poly = (idx, grow) => {
        let cx = 0, cy = 0;
        for (const i of idx) { cx += lm[i].x; cy += lm[i].y; }
        cx /= idx.length; cy /= idx.length;
        mg.beginPath();
        idx.forEach((i, k) => {
          const x = (cx + (lm[i].x - cx) * grow) * 128, y = (cy + (lm[i].y - cy) * grow) * 128;
          if (k) mg.lineTo(x, y); else mg.moveTo(x, y);
        });
        mg.closePath(); mg.fill();
      };
      poly(OVAL, 0.97);
      mg.globalCompositeOperation = "destination-out";
      HOLES.forEach((h, i) => poly(h, i === 4 ? 1.15 : 1.35));
      mg.globalCompositeOperation = "source-over";
      mg.filter = "none";
    }

    function warps(w, h) {
      const wa = new Float32Array(24), wb = new Float32Array(24);
      if (!lm) return { wa, wb };
      const P = (i) => [lm[i].x * w, lm[i].y * h];
      const fw = Math.hypot(P(454)[0] - P(234)[0], P(454)[1] - P(234)[1]);
      const nose = P(1);
      let k = 0;
      if (opts.slim > 0.01) {
        for (const [i, s] of [[132, 0.6], [150, 1], [361, 0.6], [379, 1]]) {
          const p = P(i);
          const amt = 0.13 * opts.slim * s;
          wa.set([p[0], p[1], fw * 0.32, 1], k * 4);
          wb.set([(nose[0] - p[0]) * amt, (nose[1] - p[1]) * amt * 0.6, 0, 0], k * 4);
          k++;
        }
      }
      if (opts.eyes > 0.01 && lm.length > 473) {
        for (const [c, a, b] of [[468, 33, 133], [473, 362, 263]]) {
          const p = P(c);
          const ew = Math.hypot(P(a)[0] - P(b)[0], P(a)[1] - P(b)[1]);
          wa.set([p[0], p[1], ew * 1.1, 2], k * 4);
          wb.set([0, 0, 0.32 * opts.eyes, 0], k * 4);
          k++;
        }
      }
      return { wa, wb, fw };
    }

    function process(src, w, h) {
      if (!anyOn(opts) || glFailed) return { canvas: null, face: faceBox() };
      if (!gl) {
        try { gl = Renderer(); } catch (e) { console.warn(e); glFailed = true; return { canvas: null, face: null }; }
      }
      frame++;
      if ((wantFace && models.face) || (wantSeg && models.seg)) {
        if (frame % skip === 0) detect(src, w, h);
      }
      const now = performance.now();
      if (lm && now - lmAt > 600) lm = null;          // face lost
      if (seg && now - segAt > 1000) seg = null;
      const faceOn = lm && wantFace ? 1 : 0;
      if (faceOn && opts.smooth > 0.01) drawMask();
      let bgMode = wantSeg ? opts.bg : "none";
      if (bgMode !== "none" && !bgMode.startsWith("blur") && bgMode !== "color") {
        const key = `${bgMode}:${w}x${h}:${opts.bgImage ? opts.bgImageId : ""}`;
        if (key !== bgKey) { bgCanvas = drawBackground(bgMode, w, h, opts.bgImage); bgKey = key; bgChanged = true; }
        bgMode = "image";
      }
      const { wa, wb, fw } = warps(w, h);
      const hex = opts.bgColor || "#334155";
      const glc = gl.render({
        src, w, h,
        faceMask: faceOn && opts.smooth > 0.01 ? mask : null,
        seg: wantSeg ? seg : null,
        bgMode, bgImage: bgCanvas, bgImageChanged: bgChanged,
        bgColor: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255),
        wa, wb,
        smooth: opts.smooth, smoothR: (fw || w * 0.25) * (0.025 + 0.03 * opts.smooth), faceOn,
        light: opts.light * 0.9, warm: opts.warm,
      });
      bgChanged = false;
      if (!out) { out = document.createElement("canvas"); outG = out.getContext("2d"); }
      if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
      outG.drawImage(glc, 0, 0);
      if (lm && wantFace) {
        if (opts.hair !== "none") drawHair(outG, lm, w, h, opts.hair, opts.hairColor);
        if (opts.glasses !== "none") drawGlasses(outG, lm, w, h, opts.glasses);
      }
      return { canvas: out, face: faceBox() };
    }

    function faceBox() {
      if (!lm) return null;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const i of OVAL) { const p = lm[i]; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    function destroy() {
      if (gl) gl.destroy();
      gl = null; lm = null; seg = null; listeners.clear();
    }

    return {
      set, process, destroy,
      get options() { return { ...opts }; },
      get status() { return status; },
      get active() { return anyOn(opts); },
      onStatus: (f) => listeners.add(f),
      debug: () => ({ face: !!models.face, seg: !!models.seg, lm: lm ? lm.length : 0, mask: seg ? `${seg.w}x${seg.h}` : "", skip, detectMs }),
    };
  }

  return { Pipeline, DEFAULTS, PRESETS, makeHair, drawBackground, needsFace, needsSeg, load };
})();
