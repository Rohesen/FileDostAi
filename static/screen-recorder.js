// Screen Recorder: record your screen, a window or a tab with your camera in a bubble you can drag
// anywhere, or just the camera (phones). Live face filters (face-fx.js) work on the camera:
// smooth skin, brighten, slim face, background blur or a new background, hair and glasses.
// Everything happens in this browser: the screen and camera are drawn onto a canvas, and
// MediaRecorder turns that into an MP4 or WebM file. Nothing is uploaded.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/screen-recorder.css?v=40" }));

/** Writes the duration into a MediaRecorder WebM (browsers leave it out, so players can't seek). */
const WebmDuration = (() => {
  function vint(b, p) {
    const first = b[p];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8) return null;
    let value = first & (mask - 1), allOnes = value === mask - 1;
    for (let i = 1; i < len; i++) { value = value * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
    return { len, value, unknown: allOnes };
  }
  function idAt(b, p) {
    const first = b[p];
    let len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 4) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
    return { len, id };
  }
  function sizeBytes(value, len) {
    if (value >= Math.pow(2, 7 * len) - 1) return null;
    const out = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    out[0] |= 0x80 >> (len - 1);
    return out;
  }
  async function fix(blob, ms) {
    try {
      const n = Math.min(blob.size, 1 << 20);
      const b = new Uint8Array(await blob.slice(0, n).arrayBuffer());
      let p = 0;
      const ebml = idAt(b, p); if (!ebml || ebml.id !== 0x1a45dfa3) return blob;
      const es = vint(b, p + ebml.len); p += ebml.len + es.len + es.value;
      const seg = idAt(b, p); if (!seg || seg.id !== 0x18538067) return blob;
      const segSize = vint(b, p + seg.len);
      const segSizeAt = p + seg.len;
      p += seg.len + segSize.len;
      while (p < n - 12) {
        const el = idAt(b, p); if (!el) return blob;
        const sz = vint(b, p + el.len); if (!sz) return blob;
        const body = p + el.len + sz.len;
        if (el.id === 0x1549a966) {                              // Info
          let scale = 1e6, durAt = -1, durLen = 0, q = body;
          while (q < body + sz.value) {
            const c = idAt(b, q), cs = vint(b, q + c.len), cb = q + c.len + cs.len;
            if (c.id === 0x2ad7b1) { let v = 0; for (let i = 0; i < cs.value; i++) v = v * 256 + b[cb + i]; scale = v || 1e6; }
            if (c.id === 0x4489) { durAt = cb; durLen = cs.value; }
            q = cb + cs.value;
          }
          const units = (ms * 1e6) / scale;
          if (durAt >= 0) {                                      // already there: overwrite
            const out = b.slice();
            const dv = new DataView(out.buffer);
            if (durLen === 8) dv.setFloat64(durAt, units); else if (durLen === 4) dv.setFloat32(durAt, units); else return blob;
            return new Blob([out, blob.slice(n)], { type: blob.type });
          }
          const add = new Uint8Array(11);
          add.set([0x44, 0x89, 0x88]);
          new DataView(add.buffer).setFloat64(3, units);
          const newSize = sizeBytes(sz.value + 11, sz.len);
          if (!newSize) return blob;
          const end = body + sz.value;
          const head = b.slice(0, end);
          head.set(newSize, p + el.len);
          if (!segSize.unknown) {
            const s2 = sizeBytes(segSize.value + 11, segSize.len);
            if (!s2) return blob;
            head.set(s2, segSizeAt);
          }
          return new Blob([head, add, b.slice(end), blob.slice(n)], { type: blob.type });
        }
        if (sz.unknown) return blob;
        p = body + sz.value;
      }
    } catch (e) { console.warn("WebM duration fix skipped", e); }
    return blob;
  }
  return { fix };
})();

const ScreenRecorder = (() => {
  const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const canCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const canRecord = typeof MediaRecorder !== "undefined";
  const SIZES = { s: 0.24, m: 0.32, l: 0.42 };
  const KEY = "filedost-recorder";
  const svg = (d, cls = "") => `<svg class="sr-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    rec: `<svg class="sr-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>`,
    pause: svg('<path d="M9 5v14 M15 5v14"/>'),
    play: svg('<path d="M7 5l12 7-12 7z"/>'),
    stop: `<svg class="sr-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`,
    screen: svg('<path d="M2.5 4.5h19v12h-19z M9 20.5h6 M12 16.5v4"/>'),
    camera: svg('<path d="M3 7h12v10H3z M15 10.5l6-3.5v10l-6-3.5"/>'),
    mic: svg('<path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5.5 11a6.5 6.5 0 0 0 13 0 M12 17.5V21"/>'),
    flip: svg('<path d="M4 9a8 8 0 0 1 14-3 M20 15a8 8 0 0 1-14 3 M18.5 2.5V6H15 M5.5 21.5V18H9"/>'),
    download: svg('<path d="M12 3v12 M7 10l5 5 5-5 M4 20h16"/>'),
    trim: svg('<path d="M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8 7l12 10 M8 17L20 7"/>'),
    again: svg('<path d="M4 12a8 8 0 1 0 2.5-5.8 M4 3v4.5h4.5"/>'),
    upload: svg('<path d="M12 16V4 M7 9l5-5 5 5 M4 20h16"/>'),
  };

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode */ } }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  function fmt(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;

  function pickMime(format) {
    // Only H.264 + AAC MP4: some browsers also put VP9 or Opus in MP4, which phones and WhatsApp often can't play.
    const mp4 = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.4d002a,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2"];
    const webm = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const list = format === "mp4" ? [...mp4, ...webm] : [...webm, ...mp4];
    return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }
  const nativeMp4 = () => canRecord && ["video/mp4;codecs=avc1,mp4a.40.2"].some((t) => MediaRecorder.isTypeSupported(t));

  /**
   * The newest frame of a video track. Chrome hands frames over directly
   * (MediaStreamTrackProcessor), which keeps working while this tab is in the background;
   * other browsers use a hidden <video>.
   */
  function Source(track, holder) {
    let frame = null, video = null, reader = null, closed = false;
    const s = { w: 0, h: 0, frames: 0, img: null };
    if (typeof MediaStreamTrackProcessor !== "undefined") {
      try {
        reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (closed) { value.close(); break; }
              if (frame) frame.close();
              frame = value; s.img = value; s.w = value.displayWidth; s.h = value.displayHeight; s.frames++;
            }
          } catch (e) { /* track ended */ }
        })();
      } catch (e) { reader = null; }
    }
    if (!reader) {
      video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.autoplay = true;
      video.srcObject = new MediaStream([track]);
      holder.append(video);
      video.play().catch(() => {});
      const upd = () => { if (video.readyState >= 2 && video.videoWidth) { s.img = video; s.w = video.videoWidth; s.h = video.videoHeight; s.frames++; } };
      video.addEventListener("loadeddata", upd);
      video.addEventListener("resize", upd);
      s.poll = upd;
    }
    s.close = () => {
      closed = true;
      if (reader) reader.cancel().catch(() => {});
      if (frame) { try { frame.close(); } catch (e) { /* closed */ } }
      frame = null; s.img = null;
      if (video) { video.srcObject = null; video.remove(); }
    };
    return s;
  }

  /** Calls fn about fps times a second: animation frames while visible, a worker timer when hidden. */
  function Clock(fn) {
    let fps = 30, running = false, raf = 0, last = 0, worker = null;
    const tick = () => {
      const now = performance.now();
      if (now - last < 1000 / fps - 4) return;
      last = now;
      try { fn(now); } catch (e) { console.error(e); }
    };
    const loop = () => { if (!running) return; if (!document.hidden) tick(); raf = requestAnimationFrame(loop); };
    function start(f) {
      fps = f || fps;
      if (!worker) {
        try {
          const url = URL.createObjectURL(new Blob([`let t=0;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: "text/javascript" }));
          worker = new Worker(url);
          URL.revokeObjectURL(url);
          worker.onmessage = () => { if (running && document.hidden) tick(); };
        } catch (e) { worker = null; }
      }
      if (worker) worker.postMessage(Math.round(1000 / fps));
      if (!running) { running = true; raf = requestAnimationFrame(loop); }
    }
    function stop() {
      running = false; cancelAnimationFrame(raf);
      if (worker) { worker.terminate(); worker = null; }
    }
    return { start, stop, setFps: (f) => { fps = f; if (worker) worker.postMessage(Math.round(1000 / fps)); } };
  }

  const configHtml = `<div id="srRoot"></div>`;

  function create(root) {
    const st = Object.assign({
      mode: canScreen ? "both" : "camera", shape: "circle", size: "m", bx: 0.14, by: 0.78, mirror: true,
      quality: document.documentElement.classList.contains("fx-lite") ? "720" : "1080", fps: 30,
      format: nativeMp4() ? "mp4" : "webm", countdown: true, mic: true, sys: true, camOn: true, facing: "user",
      fx: {},
    }, load());
    if (!canScreen) st.mode = "camera";
    const fx = FaceFx.Pipeline();
    fx.set(Object.assign({}, FaceFx.DEFAULTS, st.fx, { bgImage: null, bg: st.fx && st.fx.bg === "image" ? "none" : (st.fx.bg || "none") }));

    const shared = { drop: document.getElementById("dropZone"), exec: document.getElementById("btnExecute"), name: document.getElementById("saveNameRow") };
    for (const el of Object.values(shared)) if (el) el.style.display = "none";

    const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${label}</option>`;
    const seg = (name, items, cur) => `<div class="sr-seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(cur) === String(v) ? "active" : ""}">${l}</button>`).join("")}</div>`;
    const slider = (id, label, v) => `<label class="sr-slider"><span>${label}</span><input type="range" id="${id}" min="0" max="100" value="${Math.round((v || 0) * 100)}"></label>`;
    const o = fx.options;

    root.innerHTML = `
      <div class="sr">
        ${!canRecord ? `<p class="sr-warn">${Icons.ui("warn")} This browser can't record video. Please use a recent Chrome, Edge, Firefox or Safari.</p>` : ""}
        <div class="sr-modes" role="tablist">
          ${canScreen ? `<button type="button" class="sr-mode" data-mode="both" role="tab">${ICON.screen}${ICON.camera}<span>Screen + camera</span></button>
          <button type="button" class="sr-mode" data-mode="screen" role="tab">${ICON.screen}<span>Screen only</span></button>` : ""}
          <button type="button" class="sr-mode" data-mode="camera" role="tab">${ICON.camera}<span>Camera only</span></button>
        </div>
        <div class="sr-main">
          <div class="sr-stagewrap">
            <div class="sr-stage" id="srStage">
              <canvas id="srCanvas" width="1280" height="720" aria-label="Recording preview. Drag the camera bubble to move it."></canvas>
              <video id="srPlayback" class="sr-playback" controls playsinline hidden></video>
              <div class="sr-empty" id="srEmpty" hidden>
                <button type="button" class="btn btn-primary" id="srPick">${ICON.screen} Choose screen, window or tab</button>
                <p>Pick what to record. You can drag your camera bubble anywhere first.</p>
              </div>
              <div class="sr-count" id="srCount" hidden></div>
              <div class="sr-status" id="srStatus" hidden></div>
              <div class="sr-live" id="srLive" hidden><span class="sr-dot"></span><span id="srLiveTime">0:00</span></div>
            </div>
            <div class="sr-bar" id="srBar">
              <button type="button" class="btn btn-primary sr-rec" id="srRec">${ICON.rec}<span>Start recording</span></button>
              <button type="button" class="btn sr-btn" id="srPause" hidden>${ICON.pause}<span>Pause</span></button>
              <button type="button" class="btn sr-btn sr-stop" id="srStop" hidden>${ICON.stop}<span>Stop</span></button>
              <span class="sr-time" id="srTime"></span>
              <button type="button" class="btn sr-btn" id="srFlip" hidden title="Switch camera">${ICON.flip}<span>Flip</span></button>
            </div>
            <div class="sr-result" id="srResult" hidden>
              <p class="sr-result-info" id="srInfo"></p>
              <div class="sr-result-row">
                <button type="button" class="btn btn-primary" id="srSave">${ICON.download}<span>Download</span></button>
                <button type="button" class="btn sr-btn" id="srMp4" hidden>${ICON.download}<span>Download as MP4</span></button>
                <button type="button" class="btn sr-btn" id="srTrim">${ICON.trim}<span>Trim it</span></button>
                <button type="button" class="btn sr-btn" id="srAgain">${ICON.again}<span>Record again</span></button>
              </div>
              <div class="sr-progress" id="srProg" hidden><div class="sr-progress-bar"><span id="srProgBar"></span></div><span id="srProgText"></span></div>
            </div>
            <p class="drop-hint sr-hint" id="srHint"></p>
          </div>

          <div class="sr-side">
            <details class="sr-panel" open>
              <summary>Camera and sound</summary>
              <div class="sr-row">
                <label class="checkbox-group"><input type="checkbox" id="srCamOn"${st.camOn ? " checked" : ""}> ${ICON.camera} Camera</label>
                <select id="srCam" class="select-sm" aria-label="Camera"><option value="">Default camera</option></select>
              </div>
              <div class="sr-row">
                <label class="checkbox-group"><input type="checkbox" id="srMicOn"${st.mic ? " checked" : ""}> ${ICON.mic} Microphone</label>
                <select id="srMic" class="select-sm" aria-label="Microphone"><option value="">Default microphone</option></select>
              </div>
              <div class="sr-meter" aria-hidden="true"><span id="srMeter"></span></div>
              ${canScreen ? `<label class="checkbox-group sr-sys"><input type="checkbox" id="srSys"${st.sys ? " checked" : ""}> Record sound from the tab or computer too</label>` : ""}
              <div class="sr-bubble-opts" id="srBubbleOpts">
                <div class="sr-label">Camera bubble</div>
                ${seg("shape", [["circle", "Circle"], ["square", "Square"], ["wide", "Wide"]], st.shape)}
                ${seg("size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], st.size)}
              </div>
              <label class="checkbox-group"><input type="checkbox" id="srMirror"${st.mirror ? " checked" : ""}> Mirror my camera</label>
            </details>

            <details class="sr-panel" open>
              <summary>Face filters</summary>
              ${seg("preset", [["off", "Off"], ["natural", "Natural"], ["fresh", "Fresh"], ["studio", "Studio"]], "")}
              ${slider("srSmooth", "Smooth skin", o.smooth)}
              ${slider("srLight", "Brighten", o.light)}
              ${slider("srWarm", "Warmth", o.warm)}
              ${slider("srSlim", "Slim face", o.slim)}
              ${slider("srEyes", "Bigger eyes", o.eyes)}
              <label class="sr-field"><span>Background</span>
                <select id="srBg" class="select-sm">
                  ${[["none", "Keep my background"], ["blur", "Blur"], ["blur-strong", "Strong blur"], ["studio", "Studio"], ["office", "Office"], ["night", "City lights"], ["color", "Plain colour"], ["image", "My own picture…"]].map(([v, l]) => opt(v, l, o.bg)).join("")}
                </select>
              </label>
              <div class="sr-row sr-bgextra">
                <input type="color" id="srBgColor" value="${o.bgColor}" aria-label="Background colour" hidden>
                <button type="button" class="btn btn-xs" id="srBgPick" hidden>${ICON.upload} Choose picture</button>
                <input type="file" id="srBgFile" accept="image/*" hidden>
              </div>
              <label class="sr-field"><span>Hair</span>
                <select id="srHair" class="select-sm">
                  ${[["none", "None"], ["crop", "Short crop"], ["sidepart", "Side part"], ["quiff", "Quiff"], ["curly", "Curly"]].map(([v, l]) => opt(v, l, o.hair)).join("")}
                </select>
              </label>
              <div class="sr-swatches" id="srHairColor" ${o.hair === "none" ? "hidden" : ""}>
                ${[["black", "#1a1512"], ["darkbrown", "#4a2e1e"], ["brown", "#7a4f30"], ["grey", "#9a9692"]].map(([v, c]) => `<button type="button" data-v="${v}" style="background:${c}" class="${o.hairColor === v ? "active" : ""}" aria-label="${v}"></button>`).join("")}
              </div>
              <label class="sr-field"><span>Glasses</span>
                <select id="srGlasses" class="select-sm">
                  ${[["none", "None"], ["round", "Round"], ["square", "Square"], ["shades", "Sunglasses"]].map(([v, l]) => opt(v, l, o.glasses)).join("")}
                </select>
              </label>
              <p class="sr-note">Filters only change the camera. Face tracking runs on your device.</p>
            </details>

            <details class="sr-panel">
              <summary>Quality</summary>
              <div class="sr-label">Size</div>
              ${seg("quality", [["720", "720p"], ["1080", "1080p"]], st.quality)}
              <div class="sr-label">Smoothness</div>
              ${seg("fps", [["30", "30 fps"], ["60", "60 fps"]], st.fps)}
              <div class="sr-label">File type</div>
              ${seg("format", [["mp4", "MP4"], ["webm", "WebM"]], st.format)}
              <label class="checkbox-group"><input type="checkbox" id="srCountdown"${st.countdown ? " checked" : ""}> 3-second countdown</label>
            </details>
          </div>
        </div>
      </div>`;

    const $ = (id) => root.querySelector("#" + id);
    const canvas = $("srCanvas");
    const g = canvas.getContext("2d");
    const holder = document.createElement("div");
    holder.className = "sr-holder";
    document.body.append(holder);

    let screen = null, cam = null, mic = null;
    let scrSrc = null, camSrc = null;
    let ac = null, analyser = null, micNode = null, mixDest = null;
    let rec = null, chunks = [], bytes = 0, mime = "", startedAt = 0, pausedFor = 0, pauseAt = 0;
    let result = null, playUrl = "", capture = null, countdownTimer = 0, timeTimer = 0, destroyed = false;
    let faceCx = 0.5, faceCy = 0.45, dragging = null, abort = null;
    let bgImage = null, bgImageId = 0;
    const clock = Clock(draw);

    const persist = () => save({ ...st, fx: { ...fx.options, bgImage: undefined } });
    const hint = (t) => { $("srHint").textContent = t || ""; };
    const toast = (m, type = "error") => (typeof showToast === "function" ? showToast(m, type) : console.warn(m));

    // ---------- Canvas size ----------

    function targetSize() {
      const long = st.quality === "1080" ? 1920 : 1280, short = st.quality === "1080" ? 1080 : 720;
      let w = 16, h = 9;
      if (st.mode === "camera" && camSrc && camSrc.w) { w = camSrc.w; h = camSrc.h; } else if (st.mode !== "camera" && scrSrc && scrSrc.w) { w = scrSrc.w; h = scrSrc.h; }
      const s = Math.min(1, w >= h ? Math.min(long / w, short / h) : Math.min(short / w, long / h));
      if (w <= 16) return [long, short];
      return [even(w * s), even(h * s)];
    }
    function fitCanvas() {
      if (rec) return;                                   // never change size mid-recording
      const [w, h] = targetSize();
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      $("srStage").style.aspectRatio = `${w} / ${h}`;
      $("srStage").classList.toggle("sr-portrait", h > w);
    }

    // ---------- Drawing ----------

    function bubbleRect() {
      const W = canvas.width, H = canvas.height;
      const d = Math.round(Math.min(W, H) * SIZES[st.size]);
      const bw = st.shape === "wide" ? Math.round(d * 16 / 9) : d;
      const m = Math.round(Math.min(W, H) * 0.03);
      let x = st.bx * W - bw / 2, y = st.by * H - d / 2;
      x = Math.max(m, Math.min(W - bw - m, x)); y = Math.max(m, Math.min(H - d - m, y));
      return { x, y, w: bw, h: d };
    }

    function camImage() {
      if (!camSrc || !camSrc.img || !camSrc.w) return null;
      if (camSrc.poll) camSrc.poll();
      const r = fx.process(camSrc.img, camSrc.w, camSrc.h);
      if (r.face) {
        faceCx += (r.face.x + r.face.w / 2 - faceCx) * 0.12;
        faceCy += (r.face.y + r.face.h * 0.45 - faceCy) * 0.12;
      } else { faceCx += (0.5 - faceCx) * 0.05; faceCy += (0.45 - faceCy) * 0.05; }
      return { img: r.canvas || camSrc.img, w: camSrc.w, h: camSrc.h, face: r.face };
    }

    /** Draws the camera picture to fill (x, y, w, h), cropped around the face when we know where it is. */
    function drawCam(c, x, y, w, h, follow) {
      const scale = Math.max(w / c.w, h / c.h);
      const sw = w / scale, sh = h / scale;
      const cx = follow ? faceCx * c.w : c.w / 2, cy = follow ? faceCy * c.h : c.h / 2;
      const sx = Math.max(0, Math.min(c.w - sw, cx - sw / 2)), sy = Math.max(0, Math.min(c.h - sh, cy - sh / 2));
      g.save();
      if (st.mirror) { g.translate(x + w, y); g.scale(-1, 1); g.drawImage(c.img, c.w - sx - sw, sy, sw, sh, 0, 0, w, h); } else g.drawImage(c.img, sx, sy, sw, sh, x, y, w, h);
      g.restore();
    }

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    }

    function drawBubble(c) {
      const b = bubbleRect();
      const r = st.shape === "circle" ? b.h / 2 : b.h * 0.14;
      g.save();
      g.shadowColor = "rgba(0,0,0,0.45)"; g.shadowBlur = b.h * 0.08; g.shadowOffsetY = b.h * 0.02;
      g.fillStyle = "#111"; roundRect(b.x, b.y, b.w, b.h, r); g.fill();
      g.restore();
      g.save();
      roundRect(b.x, b.y, b.w, b.h, r); g.clip();
      if (c) drawCam(c, b.x, b.y, b.w, b.h, st.shape !== "wide");
      else { g.fillStyle = "#1f2937"; g.fillRect(b.x, b.y, b.w, b.h); }
      g.restore();
      g.save();
      g.lineWidth = Math.max(2, b.h * 0.018); g.strokeStyle = "rgba(255,255,255,0.9)";
      roundRect(b.x, b.y, b.w, b.h, r); g.stroke();
      g.restore();
    }

    function drawPlaceholder() {
      const W = canvas.width, H = canvas.height;
      const gr = g.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, "#111827"); gr.addColorStop(1, "#1f2024");
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.strokeStyle = "rgba(255,255,255,0.05)"; g.lineWidth = 1;
      const step = Math.round(H / 12);
      g.beginPath();
      for (let x = step; x < W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
      for (let y = step; y < H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
    }

    function draw() {
      if (destroyed) return;
      // Screen only while hidden: the recorder takes the screen directly, the preview can rest.
      if (rec && st.mode === "screen" && document.hidden) return;
      const W = canvas.width, H = canvas.height;
      if (st.mode === "camera") {
        const c = camImage();
        if (c) drawCam(c, 0, 0, W, H, false); else drawPlaceholder();
      } else {
        if (scrSrc && scrSrc.poll) scrSrc.poll();
        if (scrSrc && scrSrc.img && scrSrc.w) {
          const s = Math.min(W / scrSrc.w, H / scrSrc.h);
          const dw = scrSrc.w * s, dh = scrSrc.h * s;
          if (dw < W - 1 || dh < H - 1) { g.fillStyle = "#000"; g.fillRect(0, 0, W, H); }
          g.drawImage(scrSrc.img, (W - dw) / 2, (H - dh) / 2, dw, dh);
          if (Math.abs(canvas.width / canvas.height - scrSrc.w / scrSrc.h) > 0.01 && !rec) fitCanvas();
        } else drawPlaceholder();
        if (st.mode === "both" && st.camOn) drawBubble(camImage());
      }
      if (analyser && !document.hidden) meter();
    }

    // ---------- Devices ----------

    async function listDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const fill = (sel, kind, label) => {
          const cur = sel.value;
          const items = list.filter((d) => d.kind === kind);
          sel.innerHTML = `<option value="">${label}</option>` + items.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}`)}</option>`).join("");
          if ([...sel.options].some((op) => op.value === cur)) sel.value = cur;
        };
        fill($("srCam"), "videoinput", "Default camera");
        fill($("srMic"), "audioinput", "Default microphone");
        $("srFlip").hidden = !(st.mode === "camera" && list.filter((d) => d.kind === "videoinput").length > 1 && matchMedia("(pointer: coarse)").matches);
      } catch (e) { /* no device list */ }
    }

    async function startCam() {
      stopCam();
      if (!canCamera || !st.camOn || st.mode === "screen") return;
      const big = st.quality === "1080";
      const portrait = st.mode === "camera" && matchMedia("(orientation: portrait)").matches && matchMedia("(pointer: coarse)").matches;
      const id = $("srCam").value;
      const video = {
        width: { ideal: portrait ? (big ? 1080 : 720) : (big ? 1920 : 1280) },
        height: { ideal: portrait ? (big ? 1920 : 1280) : (big ? 1080 : 720) },
        frameRate: { ideal: Number(st.fps) },
      };
      if (id) video.deviceId = { exact: id }; else video.facingMode = st.facing;
      try {
        cam = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        console.warn(e);
        hint("Camera is off: the browser didn't allow it, or another app is using it. You can still record the screen.");
        return;
      }
      if (destroyed) { cam.getTracks().forEach((t) => t.stop()); return; }
      camSrc = Source(cam.getVideoTracks()[0], holder);
      listDevices();
      waitSize(camSrc);
    }
    function stopCam() {
      if (camSrc) camSrc.close();
      if (cam) cam.getTracks().forEach((t) => t.stop());
      cam = null; camSrc = null;
    }
    function waitSize(src) {
      let n = 0;
      const t = setInterval(() => { if (src.poll) src.poll(); if (src.w || ++n > 50) { clearInterval(t); fitCanvas(); } }, 100);
    }

    async function startMic() {
      stopMic();
      if (!canCamera || !st.mic) return;
      const id = $("srMic").value;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      } catch (e) {
        console.warn(e);
        hint("Microphone is off: the browser didn't allow it.");
        return;
      }
      if (destroyed) { mic.getTracks().forEach((t) => t.stop()); return; }
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === "suspended") ac.resume().catch(() => {});
        micNode = ac.createMediaStreamSource(mic);
        analyser = ac.createAnalyser(); analyser.fftSize = 512;
        micNode.connect(analyser);
      } catch (e) { analyser = null; }
      listDevices();
    }
    function stopMic() {
      if (micNode) { try { micNode.disconnect(); } catch (e) { /* gone */ } }
      if (mic) mic.getTracks().forEach((t) => t.stop());
      mic = null; micNode = null; analyser = null;
      $("srMeter").style.width = "0";
    }
    const meterBuf = new Uint8Array(512);
    function meter() {
      analyser.getByteTimeDomainData(meterBuf);
      let s = 0;
      for (let i = 0; i < meterBuf.length; i++) { const v = (meterBuf[i] - 128) / 128; s += v * v; }
      $("srMeter").style.width = `${Math.min(100, Math.sqrt(s / meterBuf.length) * 380)}%`;
    }

    async function pickScreen() {
      if (!canScreen) return false;
      const big = st.quality === "1080";
      let s;
      try {
        s = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: big ? 1920 : 1280, max: big ? 1920 : 1280 }, height: { ideal: big ? 1080 : 720, max: big ? 1080 : 720 }, frameRate: { ideal: Number(st.fps), max: Number(st.fps) }, cursor: "always" },
          audio: st.sys ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
          selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include",
        });
      } catch (e) {
        if (e && e.name !== "NotAllowedError") console.warn(e);
        hint(e && e.name === "NotAllowedError" ? "Screen sharing was cancelled. Click “Choose screen” to try again." : "This browser couldn't share the screen.");
        return false;
      }
      if (destroyed) { s.getTracks().forEach((t) => t.stop()); return false; }
      stopScreen();
      screen = s;
      const vt = s.getVideoTracks()[0];
      if ("contentHint" in vt) vt.contentHint = "detail";
      vt.addEventListener("ended", () => {
        if (screen !== s) return;
        if (rec) stopRecording(); else { stopScreen(); updateUi(); }
      });
      scrSrc = Source(vt, holder);
      waitSize(scrSrc);
      updateUi();
      return true;
    }
    function stopScreen() {
      if (scrSrc) scrSrc.close();
      if (screen) screen.getTracks().forEach((t) => t.stop());
      screen = null; scrSrc = null;
    }

    // ---------- Recording ----------

    function audioTrack() {
      const ins = [];
      if (mic && st.mic) ins.push(mic);
      if (screen && st.sys && st.mode !== "camera" && screen.getAudioTracks().length) ins.push(new MediaStream(screen.getAudioTracks()));
      if (!ins.length) return null;
      if (ins.length === 1) return ins[0].getAudioTracks()[0];
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      mixDest = ac.createMediaStreamDestination();
      for (const s of ins) ac.createMediaStreamSource(s).connect(mixDest);
      return mixDest.stream.getAudioTracks()[0];
    }

    async function begin() {
      if (!canRecord) return;
      if (ac && ac.state === "suspended") ac.resume().catch(() => {});
      if (st.mode !== "camera" && !screen) { if (!(await pickScreen())) return; }
      if (st.mode !== "screen" && st.camOn && !cam) await startCam();
      if (st.mode === "camera" && !cam) { hint("Turn on the camera to record it."); return; }
      if (st.mic && !mic) await startMic();
      fitCanvas();
      if (st.countdown) {
        $("srRec").disabled = true;
        let n = 3;
        const box = $("srCount");
        box.hidden = false; box.textContent = n;
        await new Promise((resolve) => {
          countdownTimer = setInterval(() => {
            n--;
            if (n <= 0 || destroyed) { clearInterval(countdownTimer); box.hidden = true; resolve(); } else box.textContent = n;
          }, 1000);
        });
        $("srRec").disabled = false;
        if (destroyed) return;
      }
      startRecording();
    }

    function startRecording() {
      mime = pickMime(st.format);
      const fps = Number(st.fps);
      const big = st.quality === "1080";
      let video;
      if (st.mode === "screen") video = screen.getVideoTracks()[0];
      else { capture = canvas.captureStream(fps); video = capture.getVideoTracks()[0]; }
      const a = audioTrack();
      const stream = new MediaStream(a ? [video, a] : [video]);
      const bits = (big ? 6e6 : 3.5e6) * (fps === 60 ? 1.5 : 1);
      try {
        rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bits, audioBitsPerSecond: 128000 });
      } catch (e) {
        console.warn(e);
        rec = new MediaRecorder(stream);
      }
      mime = rec.mimeType || mime || "video/webm";
      chunks = []; bytes = 0; pausedFor = 0; pauseAt = 0;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); bytes += e.data.size; } };
      rec.onstop = finish;
      rec.onerror = (e) => { console.warn(e); toast("Recording stopped because of an error in the browser."); };
      rec.start(1000);
      startedAt = performance.now();
      timeTimer = setInterval(tickTime, 250);
      updateUi();
      hint(st.mode === "camera" ? "" : "Recording. Go to the window or tab you want to show; come back here or use the browser's Stop sharing button to finish.");
    }

    function elapsed() { return (pauseAt || performance.now()) - startedAt - pausedFor; }
    function tickTime() {
      const t = fmt(elapsed());
      $("srTime").textContent = `${t}  ·  ${mb(bytes)}`;
      $("srLiveTime").textContent = t;
    }

    function togglePause() {
      if (!rec) return;
      if (rec.state === "recording") { rec.pause(); pauseAt = performance.now(); } else if (rec.state === "paused") { pausedFor += performance.now() - pauseAt; pauseAt = 0; rec.resume(); }
      updateUi();
    }

    function stopRecording() {
      if (!rec || rec.state === "inactive") return;
      if (pauseAt) { pausedFor += performance.now() - pauseAt; pauseAt = 0; }
      rec.stop();
    }

    async function finish() {
      const ms = elapsed();
      clearInterval(timeTimer);
      if (capture) { capture.getTracks().forEach((t) => t.stop()); capture = null; }
      if (mixDest) { mixDest.stream.getTracks().forEach((t) => t.stop()); mixDest = null; }
      rec = null;
      if (destroyed) return;
      const type = mime.split(";")[0] || "video/webm";
      let blob = new Blob(chunks, { type });
      chunks = [];
      if (type === "video/webm") blob = await WebmDuration.fix(blob, ms);
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const ext = type === "video/mp4" ? "mp4" : "webm";
      const name = `Recording_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
      result = { blob, name, ms, ext };
      if (playUrl) URL.revokeObjectURL(playUrl);
      playUrl = URL.createObjectURL(blob);
      const pb = $("srPlayback");
      pb.src = playUrl;
      $("srInfo").textContent = `${name}  ·  ${fmt(ms)} long  ·  ${mb(blob.size)}. Saved on this device only, nothing was uploaded.`;
      $("srMp4").hidden = ext === "mp4" || typeof MediaTool === "undefined";
      if (ext !== "mp4" && st.format === "mp4") $("srInfo").textContent += " This browser records WebM; use Download as MP4 to convert it here.";
      hint("");
      updateUi();
    }

    async function toMp4() {
      if (!result || typeof MediaTool === "undefined") return;
      const btn = $("srMp4");
      btn.disabled = true;
      $("srProg").hidden = false;
      abort = new AbortController();
      const cctx = {
        signal: abort.signal,
        progress: (f, label) => { $("srProgBar").style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; $("srProgText").textContent = label || ""; },
      };
      try {
        const file = new File([result.blob], result.name, { type: "video/webm" });
        const secs = result.ms / 1000;
        const data = await MediaTool.withInput(cctx, file, 0.25, async (f, path) => {
          await MediaTool.exec(cctx, f, ["-i", path, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "out.mp4"], { duration: secs, label: "Making the MP4", from: 0.25, to: 1 });
          return MediaTool.readOut(f, "out.mp4");
        });
        downloadBlob(new Blob([data], { type: "video/mp4" }), result.name.replace(/\.webm$/, ".mp4"));
        cctx.progress(1, "Done. The MP4 is in your downloads.");
      } catch (e) {
        if (!(e && e.cancelled)) { console.warn(e); toast(e && e.message ? e.message : "Couldn't make the MP4."); }
        $("srProg").hidden = true;
      } finally {
        btn.disabled = false; abort = null;
      }
    }

    function again() {
      result = null;
      if (playUrl) { $("srPlayback").removeAttribute("src"); $("srPlayback").load(); URL.revokeObjectURL(playUrl); playUrl = ""; }
      $("srProg").hidden = true;
      updateUi();
    }

    // ---------- UI ----------

    function updateUi() {
      root.querySelectorAll(".sr-mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === st.mode));
      const recording = !!rec, paused = rec && rec.state === "paused";
      const showResult = !!result && !recording;
      canvas.hidden = showResult;
      $("srPlayback").hidden = !showResult;
      $("srResult").hidden = !showResult;
      $("srBar").hidden = showResult;
      $("srEmpty").hidden = !(st.mode !== "camera" && !screen && !showResult && !recording);
      $("srRec").hidden = recording;
      $("srPause").hidden = !recording;
      $("srStop").hidden = !recording;
      $("srLive").hidden = !recording;
      $("srLive").classList.toggle("paused", !!paused);
      $("srPause").innerHTML = paused ? `${ICON.play}<span>Resume</span>` : `${ICON.pause}<span>Pause</span>`;
      if (!recording) $("srTime").textContent = "";
      $("srBubbleOpts").hidden = st.mode !== "both";
      root.querySelectorAll(".sr-side input, .sr-side select, .sr-seg[data-seg=quality] button, .sr-seg[data-seg=fps] button, .sr-seg[data-seg=format] button, .sr-mode")
        .forEach((el) => {
          const live = el.closest(".sr-seg[data-seg=shape], .sr-seg[data-seg=size], .sr-seg[data-seg=preset]") || /^sr(Smooth|Light|Warm|Slim|Eyes|Bg|BgColor|Hair|Glasses|Mirror)$/.test(el.id);
          el.disabled = recording && !live;
        });
      const sysBox = $("srSys");
      if (sysBox) sysBox.closest("label").hidden = st.mode === "camera";
      canvas.classList.toggle("sr-draggable", st.mode === "both" && !recording);
      $("srCanvas").style.cursor = "";
    }

    function setMode(m) {
      if (rec || m === st.mode) return;
      st.mode = m; persist();
      if (m === "screen") stopCam(); else if (st.camOn && !cam) startCam();
      if (m === "camera") stopScreen();
      fitCanvas(); updateUi(); listDevices();
      hint(m === "camera" ? "Records just your camera, with filters. Great on phones." : "");
    }

    function applyFx(o) {
      fx.set(o);
      const v = fx.options;
      $("srSmooth").value = Math.round(v.smooth * 100); $("srLight").value = Math.round(v.light * 100);
      $("srWarm").value = Math.round(v.warm * 100); $("srSlim").value = Math.round(v.slim * 100); $("srEyes").value = Math.round(v.eyes * 100);
      $("srBg").value = v.bg; $("srHair").value = v.hair; $("srGlasses").value = v.glasses;
      $("srBgColor").hidden = v.bg !== "color";
      $("srBgPick").hidden = v.bg !== "image";
      $("srBgPick").parentElement.hidden = v.bg !== "color" && v.bg !== "image";
      $("srHairColor").hidden = v.hair === "none";
      root.querySelectorAll("#srHairColor button").forEach((b) => b.classList.toggle("active", b.dataset.v === v.hairColor));
      persist();
    }

    // Segmented buttons.
    root.addEventListener("click", (e) => {
      const m = e.target.closest(".sr-mode");
      if (m) return setMode(m.dataset.mode);
      const b = e.target.closest(".sr-seg button");
      if (b && !b.disabled) {
        const name = b.closest(".sr-seg").dataset.seg, v = b.dataset.v;
        if (name === "preset") {
          applyFx({ ...FaceFx.DEFAULTS, bgImage: bgImage, bgImageId, ...FaceFx.PRESETS[v] });
          b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
          return;
        }
        b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        st[name] = name === "fps" ? Number(v) : v;
        persist();
        if (name === "quality" || name === "fps") {
          clock.setFps(Number(st.fps));
          if (cam) startCam();
          if (screen) { const t = screen.getVideoTracks()[0]; const big = st.quality === "1080"; t.applyConstraints({ width: { max: big ? 1920 : 1280 }, height: { max: big ? 1080 : 720 }, frameRate: { max: Number(st.fps) } }).catch(() => {}); }
          setTimeout(fitCanvas, 300);
        }
        return;
      }
      const sw = e.target.closest("#srHairColor button");
      if (sw) return applyFx({ hairColor: sw.dataset.v });
    });

    const fxSliders = { srSmooth: "smooth", srLight: "light", srWarm: "warm", srSlim: "slim", srEyes: "eyes" };
    root.addEventListener("input", (e) => {
      const k = fxSliders[e.target.id];
      if (k) { fx.set({ [k]: e.target.value / 100 }); persist(); root.querySelectorAll('.sr-seg[data-seg=preset] button').forEach((x) => x.classList.remove("active")); }
      if (e.target.id === "srBgColor") applyFx({ bgColor: e.target.value });
    });

    $("srBg").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "image" && !bgImage) { $("srBgFile").click(); applyFx({ bg: "none" }); $("srBg").value = "image"; $("srBgPick").hidden = false; return; }
      applyFx({ bg: v });
    });
    $("srBgPick").addEventListener("click", () => $("srBgFile").click());
    $("srBgFile").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        bgImage = await createImageBitmap(f);
        bgImageId++;
        applyFx({ bg: "image", bgImage, bgImageId });
      } catch (err) { toast("This picture couldn't be opened. Try a JPG or PNG."); }
    });
    $("srHair").addEventListener("change", (e) => applyFx({ hair: e.target.value }));
    $("srGlasses").addEventListener("change", (e) => applyFx({ glasses: e.target.value }));
    $("srMirror").addEventListener("change", (e) => { st.mirror = e.target.checked; persist(); });
    $("srCountdown").addEventListener("change", (e) => { st.countdown = e.target.checked; persist(); });
    if ($("srSys")) $("srSys").addEventListener("change", (e) => { st.sys = e.target.checked; persist(); if (screen) hint("Sound from the screen is chosen when you pick it. Choose the screen again to change this."); });
    $("srCamOn").addEventListener("change", (e) => { st.camOn = e.target.checked; persist(); if (st.camOn) startCam(); else stopCam(); });
    $("srMicOn").addEventListener("change", (e) => { st.mic = e.target.checked; persist(); if (st.mic) startMic(); else stopMic(); });
    $("srCam").addEventListener("change", () => { if (st.camOn) startCam(); });
    $("srMic").addEventListener("change", () => { if (st.mic) startMic(); });
    $("srFlip").addEventListener("click", () => { st.facing = st.facing === "user" ? "environment" : "user"; $("srCam").value = ""; st.mirror = st.facing === "user"; $("srMirror").checked = st.mirror; startCam(); });
    $("srPick").addEventListener("click", () => pickScreen());
    $("srRec").addEventListener("click", () => begin());
    $("srPause").addEventListener("click", togglePause);
    $("srStop").addEventListener("click", stopRecording);
    $("srSave").addEventListener("click", () => result && downloadBlob(result.blob, result.name));
    $("srMp4").addEventListener("click", toMp4);
    $("srAgain").addEventListener("click", again);
    $("srTrim").addEventListener("click", () => {
      if (!result) return;
      const file = new File([result.blob], result.name, { type: result.blob.type });
      openToolModal("trim-media");
      setTimeout(() => addFilesToTool([file]), 0);
    });
    fx.onStatus((s) => { $("srStatus").hidden = !s; $("srStatus").textContent = s; });

    // Dragging the bubble.
    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
    };
    const inBubble = (x, y) => { const b = bubbleRect(); return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; };
    canvas.addEventListener("pointerdown", (e) => {
      if (st.mode !== "both" || rec) return;
      const [x, y] = toCanvas(e);
      if (!inBubble(x, y)) return;
      const b = bubbleRect();
      dragging = { dx: x - (b.x + b.w / 2), dy: y - (b.y + b.h / 2) };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("sr-dragging");
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      const [x, y] = toCanvas(e);
      if (!dragging) { canvas.classList.toggle("sr-over", st.mode === "both" && !rec && inBubble(x, y)); return; }
      st.bx = Math.max(0, Math.min(1, (x - dragging.dx) / canvas.width));
      st.by = Math.max(0, Math.min(1, (y - dragging.dy) / canvas.height));
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = null; canvas.classList.remove("sr-dragging");
      const b = bubbleRect();                   // store where it really sits (kept inside the frame)
      st.bx = (b.x + b.w / 2) / canvas.width; st.by = (b.y + b.h / 2) / canvas.height;
      persist();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    const onKey = (e) => {
      if (!rec || e.target.matches("input, select, textarea")) return;
      if (e.key === " " && e.target === document.body) { e.preventDefault(); togglePause(); }
    };
    document.addEventListener("keydown", onKey);

    // ---------- Start ----------

    fitCanvas();
    updateUi();
    clock.start(Number(st.fps));
    if (st.mode !== "screen" && st.camOn) startCam();
    if (st.mic) startMic();
    if (!canScreen) hint("Your browser can't record the screen (phones and tablets can't), so this records your camera. Face filters work here too.");
    else hint("Pick what to record, set up your camera bubble and filters, then press Start recording.");
    applyFx({});

    function destroy() {
      destroyed = true;
      clearInterval(countdownTimer); clearInterval(timeTimer);
      if (abort) abort.abort();
      if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (e) { /* stopped */ } }
      clock.stop();
      stopScreen(); stopCam(); stopMic();
      if (capture) capture.getTracks().forEach((t) => t.stop());
      if (ac) ac.close().catch(() => {});
      fx.destroy();
      holder.remove();
      if (playUrl) URL.revokeObjectURL(playUrl);
      document.removeEventListener("keydown", onKey);
      for (const el of Object.values(shared)) if (el) el.style.display = "";
    }

    return {
      destroy,
      // For tests and debugging.
      debug: () => ({
        mode: st.mode, canvas: [canvas.width, canvas.height], recording: !!rec, state: rec && rec.state, bytes, mime,
        cam: camSrc ? [camSrc.w, camSrc.h, camSrc.frames] : null, screen: scrSrc ? [scrSrc.w, scrSrc.h, scrSrc.frames] : null,
        fx: fx.debug(), status: fx.status, result: result ? { size: result.blob.size, name: result.name, ms: result.ms, type: result.blob.type } : null,
        bubble: bubbleRect(),
      }),
      result: () => result,
      fx,
    };
  }

  return { configHtml, create, WebmDuration };
})();

TOOLS.push({
  id: "screen-recorder",
  slug: "screen-recorder",
  aliases: ["record-screen", "online-screen-recorder", "screen-recorder-with-webcam", "webcam-recorder", "record-video-online", "camera-recorder", "screen-recording"],
  name: "Screen Recorder",
  desc: "Record your screen with your camera in a bubble, or just the camera. Face filters, background blur and MP4 download. Nothing is uploaded.",
  keywords: "screen recorder record screen online screen recording webcam recorder record video with webcam camera bubble loom alternative record presentation tutorial record meeting face filter beauty filter smooth skin background blur virtual background change background hair filter bald glasses filter record camera video recorder mp4 webm",
  category: "edit",
  badge: "New",
  accept: "video/*",
  acceptLabel: "a video",
  wide: true,
  caption: "Screen + camera, with filters",
  configHtml: ScreenRecorder.configHtml,
  onOpen: (ctx) => { ctx.sr = ScreenRecorder.create(ctx.el("srRoot")); },
  onClose: (ctx) => ctx.sr && ctx.sr.destroy(),
  run: async () => { throw new ClientPDF.UserError("Use the Start recording button above."); },
});
