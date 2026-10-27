// ZIP tools: pack any files into one ZIP, or open a ZIP (also RAR, 7z, TAR and GZ) to see what's
// inside, download single files or everything, and open ZIPs that sit inside other ZIPs.
// Runs in the browser. ZIPs use JSZip (already on the page); RAR, 7z and TAR use libarchive.js
// (MIT, WebAssembly, about 1 MB), loaded only when such a file is opened.

const ZipTool = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const size = (n) => (n < 1024 ? `${n} B` : typeof formatSize === "function" ? formatSize(n) : `${(n / 1024).toFixed(1)} KB`);

  if (!document.querySelector("link[data-zt-css]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/zip-tool.css?v=34" });
    link.dataset.ztCss = "1";
    document.head.append(link);
  }

  // ---------- What kind of archive is this? (by its first bytes, not its name) ----------

  function sniff(bytes, name = "") {
    const b = bytes, s = (i, str) => [...str].every((ch, k) => b[i + k] === ch.charCodeAt(0));
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return "zip";
    if (s(0, "Rar!")) return "rar";
    if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return "7z";
    if (b.length > 262 && s(257, "ustar")) return "tar";
    if (b[0] === 0x1f && b[1] === 0x8b) return /\.(tgz|tar\.gz)$/i.test(name) ? "tgz" : "gz";
    if (s(0, "BZh")) return "bz2";
    if (b[0] === 0xfd && s(1, "7zXZ")) return "xz";
    if (s(0, "MSCF")) return "cab";
    return null;
  }
  const LABEL = { zip: "ZIP", rar: "RAR", "7z": "7-Zip", tar: "TAR", tgz: "TAR.GZ", gz: "GZ", bz2: "BZ2", xz: "XZ", cab: "CAB" };

  // ---------- Readers: each returns { kind, entries: [{ path, size, csize?, date?, get() }], encrypted? } ----------

  async function readZip(bytes) {
    let zip;
    try {
      zip = await JSZip.loadAsync(bytes, { createFolders: false });
    } catch (e) {
      if (/encrypt/i.test(e.message || "")) { const err = UserError("This ZIP is locked with a password."); err.encrypted = true; throw err; }
      throw UserError("This ZIP looks damaged and can't be opened.");
    }
    const entries = [];
    zip.forEach((path, f) => {
      if (f.dir) return;
      const d = f._data || {};
      entries.push({ path, size: d.uncompressedSize || 0, csize: d.compressedSize, date: f.date, get: () => f.async("uint8array") });
    });
    return { kind: "zip", entries };
  }

  let libLoader = null;
  function loadLibarchive() {
    if (!libLoader) {
      if (!Promise.withResolvers) {
        Promise.withResolvers = function () {
          let resolve, reject;
          const promise = new this((a, b) => { resolve = a; reject = b; });
          return { promise, resolve, reject };
        };
      }
      libLoader = import("/static/vendor/libarchive/libarchive.js?v=13").then((m) => {
        m.Archive.init({ workerUrl: "/static/vendor/libarchive/worker-bundle.js?v=13" });
        return m.Archive;
      }).catch(() => {
        libLoader = null;
        throw UserError("Couldn't load the RAR / 7-Zip reader. Check your connection, or try a newer browser.");
      });
    }
    return libLoader;
  }

  async function readLibarchive(bytes, name, kind, password) {
    const Archive = await loadLibarchive();
    const file = new File([bytes], name || "archive");
    let archive;
    try {
      archive = await Archive.open(file);
    } catch (e) {
      throw UserError(`This ${LABEL[kind] || ""} file couldn't be opened. It may be damaged.`);
    }
    let encrypted = null;
    try { encrypted = await archive.hasEncryptedData(); } catch (e) { /* unknown */ }
    if (password) await archive.usePassword(password);
    let list;
    try {
      list = await archive.getFilesArray();
    } catch (e) {
      archive.close();
      if (encrypted) { const err = UserError("This archive is locked with a password."); err.encrypted = true; throw err; }
      throw UserError(`This ${LABEL[kind] || ""} file couldn't be read. It may be damaged, or use a feature the reader doesn't support.`);
    }
    if (encrypted && !password) {
      archive.close();
      const err = UserError("This archive is locked with a password.");
      err.encrypted = true;
      throw err;
    }
    let queue = Promise.resolve();
    const entries = list.map(({ file: cf, path }) => ({
      path: `${path || ""}${cf.name}`,
      size: cf.size,
      date: cf.lastModified ? new Date(cf.lastModified / 1e6) : null,
      // The reader works one file at a time.
      get: () => {
        const p = queue.then(async () => {
          let f;
          try { f = await cf.extract(); } catch (e) { throw UserError(password ? "Wrong password, or the archive is damaged." : `Couldn't take ${cf.name} out of the archive.`); }
          return new Uint8Array(await f.arrayBuffer());
        });
        queue = p.catch(() => {});
        return p;
      },
    }));
    return { kind, entries, close: () => archive.close() };
  }

  async function readGz(bytes, name) {
    if (typeof DecompressionStream === "undefined") throw UserError("This browser can't open .gz files. Try Chrome, Edge, Firefox or Safari 16.4 or newer.");
    let out;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      out = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw UserError("This .gz file looks damaged.");
    }
    const inner = (name || "file.gz").replace(/\.gz$/i, "") || "file";
    // A .gz that holds a TAR is a folder of files.
    if (sniff(out, inner) === "tar") return readArchive(out, inner + ".tar");
    return { kind: "gz", entries: [{ path: inner, size: out.length, get: async () => out }] };
  }

  async function readArchive(bytes, name, password) {
    const kind = sniff(bytes, name);
    if (!kind) return null;
    if (kind === "zip" && !password) return readZip(bytes);
    if (kind === "gz") return readGz(bytes, name);
    if (kind === "bz2" || kind === "xz") {
      if (/\.(tbz2?|txz|tar\.(bz2|xz))$/i.test(name)) return readLibarchive(bytes, name, "tar", password);
      throw UserError(`Single .${kind} files can't be opened here yet. .zip, .rar, .7z, .tar and .gz work.`);
    }
    return readLibarchive(bytes, name, kind, password);
  }

  const isNestedZip = (path) => /\.zip$/i.test(path);
  const isNestedArchive = (path) => /\.(zip|rar|7z|tar|tgz|gz)$/i.test(path) && !/\.(tar\.gz)$/i.test(path.replace(/\.tgz$/i, ""));

  // ---------- Making a ZIP ----------

  function uniquePath(path, taken) {
    if (!taken.has(path.toLowerCase())) { taken.add(path.toLowerCase()); return path; }
    const m = path.match(/^(.*?)(\.[^./]*)?$/);
    for (let n = 2; ; n++) {
      const p = `${m[1]} (${n})${m[2] || ""}`;
      if (!taken.has(p.toLowerCase())) { taken.add(p.toLowerCase()); return p; }
    }
  }

  async function makeZip(files, buffers, { level = 6, keepFolders = true, onProgress } = {}) {
    if (!files.length) throw UserError("Add the files you want in the ZIP.");
    const zip = new JSZip();
    const taken = new Set();
    let total = 0;
    files.forEach((f, i) => {
      const rel = keepFolders && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      const path = uniquePath(rel.replace(/^\/+/, ""), taken);
      zip.file(path, buffers[i], { date: f.lastModified ? new Date(f.lastModified) : new Date(), binary: true });
      total += f.size;
    });
    const store = Number(level) === 0;
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: store ? "STORE" : "DEFLATE",
      compressionOptions: store ? undefined : { level: Number(level) },
      platform: "DOS",
    }, (meta) => onProgress && onProgress(meta.percent / 100, meta.currentFile ? `Packing ${meta.currentFile}` : "Packing…"));
    return { bytes, total };
  }

  // ---------- UI ----------

  const configHtml = `
    <div class="zt" id="ztRoot">
      <div class="zt-modes" role="tablist">
        <button type="button" role="tab" class="zt-mode" data-mode="make" aria-selected="true">Make a ZIP</button>
        <button type="button" role="tab" class="zt-mode" data-mode="open" aria-selected="false">Open a ZIP / RAR / 7z</button>
      </div>
      <section class="zt-make" id="ztMake">
        <div class="zt-row">
          <button type="button" class="btn btn-xs" id="ztFolder">${Icons.ui("folder")} Add a whole folder</button>
          <input type="file" id="ztFolderInput" webkitdirectory multiple hidden>
          <span class="drop-hint">Any files: photos, PDFs, documents, videos.</span>
        </div>
        <div class="grid-2">
          <div class="form-group"><label class="form-label" for="ztName">ZIP name</label><input type="text" id="ztName" class="form-input" placeholder="files" maxlength="80" autocomplete="off"></div>
          <div class="form-group"><label class="form-label" for="ztLevel">Compression</label>
            <select id="ztLevel" class="form-select">
              <option value="0">None (fastest; photos and videos are already compressed)</option>
              <option value="1">Fast</option>
              <option value="6" selected>Normal</option>
              <option value="9">Maximum (smallest, slower)</option>
            </select></div>
        </div>
        <label class="checkbox-group" id="ztKeepWrap" hidden><input type="checkbox" id="ztKeep" checked> Keep the folder structure</label>
        <p class="zt-sum" id="ztMakeSum"></p>
      </section>
      <section class="zt-open" id="ztOpen" hidden>
        <p class="drop-hint" id="ztOpenHint">Add a .zip, .rar, .7z, .tar or .gz file above to see what's inside. Nothing is uploaded.</p>
        <div class="zt-pass" id="ztPass" hidden>
          <label class="form-label" for="ztPassword">Password</label>
          <div class="zt-row"><input type="password" id="ztPassword" class="form-input" autocomplete="off"><button type="button" class="btn btn-primary btn-xs" id="ztPassGo">Open</button></div>
        </div>
        <div class="zt-view" id="ztView" hidden>
          <div class="zt-bar">
            <span class="zt-sum" id="ztOpenSum"></span>
            <span class="zt-bar-btns">
              <button type="button" class="btn btn-xs" id="ztExpand">Open folders</button>
              <button type="button" class="btn btn-xs" id="ztSaveFolder" hidden>${Icons.ui("save")} Save all to a folder…</button>
              <button type="button" class="btn btn-xs" id="ztEach">${Icons.ui("download")} Download each file</button>
            </span>
          </div>
          <label class="checkbox-group"><input type="checkbox" id="ztNested" checked> Open ZIP files that are inside this ZIP</label>
          <div class="zt-tree" id="ztTree" role="tree"></div>
        </div>
      </section>
    </div>`;

  function create(root, tool) {
    const $ = (id) => root.querySelector(`#${id}`);
    let mode = "make";
    let tree = null;        // { name, kind, entries, children? } of the opened archive
    let readers = [];       // things to close
    let loadToken = 0;
    const exec = document.getElementById("btnExecute");
    const execText = () => exec && exec.querySelector(".btn-text");

    function setMode(m, { keepFiles = false } = {}) {
      if (m === mode && !keepFiles) return;
      mode = m;
      root.querySelectorAll(".zt-mode").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
      $("ztMake").hidden = m !== "make";
      $("ztOpen").hidden = m !== "open";
      tool.multipleFiles = m === "make";
      tool.accept = "*/*";
      const input = document.getElementById("fileInput");
      if (input) input.multiple = m === "make";
      const hint = document.getElementById("dropHint");
      if (hint) hint.textContent = m === "make" ? "Add as many files as you like. Your files stay on this device." : "One .zip, .rar, .7z, .tar or .gz file. It stays on this device.";
      if (execText()) execText().textContent = m === "make" ? "Make ZIP" : "Download all as one ZIP";
      if (!keepFiles && typeof currentFiles !== "undefined" && currentFiles.length) {
        currentFiles.length = 0;
        filesChanged();
      }
      if (m === "make") clearOpen();
      updateMakeSummary([]);
    }

    function updateMakeSummary(files) {
      const sum = $("ztMakeSum");
      if (!files.length) { sum.textContent = ""; $("ztKeepWrap").hidden = true; return; }
      const total = files.reduce((n, f) => n + f.size, 0);
      sum.textContent = `${files.length} file${files.length === 1 ? "" : "s"}, ${size(total)} in total.`;
      $("ztKeepWrap").hidden = !files.some((f) => f.webkitRelativePath);
    }

    function clearOpen() {
      loadToken++;
      readers.forEach((r) => { try { r.close && r.close(); } catch (e) { /* closed */ } });
      readers = [];
      tree = null;
      $("ztView").hidden = true;
      $("ztPass").hidden = true;
      $("ztTree").innerHTML = "";
      $("ztOpenHint").hidden = false;
      $("ztOpenHint").textContent = "Add a .zip, .rar, .7z, .tar or .gz file above to see what's inside. Nothing is uploaded.";
    }

    // ----- Open mode -----

    async function open(file, bytes, password) {
      clearOpen();
      const my = loadToken;
      $("ztOpenHint").textContent = `Opening ${file.name}…`;
      let res;
      try {
        res = await readArchive(bytes, file.name, password);
      } catch (e) {
        if (my !== loadToken) return;
        if (e.encrypted) {
          $("ztOpenHint").textContent = password ? "That password didn't work. Try again." : `${file.name} is locked with a password. Type it to open the files.`;
          $("ztPass").hidden = false;
          $("ztPassword").value = "";
          $("ztPassword").focus();
          $("ztPassGo").onclick = () => { const pw = $("ztPassword").value; if (pw) open(file, bytes, pw); };
          $("ztPassword").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("ztPassGo").click(); } };
          return;
        }
        $("ztOpenHint").textContent = e.message;
        throw e;
      }
      if (my !== loadToken) return;
      if (!res) {
        $("ztOpenHint").innerHTML = `<strong>${esc(file.name)}</strong> isn't a ZIP, RAR, 7z, TAR or GZ archive. To pack files into a new ZIP, <button type="button" class="zt-link" id="ztToMake">use Make a ZIP</button>.`;
        $("ztToMake").onclick = () => { setMode("make", { keepFiles: true }); tool.multipleFiles = true; filesChanged(); };
        return;
      }
      if (res.close) readers.push(res);
      if (password && res.entries.length) {
        // Check the password by taking out the first file.
        try { await res.entries[0].get(); } catch (e) {
          $("ztOpenHint").textContent = "That password didn't work. Try again.";
          $("ztPass").hidden = false;
          return;
        }
      }
      tree = { name: file.name, kind: res.kind, entries: res.entries, nested: new Map() };
      $("ztPass").hidden = true;
      $("ztOpenHint").hidden = true;
      $("ztView").hidden = false;
      $("ztSaveFolder").hidden = typeof window.showDirectoryPicker !== "function";
      $("ztNested").closest("label").hidden = !res.entries.some((e) => isNestedZip(e.path));
      if ($("ztNested").checked) await openNested(tree, 1);
      if (my !== loadToken) return;
      render();
    }

    /** Opens ZIPs inside the archive (up to 3 levels, 200 MB each) so their files show in the tree too. */
    async function openNested(node, depth) {
      if (depth > 3) return;
      for (const e of node.entries) {
        if (!isNestedZip(e.path) || node.nested.has(e.path) || e.size > 200 * 1048576) continue;
        try {
          const bytes = await e.get();
          if (sniff(bytes, e.path) !== "zip") continue;
          const res = await readZip(bytes);
          const child = { name: e.path.split("/").pop(), kind: "zip", entries: res.entries, nested: new Map() };
          node.nested.set(e.path, child);
          await openNested(child, depth + 1);
        } catch (err) { /* locked or damaged inner zip: leave it as a file */ }
      }
    }
    async function openOne(node, path) {
      const e = node.entries.find((x) => x.path === path);
      if (!e) return;
      const bytes = await e.get();
      const res = await readArchive(bytes, path);
      if (!res) throw UserError(`${path.split("/").pop()} isn't an archive.`);
      if (res.close) readers.push(res);
      node.nested.set(path, { name: path.split("/").pop(), kind: res.kind, entries: res.entries, nested: new Map() });
    }

    function count(node) {
      let files = 0, bytes = 0;
      for (const e of node.entries) {
        const inner = node.nested.get(e.path);
        if (inner) { const c = count(inner); files += c.files; bytes += c.bytes; } else { files++; bytes += e.size; }
      }
      return { files, bytes };
    }

    // Folder tree from flat paths: { dirs: Map(name -> dir), files: [entry] }
    function buildDirs(entries) {
      const rootDir = { dirs: new Map(), files: [] };
      for (const e of entries) {
        const parts = e.path.split("/").filter(Boolean);
        let d = rootDir;
        for (const part of parts.slice(0, -1)) {
          if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] });
          d = d.dirs.get(part);
        }
        d.files.push({ ...e, name: parts[parts.length - 1] || e.path });
      }
      return rootDir;
    }
    const dirSize = (d) => d.files.reduce((n, f) => n + f.size, 0) + [...d.dirs.values()].reduce((n, x) => n + dirSize(x), 0);
    const dirCount = (d) => d.files.length + [...d.dirs.values()].reduce((n, x) => n + dirCount(x), 0);

    let idSeq = 0;
    const handles = new Map(); // row id -> { node, entry }
    function renderNode(node, depth) {
      const dirs = buildDirs(node.entries);
      return renderDir(node, dirs, depth);
    }
    function renderDir(node, d, depth) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const dirNames = [...d.dirs.keys()].sort(collator.compare);
      const files = [...d.files].sort((a, b) => collator.compare(a.name, b.name));
      let html = "";
      for (const name of dirNames) {
        const sub = d.dirs.get(name);
        const open = depth < 1 || dirCount(sub) <= 12;
        html += `<details class="zt-dir"${open ? " open" : ""}><summary><span class="zt-ico">${Icons.ui("folder")}</span><span class="zt-name">${esc(name)}</span><span class="zt-size">${dirCount(sub)} item${dirCount(sub) === 1 ? "" : "s"} · ${size(dirSize(sub))}</span></summary>
          <div class="zt-kids">${renderDir(node, sub, depth + 1)}</div></details>`;
      }
      for (const f of files) {
        const id = `z${idSeq++}`;
        handles.set(id, { node, entry: f });
        const inner = node.nested.get(f.path);
        if (inner) {
          html += `<details class="zt-dir zt-arc" open><summary><span class="zt-ico">${Icons.ui("archive")}</span><span class="zt-name">${esc(f.name)}</span><span class="zt-size">${count(inner).files} files inside · ${size(f.size)}</span>
            <button type="button" class="btn btn-xs zt-dl" data-dl="${id}" title="Download ${esc(f.name)}">${Icons.ui("download")}</button></summary>
            <div class="zt-kids">${renderNode(inner, depth + 1)}</div></details>`;
          continue;
        }
        const canOpen = isNestedArchive(f.path);
        const ratio = f.csize && f.size ? ` · ${Math.max(0, Math.round((1 - f.csize / f.size) * 100))}% packed` : "";
        html += `<div class="zt-file" role="treeitem"><span class="zt-ico">${Icons.ui(icon(f.name))}</span><span class="zt-name" title="${esc(f.path)}">${esc(f.name)}</span>
          <span class="zt-size">${size(f.size)}${ratio}</span>
          ${canOpen ? `<button type="button" class="btn btn-xs" data-open="${id}">Open</button>` : ""}
          <button type="button" class="btn btn-xs zt-dl" data-dl="${id}" title="Download ${esc(f.name)}" aria-label="Download ${esc(f.name)}">${Icons.ui("download")}</button></div>`;
      }
      return html;
    }
    function icon(name) {
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (/^(jpe?g|png|gif|webp|heic|bmp|svg|avif)$/.test(ext)) return "image";
      if (ext === "pdf") return "file";
      if (/^(docx?|odt|rtf|txt|md)$/.test(ext)) return "file";
      if (/^(xlsx?|csv|ods)$/.test(ext)) return "table";
      if (/^(pptx?|odp)$/.test(ext)) return "video";
      if (/^(mp4|mov|mkv|avi|webm)$/.test(ext)) return "video";
      if (/^(mp3|wav|m4a|aac|ogg|flac)$/.test(ext)) return "music";
      if (/^(zip|rar|7z|tar|gz|tgz)$/.test(ext)) return "archive";
      return "file";
    }

    function render() {
      if (!tree) return;
      handles.clear();
      idSeq = 0;
      const c = count(tree);
      $("ztOpenSum").textContent = `${LABEL[tree.kind] || ""} · ${c.files} file${c.files === 1 ? "" : "s"} · ${size(c.bytes)} unpacked`;
      $("ztTree").innerHTML = tree.entries.length ? renderNode(tree, 0) : `<p class="drop-hint">This archive is empty.</p>`;
      const each = $("ztEach");
      each.hidden = c.files > 40 || c.files < 1;
      $("ztExpand").hidden = !$("ztTree").querySelector("details:not([open])");
    }

    /** Every file, with nested archives opened as folders: [{ path, get }]. */
    function flatten(node, prefix = "") {
      const out = [];
      for (const e of node.entries) {
        const inner = node.nested.get(e.path);
        if (inner) out.push(...flatten(inner, prefix + e.path.replace(/\.[^./]+$/, "") + "/"));
        else out.push({ path: prefix + e.path, size: e.size, date: e.date, get: e.get });
      }
      return out;
    }

    async function downloadEntry(id) {
      const h = handles.get(id);
      if (!h) return;
      try {
        const bytes = await h.entry.get();
        downloadBlob(new Blob([bytes]), h.entry.name);
      } catch (e) { reportError(e); }
    }

    async function saveToFolder() {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch (e) { return; }
      const files = flatten(tree);
      let done = 0;
      try {
        for (const f of files) {
          const parts = f.path.split("/").filter((p) => p && p !== "." && p !== "..");
          let d = dir;
          for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
          const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
          const w = await fh.createWritable();
          await w.write(await f.get());
          await w.close();
          done++;
        }
        showToast(`Saved ${done} file${done === 1 ? "" : "s"} into the folder ${dir.name}.`, "success");
      } catch (e) {
        reportError(e.name === "NotAllowedError" ? UserError("The browser didn't allow saving into that folder.") : e);
      }
    }

    async function downloadEach() {
      const files = flatten(tree);
      if (files.length > 40) return showToast("That's a lot of files. Use “Download all as one ZIP” instead.", "error");
      for (const f of files) {
        try {
          downloadBlob(new Blob([await f.get()]), f.path.split("/").pop());
        } catch (e) { reportError(e); return; }
        await new Promise((r) => setTimeout(r, 350)); // browsers drop downloads fired all at once
      }
    }

    root.addEventListener("click", async (e) => {
      const m = e.target.closest(".zt-mode");
      if (m) return setMode(m.dataset.mode);
      const dl = e.target.closest("[data-dl]");
      if (dl) { e.preventDefault(); e.stopPropagation(); return downloadEntry(dl.dataset.dl); }
      const op = e.target.closest("[data-open]");
      if (op) {
        const h = handles.get(op.dataset.open);
        op.disabled = true;
        op.textContent = "Opening…";
        try { await openOne(h.node, h.entry.path); render(); } catch (err) { op.disabled = false; op.textContent = "Open"; reportError(err); }
      }
    });
    $("ztFolder").onclick = () => $("ztFolderInput").click();
    $("ztFolderInput").onchange = (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) addFilesToTool(files);
    };
    $("ztExpand").onclick = () => { $("ztTree").querySelectorAll("details").forEach((d) => { d.open = true; }); $("ztExpand").hidden = true; };
    $("ztSaveFolder").onclick = saveToFolder;
    $("ztEach").onclick = downloadEach;
    $("ztNested").onchange = async () => {
      if (!tree) return;
      if ($("ztNested").checked) await openNested(tree, 1);
      else tree.nested.clear();
      render();
    };

    const path = location.pathname;
    setMode(/unzip|extract|open|rar|7z/.test(path) ? "open" : "make", { keepFiles: true });

    return {
      mode: () => mode,
      setMode,
      async onFiles(files, buffers) {
        if (mode === "make") return updateMakeSummary(files);
        if (!files.length) return clearOpen();
        await open(files[0], buffers[0]);
      },
      tree: () => tree,
      flatten: () => (tree ? flatten(tree) : []),
      name: () => ($("ztName").value || "").trim().replace(/\.zip$/i, "").replace(/[\\/:*?"<>|]+/g, "_"),
      level: () => Number($("ztLevel").value),
      keepFolders: () => $("ztKeep").checked,
      destroy() {
        clearOpen();
        tool.multipleFiles = true;
        if (execText()) execText().textContent = tool.actionLabel;
      },
    };
  }

  async function run(ctx) {
    const ui = ctx.zip;
    if (ui.mode() === "make") {
      const { bytes, total } = await makeZip(ctx.files, ctx.buffers, { level: ui.level(), keepFolders: ui.keepFolders(), onProgress: ctx.progress });
      let name = ui.name();
      if (!name) {
        const dirs = new Set(ctx.files.map((f) => (f.webkitRelativePath || "").split("/")[0]).filter(Boolean));
        name = dirs.size === 1 ? [...dirs][0] : ctx.files.length === 1 ? ctx.files[0].name.replace(/\.[^.]+$/, "") : "files";
      }
      const filename = `${name}.zip`;
      return {
        bytes, filename, mime: "application/zip",
        message: `Done! Downloaded ${filename}: ${ctx.files.length} file${ctx.files.length === 1 ? "" : "s"}, ${size(total)} → ${size(bytes.length)}. Nothing was uploaded.`,
      };
    }
    // Open mode: everything (with inner ZIPs opened as folders) in one fresh ZIP. Turns RAR / 7z into ZIP too.
    const tree = ui.tree();
    if (!tree) throw UserError("Add a ZIP, RAR, 7z, TAR or GZ file first, and wait for its list of files.");
    const files = ui.flatten();
    if (!files.length) throw UserError("This archive has no files in it.");
    const zip = new JSZip();
    const taken = new Set();
    for (let i = 0; i < files.length; i++) {
      ctx.progress(i / files.length * 0.6, `Unpacking ${i + 1} of ${files.length}`);
      const f = files[i];
      zip.file(uniquePath(f.path, taken), await f.get(), { date: f.date || new Date(), binary: true });
    }
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" },
      (meta) => ctx.progress(0.6 + meta.percent / 250, "Packing the ZIP…"));
    const base = tree.name.replace(/\.(zip|rar|7z|tar|tgz|tar\.gz|gz)$/i, "");
    const filename = tree.kind === "zip" ? `${base}_all_files.zip` : `${base}.zip`;
    return { bytes, filename, mime: "application/zip" };
  }

  return { configHtml, create, run, sniff, readArchive, makeZip };
})();

TOOLS.push({
  id: "zip-tools",
  slug: "zip-tools",
  name: "ZIP Maker & Opener",
  desc: "Pack any files into one ZIP, or open a ZIP, RAR, 7z or TAR to see what's inside and take out the files you need.",
  keywords: "zip file maker create zip compress files into zip make zip folder to zip unzip extract zip open zip zip opener zip extractor rar extractor open rar unrar 7z 7zip extract 7z tar gz tgz archive file compressor decompress rar to zip 7z to zip inspect zip list files",
  icon: "🗜️",
  category: "optimize",
  badge: "New",
  accept: "*/*",
  acceptLabel: "any files",
  multipleFiles: true,
  compactFileList: true,
  actionLabel: "Make ZIP",
  caption: "Pack or unpack files",
  scene: "squash",
  configHtml: ZipTool.configHtml,
  onOpen: (ctx) => { ctx.zip = ZipTool.create(ctx.el("ztRoot"), TOOLS.find((t) => t.id === "zip-tools")); },
  onFiles: (ctx) => ctx.zip.onFiles(ctx.files, ctx.buffers),
  onClose: (ctx) => ctx.zip && ctx.zip.destroy(),
  run: ZipTool.run,
});
