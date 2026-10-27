// More video and audio tools on the same in-browser ffmpeg as media-tool.js: Video to GIF,
// Compress GIF, Resize Video for Reels/Shorts, Change Speed, Volume Booster and Audio Joiner.
// Files never leave the device.

const MediaExtra = (() => {
  const M = MediaTool;
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const GIF_ACCEPT = "image/gif,.gif";

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
      // Own names, so two files called "audio.mp3" don't clash.
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

  const timeField = (id, label, placeholder) => `
    <div class="form-group"><label class="form-label" for="${id}">${label}</label>
      <input type="text" id="${id}" class="form-input" placeholder="${placeholder}" inputmode="decimal" autocomplete="off"></div>`;
  function times(ctx, startId, endId, total) {
    const s = M.parseTime(ctx.value(startId)), e = M.parseTime(ctx.value(endId));
    if (Number.isNaN(s) || Number.isNaN(e)) throw UserError("Write times like 5, 1:30 or 0:01:30.");
    const start = s || 0;
    const end = e == null ? total : Math.min(e, total || e);
    if (total && start >= total) throw UserError(`The start is after the end of the video (${M.fmt(total)}).`);
    if (end && end <= start) throw UserError("The end must be after the start.");
    return { start, len: end ? end - start : 0 };
  }
  // A GIF palette made for this clip, so colours stay true; "diff" dithering keeps files smaller.
  const gifFilter = (fps, width, colors) =>
    `${fps ? `fps=${fps},` : ""}${width ? `scale='min(${width},iw)':-2:flags=lanczos,` : ""}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;

  // ---------- Video to GIF ----------

  const gifConfig = `
    <div class="grid-2">${timeField("vgStart", "Start at", "0:00")}${timeField("vgEnd", "End at", "Start + 5 seconds")}</div>
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="vgWidth">Width</label>
        <select id="vgWidth" class="form-select"><option value="320">320 px (small, for chats)</option><option value="480" selected>480 px</option><option value="640">640 px</option><option value="0">Same as the video</option></select></div>
      <div class="form-group"><label class="form-label" for="vgFps">Smoothness</label>
        <select id="vgFps" class="form-select"><option value="10">10 frames a second (smaller)</option><option value="15" selected>15 frames a second</option><option value="24">24 frames a second (smoothest)</option></select></div>
    </div>
    <p class="drop-hint">GIFs get big fast: keep clips short (under 10 seconds) and small. Works with MP4, MOV, WebM and more.</p>
    ${M.PHONE_NOTE}`;

  async function gifRun(ctx) {
    const file = ctx.files[0];
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture to turn into a GIF.");
      let { start, len } = times(ctx, "vgStart", "vgEnd", info.duration);
      if (!ctx.value("vgEnd").trim()) len = Math.min(5, (info.duration || 5) - start);
      if (len > 60) throw UserError("That's over a minute: a GIF that long would be huge. Choose up to 60 seconds, or use Compress Video instead.");
      const out = "out.gif";
      await M.exec(ctx, f, ["-ss", start.toFixed(3), "-t", len.toFixed(3), "-i", input,
        "-filter_complex", gifFilter(Number(ctx.value("vgFps")) || 15, Number(ctx.value("vgWidth")), 256), "-loop", "0", out],
        { duration: len, label: "Making the GIF on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}.gif`;
      return { bytes: data, mime: "image/gif", filename, message: `Done! Saved ${filename} (${M.mb(data.length)}, ${len.toFixed(1)} s). Nothing was uploaded.` };
    });
  }

  // ---------- Compress GIF ----------

  const gifCompressConfig = `
    <div class="form-group"><label class="form-label" for="cgLevel">How much smaller</label>
      <select id="cgLevel" class="form-select">
        <option value="light">A little (best look)</option>
        <option value="medium" selected>Medium</option>
        <option value="strong">A lot (for WhatsApp, Discord and email limits)</option>
      </select></div>
    <div class="form-group"><label class="form-label" for="cgWidth">Size</label>
      <select id="cgWidth" class="form-select"><option value="1" selected>Keep the size</option><option value="0.75">75%</option><option value="0.5">Half</option></select></div>
    <p class="drop-hint">Uses fewer colours and, on stronger settings, fewer frames. Animated and still GIFs both work.</p>`;

  async function gifCompressRun(ctx) {
    const file = ctx.files[0];
    const level = { light: [192, 0], medium: [96, 15], strong: [48, 10] }[ctx.value("cgLevel")] || [96, 15];
    const scale = Number(ctx.value("cgWidth")) || 1;
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This doesn't look like a GIF.");
      const width = scale < 1 && info.width ? Math.round(info.width * scale) : 0;
      // Lower the frame rate only when the GIF has more frames a second than the cap.
      const log = await M.exec(ctx, f, ["-i", input], { allowFail: true });
      const src = Number((/, ([\d.]+) fps/.exec(log) || [])[1]) || 0;
      const fps = level[1] && src > level[1] + 0.5 ? level[1] : 0;
      const out = "out.gif";
      await M.exec(ctx, f, ["-i", input, "-filter_complex", gifFilter(fps, width, level[0]), "-loop", "0", out],
        { duration: info.duration, label: "Compressing the GIF on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_compressed.gif`;
      if (data.length >= file.size) throw UserError(`This GIF is already well compressed (${M.mb(file.size)}). Try "A lot" or a smaller size.`);
      return { bytes: data, mime: "image/gif", filename,
        message: `Done! ${filename}: ${M.mb(file.size)} → ${M.mb(data.length)} (${Math.round((1 - data.length / file.size) * 100)}% smaller). Nothing was uploaded.` };
    });
  }

  // ---------- Resize video for Reels / Shorts ----------

  const reelsConfig = `
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="rsShape">Shape</label>
        <select id="rsShape" class="form-select">
          <option value="9:16" selected>9:16 tall (Reels, Shorts, Status, TikTok)</option>
          <option value="1:1">1:1 square (feed post)</option>
          <option value="4:5">4:5 portrait (Instagram post)</option>
          <option value="16:9">16:9 wide (YouTube)</option>
        </select></div>
      <div class="form-group"><label class="form-label" for="rsFill">Empty space</label>
        <select id="rsFill" class="form-select">
          <option value="blur" selected>Blurred copy of the video</option>
          <option value="black">Black bars</option>
          <option value="white">White bars</option>
          <option value="crop">None: zoom in and crop the sides</option>
        </select></div>
    </div>
    <div class="form-group"><label class="form-label" for="rsQuality">Quality</label>
      <select id="rsQuality" class="form-select"><option value="720" selected>HD 720p (faster)</option><option value="1080">Full HD 1080p (slower)</option></select></div>
    <p class="drop-hint">Fits a wide video into a tall frame (or the other way) without stretching. The sound is kept.</p>
    ${M.PHONE_NOTE}`;

  async function reelsRun(ctx) {
    const file = ctx.files[0];
    const [rw, rh] = ctx.value("rsShape").split(":").map(Number);
    const q = Number(ctx.value("rsQuality")) || 720;
    // q is the short side
    let W = rw < rh ? q : Math.round((q * rw) / rh), H = rw < rh ? Math.round((q * rh) / rw) : q;
    if (rw === rh) { W = q; H = q; }
    W -= W % 2; H -= H % 2;
    const fill = ctx.value("rsFill");
    let vf;
    if (fill === "crop") vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v]`;
    else if (fill === "blur") {
      const bw = Math.round(W / 8) * 2, bh = Math.round(H / 8) * 2;
      // The blurred backdrop doesn't need a sharp scaler; fast_bilinear there and bilinear for
      // the picture cut the filter time by about 30% in the single-thread wasm build.
      vf = `[0:v]split[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${bw}:${bh},boxblur=8:2,scale=${W}:${H}:flags=fast_bilinear[bg];` +
        `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bilinear,scale=trunc(iw/2)*2:trunc(ih/2)*2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
    } else {
      vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${fill},setsar=1[v]`;
    }
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.video) throw UserError("This file has no picture.");
      const out = "out.mp4";
      await M.exec(ctx, f, ["-i", input, "-filter_complex", vf, "-map", "[v]", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-fpsmax", "30",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out],
        { duration: info.duration, label: "Resizing on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const tag = ctx.value("rsShape").replace(":", "x");
      const filename = `${M.baseName(file.name)}_${tag}.mp4`;
      return { bytes: data, mime: "video/mp4", filename, message: `Done! ${W}×${H} video saved as ${filename} (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Change speed ----------

  const speedConfig = `
    <div class="form-group"><label class="form-label" for="spSpeed">Speed</label>
      <select id="spSpeed" class="form-select">
        <option value="0.25">0.25× (4 times slower)</option><option value="0.5">0.5× (half speed)</option><option value="0.75">0.75×</option>
        <option value="1.25">1.25×</option><option value="1.5" selected>1.5×</option><option value="2">2× (twice as fast)</option><option value="3">3×</option><option value="4">4×</option>
      </select></div>
    <label class="checkbox-group"><input type="checkbox" id="spPitch" checked> Keep voices sounding normal (no chipmunk voice)</label>
    <p class="drop-hint">Works with videos (MP4, MOV, WebM...) and audio (MP3, M4A, WAV, voice notes).</p>
    ${M.PHONE_NOTE}`;

  /** atempo only takes 0.5-2, so bigger changes are chained. */
  function atempo(s) {
    const parts = [];
    while (s > 2) { parts.push(2); s /= 2; }
    while (s < 0.5) { parts.push(0.5); s /= 0.5; }
    parts.push(s);
    return parts.map((p) => `atempo=${p.toFixed(5)}`).join(",");
  }

  async function speedRun(ctx) {
    const file = ctx.files[0];
    const s = Number(ctx.value("spSpeed")) || 1.5;
    const keepPitch = ctx.el("spPitch").checked;
    const af = keepPitch ? atempo(s) : `asetrate=44100*${s},aresample=44100`;
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      const outLen = info.duration / s;
      const audioPre = keepPitch ? "" : "aresample=44100,";
      let args, out, mime, ext;
      if (info.video && !M.isAudioFile(file)) {
        out = "out.mp4"; mime = "video/mp4"; ext = "mp4";
        const graph = `[0:v]setpts=PTS/${s}[v]${info.audio ? `;[0:a]${audioPre}${af}[a]` : ""}`;
        args = ["-i", input, "-filter_complex", graph, "-map", "[v]", ...(info.audio ? ["-map", "[a]"] : []),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-fpsmax", "60",
          ...(info.audio ? ["-c:a", "aac", "-b:a", "160k"] : []), "-movflags", "+faststart", out];
      } else {
        if (!info.audio) throw UserError("This file has no sound.");
        out = "out.mp3"; mime = "audio/mpeg"; ext = "mp3";
        args = ["-i", input, "-vn", "-af", `${audioPre}${af}`, "-c:a", "libmp3lame", "-b:a", "192k", out];
      }
      await M.exec(ctx, f, args, { duration: outLen, label: "Changing the speed on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_${s}x.${ext}`;
      return { bytes: data, mime, filename, message: `Done! ${filename} is ${M.fmt(outLen)} long (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Volume booster ----------

  const volumeConfig = `
    <div class="form-group"><label class="form-label" for="vbBoost">Make it</label>
      <select id="vbBoost" class="form-select">
        <option value="auto" selected>As loud as it can go without crackling</option>
        <option value="6">Louder (+6 dB, about 2× as loud)</option>
        <option value="10">Much louder (+10 dB)</option>
        <option value="15">Very loud (+15 dB)</option>
        <option value="-6">Quieter (-6 dB)</option>
      </select></div>
    <p class="drop-hint">For quiet videos, lectures, voice notes and songs. A limiter stops the loud parts from distorting. Video stays as it is.</p>
    ${M.PHONE_NOTE}`;

  async function volumeRun(ctx) {
    const file = ctx.files[0];
    const choice = ctx.value("vbBoost");
    // The trailing aformat pins the output layout: without it the wasm ffmpeg can't pick one
    // for mono sound after loudnorm ("Cannot select channel layout") and the job fails.
    const af = (choice === "auto" ? "loudnorm=I=-12:TP=-1:LRA=11,aresample=44100" : `volume=${choice}dB,alimiter=limit=0.95:level=disabled`) +
      ",aformat=sample_rates=44100:channel_layouts=stereo";
    return M.withInput(ctx, file, 0.25, async (f, input) => {
      const info = await M.probe(ctx, f, input, file);
      if (!info.audio) throw UserError("This file has no sound to make louder.");
      let args, out, mime, ext;
      if (info.video && !M.isAudioFile(file)) {
        const copyable = /^(mp4|mov|m4v)$/.test(M.extOf(file.name));
        out = "out.mp4"; mime = "video/mp4"; ext = "mp4";
        args = ["-i", input, "-map", "0:v:0", "-map", "0:a:0", "-af", af,
          ...(copyable ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]),
          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out];
      } else {
        out = "out.mp3"; mime = "audio/mpeg"; ext = "mp3";
        args = ["-i", input, "-vn", "-af", af, "-c:a", "libmp3lame", "-b:a", "192k", out];
      }
      await M.exec(ctx, f, args, { duration: info.duration, label: "Adjusting the volume on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(file.name)}_louder.${ext}`.replace("_louder", choice === "-6" ? "_quieter" : "_louder");
      return { bytes: data, mime, filename, message: `Done! Saved ${filename} (${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  // ---------- Audio joiner ----------

  const joinConfig = `
    <div class="grid-2">
      <div class="form-group"><label class="form-label" for="ajFade">Between songs</label>
        <select id="ajFade" class="form-select"><option value="0" selected>Straight after each other</option><option value="2">Fade into each other (2 s)</option><option value="5">Fade into each other (5 s)</option></select></div>
      <div class="form-group"><label class="form-label" for="ajQuality">Quality</label>
        <select id="ajQuality" class="form-select"><option value="128">Good (128 kbps)</option><option value="192" selected>High (192 kbps)</option><option value="320">Best (320 kbps)</option></select></div>
    </div>
    <p class="drop-hint">Joined in the order shown in the list above (the order you added them). MP3, M4A, WAV, OGG, voice notes, and the sound from videos all work. Saves one MP3.</p>`;

  async function joinRun(ctx) {
    const files = ctx.files;
    if (files.length < 2) throw UserError("Add at least two audio files to join.");
    const fade = Number(ctx.value("ajFade")) || 0;
    const kbps = Number(ctx.value("ajQuality")) || 192;
    return withInputs(ctx, files, 0.2, async (f, inputs) => {
      let total = 0;
      for (let i = 0; i < inputs.length; i++) {
        ctx.progress(0.2 + 0.05 * (i / inputs.length), `Checking file ${i + 1} of ${inputs.length}…`);
        const info = await M.probe(ctx, f, inputs[i], files[i]);
        if (!info.audio) throw UserError(`${files[i].name} has no sound.`);
        if (fade && info.duration && info.duration < fade * (i > 0 && i < inputs.length - 1 ? 2 : 1) + 0.5) throw UserError(`${files[i].name} is too short for a ${fade}-second fade. Choose "Straight after each other".`);
        total += info.duration || 0;
      }
      const n = inputs.length;
      const norm = inputs.map((_, i) => `[${i}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`).join(";");
      let graph;
      if (!fade) graph = `${norm};${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1[out]`;
      else {
        let prev = "a0";
        const steps = [];
        for (let i = 1; i < n; i++) {
          const next = i === n - 1 ? "out" : `x${i}`;
          steps.push(`[${prev}][a${i}]acrossfade=d=${fade}:c1=tri:c2=tri[${next}]`);
          prev = next;
        }
        graph = `${norm};${steps.join(";")}`;
      }
      const out = "out.mp3";
      await M.exec(ctx, f, [...inputs.flatMap((p) => ["-i", p]), "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, out],
        { duration: total - fade * (n - 1), label: "Joining on your device", from: 0.27, to: 1 });
      const data = await M.readOut(f, out);
      const filename = `${M.baseName(files[0].name)}_joined.mp3`;
      return { bytes: data, mime: "audio/mpeg", filename, message: `Done! Joined ${n} files into ${filename} (${M.fmt(total - fade * (n - 1))}, ${M.mb(data.length)}). Nothing was uploaded.` };
    });
  }

  return {
    GIF_ACCEPT, gifConfig, gifRun, gifCompressConfig, gifCompressRun, reelsConfig, reelsRun,
    speedConfig, speedRun, volumeConfig, volumeRun, joinConfig, joinRun, atempo,
  };
})();

TOOLS.push(
  {
    id: "video-to-gif",
    noBuffers: true,
    slug: "video-to-gif",
    aliases: ["mp4-to-gif", "gif-maker", "make-gif", "mov-to-gif"],
    name: "Video to GIF",
    desc: "Turn a short part of a video into a GIF for chats and posts. Pick the start, length, size and smoothness.",
    keywords: "mp4 to gif video to gif gif maker make gif from video convert video to gif mov to gif webm to gif animated gif",
    category: "convert",
    badge: "New",
    caption: "Clip to GIF",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Make GIF",
    configHtml: MediaExtra.gifConfig,
    run: (ctx) => MediaExtra.gifRun(ctx),
  },
  {
    id: "compress-gif",
    noBuffers: true,
    slug: "compress-gif",
    aliases: ["gif-compressor", "reduce-gif-size", "optimize-gif"],
    name: "Compress GIF",
    desc: "Make an animated GIF smaller so it fits WhatsApp, Discord and email limits.",
    keywords: "gif compressor compress gif reduce gif size optimize gif smaller gif discord gif limit animated gif mb",
    category: "optimize",
    badge: "New",
    caption: "Smaller GIFs",
    accept: MediaExtra.GIF_ACCEPT,
    acceptLabel: "a GIF",
    actionLabel: "Compress GIF",
    configHtml: MediaExtra.gifCompressConfig,
    run: (ctx) => MediaExtra.gifCompressRun(ctx),
  },
  {
    id: "reels-resizer",
    noBuffers: true,
    slug: "resize-video-for-reels",
    aliases: ["video-to-9-16", "reels-size", "youtube-shorts-size", "instagram-video-size", "video-aspect-ratio", "square-video"],
    name: "Resize Video for Reels & Shorts",
    desc: "Fit any video into 9:16 for Reels, Shorts and Status, or square and 4:5 for posts, with a blurred background or bars.",
    keywords: "video to 9:16 reels size youtube shorts resize instagram reels aspect ratio 16:9 to 9:16 whatsapp status square video 1:1 4:5 vertical video converter blur background",
    category: "edit",
    badge: "New",
    caption: "Wide to tall, no stretching",
    accept: MediaTool.VIDEO_ACCEPT,
    acceptLabel: "a video",
    actionLabel: "Resize video",
    configHtml: MediaExtra.reelsConfig,
    run: (ctx) => MediaExtra.reelsRun(ctx),
  },
  {
    id: "media-speed",
    noBuffers: true,
    slug: "change-video-speed",
    aliases: ["speed-up-video", "slow-down-video", "audio-speed-changer", "change-audio-speed", "slow-motion-video"],
    name: "Change Video or Audio Speed",
    desc: "Speed up or slow down a video, song or voice note, from 0.25× to 4×, with voices kept natural.",
    keywords: "speed up video slow down video change video speed audio speed changer slow motion fast forward 2x 1.5x 0.5x speed up audio voice note mp3 speed",
    category: "edit",
    badge: "New",
    caption: "Faster or slower",
    accept: `${MediaTool.VIDEO_ACCEPT},${MediaTool.AUDIO_ACCEPT}`,
    acceptLabel: "a video or audio file",
    actionLabel: "Change speed",
    configHtml: MediaExtra.speedConfig,
    run: (ctx) => MediaExtra.speedRun(ctx),
  },
  {
    id: "volume-booster",
    noBuffers: true,
    slug: "volume-booster",
    aliases: ["increase-volume", "make-audio-louder", "increase-video-volume", "audio-amplifier", "mp3-volume-booster"],
    name: "Volume Booster",
    desc: "Make a quiet video, song, lecture or voice note louder without crackling. Or make it quieter.",
    keywords: "volume booster increase volume of video make audio louder mp3 volume booster audio amplifier increase sound normalize loudness quiet video louder lecture voice note",
    category: "edit",
    badge: "New",
    caption: "Louder, without crackle",
    accept: `${MediaTool.VIDEO_ACCEPT},${MediaTool.AUDIO_ACCEPT}`,
    acceptLabel: "a video or audio file",
    actionLabel: "Boost volume",
    configHtml: MediaExtra.volumeConfig,
    run: (ctx) => MediaExtra.volumeRun(ctx),
  },
  {
    id: "audio-joiner",
    noBuffers: true,
    slug: "audio-joiner",
    aliases: ["merge-audio", "join-mp3", "combine-audio", "mp3-joiner", "merge-mp3"],
    name: "Audio Joiner",
    desc: "Join songs, voice notes and audio clips into one MP3, one after another or fading into each other.",
    keywords: "audio joiner merge audio join mp3 combine audio files mp3 merger merge songs join voice notes crossfade one mp3",
    category: "edit",
    badge: "New",
    caption: "Many clips, one MP3",
    accept: `${MediaTool.AUDIO_ACCEPT},${MediaTool.VIDEO_ACCEPT}`,
    acceptLabel: "audio files",
    multipleFiles: true,
    actionLabel: "Join & save",
    configHtml: MediaExtra.joinConfig,
    run: (ctx) => MediaExtra.joinRun(ctx),
  },
);
