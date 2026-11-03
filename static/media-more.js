// Video Converter, Audio Converter, Merge Videos, Mute, Rotate and Crop Video on the same
// in-browser ffmpeg as media-tool.js. Files never leave the device. When the picture or sound
// is already in a format the output can hold, it is copied instead of re-encoded (seconds, not minutes).

const MediaMore = (() => {
  const M = MediaTool;
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
  const AAC = ["-c:a", "aac", "-b:a", "160k"];
  const STEREO = "aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

  /** Like MediaTool.withInput, for several files: fn(f, [paths]). */
  async function withInputs(ctx, files, loadShare, fn) {
    files.forEach(M.checkSize);
    if (ctx.signal && ctx.signal.aborted) throw M.cancelled();
    const onAbort = () => M.stopEngine();
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });
    const dir = `/in${Date.now()}`;
    let f;
    try {
      f = await M.engine(ctx, loadShare);
      await f.createDir(dir);
      const blobs = files.map((file, i) => ({ name: `in${i}.${M.extOf(file.name) || "bin"}`, data: file }));
      await f.mount("WORKERFS", { blobs }, dir);
      try {
        return await fn(f, blobs.map((b) => `${dir}/${b.name}`));
      } finally {
        await f.unmount(dir).catch(() => {});
        await f.deleteDir(dir).catch(() => {});
      }
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) throw M.cancelled();
      throw e;
    } finally {
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  const VIDEO_MIME = { mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo" };
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  /** Scale filter that makes the short side at most `p` pixels (never upscales). */
  const shortSide = (p) => `scale='if(gt(iw,ih),-2,min(${p},iw))':'if(gt(iw,ih),min(${p},ih),-2)'`;

  // ---------- Video converter ----------

  const convertConfig = `
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="vcFormat">Convert to</label>
        <select id="vcFormat" class="form-select">
          <option value="mp4" selected>MP4 (plays everywhere)</option>
          <option value="mov">MOV (iPhone, Mac)</option>
          <option value="mkv">MKV</option>
          <option value="webm">WebM (websites)</option>
          <option value="avi">AVI (old players, TVs)</option>
        </select></div>
      <div class="form-group"><label class="form-label" for="vcSize">Size</label>
        <select id="vcSize" class="form-select">
          <option value="0" selected>Same as the original</option>
          <option value="1080">Full HD 1080p</option>
          <option value="720">HD 720p (smaller)</option>
          <option value="480">480p (smallest)</option>
        </select></div>
    </div>
    <p class="drop-hint">MOV, MKV, AVI, WebM, 3GP, WMV, FLV and more. When the picture is already H.264 it is copied as it is, so the conversion takes seconds and loses nothing.</p>
    ${M.PHONE_NOTE}`;

  async function convertRun(ctx) {
    const file = ctx.files[0];
    const fmt = ctx.value("vcFormat") || "mp4";
    const size = Number(ctx.value("vcSize")) || 0;
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture. To convert sound, use the Audio Converter.");
      const vc = info.vcodec, ac = info.acodec;
      const small = size && Math.min(info.width || 1e9, info.height || 1e9) > size;
      let v, a;
      if (fmt === "webm") {
        v = !small && /^(vp8|vp9|av1)$/.test(vc) ? ["-c:v", "copy"]
          : ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "0", "-crf", "12", "-qmin", "4", "-qmax", "42", "-pix_fmt", "yuv420p"];
        a = /^(opus|vorbis)$/.test(ac) ? ["-c:a", "copy"] : ["-c:a", "libvorbis", "-q:a", "4"];
      } else if (fmt === "avi") {
        v = ["-c:v", "mpeg4", "-q:v", "4", "-tag:v", "XVID"];
        a = ac === "mp3" ? ["-c:a", "copy"] : ["-c:a", "libmp3lame", "-b:a", "160k"];
      } else {
        const copyV = !small && (vc === "h264" || (vc === "hevc" && fmt !== "mp4") || (fmt === "mkv" && /^(hevc|vp9|av1|mpeg4)$/.test(vc)));
        v = copyV ? ["-c:v", "copy"] : X264;
        if (copyV && vc === "hevc") v.push("-tag:v", "hvc1");
        a = /^(aac|mp3)$/.test(ac) || (fmt === "mkv" && ac) ? ["-c:a", "copy"] : AAC;
      }
      const copying = v[1] === "copy";
      const vf = small ? ["-vf", `${shortSide(size)},setsar=1`] : copying ? [] : ["-vf", even];
      const out = `out.${fmt}`;
      const args = ["-i", input, "-map", "0:v:0", "-map", "0:a:0?", ...vf, ...v, ...(info.audio ? a : []),
        ...(/^(mp4|mov)$/.test(fmt) ? ["-movflags", "+faststart"] : []), out];
      await M.exec(ctx, f, args, { duration: info.duration, label: copying ? "Converting on your device (no re-encode)" : "Converting on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      if (data.length < 1024) throw UserError("The conversion came out empty. Try MP4, or another file.");
      const filename = `${M.baseName(file.name)}.${fmt}`;
      return { bytes: data, mime: VIDEO_MIME[fmt], filename, message: `Done! Saved ${filename} (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Audio converter ----------

  const AUDIO_OUT = {
    mp3: { mime: "audio/mpeg", codec: (k) => ["-c:a", "libmp3lame", "-b:a", `${k}k`] },
    wav: { mime: "audio/wav", codec: () => ["-c:a", "pcm_s16le"] },
    m4a: { mime: "audio/mp4", codec: (k) => ["-c:a", "aac", "-b:a", `${Math.min(k, 256)}k`] },
    ogg: { mime: "audio/ogg", codec: (k) => ["-c:a", "libvorbis", "-q:a", k >= 320 ? "8" : k >= 192 ? "6" : "4"] },
    flac: { mime: "audio/flac", codec: () => ["-c:a", "flac"] },
    opus: { mime: "audio/ogg", codec: (k) => ["-c:a", "libopus", "-b:a", `${Math.min(k, 256)}k`] },
  };

  const audioConfig = `
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="acFormat">Convert to</label>
        <select id="acFormat" class="form-select">
          <option value="mp3" selected>MP3 (plays everywhere)</option>
          <option value="wav">WAV (no quality loss, big)</option>
          <option value="m4a">M4A / AAC (iPhone)</option>
          <option value="ogg">OGG</option>
          <option value="flac">FLAC (no quality loss)</option>
          <option value="opus">Opus (smallest)</option>
        </select></div>
      <div class="form-group"><label class="form-label" for="acQuality">Quality</label>
        <select id="acQuality" class="form-select"><option value="128">Good (128 kbps)</option><option value="192" selected>High (192 kbps)</option><option value="320">Best (320 kbps)</option></select></div>
    </div>
    <p class="drop-hint">MP3, WAV, M4A, AAC, OGG, Opus, FLAC, AMR, WMA, voice notes, and the sound from videos. Add many files to convert them all at once.</p>
    ${M.PHONE_NOTE}`;

  function audioInput(ctx, id) {
    if (id === "acFormat") ctx.el("acQuality").disabled = /^(wav|flac)$/.test(ctx.value("acFormat"));
  }

  async function audioRun(ctx) {
    const files = ctx.files;
    const fmt = ctx.value("acFormat") || "mp3";
    const kbps = Number(ctx.value("acQuality")) || 192;
    const spec = AUDIO_OUT[fmt];
    return withInputs(ctx, files, 0.2, async (f, inputs) => {
      const made = [];
      for (let i = 0; i < inputs.length; i++) {
        const span = 0.73 / inputs.length, from = 0.25 + span * i;
        ctx.progress(from, `Checking file ${i + 1} of ${inputs.length}…`);
        const info = await M.probe(ctx, f, inputs[i], files[i]);
        if (!info.audio) throw UserError(`${files[i].name} has no sound.`);
        const out = `out${i}.${fmt}`;
        await M.exec(ctx, f, ["-i", inputs[i], "-vn", "-map", "0:a:0", ...(fmt === "opus" ? ["-ar", "48000"] : []), ...spec.codec(kbps), out],
          { duration: info.duration, label: inputs.length > 1 ? `Converting ${i + 1} of ${inputs.length}` : "Converting on your device", from, to: from + span });
        made.push({ filename: `${M.baseName(files[i].name)}.${fmt}`, bytes: await M.readOut(f, out) });
      }
      if (made.length === 1) {
        const r = made[0];
        return { bytes: r.bytes, mime: spec.mime, filename: r.filename, message: `Done! Saved ${r.filename} (${M.mb(r.bytes.length)}). Nothing was uploaded.` };
      }
      const names = new Set();
      made.forEach((m) => { let n = m.filename, k = 2; while (names.has(n)) n = m.filename.replace(/(\.\w+)$/, `_${k++}$1`); names.add(n); m.filename = n; });
      const zipped = await ImageKit.zipOf(made, `audio_${fmt}.zip`);
      return { ...zipped, message: `Done! Converted ${made.length} files to ${fmt.toUpperCase()} (in one ZIP). Nothing was uploaded.` };
    });
  }

  // ---------- Merge videos ----------

  const mergeConfig = `
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="mgSize">Size</label>
        <select id="mgSize" class="form-select">
          <option value="first" selected>Same as the first video</option>
          <option value="720">HD 720p</option>
          <option value="1080">Full HD 1080p</option>
        </select></div>
      <div class="form-group"><label class="form-label" for="mgFill">If shapes differ</label>
        <select id="mgFill" class="form-select"><option value="black" selected>Black bars</option><option value="crop">Zoom in to fill</option></select></div>
    </div>
    <p class="drop-hint">Joined in the order shown in the list above. Videos of different sizes, shapes and phones all work; clips without sound get silence. Saves one MP4.</p>
    ${M.PHONE_NOTE}`;

  async function mergeRun(ctx) {
    const files = ctx.files;
    if (files.length < 2) throw UserError("Add at least two videos to merge.");
    const sizeOpt = ctx.value("mgSize");
    const crop = ctx.value("mgFill") === "crop";
    return withInputs(ctx, files, 0.2, async (f, inputs) => {
      const infos = [];
      for (let i = 0; i < inputs.length; i++) {
        ctx.progress(0.2 + 0.05 * (i / inputs.length), `Checking video ${i + 1} of ${inputs.length}…`);
        const info = await M.probe(ctx, f, inputs[i], files[i]);
        if (!info.video) throw UserError(`${files[i].name} has no picture. Use the Audio Joiner for sound only.`);
        infos.push(info);
      }
      const total = infos.reduce((s, x) => s + (x.duration || 0), 0);
      const shown = (x) => (x.rotation === 90 || x.rotation === 270 ? [x.height, x.width] : [x.width, x.height]);
      let [W, H] = shown(infos[0]);
      if (!W || !H) { W = 1280; H = 720; }
      if (sizeOpt !== "first") {
        const p = Number(sizeOpt);
        if (W >= H) { W = Math.round((W * p) / H); H = p; } else { H = Math.round((H * p) / W); W = p; }
      } else if (Math.min(W, H) > 1080) {
        const k = 1080 / Math.min(W, H); W = Math.round(W * k); H = Math.round(H * k);
      }
      W -= W % 2; H -= H % 2;
      const out = "out.mp4";
      // Same codec, size and sound everywhere (clips from one phone): join without re-encoding.
      const same = sizeOpt === "first" && infos.every((x) => x.vcodec === "h264" && x.acodec === "aac" && x.width === infos[0].width
        && x.height === infos[0].height && x.rotation === infos[0].rotation) && files.every((x) => /^(mp4|mov|m4v)$/.test(M.extOf(x.name)));
      if (same) {
        await f.writeFile("list.txt", new TextEncoder().encode(inputs.map((p) => `file '${p}'`).join("\n")));
        try {
          await M.exec(ctx, f, ["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", out],
            { duration: total, label: "Joining on your device (no re-encode)", from: 0.27, to: 1 });
          const data = await M.readOut(f, out);
          if (data.length > 1024) return done(data, true);
        } catch (e) {
          if (ctx.signal && ctx.signal.aborted) throw e;
        } finally {
          await f.deleteFile("list.txt").catch(() => {});
        }
      }
      const fit = crop ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease,${even},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
      const parts = [], pairs = [];
      infos.forEach((x, i) => {
        parts.push(`[${i}:v:0]${fit},setsar=1,fps=30,format=yuv420p[v${i}]`);
        parts.push(x.audio ? `[${i}:a:0]${STEREO}[a${i}]` : `aevalsrc=0:c=stereo:s=44100:d=${(x.duration || 1).toFixed(3)},aformat=sample_fmts=fltp[a${i}]`);
        pairs.push(`[v${i}][a${i}]`);
      });
      const graph = `${parts.join(";")};${pairs.join("")}concat=n=${infos.length}:v=1:a=1[v][a]`;
      await M.exec(ctx, f, [...inputs.flatMap((p) => ["-i", p]), "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        ...X264, ...AAC, "-movflags", "+faststart", out],
        { duration: total, label: "Joining on your device", from: 0.27, to: 1 });
      return done(await M.readOut(f, out), false);

      function done(data, copied) {
        const filename = `${M.baseName(files[0].name)}_merged.mp4`;
        return {
          bytes: data, mime: "video/mp4", filename,
          message: `Done! Joined ${files.length} videos into ${filename} (${M.fmt(total)}, ${M.mb(data.length)})${copied ? " without re-encoding" : ""}. Nothing was uploaded.`,
        };
      }
    });
  }

  // ---------- Mute video ----------

  const muteConfig = `
    <p class="drop-hint">Removes all sound from the video. The picture is copied as it is, so it takes seconds and keeps full quality.</p>
    ${M.PHONE_NOTE}`;

  async function muteRun(ctx) {
    const file = ctx.files[0];
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture.");
      let ext = M.extOf(file.name);
      const copy = /^(mp4|mov|m4v|mkv|webm)$/.test(ext) || (info.vcodec === "h264" && (ext = "mp4"));
      if (!copy) ext = "mp4";
      const out = `out.${ext}`;
      await M.exec(ctx, f, ["-i", input, "-map", "0:v:0", "-an", ...(copy ? ["-c:v", "copy"] : [...X264, "-vf", even]),
        ...(/^(mp4|mov|m4v)$/.test(ext) ? ["-movflags", "+faststart"] : []), out],
        { duration: info.duration, label: "Removing the sound on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_muted.${ext}`;
      return {
        bytes: data, mime: VIDEO_MIME[ext] || "video/mp4", filename,
        message: `Done! Saved ${filename} with no sound (${M.mb(data.length)}). Nothing was uploaded.`,
      };
    });
  }

  // ---------- Rotate / flip video ----------

  const ROTATE = {
    cw: { vf: "transpose=1", tag: "rotated", label: "turned right" },
    ccw: { vf: "transpose=2", tag: "rotated", label: "turned left" },
    180: { vf: "transpose=1,transpose=1", tag: "rotated", label: "turned upside down" },
    hflip: { vf: "hflip", tag: "mirrored", label: "mirrored" },
    vflip: { vf: "vflip", tag: "flipped", label: "flipped" },
  };
  const rotateConfig = `
    <div class="form-group"><label class="form-label">Turn</label>
      <div class="rot-choices" role="radiogroup">
        <label class="rot-choice"><input type="radio" name="rvTurn" value="cw" checked><span>${rotIcon(90)} 90° right</span></label>
        <label class="rot-choice"><input type="radio" name="rvTurn" value="ccw"><span>${rotIcon(-90)} 90° left</span></label>
        <label class="rot-choice"><input type="radio" name="rvTurn" value="180"><span>${rotIcon(180)} 180°</span></label>
        <label class="rot-choice"><input type="radio" name="rvTurn" value="hflip"><span>${flipIcon(false)} Mirror</span></label>
        <label class="rot-choice"><input type="radio" name="rvTurn" value="vflip"><span>${flipIcon(true)} Upside down</span></label>
      </div></div>
    <p class="drop-hint">For phone videos recorded sideways or upside down. The sound is kept as it is.</p>
    ${M.PHONE_NOTE}`;

  function rotIcon(deg) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="transform:scaleX(${deg < 0 ? -1 : 1})"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>${deg === 180 ? '<path d="M12 8v4l2 2"/>' : ""}</svg>`;
  }
  function flipIcon(vertical) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="transform:rotate(${vertical ? 90 : 0}deg)"><path d="M12 3v18"/><path d="M8 7 3 12l5 5V7z"/><path d="M16 7l5 5-5 5V7z"/></svg>`;
  }

  async function rotateRun(ctx) {
    const file = ctx.files[0];
    const pick = (document.querySelector('input[name="rvTurn"]:checked') || {}).value || "cw";
    const r = ROTATE[pick];
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture.");
      const out = "out.mp4";
      await M.exec(ctx, f, ["-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${r.vf},setsar=1`, ...X264,
        ...(info.audio ? (/^(aac|mp3)$/.test(info.acodec) ? ["-c:a", "copy"] : AAC) : []), "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart", out],
        { duration: info.duration, label: "Turning the video on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_${r.tag}.mp4`;
      return { bytes: data, mime: "video/mp4", filename, message: `Done! Video ${r.label} and saved as ${filename} (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Crop video ----------

  const SHAPES = { free: 0, "1:1": 1, "9:16": 9 / 16, "16:9": 16 / 9, "4:5": 4 / 5, "4:3": 4 / 3 };
  const cropConfig = `
    <div class="form-group"><label class="form-label" for="cvShape">Shape</label>
      <select id="cvShape" class="form-select">
        <option value="free" selected>Free: drag the box</option>
        <option value="1:1">1:1 square</option>
        <option value="9:16">9:16 tall (Reels, Shorts)</option>
        <option value="16:9">16:9 wide</option>
        <option value="4:5">4:5 portrait</option>
        <option value="4:3">4:3</option>
      </select></div>
    <div id="cvRoot" class="cv-root"></div>
    <p class="drop-hint">Drag the box to keep only part of the picture, for example to cut off black bars, a watermark corner or people at the edge. The sound is kept.</p>
    ${M.PHONE_NOTE}`;

  function createCropper(root) {
    root.innerHTML = `<div class="crop-stage cv-stage" id="cvStage" hidden><canvas id="cvCanvas"></canvas>
      <div class="crop-box" id="cvBox"><span class="crop-handle h-nw" data-h="nw"></span><span class="crop-handle h-ne" data-h="ne"></span>
      <span class="crop-handle h-sw" data-h="sw"></span><span class="crop-handle h-se" data-h="se"></span></div></div>
      <p class="drop-hint" id="cvInfo"></p>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let box = null, aspect = 0, vw = 0, vh = 0, url = null, video = null, token = 0, busy = null;

    function place() {
      const b = box || { l: 0, t: 0, r: 1, b: 1 };
      const el = $("cvBox");
      el.style.left = `${b.l * 100}%`; el.style.top = `${b.t * 100}%`;
      el.style.width = `${(b.r - b.l) * 100}%`; el.style.height = `${(b.b - b.t) * 100}%`;
      if (vw && vh) $("cvInfo").textContent = `Keeping ${Math.round((b.r - b.l) * vw)} × ${Math.round((b.b - b.t) * vh)} pixels of ${vw} × ${vh}.`;
    }
    /** Largest box of the chosen shape, centred. */
    function fitShape() {
      if (!aspect || !vw) { box = box || { l: 0.1, t: 0.1, r: 0.9, b: 0.9 }; place(); return; }
      const frac = aspect / (vw / vh); // box width / box height in fractions
      let w = 1, h = 1;
      if (frac > 1) h = 1 / frac; else w = frac;
      box = { l: (1 - w) / 2, t: (1 - h) / 2, r: (1 + w) / 2, b: (1 + h) / 2 };
      place();
    }
    function setShape(v) { aspect = SHAPES[v] || 0; if (aspect) fitShape(); }

    async function setFile(file) {
      const my = ++token;
      destroy(true);
      $("cvStage").hidden = true;
      $("cvInfo").textContent = "Loading a preview…";
      url = URL.createObjectURL(file);
      video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto", src: url });
      try {
        await new Promise((ok, bad) => { video.onloadeddata = ok; video.onerror = bad; setTimeout(bad, 15000); });
        video.currentTime = Math.min(1, (video.duration || 2) / 3);
        await new Promise((ok) => { video.onseeked = ok; setTimeout(ok, 3000); });
      } catch (e) {
        if (my !== token) return;
        // The browser can't play this format (MKV, AVI, or H.264 in some browsers): grab a frame with ffmpeg.
        busy = frameByEngine(file, my);
        await busy.catch(() => {});
        busy = null;
        return;
      }
      if (my !== token) return;
      show(video, video.videoWidth, video.videoHeight);
    }

    async function frameByEngine(file, my) {
      const info = $("cvInfo");
      const ctx = { signal: null, progress: (_, msg) => { if (my === token && msg) info.textContent = msg; } };
      try {
        const bmp = await M.withInput(ctx, file, 1, async (f, input) => {
          info.textContent = "Getting a preview frame…";
          await M.exec(ctx, f, ["-ss", "1", "-i", input, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "frame.png"], { label: "Getting a preview frame", allowFail: true });
          let data;
          try { data = await M.readOut(f, "frame.png"); } catch (e) {
            await M.exec(ctx, f, ["-i", input, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "frame.png"], { label: "Getting a preview frame", allowFail: true });
            data = await M.readOut(f, "frame.png");
          }
          const probe = await M.probe(ctx, f, input, file);
          return { bmp: await createImageBitmap(new Blob([data], { type: "image/png" })), probe };
        });
        if (my !== token) return;
        const p = bmp.probe;
        const side = p.rotation === 90 || p.rotation === 270;
        show(bmp.bmp, (side ? p.height : p.width) || bmp.bmp.width, (side ? p.width : p.height) || bmp.bmp.height);
      } catch (e) {
        if (my !== token) return;
        vw = vh = 0;
        info.textContent = "This video can't be previewed here. Pick a shape and the middle of the picture is kept.";
      }
    }

    function show(src, w, h) {
      vw = w; vh = h;
      const c = $("cvCanvas");
      const k = Math.min(1, 640 / vw, 360 / vh);
      c.width = Math.round(vw * k); c.height = Math.round(vh * k);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      $("cvStage").hidden = false;
      box = null;
      if (aspect) fitShape(); else { box = { l: 0.1, t: 0.1, r: 0.9, b: 0.9 }; place(); }
    }

    // Drag to move, corners to resize; the shape stays locked when one is chosen.
    let drag = null;
    root.addEventListener("pointerdown", (e) => {
      const stage = $("cvStage");
      if (stage.hidden || !stage.contains(e.target) || !box) return;
      const r = stage.getBoundingClientRect();
      const h = e.target.dataset.h || (e.target === $("cvBox") ? "move" : null);
      if (!h) return;
      e.preventDefault();
      drag = { h, r, start: { ...box }, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
    });
    root.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / drag.r.width, dy = (e.clientY - drag.y) / drag.r.height;
      const s = drag.start, min = 0.05;
      let b = { ...s };
      if (drag.h === "move") {
        const w = s.r - s.l, h = s.b - s.t;
        b.l = Math.max(0, Math.min(1 - w, s.l + dx)); b.t = Math.max(0, Math.min(1 - h, s.t + dy));
        b.r = b.l + w; b.b = b.t + h;
      } else {
        if (drag.h.includes("w")) b.l = Math.max(0, Math.min(s.r - min, s.l + dx));
        if (drag.h.includes("e")) b.r = Math.min(1, Math.max(s.l + min, s.r + dx));
        if (drag.h.includes("n")) b.t = Math.max(0, Math.min(s.b - min, s.t + dy));
        if (drag.h.includes("s")) b.b = Math.min(1, Math.max(s.t + min, s.b + dy));
        if (aspect && vw) {
          const frac = aspect / (vw / vh);
          let w = b.r - b.l, h = w / frac;
          if (drag.h.includes("n") ? s.b - h < 0 : s.t + h > 1) { h = drag.h.includes("n") ? s.b : 1 - s.t; w = h * frac; }
          if (drag.h.includes("w")) b.l = s.r - w; else b.r = s.l + w;
          if (drag.h.includes("n")) b.t = s.b - h; else b.b = s.t + h;
        }
      }
      box = b;
      place();
    });
    const end = () => { drag = null; };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);

    function destroy(keep) {
      if (video) { video.removeAttribute("src"); video.load(); }
      if (url) URL.revokeObjectURL(url);
      video = null; url = null;
      if (!keep) token++;
    }

    return { setFile, setShape, destroy, ready: () => busy && busy.catch(() => {}), value: () => ({ box: vw ? box : null, aspect }) };
  }

  async function cropRun(ctx) {
    const file = ctx.files[0];
    if (ctx.cropper) await ctx.cropper.ready(); // the preview may still be using the video engine
    const { box, aspect } = ctx.cropper ? ctx.cropper.value() : {};
    let vf;
    if (box) {
      const n = (v) => Math.max(0, Math.min(1, v)).toFixed(5);
      vf = `crop=trunc(iw*${n(box.r - box.l)}/2)*2:trunc(ih*${n(box.b - box.t)}/2)*2:trunc(iw*${n(box.l)}):trunc(ih*${n(box.t)})`;
    } else if (aspect) {
      const a = aspect.toFixed(5);
      vf = `crop=trunc(min(iw\\,ih*${a})/2)*2:trunc(min(ih\\,iw/${a})/2)*2`;
    } else throw UserError("This video can't be previewed here, so pick a shape (for example 1:1 square) and the middle is kept.");
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture.");
      const out = "out.mp4";
      await M.exec(ctx, f, ["-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${vf},setsar=1`, ...X264,
        ...(info.audio ? (/^(aac|mp3)$/.test(info.acodec) ? ["-c:a", "copy"] : AAC) : []), "-movflags", "+faststart", out],
        { duration: info.duration, label: "Cropping on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_cropped.mp4`;
      return { bytes: data, mime: "video/mp4", filename, message: `Done! Saved ${filename} (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  return {
    convertConfig, convertRun, audioConfig, audioInput, audioRun, mergeConfig, mergeRun, muteConfig, muteRun,
    rotateConfig, rotateRun, cropConfig, createCropper, cropRun, withInputs,
  };
})();

TOOLS.push(
  {
    id: "video-converter",
    noBuffers: true,
    slug: "video-converter",
    aliases: ["mov-to-mp4", "mkv-to-mp4", "avi-to-mp4", "webm-to-mp4", "convert-video-to-mp4", "3gp-to-mp4", "wmv-to-mp4", "flv-to-mp4", "mp4-to-webm", "mp4-to-avi"],
    name: "Video Converter",
    desc: "Convert MOV, MKV, AVI, WebM and other videos to MP4 (or MP4 to WebM, MOV, MKV, AVI). Private, on your device.",
    keywords: "video converter mov to mp4 mkv to mp4 avi to mp4 webm to mp4 convert video to mp4 iphone video to mp4 3gp wmv flv mp4 to webm mp4 to avi change video format",
    category: "convert",
    badge: "New",
    caption: "Any video to MP4",
    flip: ["MOV", "MP4"],
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Convert video",
    configHtml: MediaMore.convertConfig,
    run: (ctx) => MediaMore.convertRun(ctx),
  },
  {
    id: "audio-converter",
    noBuffers: true,
    slug: "audio-converter",
    aliases: ["mp3-to-wav", "wav-to-mp3", "m4a-to-mp3", "ogg-to-mp3", "flac-to-mp3", "aac-to-mp3", "opus-to-mp3", "amr-to-mp3", "mp3-to-m4a", "mp3-to-ogg", "convert-audio"],
    name: "Audio Converter",
    desc: "Convert audio between MP3, WAV, M4A, OGG, FLAC and Opus, many files at once. Voice notes and video sound too.",
    keywords: "audio converter mp3 to wav wav to mp3 m4a to mp3 ogg to mp3 flac to mp3 aac opus amr voice note to mp3 whatsapp audio convert audio format mp3 to m4a",
    category: "convert",
    badge: "New",
    caption: "MP3, WAV, M4A, OGG",
    flip: ["WAV", "MP3"],
    accept: `${MediaTool.AUDIO_ACCEPT},${MediaTool.VIDEO_ACCEPT}`,
    acceptLabel: "audio files",
    multipleFiles: true,
    actionLabel: "Convert audio",
    configHtml: MediaMore.audioConfig,
    onInput: (ctx, id) => MediaMore.audioInput(ctx, id),
    run: (ctx) => MediaMore.audioRun(ctx),
  },
  {
    id: "merge-videos",
    noBuffers: true,
    slug: "merge-videos",
    aliases: ["video-merger", "join-videos", "combine-videos", "merge-mp4", "video-joiner"],
    name: "Merge Videos",
    desc: "Join several videos into one MP4, in the order you choose. Different sizes and phones are fine.",
    keywords: "merge videos video merger join videos combine videos merge mp4 video joiner add videos together one video",
    category: "edit",
    badge: "New",
    caption: "Many clips, one video",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "videos",
    multipleFiles: true,
    actionLabel: "Merge videos",
    configHtml: MediaMore.mergeConfig,
    run: (ctx) => MediaMore.mergeRun(ctx),
  },
  {
    id: "mute-video",
    noBuffers: true,
    slug: "mute-video",
    aliases: ["remove-audio-from-video", "remove-sound-from-video", "video-mute", "silent-video"],
    name: "Mute Video",
    desc: "Remove the sound from a video in seconds, with no loss in picture quality.",
    keywords: "mute video remove audio from video remove sound from video silent video no sound delete audio track",
    category: "edit",
    badge: "New",
    caption: "Sound off, picture kept",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Mute video",
    configHtml: MediaMore.muteConfig,
    run: (ctx) => MediaMore.muteRun(ctx),
  },
  {
    id: "rotate-video",
    noBuffers: true,
    slug: "rotate-video",
    aliases: ["flip-video", "mirror-video", "rotate-video-90-degrees", "turn-video"],
    name: "Rotate Video",
    desc: "Turn a sideways or upside-down video the right way, or mirror it. Sound is kept.",
    keywords: "rotate video flip video mirror video rotate 90 degrees sideways video upside down turn video portrait landscape",
    category: "edit",
    badge: "New",
    caption: "Sideways to straight",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Rotate video",
    configHtml: MediaMore.rotateConfig,
    run: (ctx) => MediaMore.rotateRun(ctx),
  },
  {
    id: "crop-video",
    noBuffers: true,
    slug: "crop-video",
    aliases: ["video-cropper", "crop-mp4", "cut-video-frame", "remove-black-bars"],
    name: "Crop Video",
    desc: "Cut off the edges of a video: black bars, a corner logo, or to make it square or 9:16.",
    keywords: "crop video video cropper crop mp4 remove black bars cut edges square video 9:16 crop zoom video frame",
    category: "edit",
    badge: "New",
    caption: "Keep just the middle",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Crop video",
    wide: true,
    configHtml: MediaMore.cropConfig,
    onOpen: (ctx) => { ctx.cropper = MediaMore.createCropper(ctx.el("cvRoot")); },
    onFiles: (ctx) => ctx.files.length && ctx.cropper.setFile(ctx.files[0]),
    onInput: (ctx, id) => { if (id === "cvShape") ctx.cropper.setShape(ctx.value("cvShape")); },
    onClose: (ctx) => ctx.cropper && ctx.cropper.destroy(),
    run: (ctx) => MediaMore.cropRun(ctx),
  },
);
