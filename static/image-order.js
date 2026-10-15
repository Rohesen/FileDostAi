// Image order board for "Images to PDF": thumbnails of every image, sorted by date taken,
// date modified or name, or dragged by hand. Works for hundreds of images; nothing is uploaded.

const ImageOrder = (() => {
  // ---- When was a photo taken? EXIF DateTimeOriginal for JPEGs, else the file's date. ----
  async function exifDate(file) {
    if (!/jpe?g$/i.test(file.type.split("/")[1] || file.name)) return null;
    try {
      const buf = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
      if (buf.getUint16(0) !== 0xffd8) return null;
      let off = 2;
      while (off + 4 < buf.byteLength) {
        const marker = buf.getUint16(off), len = buf.getUint16(off + 2);
        if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) return readTiff(buf, off + 10);
        if ((marker & 0xff00) !== 0xff00) return null;
        off += 2 + len;
      }
    } catch (e) { /* unreadable: use the file date */ }
    return null;
  }
  function readTiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
    const str = (o, n) => { let s = ""; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(t + o + i)); return s; };
    const find = (ifd, tag) => {
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === tag) return e;
      }
      return -1;
    };
    const ifd0 = u32(4);
    let entry = -1;
    const exifPtr = find(ifd0, 0x8769);
    if (exifPtr >= 0) entry = find(u32(exifPtr + 8), 0x9003); // DateTimeOriginal
    if (entry < 0) entry = find(ifd0, 0x0132);                 // DateTime
    if (entry < 0) return null;
    const m = str(u32(entry + 8), 20).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }); // img2 before img10
  const SORTS = {
    added: null,
    "time-asc": (a, b) => a.time - b.time || collator.compare(a.file.name, b.file.name),
    "time-desc": (a, b) => b.time - a.time || collator.compare(a.file.name, b.file.name),
    "name-asc": (a, b) => collator.compare(a.file.name, b.file.name),
    "name-desc": (a, b) => collator.compare(b.file.name, a.file.name),
  };

  function create(root, { onRemove }) {
    root.innerHTML = `
      <div class="io-bar">
        <label class="form-label" for="ioSort">Order</label>
        <select id="ioSort" class="form-select io-sort">
          <option value="added">The order I added them</option>
          <option value="time-asc">Date taken or saved: oldest first</option>
          <option value="time-desc">Date taken or saved: newest first</option>
          <option value="name-asc">File name: A → Z (1, 2, 10)</option>
          <option value="name-desc">File name: Z → A</option>
          <option value="manual" hidden>My own order (dragged)</option>
        </select>
        <button type="button" class="btn btn-xs" id="ioReverse" title="Flip the order">⇅ Reverse</button>
        <span class="io-count" id="ioCount"></span>
      </div>
      <p class="drop-hint">Drag any picture to move it, or use ◀ ▶. Dates come from the photo's camera info when it has one, otherwise the date the file was saved (browsers can't read a file's creation date).</p>
      <div class="io-grid" id="ioGrid"></div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label" for="ioPage">Page size</label>
          <select id="ioPage" class="form-select">
            <option value="fit">Same as each image</option>
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="ioMargin">Margin</label>
          <select id="ioMargin" class="form-select">
            <option value="0">None</option>
            <option value="20" selected>Small</option>
            <option value="40">Big</option>
          </select>
        </div>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    let items = []; // { file, url, time, fromExif }
    let mode = "added";

    async function setFiles(files) {
      const known = new Map(items.map((it) => [it.file, it]));
      const next = [];
      for (const f of files) {
        let it = known.get(f);
        if (!it) {
          it = { file: f, url: URL.createObjectURL(f), time: f.lastModified, fromExif: false };
          const t = await exifDate(f);
          if (t) { it.time = t; it.fromExif = true; }
        }
        next.push(it);
      }
      items.filter((it) => !files.includes(it.file)).forEach((it) => URL.revokeObjectURL(it.url));
      // Keep the current arrangement for images already on the board; new ones go at the end.
      const kept = items.filter((it) => files.includes(it.file));
      const added = next.filter((it) => !known.has(it.file));
      items = mode === "added" ? next : [...kept, ...added];
      if (SORTS[mode]) items.sort(SORTS[mode]);
      render();
    }

    const fmt = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    function render() {
      $("ioCount").textContent = `${items.length} image${items.length === 1 ? "" : "s"}`;
      $("ioGrid").innerHTML = items.map((it, i) => `
        <div class="io-card" draggable="true" data-i="${i}">
          <span class="io-num">${i + 1}</span>
          <button type="button" class="io-x" data-act="remove" aria-label="Remove ${escapeHtml(it.file.name)}">×</button>
          <img src="${it.url}" alt="" loading="lazy" decoding="async">
          <div class="io-name" title="${escapeHtml(it.file.name)}">${escapeHtml(it.file.name)}</div>
          <div class="io-date" title="${it.fromExif ? "Date taken (camera info)" : "Date the file was saved"}">${Icons.ui(it.fromExif ? "camera" : "save")} ${fmt(it.time)}</div>
          <div class="io-move">
            <button type="button" class="btn btn-xs" data-act="left" aria-label="Move earlier" ${i === 0 ? "disabled" : ""}>◀</button>
            <button type="button" class="btn btn-xs" data-act="right" aria-label="Move later" ${i === items.length - 1 ? "disabled" : ""}>▶</button>
          </div>
        </div>`).join("");
    }

    function manual() {
      mode = "manual";
      $("ioSort").value = "manual";
      $("ioSort").querySelector('[value="manual"]').hidden = false;
    }
    function move(from, to) {
      if (to < 0 || to >= items.length || from === to) return;
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      manual();
      render();
    }

    $("ioSort").addEventListener("change", () => {
      mode = $("ioSort").value;
      if (SORTS[mode]) items.sort(SORTS[mode]);
      else if (mode === "added") items.sort((a, b) => ctxOrder(a) - ctxOrder(b));
      render();
    });
    let addedOrder = [];
    const ctxOrder = (it) => addedOrder.indexOf(it.file);
    $("ioReverse").addEventListener("click", () => { items.reverse(); manual(); render(); });

    $("ioGrid").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const i = Number(b.closest(".io-card").dataset.i);
      if (b.dataset.act === "remove") return onRemove(items[i].file);
      move(i, b.dataset.act === "left" ? i - 1 : i + 1);
    });

    // Drag and drop (mouse); touch uses the arrows, or long-press drag on browsers that support it.
    let dragFrom = -1;
    $("ioGrid").addEventListener("dragstart", (e) => {
      const card = e.target.closest(".io-card");
      if (!card) return;
      dragFrom = Number(card.dataset.i);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragFrom));
    });
    $("ioGrid").addEventListener("dragover", (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      $("ioGrid").querySelectorAll(".drop-before, .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
      const card = e.target.closest(".io-card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    });
    $("ioGrid").addEventListener("drop", (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const card = e.target.closest(".io-card");
      if (card) {
        let to = Number(card.dataset.i) + (card.classList.contains("drop-after") ? 1 : 0);
        if (to > dragFrom) to--;
        move(dragFrom, to);
      }
      dragFrom = -1;
    });
    $("ioGrid").addEventListener("dragend", () => {
      dragFrom = -1;
      $("ioGrid").querySelectorAll(".dragging, .drop-before, .drop-after").forEach((c) => c.classList.remove("dragging", "drop-before", "drop-after"));
    });

    const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
    return {
      setFiles: (files) => { addedOrder = files.slice(); return setFiles(files); },
      files: () => items.map((it) => it.file),
      layout: () => ({ paper: PAPER[$("ioPage").value] || null, margin: Number($("ioMargin").value) }),
      destroy: () => items.forEach((it) => URL.revokeObjectURL(it.url)),
    };
  }

  return { create, exifDate };
})();
