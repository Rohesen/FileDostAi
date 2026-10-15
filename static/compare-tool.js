// Compare PDFs: text changes side by side, and a visual difference view page by page.
// Runs in the browser with pdf.js; neither file is uploaded.

const PdfCompare = (() => {
  /** Myers diff on two arrays of strings. Returns [{ op: "=", "-", "+", a: [...], b: [...] }]. */
  function diff(a, b, maxD = 4000) {
    // Compare words without the spaces after them, so a line break vs a space isn't a change.
    const ka = a.map((t) => t.trim()), kb = b.map((t) => t.trim());
    const n = a.length, m = b.length, max = n + m;
    const off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = false;
    for (let d = 0; d <= Math.min(max, maxD); d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && ka[x] === kb[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = true; break; }
      }
      if (found) break;
    }
    if (!found) return [{ op: "-", a, b: [] }, { op: "+", a: [], b }];
    // Walk back through the snapshots.
    const edits = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const snap = trace[d];
      const get = (k) => snap[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
      const prevX = d === 0 ? 0 : get(prevK);
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { edits.push(["=", a[x - 1]]); x--; y--; }
      if (d > 0) {
        if (x === prevX) edits.push(["+", b[y - 1]]);
        else edits.push(["-", a[x - 1]]);
      }
      x = prevX; y = prevY;
    }
    edits.reverse();
    const out = [];
    for (const [op, tok] of edits) {
      let last = out[out.length - 1];
      if (!last || last.op !== op) { last = { op, a: [], b: [] }; out.push(last); }
      if (op !== "+") last.a.push(tok);
      if (op !== "-") last.b.push(tok);
    }
    return out;
  }

  const words = (s) => s.match(/\s*\S+\s*/g) || [];

  /** Line diff first, then word diff inside each changed block. */
  function textDiff(textA, textB) {
    const la = textA.split("\n"), lb = textB.split("\n");
    const blocks = diff(la, lb);
    const parts = []; // { op, text }
    let added = 0, removed = 0, same = 0;
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      if (blk.op === "=") {
        parts.push({ op: "=", text: blk.a.join("\n") + "\n" });
        same += blk.a.join(" ").split(/\s+/).filter(Boolean).length;
        continue;
      }
      // Pair a removal with the addition right after it and diff them word by word.
      const next = blocks[i + 1];
      const aText = blk.op === "-" ? blk.a.join("\n") + "\n" : "";
      const bText = blk.op === "+" ? blk.b.join("\n") + "\n" : (next && next.op === "+" ? next.b.join("\n") + "\n" : "");
      if (blk.op === "-" && next && next.op === "+") i++;
      const wd = diff(words(aText), words(bText), 1500);
      for (const w of wd) {
        const text = (w.op === "+" ? w.b : w.a).join("");
        const count = text.split(/\s+/).filter(Boolean).length;
        if (w.op === "+") added += count; else if (w.op === "-") removed += count; else same += count;
        parts.push({ op: w.op, text });
      }
    }
    const total = same + Math.max(added, removed);
    return { parts, added, removed, similarity: total ? Math.round((same / total) * 1000) / 10 : 100 };
  }

  async function pagesText(bytes) {
    const r = await PdfRender.extractText(bytes);
    return { text: r.pages.map((p) => p.text).join("\n\n"), pages: r.page_count };
  }

  async function run(ctx) {
    if (ctx.buffers.length !== 2) throw new ClientPDF.UserError("Add exactly two PDFs: the old version first, then the new one.");
    const [A, B] = await Promise.all(ctx.buffers.map(pagesText));
    const d = textDiff(A.text, B.text);
    return {
      json: {
        names: ctx.files.map((f) => f.name),
        pages: [A.pages, B.pages],
        ...d,
      },
    };
  }

  function render(data, box, ctx) {
    const esc = (s) => escapeHtml(s);
    const left = data.parts.filter((p) => p.op !== "+").map((p) => p.op === "-" ? `<del>${esc(p.text)}</del>` : esc(p.text)).join("");
    const right = data.parts.filter((p) => p.op !== "-").map((p) => p.op === "+" ? `<ins>${esc(p.text)}</ins>` : esc(p.text)).join("");
    box.innerHTML = `
      <div class="ai-stat-row">
        <div class="ai-card"><div class="ai-card-val">${data.similarity}%</div><div class="ai-card-lbl">Same text</div></div>
        <div class="ai-card"><div class="ai-card-val" style="color:#34d399">+${data.added}</div><div class="ai-card-lbl">Words added</div></div>
        <div class="ai-card"><div class="ai-card-val" style="color:#f87171">−${data.removed}</div><div class="ai-card-lbl">Words removed</div></div>
      </div>
      <div class="sign-tabs" role="tablist">
        <button type="button" class="sign-tab active" data-view="text">Text changes</button>
        <button type="button" class="sign-tab" data-view="visual">Visual differences</button>
      </div>
      <div class="cmp-view" data-view="text">
        <div class="cmp-cols">
          <div><div class="cmp-head">${esc(data.names[0])} · ${data.pages[0]} pages</div><div class="cmp-text" id="cmpA">${left}</div></div>
          <div><div class="cmp-head">${esc(data.names[1])} · ${data.pages[1]} pages</div><div class="cmp-text" id="cmpB">${right}</div></div>
        </div>
        <div class="sign-row"><button type="button" class="btn btn-xs" id="cmpNext">Next change ▼</button>
          <span class="drop-hint">Red was removed, green was added.</span></div>
      </div>
      <div class="cmp-view" data-view="visual" hidden>
        <div class="sign-row">
          <button type="button" class="btn btn-xs" id="cmpPrevPage">◀</button>
          <span id="cmpPageLabel">Page 1</span>
          <button type="button" class="btn btn-xs" id="cmpNextPage">▶</button>
          <span class="drop-hint" id="cmpPixels" style="margin-left:auto;"></span>
        </div>
        <div class="cmp-cols">
          <canvas id="cmpCanvasA"></canvas>
          <canvas id="cmpCanvasB"></canvas>
        </div>
      </div>`;

    // Keep both text columns scrolled together.
    const a = box.querySelector("#cmpA"), b = box.querySelector("#cmpB");
    let syncing = false;
    const sync = (from, to) => from.addEventListener("scroll", () => {
      if (syncing) { syncing = false; return; }
      syncing = true;
      to.scrollTop = (from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight)) * (to.scrollHeight - to.clientHeight);
    });
    sync(a, b); sync(b, a);
    let changeIdx = -1;
    box.querySelector("#cmpNext").addEventListener("click", () => {
      const marks = [...b.querySelectorAll("ins"), ...a.querySelectorAll("del")].sort((x, y) => x.offsetTop - y.offsetTop);
      if (!marks.length) return showToast("No text changes found.", "success");
      changeIdx = (changeIdx + 1) % marks.length;
      marks[changeIdx].scrollIntoView({ block: "center", behavior: "smooth" });
    });

    box.querySelectorAll(".sign-tab").forEach((t) => t.addEventListener("click", () => {
      box.querySelectorAll(".sign-tab").forEach((x) => x.classList.toggle("active", x === t));
      box.querySelectorAll(".cmp-view").forEach((v) => { v.hidden = v.dataset.view !== t.dataset.view; });
      if (t.dataset.view === "visual" && !visualReady) showVisual();
    }));

    let visualReady = false, docs = null, page = 0;
    const maxPages = Math.max(...data.pages);
    async function showVisual() {
      visualReady = true;
      docs = await Promise.all(ctx.buffers.map((buf) => PdfRender.open(buf)));
      drawPage();
    }
    async function drawPage() {
      box.querySelector("#cmpPageLabel").textContent = `Page ${page + 1} of ${maxPages}`;
      const ca = box.querySelector("#cmpCanvasA"), cb = box.querySelector("#cmpCanvasB");
      const width = Math.min(Math.floor((box.clientWidth - 24) / 2), 460);
      for (const [d, c] of [[docs[0], ca], [docs[1], cb]]) {
        if (page < d.numPages) await PdfRender.renderPage(await d.getPage(page + 1), c, { maxWidth: width });
        else { c.width = c.height = 1; }
      }
      // Mark pixels that differ in red on the new version.
      if (ca.width > 1 && cb.width > 1) {
        const w = Math.min(ca.width, cb.width), h = Math.min(ca.height, cb.height);
        const da = ca.getContext("2d").getImageData(0, 0, w, h).data;
        const ictx = cb.getContext("2d");
        const img = ictx.getImageData(0, 0, w, h);
        let changed = 0;
        for (let i = 0; i < da.length; i += 4) {
          const delta = Math.abs(da[i] - img.data[i]) + Math.abs(da[i + 1] - img.data[i + 1]) + Math.abs(da[i + 2] - img.data[i + 2]);
          if (delta > 90) { img.data[i] = 239; img.data[i + 1] = 68; img.data[i + 2] = 68; changed++; }
        }
        ictx.putImageData(img, 0, 0);
        box.querySelector("#cmpPixels").textContent = changed ? `${((changed / (w * h)) * 100).toFixed(2)}% of this page changed (red)` : "This page looks identical.";
      } else {
        box.querySelector("#cmpPixels").textContent = "This page exists in only one file.";
      }
    }
    box.querySelector("#cmpPrevPage").addEventListener("click", () => { if (page > 0) { page--; drawPage(); } });
    box.querySelector("#cmpNextPage").addEventListener("click", () => { if (page < maxPages - 1) { page++; drawPage(); } });
  }

  return { diff, textDiff, run, render };
})();
