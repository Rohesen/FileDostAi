// Homepage extras: a "what do you want to do?" box with a smart drop zone (drop any file and
// it suggests the right tools), a page-wide drop target, a "Recently used" row, tool counts on
// the category tabs, and tool cards that rise in as you scroll.
// Nothing here uploads anything: suggestions come from the file's name and type only.

const HomePlus = (() => {
  const RECENT_KEY = "ultrapdf-recent";
  const POPULAR = ["merge", "compress", "img-to-pdf", "pdf-to-docx", "photo-resize"];
  // What people usually want first, by kind of file. Anything else that accepts the file follows.
  const FIRST = {
    pdf: ["compress", "merge", "split", "pdf-to-docx", "pdf-to-jpg", "sign", "edit", "compress-to-size", "organize", "ocr", "protect", "page-numbers"],
    pdfs: ["merge", "compress", "compare", "compress-any", "zip-tools"],
    image: ["img-to-pdf", "photo-resize", "image-convert", "compress-any", "exam-form-kit", "remove-bg", "image-to-text", "upscale-image", "jpg-to-word", "remove-exif", "blur-image", "watermark-image", "scan", "qr-code"],
    images: ["img-to-pdf", "image-to-text", "jpg-to-word", "remove-exif", "watermark-image", "image-convert", "scan", "compress-any", "exam-form-kit", "zip-tools"],
    heic: ["heic-to-jpg", "img-to-pdf", "photo-resize", "image-convert", "remove-bg"],
    word: ["word-to-pdf"], excel: ["excel-to-pdf"], slides: ["powerpoint-to-pdf"], text: ["markdown-to-pdf", "word-to-pdf"],
    video: ["compress-video", "video-to-mp3", "trim-media", "reels-resizer", "video-to-gif", "media-speed", "volume-booster"], audio: ["trim-media", "video-to-mp3", "audio-joiner", "volume-booster", "media-speed"],
    other: ["zip-tools", "compress-any"],
  };
  const LAST = new Set(["recipes", "compress-any", "zip-tools"]);

  const byId = (id) => TOOLS.find((t) => t.id === id);
  const esc = (s) => escapeHtml(String(s));

  function kindOf(files) {
    const f = files[0], n = f.name.toLowerCase(), many = files.length > 1;
    if (isPdf(f)) return many ? "pdfs" : "pdf";
    if (/\.(heic|heif)$/.test(n)) return "heic";
    if (/^image\//.test(f.type) || /\.(avif|bmp|svg|webp|jpe?g|png|gif|tiff?)$/.test(n)) return many ? "images" : "image";
    if (/\.(docx?|odt|rtf)$/.test(n)) return "word";
    if (/\.(xlsx?|ods|csv)$/.test(n)) return "excel";
    if (/\.(pptx?|odp)$/.test(n)) return "slides";
    if (/\.(md|markdown|html?|txt)$/.test(n)) return "text";
    if (/^video\//.test(f.type) || /\.(mp4|mov|mkv|avi|webm|3gp|m4v|wmv|flv|mpe?g|mts)$/.test(n)) return "video";
    if (/^audio\//.test(f.type) || /\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|amr|wma)$/.test(n)) return "audio";
    return "other";
  }

  /** Tools that can take these files, most likely first. */
  function suggest(files) {
    const kind = kindOf(files);
    const fits = TOOLS.filter((t) => acceptsFile(t, files[0]));
    const first = FIRST[kind].map(byId).filter((t) => t && fits.includes(t));
    const rest = fits.filter((t) => !first.includes(t) && !LAST.has(t.id));
    const last = fits.filter((t) => !first.includes(t) && LAST.has(t.id));
    return { kind, tools: [...first, ...rest, ...last] };
  }

  const fileLabel = (files) => files.length > 1 ? `${files.length} files` : files[0].name;
  const sizeLabel = (bytes) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  let pending = [];

  function chip(t, extra = "") {
    return `<button type="button" class="hp-chip ${extra}" data-open="${t.id}" style="--c1:${colors(t)[0]};--c2:${colors(t)[1]}">
      ${Icons.tool(t, "ti-sm")}<span>${esc(t.name)}</span></button>`;
  }
  const colors = (t) => (typeof TileArt !== "undefined" ? TileArt.colors(t) : ["#6366f1", "#06b6d4"]);

  async function openWith(id, files) {
    remember(id);
    openToolModal(id);
    if (files && files.length) await addFilesToTool(files);
  }

  // ---------- The hero box ----------
  function buildHero() {
    const hero = document.querySelector(".hero");
    const sub = hero && hero.querySelector(".hero-subtitle");
    if (!sub) return;
    // index.html already has an empty #hpGo holding the box's space (no layout shift on load).
    let box = document.getElementById("hpGo");
    const placed = !!box;
    if (!box) { box = document.createElement("div"); box.className = "hp-go"; box.id = "hpGo"; }
    box.innerHTML = `
      <div class="hp-ask">
        <span class="hp-ask-ico" aria-hidden="true">${Icons.ui("search")}</span>
        <input type="search" id="hpAsk" autocomplete="off" placeholder="What do you want to do? e.g. “pdf to word”" aria-label="What do you want to do?">
        <label class="hp-pick btn">${Icons.ui("folder")} Choose files<input type="file" id="hpFile" multiple hidden></label>
      </div>
      <div class="hp-drop" id="hpDrop">
        <div class="hp-drop-idle">
          or drop a file anywhere on this page <span class="hp-dot">·</span> <span class="hp-drop-note">${Icons.ui("lock")} nothing is uploaded until you pick a tool</span>
        </div>
        <div class="hp-drop-files" hidden></div>
      </div>
      <div class="hp-popular" id="hpPopular">
        <span class="hp-label">Popular:</span>
        ${POPULAR.map(byId).filter(Boolean).map((t) => chip(t, "hp-chip-sm")).join("")}
      </div>`;
    if (!placed) sub.after(box);

    const ask = box.querySelector("#hpAsk");
    const popular = box.querySelector("#hpPopular");
    ask.addEventListener("input", () => {
      const q = ask.value.trim();
      if (!q) { showPopular(); return; }
      const { hits, close } = Site.rank(q, 6);
      popular.innerHTML = hits.length
        ? `<span class="hp-label">${close ? "Closest:" : "Best match:"}</span>${hits.map(([, t]) => chip(t, "hp-chip-sm")).join("")}`
        : `<span class="hp-label">No tool for that yet.</span> <a href="#" class="hp-ask-for">Ask for it</a>`;
      const askFor = popular.querySelector(".hp-ask-for");
      if (askFor) askFor.addEventListener("click", (e) => { e.preventDefault(); Feedback.openForm("request"); });
    });
    ask.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = popular.querySelector("[data-open]");
      if (first) { e.preventDefault(); first.click(); }
    });
    function showPopular() {
      popular.innerHTML = `<span class="hp-label">Popular:</span>${POPULAR.map(byId).filter(Boolean).map((t) => chip(t, "hp-chip-sm")).join("")}`;
    }

    box.querySelector("#hpFile").addEventListener("change", (e) => {
      if (e.target.files.length) showFiles([...e.target.files]);
      e.target.value = "";
    });
    const drop = box.querySelector("#hpDrop");
    drop.addEventListener("click", (e) => { if (!e.target.closest("button, a")) box.querySelector("#hpFile").click(); });
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-open]");
      if (!b) return;
      e.preventDefault();
      openWith(b.dataset.open, b.closest(".hp-drop") ? pending : null);
    });
  }

  function showFiles(files) {
    pending = files;
    const drop = document.getElementById("hpDrop");
    if (!drop) return;
    const { tools } = suggest(files);
    const total = files.reduce((n, f) => n + f.size, 0);
    const list = drop.querySelector(".hp-drop-files");
    drop.querySelector(".hp-drop-idle").hidden = true;
    list.hidden = false;
    drop.classList.add("has-files");
    list.innerHTML = `
      <div class="hp-file-head">
        <span class="hp-file-name">${Icons.ui(files.length > 1 ? "files" : "file")} <b>${esc(fileLabel(files))}</b> <small>${sizeLabel(total)}</small></span>
        <button type="button" class="hp-clear" aria-label="Clear">${Icons.ui("close")}</button>
      </div>
      ${tools.length
        ? `<p class="hp-file-q">What would you like to do with ${files.length > 1 ? "them" : "it"}?</p>
           <div class="hp-file-tools">${tools.slice(0, 8).map((t, i) => chip(t, i === 0 ? "hp-chip-top" : "")).join("")}</div>
           ${tools.length > 8 ? `<select class="form-select hp-more" aria-label="More tools"><option value="">${tools.length - 8} more tools…</option>${tools.slice(8).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>` : ""}`
        : `<p class="hp-file-q">No tool takes this kind of file yet.</p>`}`;
    list.querySelector(".hp-clear").addEventListener("click", (e) => { e.stopPropagation(); reset(); });
    const more = list.querySelector(".hp-more");
    if (more) {
      more.addEventListener("click", (e) => e.stopPropagation());
      more.addEventListener("change", () => more.value && openWith(more.value, pending));
    }
    document.getElementById("hpGo").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function reset() {
    pending = [];
    const drop = document.getElementById("hpDrop");
    drop.classList.remove("has-files");
    drop.querySelector(".hp-drop-idle").hidden = false;
    drop.querySelector(".hp-drop-files").hidden = true;
  }

  // ---------- Drop anywhere on the page ----------
  function setupPageDrop() {
    const veil = document.createElement("div");
    veil.className = "hp-veil";
    veil.innerHTML = `<div class="hp-veil-card"><div class="hp-veil-ico">${Icons.ui("upload")}</div><b>Drop to find the right tool</b><span>Nothing is uploaded yet.</span></div>`;
    document.body.append(veil);
    let depth = 0;
    const busy = () => document.querySelector(".modal.open, .modal-overlay.open, #universalModal.open, #infoModal.open");
    const hasFiles = (e) => [...(e.dataTransfer && e.dataTransfer.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e) || busy()) return;
      depth++;
      veil.classList.add("on");
    });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; veil.classList.remove("on"); } });
    window.addEventListener("dragover", (e) => { if (hasFiles(e) && !busy()) e.preventDefault(); });
    window.addEventListener("drop", (e) => {
      depth = 0;
      veil.classList.remove("on");
      if (!hasFiles(e) || busy()) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      if (files.length) showFiles(files);
    });
  }

  // ---------- Recently used ----------
  function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; } }
  function remember(id) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 6))); } catch (e) { /* private mode */ }
  }
  function buildRecent() {
    const tabs = document.getElementById("categoryTabs");
    if (!tabs) return;
    let row = document.getElementById("hpRecent");
    const tools = recent().map(byId).filter(Boolean);
    if (!tools.length) { if (row) row.remove(); return; }
    if (!row) {
      row = document.createElement("div");
      row.id = "hpRecent";
      row.className = "hp-recent";
      tabs.before(row);
      row.addEventListener("click", (e) => {
        const b = e.target.closest("[data-open]");
        if (b) openWith(b.dataset.open);
        if (e.target.closest(".hp-recent-clear")) { try { localStorage.removeItem(RECENT_KEY); } catch (err) { /* ignore */ } row.remove(); }
      });
    }
    row.innerHTML = `<span class="hp-label">${Icons.ui("clock")} Recently used</span>${tools.map((t) => chip(t, "hp-chip-sm")).join("")}<button type="button" class="hp-recent-clear" title="Forget recently used tools">Clear</button>`;
  }

  // ---------- Tabs and cards ----------
  function countTabs() {
    document.querySelectorAll("#categoryTabs .tab-btn").forEach((b) => {
      const cat = b.dataset.cat;
      const n = cat === "all" ? TOOLS.length : TOOLS.filter((t) => t.category === cat).length;
      if (!b.querySelector(".hp-count") && !/\d/.test(b.textContent)) b.insertAdjacentHTML("beforeend", ` <span class="hp-count">${n}</span>`);
    });
  }

  // Cards rise in as they scroll into view, a few at a time.
  function setupReveal() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const grid = document.getElementById("toolsGrid");
    if (!grid || reduced || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
      let i = 0;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.style.setProperty("--d", `${Math.min(i++, 6) * 50}ms`);
        const card = en.target;
        card.classList.add("hp-in");
        io.unobserve(card);
        // Hand the card back to its normal hover and tilt styles once it has landed.
        setTimeout(() => card.classList.remove("hp-rise", "hp-in"), 1100);
      }
    }, { rootMargin: "0px 0px -40px 0px" });
    const watch = () => grid.querySelectorAll(".tool-card:not([data-hp-seen])").forEach((c) => { c.dataset.hpSeen = "1"; c.classList.add("hp-rise"); io.observe(c); });
    new MutationObserver(watch).observe(grid, { childList: true });
    watch();
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Record every tool someone opens, however they got there (cards, menus, search, links).
    const open = window.openToolModal;
    window.openToolModal = function (id, opts) {
      remember(id);
      return open.call(this, id, opts);
    };
    buildHero();
    setupPageDrop();
    countTabs();
    setupReveal();
    buildRecent();
    // Refresh "Recently used" whenever a tool closes and the homepage shows again.
    const modal = document.getElementById("universalModal");
    if (modal) new MutationObserver(() => { if (!modal.classList.contains("open")) buildRecent(); }).observe(modal, { attributes: true, attributeFilter: ["class"] });
  });

  return { suggest, showFiles, kindOf };
})();
