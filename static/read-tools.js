// Reading tools that run on the device: read aloud, summarize and translate.
// Text comes from pdf.js; speech uses the browser's voices; summaries and translation use the
// browser's built-in on-device AI where it exists (Chrome), with an offline fallback for summaries.

const ReadTools = (() => {
  function sentences(text) {
    // Sentence ends: Latin and CJK marks, the Devanagari/Bengali danda (। ॥) and the Urdu full stop (۔).
    return (text.replace(/\s+/g, " ").match(/[^.!?。！？।॥۔]+[.!?。！？।॥۔]+["')\]]*|[^.!?。！？।॥۔]+$/g) || [])
      .map((s) => s.trim()).filter((s) => s.length > 1);
  }

  // Indian languages first. [code, English name, name in its own script]
  const INDIAN = [["hi", "Hindi", "हिन्दी"], ["mr", "Marathi", "मराठी"], ["bn", "Bengali", "বাংলা"], ["ta", "Tamil", "தமிழ்"],
    ["te", "Telugu", "తెలుగు"], ["gu", "Gujarati", "ગુજરાતી"], ["kn", "Kannada", "ಕನ್ನಡ"], ["ml", "Malayalam", "മലയാളം"],
    ["pa", "Punjabi", "ਪੰਜਾਬੀ"], ["ur", "Urdu", "اردو"]];
  const LANG_NAMES = Object.fromEntries([["en", "English"], ["or", "Odia"], ["sa", "Sanskrit"], ...INDIAN.map(([c, n]) => [c, n]),
    ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"], ["it", "Italian"], ["nl", "Dutch"], ["ru", "Russian"],
    ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ar", "Arabic"], ["tr", "Turkish"], ["vi", "Vietnamese"], ["pl", "Polish"]]);
  const langName = (code) => LANG_NAMES[String(code).split("-")[0]] || code;

  /** Guesses a document's language from its script (good enough to pick a voice). */
  function detectScript(text) {
    const sample = text.slice(0, 6000);
    const count = (re) => (sample.match(re) || []).length;
    const scripts = [
      ["hi", count(/[ऀ-ॿ]/g)], ["bn", count(/[ঀ-৿]/g)], ["pa", count(/[਀-੿]/g)],
      ["gu", count(/[઀-૿]/g)], ["or", count(/[଀-୿]/g)], ["ta", count(/[஀-௿]/g)],
      ["te", count(/[ఀ-౿]/g)], ["kn", count(/[ಀ-೿]/g)], ["ml", count(/[ഀ-ൿ]/g)],
      ["ar", count(/[؀-ۿ]/g)], ["en", count(/[A-Za-z]/g)],
    ].sort((a, b) => b[1] - a[1]);
    let [code, n] = scripts[0];
    if (!n) return "en";
    // Marathi is written in Devanagari too; a few very common Marathi words tell them apart.
    if (code === "hi" && count(/(आहे|आणि|नाही|हे |च्या|ला )/g) > count(/(है|और|नहीं|के |की )/g)) code = "mr";
    // Urdu and Arabic share a script; Urdu has letters Arabic doesn't.
    if (code === "ar" && /[ٹڈڑںےہھ]/.test(sample)) code = "ur";
    return code;
  }

  /** True when this person is probably in India, so English is best read with an Indian voice. */
  function prefersIndia() {
    const langs = navigator.languages || [navigator.language || ""];
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* old browser */ }
    return langs.some((l) => /-IN$/i.test(l)) || /Kolkata|Calcutta/.test(tz);
  }

  // ---------- Read aloud ----------

  async function audioRun(ctx) {
    const r = await PdfRender.extractText(ctx.buffers[0]);
    const pages = r.pages.map((p) => ({ page: p.page, sentences: sentences(p.text) }));
    if (!pages.some((p) => p.sentences.length)) throw new ClientPDF.UserError("This PDF has no text to read. Run OCR PDF on scanned pages first.");
    return { json: { title: r.title, pages, lang: detectScript(r.pages.map((p) => p.text).join("\n")) } };
  }

  const VOICE_HELP = `To add one: on <strong>Android</strong>, Settings → Accessibility (or System) → Text-to-speech output → Google → Install voice data.
    On <strong>Windows</strong>, Settings → Time &amp; language → Speech → Add voices. On <strong>iPhone, iPad or Mac</strong>, Settings → Accessibility → Spoken Content → Voices.
    Chrome on a computer also has Google voices for Hindi and other languages. Then reopen this page.`;

  function audioRender(data, box) {
    if (!("speechSynthesis" in window)) {
      box.innerHTML = `<p class="drop-hint">This browser can't read text aloud. Try Chrome, Edge or Safari.</p>`;
      return;
    }
    const queue = data.pages.flatMap((p) => p.sentences.map((s) => ({ page: p.page, text: s })));
    const docLang = data.lang || "en";
    const langOptions = [["auto", `Same as the document (${langName(docLang)})`], ["en-IN", "English (India)"],
      ...INDIAN.map(([c, n, native]) => [`${c}-IN`, `${native} · ${n}`]), ["en", "English (any accent)"], ["all", "Show every voice"]];
    box.innerHTML = `
      <div class="grid-2">
        <div class="form-group"><label class="form-label" for="ttsLang">Language</label>
          <select id="ttsLang" class="form-select">${langOptions.map(([v, n]) => `<option value="${v}">${escapeHtml(n)}</option>`).join("")}</select></div>
        <div class="form-group" style="margin-top:0"><label class="form-label" for="ttsVoice">Voice</label><select id="ttsVoice" class="form-select"></select></div>
      </div>
      <p class="drop-hint" id="ttsNote" hidden style="text-align:left;line-height:1.5;margin:0 0 8px"></p>
      <div class="form-group"><label class="form-label" for="ttsRate">Speed <span id="ttsRateVal">1.0×</span></label>
        <input type="range" id="ttsRate" min="0.5" max="2" step="0.1" value="1" style="width:100%;accent-color:var(--primary)"></div>
      <div class="sign-row">
        <button type="button" class="btn btn-primary btn-xs" id="ttsPlay">▶ Play</button>
        <button type="button" class="btn btn-xs" id="ttsStop">■ Stop</button>
        <label class="checkbox-group" style="margin-left:auto;">From page
          <select id="ttsPage" class="select-sm">${data.pages.map((p) => `<option value="${p.page}">${p.page}</option>`).join("")}</select></label>
      </div>
      <div class="tts-text" id="ttsText" lang="${escapeHtml(docLang)}">${queue.map((q, i) => `<span data-i="${i}">${escapeHtml(q.text)} </span>`).join("")}</div>`;
    const $ = (id) => box.querySelector(`#${id}`);
    const synth = window.speechSynthesis;
    let idx = 0, playing = false, paused = false, waitedForVoices = false;

    // The language we want to hear, e.g. "hi-IN". Indian languages always prefer an Indian voice.
    function wanted() {
      const pick = $("ttsLang").value;
      if (pick !== "auto") return pick;
      if (INDIAN.some(([c]) => c === docLang) || docLang === "or") return `${docLang}-IN`;
      if (docLang === "en") return prefersIndia() ? "en-IN" : (navigator.language || "en").startsWith("en") ? navigator.language : "en";
      return docLang;
    }

    function fillVoices() {
      if (!$("ttsVoice")) return; // the result box now shows something else
      const voices = synth.getVoices();
      const want = wanted();
      const [base, region] = want.split("-");
      const norm = (v) => v.lang.replace("_", "-").toLowerCase();
      const matching = want === "all" ? voices.map((v, i) => i)
        : voices.map((v, i) => i).filter((i) => norm(voices[i]).split("-")[0] === base);
      const score = (v) => (region && norm(v).endsWith(`-${region.toLowerCase()}`) ? 4 : 0)
        + (/natural|neural|online|google|enhanced|premium/i.test(v.name) ? 2 : 0) + (v.default ? 1 : 0);
      const ranked = matching.sort((a, b) => score(voices[b]) - score(voices[a]));
      const list = ranked.length ? ranked : voices.map((v, i) => i);
      $("ttsVoice").innerHTML = list.length
        ? list.map((i) => `<option value="${i}">${escapeHtml(voices[i].name)} (${escapeHtml(voices[i].lang)})</option>`).join("")
        : `<option value="">No voices on this device</option>`;
      const note = $("ttsNote");
      if (!voices.length) {
        note.innerHTML = waitedForVoices ? `<strong>This device has no voices for reading aloud.</strong> ${VOICE_HELP}` : "Loading the voices on this device…";
        note.hidden = false;
      } else if (!ranked.length) {
        const name = langName(base);
        note.innerHTML = `<strong>This device has no ${escapeHtml(name)} voice.</strong> Another voice may skip the words or read them with the wrong sounds. ${VOICE_HELP}`;
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }
    fillVoices();
    synth.onvoiceschanged = () => { waitedForVoices = true; fillVoices(); };
    setTimeout(() => { if (!waitedForVoices) { waitedForVoices = true; if (box.isConnected && $("ttsVoice")) fillVoices(); } }, 1500);
    $("ttsLang").addEventListener("change", () => {
      fillVoices();
      if (playing) { synth.cancel(); paused = false; speakNext(); }
    });
    $("ttsRate").addEventListener("input", () => { $("ttsRateVal").textContent = `${Number($("ttsRate").value).toFixed(1)}×`; });

    function mark(i) {
      box.querySelectorAll(".tts-text span.on").forEach((s) => s.classList.remove("on"));
      const el = box.querySelector(`.tts-text span[data-i="${i}"]`);
      if (el) { el.classList.add("on"); el.scrollIntoView({ block: "nearest" }); }
    }
    function speakNext() {
      if (!playing || idx >= queue.length) { playing = false; $("ttsPlay").textContent = "▶ Play"; return; }
      const u = new SpeechSynthesisUtterance(queue[idx].text);
      const v = $("ttsVoice").value === "" ? null : synth.getVoices()[Number($("ttsVoice").value)];
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = wanted() === "all" ? docLang : wanted(); }
      u.rate = Number($("ttsRate").value);
      mark(idx);
      u.onend = () => { if (playing && !paused) { idx++; speakNext(); } };
      synth.speak(u);
    }
    $("ttsPlay").addEventListener("click", () => {
      if (playing && !paused) { synth.pause(); paused = true; $("ttsPlay").textContent = "▶ Resume"; return; }
      if (paused) { synth.resume(); paused = false; $("ttsPlay").textContent = "❚❚ Pause"; return; }
      playing = true; $("ttsPlay").textContent = "❚❚ Pause"; synth.cancel(); speakNext();
    });
    $("ttsStop").addEventListener("click", () => { playing = false; paused = false; synth.cancel(); $("ttsPlay").textContent = "▶ Play"; });
    $("ttsPage").addEventListener("change", () => {
      idx = Math.max(0, queue.findIndex((q) => q.page >= Number($("ttsPage").value)));
      mark(idx);
      if (playing) { synth.cancel(); paused = false; speakNext(); }
    });
    // Clicking a sentence starts reading from there.
    $("ttsText").addEventListener("click", (e) => {
      const s = e.target.closest("span[data-i]");
      if (!s) return;
      idx = Number(s.dataset.i);
      playing = true; paused = false; $("ttsPlay").textContent = "❚❚ Pause"; synth.cancel(); speakNext();
    });
  }

  function stopAudio() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  // ---------- Summarize ----------

  const STOP = new Set("a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those there their they them he she we you i not no so than then too very can will just do does did has have had into over under about after before between more most such only own same other also may might must should would could our your his her which who whom what when where why how all any each few some".split(" "));

  /** Offline summary: scores sentences by how many of the document's key words they contain. */
  function extractive(text, count) {
    const sents = sentences(text).filter((s) => s.split(" ").length >= 6 && s.length < 400);
    if (!sents.length) return [];
    const freq = new Map();
    for (const s of sents) {
      for (const w of s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    const top = Math.max(...freq.values(), 1);
    const scored = sents.map((s, i) => {
      const ws = (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w));
      const score = ws.reduce((n, w) => n + freq.get(w) / top, 0) / Math.sqrt(ws.length + 1);
      const position = i < sents.length * 0.1 ? 1.2 : 1; // openings usually matter
      return { s, i, score: score * position };
    });
    const picked = [];
    for (const c of scored.sort((a, b) => b.score - a.score)) {
      // Skip near-duplicates.
      if (picked.some((p) => overlap(p.s, c.s) > 0.6)) continue;
      picked.push(c);
      if (picked.length >= count) break;
    }
    return picked.sort((a, b) => a.i - b.i).map((p) => p.s);
  }
  function overlap(a, b) {
    const A = new Set(a.toLowerCase().split(/\W+/)), B = new Set(b.toLowerCase().split(/\W+/));
    let n = 0;
    A.forEach((w) => { if (B.has(w)) n++; });
    return n / Math.min(A.size, B.size);
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
  }

  async function onDeviceSummary(text, length) {
    if (typeof Summarizer === "undefined") return null;
    try {
      // Only use the model when it's already on the device; never start a big download silently.
      const state = await withTimeout(Summarizer.availability(), 3000);
      if (state !== "available") return null;
      const s = await Summarizer.create({ type: "key-points", format: "plain-text", length, outputLanguage: "en", sharedContext: "A PDF document." });
      const quota = (s.inputQuota || 4000) * 3; // rough characters per token
      const chunks = [];
      for (let i = 0; i < text.length && chunks.length < 8; i += quota) chunks.push(text.slice(i, i + quota));
      const parts = [];
      for (const c of chunks) parts.push(await withTimeout(s.summarize(c), 60000));
      s.destroy && s.destroy();
      return parts.join("\n").split("\n").map((l) => l.replace(/^[\s*•-]+/, "").trim()).filter(Boolean);
    } catch (e) {
      return null;
    }
  }

  async function summaryRun(ctx) {
    const r = await PdfRender.extractText(ctx.buffers[0]);
    const text = r.pages.map((p) => p.text).join("\n");
    if (text.split(/\s+/).length < 40) throw new ClientPDF.UserError("This PDF has too little text to summarize. Run OCR PDF on scanned pages first.");
    const size = ctx.value("sumLength") || "medium";
    setProcessingLabel("Summarizing on your device...");
    let points = await onDeviceSummary(text, size);
    let engine = "Chrome's built-in AI, on your device";
    if (!points || !points.length) {
      points = extractive(text, { short: 4, medium: 7, long: 12 }[size]);
      engine = "key-sentence extraction, on your device";
    }
    return { json: { title: r.title, words: r.word_count, pages: r.page_count, points, engine } };
  }

  function summaryRender(data, box) {
    const plain = data.points.map((p) => `• ${p}`).join("\n");
    box.innerHTML = `
      <div class="ai-stat-row">
        <div class="ai-card"><div class="ai-card-val">${data.pages}</div><div class="ai-card-lbl">Pages</div></div>
        <div class="ai-card"><div class="ai-card-val">${data.words}</div><div class="ai-card-lbl">Words</div></div>
        <div class="ai-card"><div class="ai-card-val">${data.points.length}</div><div class="ai-card-lbl">Key points</div></div>
      </div>
      <ul class="ai-summary-list">${data.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
      <div class="sign-row"><button type="button" class="btn btn-xs" id="sumCopy">Copy summary</button>
        <span class="drop-hint">Made with ${escapeHtml(data.engine)}. Nothing was uploaded.</span></div>`;
    box.querySelector("#sumCopy").addEventListener("click", () => {
      navigator.clipboard.writeText(plain);
      showToast("Summary copied.", "success");
    });
  }

  // ---------- Translate ----------

  // Translate targets: English, then Indian languages (with their own script), then others.
  // Whether a pair works depends on the browser; translateOpen() marks the ones it can't do yet.
  const LANGS = [["en", "English"], ...INDIAN.map(([c, n, native]) => [c, `${n} · ${native}`]),
    ...["es", "fr", "de", "pt", "it", "nl", "ru", "ja", "ko", "zh", "ar", "tr", "vi", "pl"].map((c) => [c, LANG_NAMES[c]])];
  const NOT_YET = " (not in this browser yet)";

  async function availability(source, target) {
    try { return await withTimeout(Translator.availability({ sourceLanguage: source, targetLanguage: target }), 4000); } catch (e) { return "unavailable"; }
  }

  /** Marks the languages this browser can't translate into yet. Called when Translate PDF opens. */
  async function translateOpen(ctx) {
    if (typeof Translator === "undefined") return;
    const target = ctx.el("trTarget"), source = ctx.el("trSource");
    if (!target) return;
    await Promise.all(LANGS.filter(([c]) => c !== "en").map(async ([c]) => {
      const [into, from] = await Promise.all([availability("en", c), availability(c, "en")]);
      for (const [sel, state] of [[target, into], [source, from]]) {
        const opt = sel && sel.querySelector(`option[value="${c}"]`);
        if (opt && state === "unavailable" && !opt.textContent.endsWith(NOT_YET)) opt.textContent += NOT_YET;
      }
    }));
  }

  /** A translator for source → target, going through English when the browser has no direct pair. */
  async function makeTranslator(source, target) {
    const direct = await availability(source, target);
    if (direct !== "unavailable") return { state: direct, steps: [[source, target]] };
    if (source !== "en" && target !== "en") {
      const [a, b] = await Promise.all([availability(source, "en"), availability("en", target)]);
      if (a !== "unavailable" && b !== "unavailable") {
        return { state: a === "available" && b === "available" ? "available" : "downloadable", steps: [[source, "en"], ["en", target]] };
      }
    }
    return null;
  }

  /** Translator.create, with download progress and a clear error when the download stalls. */
  function createTranslator(source, target, ctx) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const stall = () => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new ClientPDF.UserError(
          `Couldn't download the ${langName(source === "en" ? target : source)} language pack. Check your internet connection and try again.`)), 45000);
      };
      stall();
      Translator.create({
        sourceLanguage: source, targetLanguage: target,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            stall();
            if (ctx.progress && e.loaded < 1) ctx.progress(e.loaded, `Downloading the ${langName(source === "en" ? target : source)} language pack once… ${Math.round(e.loaded * 100)}%`);
          });
        },
      }).then((t) => { clearTimeout(timer); resolve(t); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }

  async function translateRun(ctx) {
    if (typeof Translator === "undefined") {
      throw new ClientPDF.UserError("Translation runs on your device with the browser's built-in AI. Open this page in a recent Chrome on a computer to use it.");
    }
    const r = await PdfRender.extractText(ctx.buffers[0]);
    const target = ctx.value("trTarget") || "en";
    let source = ctx.value("trSource") || "auto";
    const sample = r.pages.map((p) => p.text).join("\n").slice(0, 2000);
    if (!sample.trim()) throw new ClientPDF.UserError("This PDF has no text to translate. Run OCR PDF on scanned pages first.");
    if (source === "auto") {
      let best = null;
      if (typeof LanguageDetector !== "undefined") {
        // Only use the detector when it's ready; otherwise the script tells us enough.
        try {
          if ((await withTimeout(LanguageDetector.availability(), 3000)) === "available") {
            [best] = await withTimeout((await withTimeout(LanguageDetector.create(), 5000)).detect(sample), 5000);
          }
        } catch (e) { best = null; }
      }
      source = best && best.detectedLanguage && best.detectedLanguage !== "und" ? best.detectedLanguage.split("-")[0] : detectScript(sample);
    }
    if (source === target) throw new ClientPDF.UserError(`The document is already in ${langName(target)}.`);
    const plan = await makeTranslator(source, target);
    if (!plan) {
      throw new ClientPDF.UserError(`This browser can't translate ${langName(source)} to ${langName(target)} yet. Chrome adds languages over time; ` +
        `today it handles Hindi, Bengali, Marathi, Tamil, Telugu and Kannada best. Try English as the other side.`);
    }
    setProcessingLabel(plan.state === "available" ? "Translating on your device..." : "Downloading the language pack once, then translating...");
    const translators = [];
    for (const [s, t] of plan.steps) translators.push(await createTranslator(s, t, ctx));
    const pages = [];
    try {
      for (const p of r.pages) {
        const paras = p.text.split(/\n{2,}|\n(?=[A-Z0-9•\-])/).map((s) => s.trim()).filter(Boolean);
        const out = [];
        for (const para of paras) {
          let t = para.replace(/\n/g, " ");
          for (const tr of translators) t = await tr.translate(t);
          out.push(t);
        }
        pages.push({ page: p.page, text: out.join("\n\n") });
        setProcessingLabel(`Translated page ${p.page} of ${r.page_count}...`);
      }
    } finally {
      translators.forEach((tr) => tr.destroy && tr.destroy());
    }
    return { json: { source, target, title: r.title, pages, via: plan.steps.length > 1 } };
  }

  function translateRender(data, box) {
    const text = data.pages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join("\n\n");
    box.innerHTML = `
      <p class="drop-hint">Translated from <strong>${escapeHtml(langName(data.source))}</strong> to <strong>${escapeHtml(langName(data.target))}</strong>${data.via ? " (through English)" : ""} on your device.</p>
      <textarea id="trOut" class="form-input" lang="${escapeHtml(data.target)}" dir="${data.target === "ur" || data.target === "ar" ? "rtl" : "auto"}" style="height:220px;font-size:13px;" readonly>${escapeHtml(text)}</textarea>
      <div class="sign-row">
        <button type="button" class="btn btn-xs" id="trCopy">Copy</button>
        <button type="button" class="btn btn-xs" id="trTxt">Download .txt</button>
        <button type="button" class="btn btn-xs" id="trPdf">Download as PDF</button>
      </div>`;
    box.querySelector("#trCopy").addEventListener("click", () => { navigator.clipboard.writeText(text); showToast("Copied.", "success"); });
    box.querySelector("#trTxt").addEventListener("click", () => downloadBlob(new Blob([text], { type: "text/plain" }), `translated_${data.target}.txt`));
    box.querySelector("#trPdf").addEventListener("click", () => {
      // Printing to PDF keeps every script (Hindi, Chinese...) that built-in PDF fonts can't draw.
      const w = window.open("", "_blank");
      if (!w) return showToast("Allow pop-ups to save as PDF.", "error");
      w.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(data.title)} (${escapeHtml(data.target)})</title>
        <style>body{font:12pt/1.55 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;white-space:pre-wrap}</style>
        <body lang="${escapeHtml(data.target)}" dir="${data.target === "ur" || data.target === "ar" ? "rtl" : "auto"}">${escapeHtml(text)}<script>onload=()=>print()<\/script>`);
      w.document.close();
    });
  }

  // Translate PDF's entry lives in tools.js; mark unsupported languages whenever it opens.
  document.addEventListener("DOMContentLoaded", () => {
    const tool = typeof TOOLS !== "undefined" && TOOLS.find((t) => t.id === "translate");
    if (!tool || tool.onOpen) return;
    tool.onOpen = (ctx) => { translateOpen(ctx).catch(() => {}); };
  });

  return {
    sentences, extractive, LANGS, INDIAN, detectScript, langName, translateOpen,
    audioRun, audioRender, stopAudio,
    summaryRun, summaryRender,
    translateRun, translateRender,
  };
})();
