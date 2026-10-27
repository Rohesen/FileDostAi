// FileDost AI web app shell: tool grid, tool modal, page grid, routing and downloads.
// Tool definitions live in tools.js.

const BRAND_NAME = (window.BRAND && window.BRAND.name) || "FileDost AI";
const HOME_TITLE = `${BRAND_NAME}: Free PDF, Image and File Tools That Keep Your Files Private`;
let activeTool = null;
let currentFiles = [];
let ctx = null;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector('.tab-btn[data-cat="all"]').textContent = `All Tools (${TOOLS.length})`;
  renderToolsGrid("all");
  setupSearch();
  setupCategoryTabs();
  setupDropZone();
  setupPipelineDropZone();
  setupModalEvents();
  openFromUrl();
  window.addEventListener("popstate", openFromUrl);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Fill the offline copy only after the page has been quiet for a while, never during first use.
    const saveData = navigator.connection && navigator.connection.saveData;
    if (!saveData) window.addEventListener("load", () => setTimeout(() => {
      navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage("precache")).catch(() => {});
    }, 20000));
  }
});

// ---------- Routing: every tool has its own address, e.g. /merge-pdf ----------

function openFromUrl() {
  const slug = location.pathname.replace(/^\/+|\/+$/g, "");
  const tool = TOOLS.find((t) => t.slug === slug || (t.aliases || []).includes(slug));
  if (tool) {
    if (!activeTool || activeTool.id !== tool.id) openToolModal(tool.id, { push: false });
  } else {
    if (activeTool) closeModal("universalModal", { push: false });
    if (typeof Site !== "undefined") Site.route(slug);
  }
}

function renderToolsGrid(category) {
  const grid = document.getElementById("toolsGrid");
  grid.innerHTML = "";
  const filtered = category === "all" ? TOOLS : TOOLS.filter((t) => t.category === category);

  filtered.forEach((tool) => {
    const card = document.createElement("a");
    card.className = "tool-card";
    const [c1, c2] = Icons.colors(tool.category);
    card.style.setProperty("--c1", c1);
    card.style.setProperty("--c2", c2);
    card.href = `/${tool.slug}`;
    card.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let people open tools in a new tab
      e.preventDefault();
      openToolModal(tool.id);
    });

    const local = !tool.endpoint && !tool.server;
    card.innerHTML = `
      ${typeof TileArt !== "undefined" ? TileArt.html(tool) : ""}
      <div class="card-head">
        ${Icons.tool(tool, "ti-md")}
        <h3 class="card-title">${tool.name}</h3>
      </div>
      <p class="card-desc">${tool.desc}</p>
      ${tool.keywords ? `<span class="card-keywords" hidden>${tool.keywords}</span>` : ""}
      <div class="card-footer">
        <span class="runs-on ${local ? "runs-device" : "runs-server"}" title="${local ? "Your file never leaves your device" : "Sent over HTTPS, processed, then deleted"}">
          ${local ? `${Icons.ui("lock")}On your device` : `${Icons.ui("cloud")}Server, deleted after`}
        </span>
      </div>`;
    grid.appendChild(card);
  });
  if (typeof TileArt !== "undefined") TileArt.watch(grid);
  if (typeof Feedback !== "undefined") Feedback.decorate();
}

function setupCategoryTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      renderToolsGrid(tab.dataset.cat);
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById("toolSearch");
  searchInput.addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase().trim();
    document.querySelectorAll(".tool-card").forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.style.display = text.includes(term) ? "flex" : "none";
    });
  });
}

// ---------- Tool modal ----------

function makeContext() {
  const el = (id) => document.getElementById(id);
  return {
    files: [],
    buffers: [],
    board: null,
    el,
    value: (id) => (el(id) ? el(id).value : ""),
    checked: (id) => !!(el(id) && el(id).checked),
  };
}

function openToolModal(toolId, { push = true } = {}) {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return;
  if (activeTool) teardownTool();

  activeTool = tool;
  currentFiles = [];
  ctx = makeContext();

  document.getElementById("mIcon").innerHTML = Icons.tool(tool, "ti-md");
  document.getElementById("mTitle").textContent = tool.name;
  document.getElementById("mDesc").textContent = tool.desc;
  document.getElementById("toolConfig").innerHTML = tool.configHtml || "";
  document.getElementById("selectedFilesList").innerHTML = "";
  document.getElementById("boardArea").innerHTML = "";
  document.getElementById("resultBox").style.display = "none";
  document.getElementById("processingState").style.display = "none";
  if (typeof Chains !== "undefined") Chains.hide();
  if (typeof Feedback !== "undefined") Feedback.clearRatingPrompt();
  document.querySelector("#universalModal .modal-card").classList.toggle("modal-wide", !!(tool.board || tool.wide));

  const fileInput = document.getElementById("fileInput");
  fileInput.value = "";
  fileInput.multiple = !!tool.multipleFiles;
  fileInput.accept = tool.accept;

  const local = !tool.endpoint && !tool.server;
  document.getElementById("dropHint").textContent =
    (tool.multipleFiles ? "Add as many files as you like" : "One file") +
    (local ? ". Your file stays on this device." : ". Uploaded over HTTPS, processed in memory, never stored.");
  document.getElementById("privacyNote").className = `privacy-note ${local ? "runs-device" : "runs-server"}`;
  document.getElementById("privacyNote").innerHTML = (local
    ? `${Icons.ui("lock")} This tool runs in your browser. Your file is not uploaded anywhere.`
    : `${Icons.ui("cloud")} This tool needs our server. Your file is processed in memory and deleted as soon as you get the result.`);

  const shows = tool.renderResult || ["ai-analyze", "pdf-to-text"].includes(tool.id);
  document.querySelector("#btnExecute .btn-text").textContent = tool.actionLabel || (shows ? "Run" : "Save & download");

  if (tool.onOpen) tool.onOpen(ctx);
  // PDF tools: fetch pdf.js and start the PDF worker now, while the user picks files.
  if (/pdf/.test(tool.accept || "")) {
    if (typeof PdfRender !== "undefined") PdfRender.ready().catch(() => {});
    if (!tool.endpoint && !tool.server && typeof PdfWorker !== "undefined") PdfWorker.warm();
  }
  document.getElementById("universalModal").classList.add("open");
  document.title = `${tool.name} | ${BRAND_NAME}`;
  if (push && location.pathname !== `/${tool.slug}`) history.pushState({}, "", `/${tool.slug}`);
}

function teardownTool() {
  if (ctx && ctx.board) ctx.board.destroy();
  if (activeTool && activeTool.onClose) activeTool.onClose(ctx);
}

function closeModal(modalId, { push = true } = {}) {
  document.getElementById(modalId).classList.remove("open");
  if (modalId !== "universalModal") return;
  teardownTool();
  activeTool = null;
  ctx = null;
  document.title = HOME_TITLE;
  if (push && location.pathname !== "/") history.pushState({}, "", "/");
}

function setupModalEvents() {
  const config = document.getElementById("toolConfig");
  config.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-board], button[data-action]");
    if (!b || !activeTool) return;
    if (!ctx.board) return showToast("Add a PDF first.", "error");
    if (b.dataset.board) ctx.board[b.dataset.board]();
    else activeTool.actions[b.dataset.action](ctx);
  });
  config.addEventListener("input", (e) => {
    if (activeTool && activeTool.onInput && e.target.id) activeTool.onInput(ctx, e.target.id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("universalModal").classList.contains("open")) {
      closeModal("universalModal");
    }
  });
}

function setupDropZone() {
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");

  dropZone.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleFiles(Array.from(e.target.files));
    fileInput.value = "";
  });
}

async function handleFiles(files) {
  if (!activeTool) return;
  const accepted = files.filter((f) => acceptsFile(activeTool, f));
  if (accepted.length < files.length) showToast(`This tool takes ${acceptLabel(activeTool)} only.`, "error");
  if (!accepted.length) return;
  currentFiles = activeTool.multipleFiles ? [...currentFiles, ...accepted] : [accepted[0]];
  await filesChanged();
}

// Lets tool modules (camera capture, etc.) add files as if they were dropped.
function addFilesToTool(files) {
  return handleFiles(files);
}

function acceptsFile(tool, file) {
  const name = file.name.toLowerCase();
  return tool.accept.split(",").map((a) => a.trim().toLowerCase()).some((a) => {
    if (a === "*/*") return true;
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return file.type.startsWith(a.slice(0, -1));
    return file.type === a;
  });
}

function acceptLabel(tool) {
  if (tool.acceptLabel) return tool.acceptLabel;
  if (tool.accept.includes("pdf")) return "PDF files";
  if (tool.accept.includes("image")) return "image files";
  return tool.accept.replace(/,/g, ", ");
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Running a tool waits for these, so a quick click right after adding files can't see a half-ready state:
// ctx.buffersReady once the files are read, ctx.settled once page thumbnails and onFiles are done.
function filesChanged() {
  ctx.settled = filesChangedNow();
  return ctx.settled;
}

async function filesChangedNow() {
  const tool = activeTool;
  updateSelectedFilesUI();
  ctx.files = currentFiles;
  // Tools that stream big files themselves (video) set noBuffers so a 1 GB video isn't read into memory twice.
  ctx.buffersReady = tool.noBuffers ? Promise.resolve([]) : Promise.all(currentFiles.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b))));
  ctx.buffers = await ctx.buffersReady;
  if (tool !== activeTool) return;
  try {
    if (tool.board) {
      if (ctx.board) ctx.board.destroy();
      ctx.board = null;
      const area = document.getElementById("boardArea");
      if (currentFiles.length) {
        ctx.board = await PageBoard.mount(area, {
          buffers: ctx.buffers,
          names: currentFiles.map((f) => f.name),
          mode: tool.board,
          onChange: (board) => {
            ctx.board = board;
            if (tool.onBoardChange) tool.onBoardChange(ctx);
          },
        });
      } else {
        area.innerHTML = "";
      }
    }
    if (tool.onFiles && (currentFiles.length || tool.compactFileList)) await tool.onFiles(ctx);
  } catch (err) {
    reportError(err);
  }
}

function updateSelectedFilesUI() {
  const container = document.getElementById("selectedFilesList");
  container.innerHTML = "";
  if (activeTool && activeTool.compactFileList && currentFiles.length > 1) {
    // Tools with their own thumbnail board (e.g. many images) show one summary line, not 100 rows.
    const total = currentFiles.reduce((n, f) => n + f.size, 0);
    const item = document.createElement("div");
    item.className = "file-item file-summary";
    const name = document.createElement("span");
    name.className = "file-name";
    name.innerHTML = `${Icons.ui("files")} `;
    name.append(`${currentFiles.length} files (${formatSize(total)})`);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn btn-xs file-clear";
    clear.textContent = "Clear all";
    clear.onclick = (e) => { e.stopPropagation(); currentFiles.length = 0; filesChanged(); };
    item.append(name, clear);
    container.appendChild(item);
    return;
  }
  currentFiles.forEach((file, idx) => {
    const item = document.createElement("div");
    item.className = "file-item";
    const name = document.createElement("span");
    name.className = "file-name";
    name.innerHTML = `${Icons.ui("file")} `;
    name.append(`${file.name} (${formatSize(file.size)})`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.innerHTML = "&times;";
    remove.onclick = (e) => { e.stopPropagation(); removeFile(idx); };
    item.append(name, remove);
    container.appendChild(item);
  });
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function removeFile(idx) {
  currentFiles.splice(idx, 1);
  filesChanged();
}

// ---------- Progress: a real bar with steps, from start until the file is ready ----------

const Progress = (() => {
  let shown = 0, real = 0, floor = 0, ceil = 1, started = 0, expect = 4000, timer = null, label = "";
  let steps = [], current = 0, onCancel = null, gen = 0;
  const el = (id) => document.getElementById(id);

  function begin({ steps: names, expectMs = 4000, cancel = null }) {
    steps = names; current = 0; expect = expectMs; onCancel = cancel; gen++;
    shown = real = floor = 0; ceil = 1; started = performance.now();
    el("processingState").style.display = "flex";
    el("progressCancel").hidden = !cancel;
    renderSteps();
    clearInterval(timer);
    timer = setInterval(tick, 120);
    tick();
  }

  // Each step owns a slice of the bar; inside a step the bar creeps on its own so it never
  // looks frozen, and jumps forward whenever real progress is known.
  function step(i, { from, to, expectMs } = {}) {
    current = i;
    if (from !== undefined) { floor = from; ceil = to; real = from; }
    if (expectMs) { expect = expectMs; started = performance.now(); }
    renderSteps();
  }
  function set(fraction, text) {
    if (fraction !== null && fraction !== undefined) real = floor + (ceil - floor) * Math.min(Math.max(fraction, 0), 1);
    if (text) { label = text; el("processingLabel").textContent = text; }
  }
  function setLabel(text) {
    label = text;
    el("processingLabel").textContent = text;
    const m = text.match(/(\d+) of (\d+)/);
    if (m && Number(m[2]) > 0) set((Number(m[1]) - 1) / Number(m[2]));
  }
  function tick() {
    const t = performance.now() - started;
    const creep = floor + (ceil - floor) * 0.92 * (1 - Math.exp(-t / expect));
    const target = Math.max(real, creep);
    shown += (target - shown) * 0.25;
    if (target - shown < 0.002) shown = target;
    const pct = Math.min(99, Math.floor(shown * 100));
    el("progressFill").style.width = `${shown * 100}%`;
    el("progressPct").textContent = `${pct}%`;
    const secs = Math.floor((performance.now() - started) / 1000);
    el("progressTime").textContent = secs >= 2 ? `${secs}s` : "";
  }
  function renderSteps() {
    el("progressSteps").innerHTML = steps.map((s, i) =>
      `<li class="${i < current ? "done" : i === current ? "now" : ""}"><span class="mark">${i < current ? "✓" : i === current ? "" : "○"}</span>${escapeHtml(s)}</li>`).join("");
  }
  function finish() {
    clearInterval(timer);
    current = steps.length; renderSteps();
    el("progressFill").style.width = "100%";
    el("progressPct").textContent = "100%";
    const g = gen;
    return new Promise((r) => setTimeout(() => { if (g === gen) hide(); r(); }, 250));
  }
  function hide() {
    clearInterval(timer);
    el("processingState").style.display = "none";
    onCancel = null;
  }
  function cancel() { if (onCancel) onCancel(); }
  return { begin, step, set, setLabel, finish, hide, cancel };
})();

function setProcessingLabel(text) {
  Progress.setLabel(text);
}

function reportError(err) {
  if (err && err.cancelled) return showToast("Cancelled.", "success");
  const known = err instanceof ClientPDF.UserError || err.userFacing;
  if (!known) console.error(err);
  showToast(known ? err.message : `Something went wrong: ${err.message}`, "error");
}

function cancelledError() {
  const e = new Error("Cancelled");
  e.cancelled = true;
  return e;
}

// How long the server part usually takes, so the bar moves at a believable pace.
function expectedServerMs(tool, bytes) {
  const mb = bytes / 1048576;
  if (/powerpoint|word|excel/.test(tool.id)) return 6000 + mb * 2500;
  if (tool.slow) return 5000 + mb * 4000;
  return 1200 + mb * 900;
}

let runToken = 0;

// keep: true (used by recipes) hands the result back instead of downloading it; null means it failed.
async function executeCurrentTool({ keep = false } = {}) {
  const tool = activeTool;
  if (!tool) return null;
  if (currentFiles.length === 0) {
    showToast(`Add ${acceptLabel(tool).replace(/ files$/, "")} first.`, "error");
    return null;
  }
  if (typeof Chains !== "undefined") Chains.hide();

  const btn = document.getElementById("btnExecute");
  document.getElementById("resultBox").style.display = "none";
  btn.disabled = true;
  const token = ++runToken;
  const abort = new AbortController();
  ctx.signal = abort.signal;
  const bytes = currentFiles.reduce((n, f) => n + f.size, 0);
  const cancel = () => { abort.abort(); runToken++; };

  try {
    let result;
    if (tool.run) {
      Progress.begin({ steps: ["Read your file", "Work on it on this device", "Get the download ready"], expectMs: 1500 + (bytes / 1048576) * 600, cancel });
      Progress.setLabel("Reading your file…");
      await new Promise((r) => requestAnimationFrame(() => r()));
      Progress.step(1, { from: 0.08, to: 0.92 });
      Progress.setLabel("Working on your device…");
      ctx.progress = (f, text) => { if (token === runToken) Progress.set(f, text); };
      if (ctx.buffersReady) ctx.buffers = await ctx.buffersReady;
      if (ctx.settled && !(tool.boardOptional && !ctx.board)) {
        Progress.setLabel("Getting your pages ready…");
        await ctx.settled;
        Progress.setLabel("Working on your device…");
      }
      result = await tool.run(ctx);
    } else {
      Progress.begin({ steps: ["Upload", tool.slow ? "Convert (the slowest part)" : "Process on the server", "Download the result"], expectMs: 2000, cancel });
      result = await runOnServer(tool, ctx, bytes);
    }
    if (token !== runToken) throw cancelledError();
    if (tool !== activeTool) return null;
    Progress.step(2, { from: 0.95, to: 1 });
    // The bar's last moment plays while the file is already being saved, not before it.
    const finished = Progress.finish();
    if (keep) { await finished; return result; }
    if (result.json) {
      await finished;
      const box = document.getElementById("resultBox");
      if (tool.renderResult) {
        box.style.display = "flex";
        box.innerHTML = "";
        tool.renderResult(result.json, box, ctx);
      } else {
        renderJsonResult(result.json);
      }
      showToast(result.message || "Done!", "success");
      afterSuccess(tool);
      return result;
    }
    downloadBlob(new Blob([result.bytes], { type: result.mime }), result.filename);
    showToast(result.message || `Done! Downloaded ${result.filename}${savedText(result)}.${tool.run ? " Nothing was uploaded." : ""}`, "success");
    if (typeof Chains !== "undefined") Chains.offerNext(tool, result);
    afterSuccess(tool);
    return result;
  } catch (err) {
    Progress.hide();
    if (token !== runToken || (err && err.name === "AbortError")) reportError(cancelledError());
    else reportError(err);
    return null;
  } finally {
    Progress.hide();
    btn.disabled = false;
  }
}

/**
 * Sends a form to the server with real upload and download progress, and lets the
 * person cancel. Returns { bytes, mime, headers } or { json }.
 * The upload fills the first part of the bar, the server's work the middle, the download the end.
 */
function serverRequest(url, formData, ctx, { expectMs = 3000, uploadShare = 0.25, label = "Processing on the server…", quiet = false } = {}) {
  // quiet: called from inside a browser tool that runs its own progress steps.
  const P = quiet ? { set: (f, t) => Progress.set(null, t), step: () => {}, setLabel: (t) => Progress.set(null, t) } : Progress;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "arraybuffer";
    const signal = ctx && ctx.signal;
    if (signal) {
      if (signal.aborted) return reject(cancelledError());
      signal.addEventListener("abort", () => { xhr.abort(); reject(cancelledError()); }, { once: true });
    }
    const top = 0.93;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) P.set(e.loaded / e.total, `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`);
    };
    xhr.upload.onload = () => {
      P.step(1, { from: uploadShare, to: top, expectMs });
      P.setLabel(label);
    };
    xhr.onprogress = (e) => {
      if (e.lengthComputable && e.total > 200000) {
        P.step(2, { from: top, to: 0.99 });
        P.set(e.loaded / e.total, "Downloading the result…");
      }
    };
    xhr.onerror = () => {
      const e = new Error(`Couldn't reach the server. Check that ${BRAND_NAME} is still running, then try again.`);
      e.userFacing = true;
      reject(e);
    };
    xhr.onload = () => {
      const type = xhr.getResponseHeader("content-type") || "";
      const body = new Uint8Array(xhr.response || new ArrayBuffer(0));
      const text = () => new TextDecoder().decode(body);
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `The server returned an error (${xhr.status}).`;
        try { const j = JSON.parse(text()); if (typeof j.detail === "string") detail = j.detail; } catch (e) { /* not json */ }
        const e = new Error(detail);
        e.userFacing = true;
        return reject(e);
      }
      if (type.includes("application/json")) return resolve({ json: JSON.parse(text()) });
      resolve({ bytes: body, mime: type.split(";")[0], header: (h) => xhr.getResponseHeader(h) });
    };
    P.step(0, { from: 0, to: uploadShare });
    P.setLabel("Uploading…");
    xhr.send(formData);
  });
}

async function runOnServer(tool, ctx, bytes) {
  const formData = new FormData();
  if (tool.multipleFiles) currentFiles.forEach((f) => formData.append("files", f));
  else formData.append("file", currentFiles[0]);
  const fields = tool.form ? tool.form(ctx) : {};
  for (const [k, v] of Object.entries(fields)) formData.append(k, v);

  const r = await serverRequest(tool.endpoint, formData, ctx, {
    expectMs: expectedServerMs(tool, bytes),
    uploadShare: Math.min(0.35, 0.08 + bytes / 1048576 / 40),
    label: tool.slow ? "Converting… big files can take a minute" : "Processing on the server…",
  });
  if (r.json) return r;
  const disposition = r.header("content-disposition") || "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = utf8 ? decodeURIComponent(utf8[1]) : match ? match[1] : `ultrapdf_${tool.id}.pdf`;
  const redacted = r.header("x-redacted-count");
  const repaired = r.header("x-repair-report");
  return {
    bytes: r.bytes,
    mime: r.mime,
    filename,
    message: redacted !== null
      ? `Removed ${redacted} item${redacted === "1" ? "" : "s"}. Downloaded ${filename}.`
      : repaired ? `Repaired: ${repaired}. Downloaded ${filename}.` : null,
  };
}

// "41% smaller" when a tool made the file smaller than what went in.
function savedText(result) {
  const before = currentFiles.reduce((n, f) => n + f.size, 0);
  const after = result.bytes ? result.bytes.length : 0;
  if (!before || !after || after >= before || result.mime !== "application/pdf") return "";
  return `, ${Math.round((1 - after / before) * 100)}% smaller (${formatSize(before)} → ${formatSize(after)})`;
}

// Hook for things that should happen after any successful run (ratings live in feedback.js).
function afterSuccess(tool) {
  if (typeof Feedback !== "undefined") Feedback.askForRating(tool);
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderJsonResult(data) {
  const resultBox = document.getElementById("resultBox");
  resultBox.style.display = "flex";

  if (activeTool.id === "ai-analyze") {
    const keywordsHtml = data.top_keywords.map(k => `<span class="chip">${escapeHtml(k.keyword)} (${k.frequency})</span>`).join("");
    const summaryHtml = data.executive_summary.map(s => `<li>${escapeHtml(s)}</li>`).join("");

    resultBox.innerHTML = `
      <div class="ai-stat-row">
        <div class="ai-card">
          <div class="ai-card-val">${data.page_count}</div>
          <div class="ai-card-lbl">Pages</div>
        </div>
        <div class="ai-card">
          <div class="ai-card-val">${data.word_count}</div>
          <div class="ai-card-lbl">Words</div>
        </div>
        <div class="ai-card">
          <div class="ai-card-val">${data.estimated_read_time_minutes}m</div>
          <div class="ai-card-lbl">Read Time</div>
        </div>
      </div>

      <div>
        <strong style="color:#fff; font-size:12px; text-transform:uppercase;">Complexity & Tone:</strong>
        <p style="color:var(--accent-cyan); font-size:13px; font-weight:600; margin-top:2px;">${data.readability_score}</p>
      </div>

      <div>
        <strong style="color:#fff; font-size:12px; text-transform:uppercase;">Opening Sentences:</strong>
        <ul class="ai-summary-list" style="margin-top:6px;">${summaryHtml}</ul>
      </div>

      <div>
        <strong style="color:#fff; font-size:12px; text-transform:uppercase; margin-bottom:6px; display:block;">Key Topics:</strong>
        <div class="chip-container">${keywordsHtml}</div>
      </div>
    `;
  } else if (activeTool.id === "pdf-to-text") {
    resultBox.innerHTML = `
      <div class="ai-stat-row">
        <div class="ai-card">
          <div class="ai-card-val">${data.page_count}</div>
          <div class="ai-card-lbl">Pages</div>
        </div>
        <div class="ai-card">
          <div class="ai-card-val">${data.word_count}</div>
          <div class="ai-card-lbl">Words</div>
        </div>
        <div class="ai-card">
          <div class="ai-card-val">${data.estimated_read_time_minutes} min</div>
          <div class="ai-card-lbl">Reading Time</div>
        </div>
      </div>
      <div style="margin-top:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <strong style="color:#fff; font-size:12px; text-transform:uppercase;">Extracted Markdown Preview:</strong>
          <button class="btn-xs" onclick="copyMarkdown()">Copy All</button>
        </div>
        <textarea id="mdOutput" style="width:100%; height:160px; background:rgba(0,0,0,0.5); border:1px solid var(--border-subtle); color:#e2e8f0; font-family:var(--font-mono); font-size:11px; padding:10px; border-radius:6px;" readonly>${escapeHtml(data.markdown)}</textarea>
      </div>
    `;
  }
}

function copyMarkdown() {
  const ta = document.getElementById("mdOutput");
  if (ta) {
    navigator.clipboard.writeText(ta.value);
    showToast("Copied Markdown to clipboard!", "success");
  }
}

// Pipeline Modal Handling
let pipelineFile = null;

function openPipelineModal() {
  pipelineFile = null;
  document.getElementById("pipelineFileLabel").textContent = "Drop PDF file or click to select";
  document.getElementById("pipelineProcessing").style.display = "none";
  document.getElementById("pipelineModal").classList.add("open");
}

function setupPipelineDropZone() {
  const zone = document.getElementById("pipelineDropZone");
  const inp = document.getElementById("pipelineFileInput");

  zone.addEventListener("click", () => inp.click());
  inp.addEventListener("change", (e) => {
    if (e.target.files.length) {
      pipelineFile = e.target.files[0];
      document.getElementById("pipelineFileLabel").textContent = `Selected: ${pipelineFile.name} (${(pipelineFile.size / 1024).toFixed(1)} KB)`;
    }
  });
}

function addPipelineStep(action) {
  const container = document.getElementById("pipelineStepsList");
  const count = container.children.length + 1;
  const card = document.createElement("div");
  card.className = "step-card";
  card.dataset.action = action;

  let badge = action;
  let inputHtml = "";

  if (action === "watermark") {
    badge = "Watermark";
    inputHtml = `<input type="text" class="input-sm step-arg" data-param="text" value="CONFIDENTIAL">`;
  } else if (action === "page_numbers") {
    badge = "Page Numbers";
    inputHtml = `<input type="text" class="input-sm step-arg" data-param="format" value="Page {n} of {total}">`;
  } else if (action === "rotate") {
    badge = "Rotate 90°";
    inputHtml = `
      <select class="select-sm step-arg" data-param="angle">
        <option value="90">90°</option>
        <option value="180">180°</option>
        <option value="270">270°</option>
      </select>
    `;
  } else if (action === "redact") {
    badge = "Auto-Redact";
    inputHtml = `<input type="text" class="input-sm step-arg" data-param="keywords" placeholder="Keywords (optional)">`;
  } else if (action === "compress") {
    badge = "Compress";
    inputHtml = `
      <select class="select-sm step-arg" data-param="level">
        <option value="low">Low</option>
        <option value="medium" selected>Recommended</option>
        <option value="extreme">Extreme</option>
      </select>
    `;
  }

  card.innerHTML = `
    <span class="step-num">Step ${count}</span>
    <span class="step-badge">${badge}</span>
    ${inputHtml}
    <button class="btn-remove-step" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(card);
}

async function executePipeline() {
  if (!pipelineFile) {
    showToast("Please provide a source PDF document for the pipeline.", "error");
    return;
  }

  const stepCards = document.querySelectorAll("#pipelineStepsList .step-card");
  if (stepCards.length === 0) {
    showToast("Add at least one pipeline step.", "error");
    return;
  }

  const recipe = [];
  stepCards.forEach(card => {
    const action = card.dataset.action;
    const stepObj = { action };
    const arg = card.querySelector(".step-arg");
    if (arg) {
      const param = arg.dataset.param;
      stepObj[param] = arg.value;
    }
    recipe.push(stepObj);
  });

  const spinner = document.getElementById("pipelineProcessing");
  spinner.style.display = "flex";

  const formData = new FormData();
  formData.append("file", pipelineFile);
  formData.append("recipe_json", JSON.stringify(recipe));

  try {
    const res = await fetch("/api/pipeline", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Pipeline failed" }));
      throw new Error(err.detail || "Server error");
    }

    const blob = await res.blob();
    downloadBlob(blob, `pipeline_output_${Date.now()}.pdf`);

    spinner.style.display = "none";
    showToast("Pipeline executed and downloaded successfully!", "success");
    closeModal("pipelineModal");
  } catch (err) {
    spinner.style.display = "none";
    showToast(err.message, "error");
  }
}

// Toast Notifications
function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}
