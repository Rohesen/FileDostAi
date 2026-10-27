// Video and audio tools that run in the browser with ffmpeg.wasm: Compress Video,
// Video to MP3 and Trim Audio or Video. The file never leaves the device.
// ffmpeg.wasm (about 31 MB) lives in /static/vendor/ffmpeg/ and is only downloaded the first
// time one of these tools runs. It is the single-thread build, so it works without
// cross-origin isolation headers. The input file is mounted read-only (WORKERFS), so a big
// video is not copied into the engine's memory.

document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/media-tool.css?v=36" }));

const MediaTool = (() => {
  const BASE = new URL("/static/vendor/ffmpeg/", location.href).href;
  const VIDEO_ACCEPT = "video/*,.mp4,.mov,.mkv,.avi,.webm,.3gp,.m4v,.wmv,.flv,.mpg,.mpeg,.ts,.mts";
  const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.wav,.aac,.ogg,.oga,.opus,.flac,.amr,.wma";
  const AUDIO_EXT = /\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|amr|wma)$/i;
  const MAX_BYTES = 2 * 1024 * 1024 * 1024;
  const PHONE_NOTE = `<p class="drop-hint media-note">${Icons.ui("phone")} Works on phones too, but long or large videos (over about 200 MB) can be slow or run out of memory there. A computer is faster.</p>`;
  const UserError = (msg) => new ClientPDF.UserError(msg);

  let ff = null; // one ffmpeg instance, kept between runs until cancelled
  let loading = null;

  // ---------- Helpers ----------

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = s.toFixed(1).padStart(4, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  function parseTime(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(t)) return NaN;
    return t.split(":").reduce((n, part) => n * 60 + Number(part), 0);
  }
  function baseName(name) { return name.replace(/\.[^.]+$/, "") || "media"; }
  function extOf(name) { const m = name.match(/\.([a-z0-9]{2,5})$/i); return m ? m[1].toLowerCase() : ""; }
  function mb(bytes) { return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`; }
  function isAudioFile(file) { return (file.type || "").startsWith("audio/") || AUDIO_EXT.test(file.name); }
  function checkSize(file) {
    if (file.size > MAX_BYTES) throw UserError("This file is over 2 GB, which is too big to process in a browser. Trim it into parts on a computer first.");
  }
  function cancelled() { const e = new Error("Cancelled"); e.cancelled = true; return e; }

  // Duration from the browser's own player, when it can read the file (most MP4, WebM, MP3...).
  function browserDuration(file, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const el = document.createElement(isAudioFile(file) ? "audio" : "video");
      const url = URL.createObjectURL(file);
      const done = (d) => { clearTimeout(timer); URL.revokeObjectURL(url); el.removeAttribute("src"); resolve(d); };
      const timer = setTimeout(() => done(null), timeoutMs);
      el.preload = "metadata";
      el.onloadedmetadata = () => done(isFinite(el.duration) && el.duration > 0 ? el.duration : null);
      el.onerror = () => done(null);
      el.src = url;
    });
  }

  // ---------- The engine ----------

  async function engine(ctx, share) {
    if (ff) return ff;
    if (!loading) {
      loading = (async () => {
        const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
          import(`${BASE}ffmpeg/index.js`), import(`${BASE}util/index.js`),
        ]);
        const inst = new FFmpeg();
        ctx.progress(0, "Getting the video engine ready (about 31 MB, only the first time)…");
        const wasmURL = await toBlobURL(`${BASE}core/ffmpeg-core.wasm`, "application/wasm", true, ({ received, total }) => {
          if (total > 0) ctx.progress(share * (received / total), `Downloading the video engine, only the first time… ${Math.round(received / 1048576)} of ${Math.round(total / 1048576)} MB`);
        });
        try {
          await inst.load({
            classWorkerURL: `${BASE}ffmpeg/worker.js`,
            coreURL: `${BASE}core/ffmpeg-core.js`,
            wasmURL,
          });
        } finally {
          URL.revokeObjectURL(wasmURL);
        }
        return inst;
      })();
    }
    try {
      ff = await loading;
      return ff;
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) throw cancelled();
      console.warn(e);
      throw UserError("The video engine couldn't start in this browser. Try a recent Chrome, Edge, Firefox or Safari.");
    } finally {
      loading = null;
    }
  }

  function stopEngine() {
    if (ff) { try { ff.terminate(); } catch (e) { /* already gone */ } }
    ff = null;
  }

  /**
   * Mounts the file, runs fn(f, inputPath) and always cleans up. Cancel (ctx.signal) stops the
   * engine at once; the next run starts a fresh one.
   */
  async function withInput(ctx, file, loadShare, fn) {
    checkSize(file);
    if (ctx.signal && ctx.signal.aborted) throw cancelled();
    const onAbort = () => stopEngine();
    if (ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const f = await engine(ctx, loadShare);
      const dir = `/in${Date.now()}`;
      await f.createDir(dir);
      await f.mount("WORKERFS", { files: [file] }, dir);
      try {
        return await fn(f, `${dir}/${file.name}`);
      } finally {
        if (ff === f) {
          await f.unmount(dir).catch(() => {});
          await f.deleteDir(dir).catch(() => {});
        }
      }
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) throw cancelled();
      throw e;
    } finally {
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Runs one ffmpeg command, feeding real progress into ctx.progress. Returns the log text. */
  async function exec(ctx, f, args, { duration = 0, label = "Working", from = 0, to = 1, allowFail = false } = {}) {
    const log = [];
    let last = 0;
    const report = (frac) => {
      if (!(frac >= 0)) return;
      frac = Math.min(1, frac);
      if (frac < last) return;
      last = frac;
      ctx.progress(from + (to - from) * frac, duration ? `${label}… ${fmt(frac * duration)} of ${fmt(duration)}` : `${label}…`);
    };
    const onLog = ({ message }) => {
      log.push(message);
      if (log.length > 400) log.splice(0, 200);
      const m = duration && /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) report((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration);
    };
    const onProgress = ({ progress, time }) => {
      if (duration && time > 0) report(time / 1e6 / duration);
      else if (progress > 0 && progress <= 1) report(progress);
    };
    f.on("log", onLog);
    f.on("progress", onProgress);
    let code;
    try {
      code = await f.exec(["-hide_banner", ...args]);
    } finally {
      f.off("log", onLog);
      f.off("progress", onProgress);
    }
    const text = log.join("\n");
    if (code !== 0 && !allowFail) {
      console.warn(text.slice(-2000));
      throw UserError(friendlyFailure(text));
    }
    return text;
  }

  function friendlyFailure(log) {
    if (/Invalid data found|could not find codec|moov atom not found|Unknown format/i.test(log)) {
      return "This file couldn't be read. It may be damaged, or in a format the browser engine doesn't know.";
    }
    if (/Cannot allocate memory|out of memory|OOM/i.test(log)) {
      return "Your device ran out of memory. Try a shorter clip, a smaller size, or a computer.";
    }
    return "The video engine couldn't process this file. Try another file, or convert it to MP4 first.";
  }

  /** What's inside the file: duration in seconds and whether it has picture and sound. */
  async function probe(ctx, f, path, file) {
    const log = await exec(ctx, f, ["-i", path], { allowFail: true });
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    let duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    if (!duration) duration = (await browserDuration(file)) || 0;
    const videoLines = log.split("\n").filter((l) => /Stream #.*Video:/.test(l) && !/attached pic/i.test(l));
    const audio = /Stream #[^\n]*Audio:/.test(log);
    if (!videoLines.length && !audio) {
      throw UserError("This file couldn't be read. It may be damaged, or in a format the browser engine doesn't know.");
    }
    const v = videoLines[0] || "";
    const br = /(\d+) kb\/s/.exec(v);
    const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(v);
    return {
      duration, video: !!v, audio,
      videoKbps: br ? Number(br[1]) : 0, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0,
    };
  }

  async function readOut(f, name) {
    const data = await f.readFile(name);
    await f.deleteFile(name).catch(() => {});
    return data;
  }

  // ---------- Compress Video ----------

  const compressConfig = `
    <div class="grid-2">
      <div class="form-group">
        <label class="form-label" for="mvTarget">Make it fit</label>
        <select id="mvTarget" class="form-select">
          <option value="16" selected>WhatsApp (under 16 MB)</option>
          <option value="25">Email (under 25 MB)</option>
          <option value="custom">Custom size…</option>
        </select>
      </div>
      <div class="form-group" style="margin-top:0">
        <label class="form-label" for="mvScale">Picture size</label>
        <select id="mvScale" class="form-select">
          <option value="auto" selected>Automatic (best for the size)</option>
          <option value="720">720p (HD)</option>
          <option value="480">480p (smaller)</option>
          <option value="0">Keep original</option>
        </select>
      </div>
    </div>
    <div class="form-group" id="mvCustomRow" hidden>
      <label class="form-label" for="mvCustom">Target size in MB</label>
      <input type="number" id="mvCustom" class="form-input" min="1" max="2000" step="1" value="10" inputmode="numeric">
    </div>
    <p class="drop-hint">Saves an MP4 that plays everywhere. The bitrate is worked out from the video's length so it lands under the size you pick. Encoding can take about as long as the video itself.</p>
    ${PHONE_NOTE}`;

  async function compressRun(ctx) {
    const file = ctx.files[0];
    const choice = ctx.value("mvTarget");
    const targetMB = choice === "custom" ? Number(ctx.value("mvCustom")) : Number(choice);
    if (!(targetMB >= 1)) throw UserError("Type a target size of at least 1 MB.");
    const targetBytes = targetMB * 1000 * 1000;
    if (file.size <= targetBytes * 0.97) {
      throw UserError(`This video is already ${mb(file.size)}, under ${targetMB} MB. You can send it as it is.`);
    }
    const scaleChoice = ctx.value("mvScale") || "auto";
    return withInput(ctx, file, 0.25, async (f, input) => {
      const info = await probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture. Use Video to MP3 or Trim Audio or Video for sound files.");
      if (!info.duration) throw UserError("Couldn't tell how long this video is, so the size can't be worked out. Try converting it to MP4 first.");
      const dur = info.duration;
      const audioKbps = info.audio ? ((targetBytes * 8) / dur / 1000 < 700 ? 64 : 96) : 0;
      // Leave room for the MP4 container and small bitrate overshoots.
      let videoKbps = Math.floor((targetBytes * 8 * 0.93) / dur / 1000 - audioKbps);
      if (info.videoKbps) videoKbps = Math.min(videoKbps, Math.round(info.videoKbps * 0.9));
      if (videoKbps < 90) {
        const mins = Math.max(1, Math.round(dur / 60));
        throw UserError(`A ${mins}-minute video can't fit in ${targetMB} MB without looking very blurry. Cut it into shorter parts with Trim Audio or Video, or pick a bigger size.`);
      }
      let height = scaleChoice === "auto" ? (videoKbps >= 1300 ? 720 : videoKbps >= 500 ? 480 : 360) : Number(scaleChoice);
      const shortSide = info.width && info.height ? Math.min(info.width, info.height) : 0;
      if (height && shortSide && shortSide <= height) height = 0; // never upscale
      // Scale the short side, so phone (portrait) videos shrink the same way as landscape ones.
      const vf = height ? ["-vf", `scale='if(gt(iw,ih),-2,min(${height},iw))':'if(gt(iw,ih),min(${height},ih),-2)'`] : [];
      const out = "out.mp4";
      const encode = (vk) => [
        "-i", input, "-map", "0:v:0", "-map", "0:a:0?", ...vf,
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${vk}k`, "-maxrate", `${Math.round(vk * 1.4)}k`, "-bufsize", `${vk * 2}k`,
        "-pix_fmt", "yuv420p", "-fpsmax", "30",
        ...(info.audio ? ["-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2"] : []),
        "-movflags", "+faststart", out,
      ];
      await exec(ctx, f, encode(videoKbps), { duration: dur, label: "Compressing on your device", from: 0.27, to: 1 });
      let data = await readOut(f, out);
      if (data.length > targetBytes) {
        // Rare: the encoder overshot. Try once more with the bitrate cut to match.
        videoKbps = Math.max(60, Math.floor(videoKbps * (targetBytes / data.length) * 0.92));
        await exec(ctx, f, encode(videoKbps), { duration: dur, label: "A little too big, compressing again", from: 0.27, to: 1 });
        data = await readOut(f, out);
      }
      const filename = `${baseName(file.name)}_compressed.mp4`;
      const over = data.length > targetBytes ? ` It is slightly over ${targetMB} MB; try a smaller picture size.` : "";
      return {
        bytes: data, mime: "video/mp4", filename,
        message: `Done! ${filename}: ${mb(file.size)} → ${mb(data.length)}.${over} Nothing was uploaded.`,
      };
    });
  }

  function compressInput(ctx, id) {
    if (id === "mvTarget") ctx.el("mvCustomRow").hidden = ctx.value("mvTarget") !== "custom";
  }

  // ---------- Video to MP3 ----------

  const mp3Config = `
    <div class="form-group">
      <label class="form-label" for="mp3Quality">Sound quality</label>
      <select id="mp3Quality" class="form-select">
        <option value="128">Good (128 kbps, smaller file)</option>
        <option value="192" selected>High (192 kbps)</option>
        <option value="320">Best (320 kbps)</option>
      </select>
    </div>
    <p class="drop-hint">Pulls the sound out of a video (MP4, MOV, MKV, WebM…) and saves it as MP3. Works with audio files too (M4A, WAV, OGG…).</p>
    ${PHONE_NOTE}`;

  async function mp3Run(ctx) {
    const file = ctx.files[0];
    const kbps = Number(ctx.value("mp3Quality")) || 192;
    return withInput(ctx, file, 0.3, async (f, input) => {
      const info = await probe(ctx, f, input, file);
      if (!info.audio) throw UserError("This video has no sound to save.");
      const out = "out.mp3";
      await exec(ctx, f, ["-i", input, "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, out],
        { duration: info.duration, label: "Making the MP3 on your device", from: 0.32, to: 1 });
      const data = await readOut(f, out);
      const filename = `${baseName(file.name)}.mp3`;
      return { bytes: data, mime: "audio/mpeg", filename, message: `Done! Saved ${filename} (${mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Trim ----------

  const trimConfig = `<div id="trimRoot" class="media-trim"><p class="drop-hint">Add a video or audio file to pick the part you want to keep.</p></div>${PHONE_NOTE}`;

  function createTrimmer(root) {
    let url = null, media = null, duration = 0, file = null, stopAt = null;
    const $ = (id) => root.querySelector(`#${id}`);

    function setFile(f) {
      file = f;
      destroyMedia();
      const audio = isAudioFile(f);
      root.innerHTML = `
        <div class="media-preview ${audio ? "is-audio" : ""}">
          ${audio ? `<audio id="trimMedia" controls preload="metadata"></audio>` : `<video id="trimMedia" controls playsinline preload="metadata"></video>`}
        </div>
        <p class="drop-hint media-cant" id="trimCant" hidden>This browser can't preview this file, but you can still type the start and end times.</p>
        <div class="media-range" id="trimRange">
          <div class="media-track"><div class="media-sel" id="trimSel"></div></div>
          <input type="range" id="trimStartR" min="0" max="1000" value="0" step="1" aria-label="Start">
          <input type="range" id="trimEndR" min="0" max="1000" value="1000" step="1" aria-label="End">
        </div>
        <div class="grid-2 media-times">
          <div class="form-group">
            <label class="form-label" for="trimStart">Start</label>
            <div class="media-time-row">
              <input type="text" id="trimStart" class="form-input" value="0:00.0" inputmode="decimal" autocomplete="off">
              <button type="button" class="btn btn-xs" id="trimSetStart" title="Use the player's current position">Use now</button>
            </div>
          </div>
          <div class="form-group" style="margin-top:0">
            <label class="form-label" for="trimEnd">End</label>
            <div class="media-time-row">
              <input type="text" id="trimEnd" class="form-input" value="" placeholder="to the end" inputmode="decimal" autocomplete="off">
              <button type="button" class="btn btn-xs" id="trimSetEnd" title="Use the player's current position">Use now</button>
            </div>
          </div>
        </div>
        <div class="sign-row media-actions">
          <button type="button" class="btn btn-xs" id="trimPlaySel">▶ Play the part you keep</button>
          <span class="drop-hint" id="trimLen"></span>
        </div>
        ${audio ? "" : `<label class="checkbox-group media-exact"><input type="checkbox" id="trimExact"> <span>Exact cut (slower: re-encodes the video). Without it the cut is instant but may start up to a couple of seconds early.</span></label>`}`;
      media = $("trimMedia");
      url = URL.createObjectURL(f);
      media.src = url;
      media.addEventListener("loadedmetadata", () => {
        if (isFinite(media.duration) && media.duration > 0) {
          duration = media.duration;
          $("trimEnd").value = fmt(duration);
          $("trimEnd").placeholder = fmt(duration);
          sync();
        }
      });
      media.addEventListener("error", () => {
        if (!media || !media.getAttribute("src")) return;
        $("trimCant").hidden = false;
        root.querySelector(".media-preview").hidden = true;
        $("trimRange").hidden = true;
        $("trimPlaySel").hidden = true;
      });
      media.addEventListener("timeupdate", () => {
        if (stopAt !== null && media.currentTime >= stopAt) { media.pause(); stopAt = null; }
      });
      const fromSlider = (which) => {
        if (!duration) return;
        let s = Number($("trimStartR").value), e = Number($("trimEndR").value);
        if (s > e - 1) { if (which === "s") s = e - 1; else e = s + 1; }
        $("trimStartR").value = s; $("trimEndR").value = e;
        $("trimStart").value = fmt((s / 1000) * duration);
        $("trimEnd").value = fmt((e / 1000) * duration);
        media.currentTime = ((which === "s" ? s : e) / 1000) * duration;
        sync(false);
      };
      $("trimStartR").addEventListener("input", () => fromSlider("s"));
      $("trimEndR").addEventListener("input", () => fromSlider("e"));
      $("trimStart").addEventListener("input", () => sync());
      $("trimEnd").addEventListener("input", () => sync());
      $("trimSetStart").addEventListener("click", () => { $("trimStart").value = fmt(media.currentTime); sync(); });
      $("trimSetEnd").addEventListener("click", () => { $("trimEnd").value = fmt(media.currentTime); sync(); });
      $("trimPlaySel").addEventListener("click", () => {
        const { start, end } = read();
        if (!isFinite(start)) return;
        media.currentTime = start;
        stopAt = isFinite(end) ? end : null;
        media.play().catch(() => {});
      });
      sync();
    }

    function read() {
      const start = parseTime($("trimStart").value) ?? 0;
      let end = parseTime($("trimEnd").value);
      if (end === null) end = duration || Infinity;
      return { start, end };
    }

    function sync(moveSliders = true) {
      if (!$("trimStart")) return;
      const { start, end } = read();
      const badStart = !isFinite(start) || (duration > 0 && start >= duration);
      const badEnd = Number.isNaN(end) || end <= start;
      $("trimStart").classList.toggle("input-error", badStart);
      $("trimEnd").classList.toggle("input-error", badEnd);
      if (badStart || badEnd) $("trimLen").textContent = "Start must be before the end.";
      else $("trimLen").textContent = isFinite(end) ? `Keeping ${fmt(end - start)}${duration ? ` of ${fmt(duration)}` : ""}` : "Keeping everything after the start";
      if (duration && !badStart && !badEnd) {
        const s = Math.max(0, Math.min(1, start / duration));
        const e = Math.max(0, Math.min(1, (isFinite(end) ? end : duration) / duration));
        if (moveSliders) { $("trimStartR").value = Math.round(s * 1000); $("trimEndR").value = Math.round(e * 1000); }
        $("trimSel").style.left = `${s * 100}%`;
        $("trimSel").style.width = `${(e - s) * 100}%`;
      }
    }

    function destroyMedia() {
      if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
      if (url) URL.revokeObjectURL(url);
      media = null; url = null; duration = 0; stopAt = null;
    }

    function values() {
      if (!file || !$("trimStart")) throw UserError("Add a video or audio file first.");
      if (media) media.pause();
      const { start, end } = read();
      if (!isFinite(start) || start < 0) throw UserError("The start time doesn't look right. Use minutes:seconds, like 1:05.5.");
      if (Number.isNaN(end)) throw UserError("The end time doesn't look right. Use minutes:seconds, like 2:30.");
      if (end <= start) throw UserError("The end must come after the start.");
      if (duration && start >= duration) throw UserError(`The start is after the end of the file (${fmt(duration)}).`);
      const exact = !!($("trimExact") && $("trimExact").checked);
      return { start, end: duration ? Math.min(end, duration) : end, exact };
    }

    return { setFile, values, destroy: destroyMedia };
  }

  async function trimRun(ctx) {
    const file = ctx.files[0];
    const { start, end, exact } = ctx.trim.values();
    const audio = isAudioFile(file);
    return withInput(ctx, file, 0.25, async (f, input) => {
      const info = await probe(ctx, f, input, file);
      const total = info.duration || 0;
      if (total && start >= total) throw UserError(`The start is after the end of the file (${fmt(total)}).`);
      const stop = isFinite(end) ? (total ? Math.min(end, total) : end) : total;
      const len = stop ? stop - start : 0;
      let ext = extOf(file.name);
      let codec;
      if (audio || !info.video) {
        // Audio frames are tiny, so copying them cuts precisely enough and keeps the quality.
        codec = ["-map", "0:a:0", "-c", "copy"];
        if (!AUDIO_EXT.test(`.${ext}`)) ext = "m4a";
      } else if (exact) {
        codec = ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"];
        ext = "mp4";
      } else {
        codec = ["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero"];
        if (!/^(mp4|mov|m4v|mkv|webm|ts|3gp)$/.test(ext)) ext = "mp4";
        if (/^(mp4|mov|m4v)$/.test(ext)) codec.push("-movflags", "+faststart");
      }
      const out = `out.${ext}`;
      await exec(ctx, f, ["-ss", start.toFixed(3), "-i", input, ...(len > 0 ? ["-t", len.toFixed(3)] : []), ...codec, out],
        { duration: len || Math.max(1, total - start), label: exact ? "Cutting and re-encoding on your device" : "Cutting on your device", from: 0.27, to: 1 });
      const data = await readOut(f, out);
      if (data.length < 1024) throw UserError("Nothing was left after cutting. Check the start and end times.");
      const filename = `${baseName(file.name)}_trimmed.${ext}`;
      const mime = audio || !info.video ? (file.type || "audio/mpeg")
        : ext === "webm" ? "video/webm" : ext === "mkv" ? "video/x-matroska" : "video/mp4";
      return {
        bytes: data, mime, filename,
        message: `Done! Saved ${filename} (${fmt(len || total - start)} long). Nothing was uploaded.`,
      };
    });
  }

  return {
    VIDEO_ACCEPT, AUDIO_ACCEPT, compressConfig, compressRun, compressInput, mp3Config, mp3Run,
    trimConfig, createTrimmer, trimRun, stopEngine, fmt, parseTime,
    // shared with media-extra.js
    withInput, exec, probe, readOut, engine, checkSize, cancelled, baseName, extOf, mb, isAudioFile, PHONE_NOTE,
  };
})();

TOOLS.push(
  {
    id: "compress-video",
    noBuffers: true,
    slug: "compress-video",
    aliases: ["video-compressor", "reduce-video-size", "compress-video-for-whatsapp"],
    name: "Compress Video",
    desc: "Shrink a video to fit WhatsApp (16 MB), email (25 MB) or any size you choose. Runs on your device, nothing is uploaded.",
    keywords: "video compressor reduce video size shrink mp4 whatsapp 16mb email 25mb smaller video mb 720p 480p mov mkv",
    icon: "🎬",
    category: "optimize",
    badge: "New",
    caption: "Fits WhatsApp & email",
    scene: "squash",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Compress video",
    configHtml: MediaTool.compressConfig,
    onInput: (ctx, id) => MediaTool.compressInput(ctx, id),
    run: (ctx) => MediaTool.compressRun(ctx),
  },
  {
    id: "video-to-mp3",
    noBuffers: true,
    slug: "video-to-mp3",
    aliases: ["mp4-to-mp3", "extract-audio", "convert-to-mp3"],
    name: "Video to MP3",
    desc: "Save the sound from any video as an MP3. Also converts M4A, WAV and other audio to MP3. Private, on your device.",
    keywords: "mp4 to mp3 video to audio extract audio from video convert mp3 sound music song m4a wav to mp3 audio converter",
    icon: "🎵",
    category: "convert",
    badge: "New",
    caption: "Sound → MP3",
    flip: ["MP4", "MP3"],
    accept: `${MediaTool.VIDEO_ACCEPT},${MediaTool.AUDIO_ACCEPT}`,
    acceptLabel: "a video or audio file",
    actionLabel: "Save MP3",
    configHtml: MediaTool.mp3Config,
    run: (ctx) => MediaTool.mp3Run(ctx),
  },
  {
    id: "trim-media",
    noBuffers: true,
    slug: "trim-media",
    aliases: ["trim-video", "trim-audio", "cut-video", "cut-audio", "cut-mp3"],
    name: "Trim Audio or Video",
    desc: "Cut the start and end off a video or audio file. Preview it, drag the sliders, save just the part you want.",
    keywords: "trim video cut video cut audio trim mp3 clip cutter shorten video ringtone start end mp4 audio cutter",
    icon: "🎞️",
    category: "edit",
    badge: "New",
    caption: "Keep just the best part",
    scene: "crop",
    accept: `${MediaTool.VIDEO_ACCEPT},${MediaTool.AUDIO_ACCEPT}`,
    acceptLabel: "a video or audio file",
    actionLabel: "Trim & save",
    wide: true,
    configHtml: MediaTool.trimConfig,
    onOpen: (ctx) => { ctx.trim = MediaTool.createTrimmer(ctx.el("trimRoot")); },
    onFiles: (ctx) => ctx.trim.setFile(ctx.files[0]),
    onClose: (ctx) => ctx.trim && ctx.trim.destroy(),
    run: (ctx) => MediaTool.trimRun(ctx),
  },
);
