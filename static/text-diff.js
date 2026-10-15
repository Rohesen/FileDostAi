// Diff Checker: paste two versions of a text (or open two text files) and see what changed,
// side by side, with the changed words marked. Uses the diff engine from compare-tool.js.
// Runs in the browser; nothing is uploaded.

const TextDiff = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX_LINES = 20000;

  /** Rows for a side-by-side view: { type: same|del|add|mod, a, b, na, nb }. */
  function compare(textA, textB, { ignoreCase = false, ignoreSpace = false } = {}) {
    const la = textA.replace(/\r\n?/g, "\n").split("\n"), lb = textB.replace(/\r\n?/g, "\n").split("\n");
    if (la.length > MAX_LINES || lb.length > MAX_LINES) throw new ClientPDF.UserError(`That's over ${MAX_LINES.toLocaleString()} lines. Compare smaller parts.`);
    const key = (l) => {
      let k = ignoreSpace ? l.replace(/\s+/g, " ").trim() : l;
      if (ignoreCase) k = k.toLowerCase();
      // The shared engine trims what it compares, so mark leading/trailing spaces when they count.
      return ignoreSpace ? k : `\u0001${k}\u0001`;
    };
    const blocks = PdfCompare.diff(la.map(key), lb.map(key), 6000);
    const rows = [];
    let i = 0, j = 0;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.op === "=") {
        for (let n = 0; n < b.a.length; n++) rows.push({ type: "same", a: la[i], b: lb[j], na: ++i, nb: ++j });
        continue;
      }
      let dels = b.op === "-" ? b.a.length : 0;
      let adds = b.op === "+" ? b.b.length : 0;
      if (b.op === "-" && blocks[k + 1] && blocks[k + 1].op === "+") { adds = blocks[k + 1].b.length; k++; }
      const pairs = Math.min(dels, adds);
      for (let n = 0; n < pairs; n++) rows.push({ type: "mod", a: la[i], b: lb[j], na: ++i, nb: ++j });
      for (let n = pairs; n < dels; n++) rows.push({ type: "del", a: la[i], na: ++i });
      for (let n = pairs; n < adds; n++) rows.push({ type: "add", b: lb[j], nb: ++j });
    }
    return rows;
  }

  /** The two sides of a changed line, with the changed words wrapped in <mark>. */
  function words(a, b) {
    const ta = a.match(/\s+|[^\s]+/g) || [], tb = b.match(/\s+|[^\s]+/g) || [];
    const d = PdfCompare.diff(ta, tb, 800);
    let ha = "", hb = "";
    for (const w of d) {
      if (w.op === "=") { ha += esc(w.a.join("")); hb += esc(w.b.join("")); }
      else if (w.op === "-") ha += `<mark>${esc(w.a.join(""))}</mark>`;
      else hb += `<mark>${esc(w.b.join(""))}</mark>`;
    }
    return [ha, hb];
  }

  function stats(rows) {
    const c = { add: 0, del: 0, mod: 0, same: 0 };
    rows.forEach((r) => c[r.type]++);
    return c;
  }

  function table(rows, { onlyChanges = false } = {}) {
    const out = [];
    let skipped = 0;
    const flush = () => { if (skipped) out.push(`<tr class="td-skip"><td colspan="4">${skipped} unchanged line${skipped === 1 ? "" : "s"}</td></tr>`); skipped = 0; };
    rows.forEach((r, idx) => {
      if (onlyChanges && r.type === "same") {
        // keep one line of context on each side of a change
        const near = (rows[idx - 1] && rows[idx - 1].type !== "same") || (rows[idx + 1] && rows[idx + 1].type !== "same");
        if (!near) { skipped++; return; }
      }
      flush();
      let a = r.a != null ? esc(r.a) : "", b = r.b != null ? esc(r.b) : "";
      if (r.type === "mod") [a, b] = words(r.a, r.b);
      const la = r.type === "add" ? "" : r.na, lb = r.type === "del" ? "" : r.nb;
      out.push(`<tr class="td-${r.type}"><td class="td-n">${la}</td><td class="td-a">${r.type === "add" ? "" : a || " "}</td><td class="td-n">${lb}</td><td class="td-b">${r.type === "del" ? "" : b || " "}</td></tr>`);
    });
    flush();
    return `<table class="td-table"><tbody>${out.join("")}</tbody></table>`;
  }

  const configHtml = `<div id="tdRoot"></div>`;

  function create(root) {
    root.innerHTML = `
      <div class="td">
        <div class="td-inputs">
          <div class="td-side">
            <div class="td-head"><label class="form-label" for="tdA">Original</label>
              <label class="btn btn-xs td-open">${Icons.ui("folder")} Open file<input type="file" id="tdFileA" accept=".txt,.md,.csv,.json,.xml,.html,.htm,.css,.js,.ts,.py,.java,.c,.cpp,.h,.sql,.yaml,.yml,.log,.ini,.srt,text/*" hidden></label></div>
            <textarea id="tdA" class="form-input td-text" spellcheck="false" placeholder="Paste the first version here"></textarea>
          </div>
          <div class="td-side">
            <div class="td-head"><label class="form-label" for="tdB">Changed</label>
              <label class="btn btn-xs td-open">${Icons.ui("folder")} Open file<input type="file" id="tdFileB" accept=".txt,.md,.csv,.json,.xml,.html,.htm,.css,.js,.ts,.py,.java,.c,.cpp,.h,.sql,.yaml,.yml,.log,.ini,.srt,text/*" hidden></label></div>
            <textarea id="tdB" class="form-input td-text" spellcheck="false" placeholder="Paste the second version here"></textarea>
          </div>
        </div>
        <div class="sign-row td-actions">
          <button type="button" class="btn btn-primary btn-xs" id="tdGo">Find differences</button>
          <button type="button" class="btn btn-xs" id="tdSwap">Swap</button>
          <button type="button" class="btn btn-xs" id="tdClear">Clear</button>
          <label class="checkbox-group"><input type="checkbox" id="tdCase"> Ignore capitals</label>
          <label class="checkbox-group"><input type="checkbox" id="tdSpace"> Ignore spaces</label>
          <label class="checkbox-group"><input type="checkbox" id="tdOnly"> Only changed lines</label>
        </div>
        <div id="tdOut" class="td-out"></div>
        <p class="drop-hint">For text, code, CSV and lists. To compare two PDFs, use Compare PDF.</p>
      </div>`;
    const $ = (id) => root.querySelector(`#${id}`);
    const shared = { drop: document.getElementById("dropZone"), exec: document.getElementById("btnExecute") };
    if (shared.drop) shared.drop.style.display = "none";
    if (shared.exec) shared.exec.style.display = "none";

    function go() {
      const a = $("tdA").value, b = $("tdB").value;
      if (!a && !b) { $("tdOut").innerHTML = ""; showToast("Paste or open two texts first.", "error"); return; }
      try {
        const rows = compare(a, b, { ignoreCase: $("tdCase").checked, ignoreSpace: $("tdSpace").checked });
        const c = stats(rows);
        const same = !c.add && !c.del && !c.mod;
        $("tdOut").innerHTML = same
          ? `<p class="td-summary td-identical">${Icons.ui("star")} The two texts are the same${$("tdCase").checked || $("tdSpace").checked ? " (with the differences you chose to ignore)" : ""}.</p>`
          : `<p class="td-summary"><span class="td-pill del">${c.del} removed</span><span class="td-pill add">${c.add} added</span><span class="td-pill mod">${c.mod} changed</span> line${c.del + c.add + c.mod === 1 ? "" : "s"}</p>
             <div class="td-scroll">${table(rows, { onlyChanges: $("tdOnly").checked })}</div>`;
      } catch (e) {
        showToast(e.message || "Couldn't compare these texts.", "error");
      }
    }
    async function open(input, target) {
      const f = input.files[0];
      if (!f) return;
      if (f.size > 20 * 1048576) { showToast("That file is over 20 MB. Open a smaller text file.", "error"); return; }
      $(target).value = await f.text();
      input.value = "";
    }
    $("tdFileA").addEventListener("change", (e) => open(e.target, "tdA"));
    $("tdFileB").addEventListener("change", (e) => open(e.target, "tdB"));
    $("tdGo").addEventListener("click", go);
    $("tdSwap").addEventListener("click", () => { const t = $("tdA").value; $("tdA").value = $("tdB").value; $("tdB").value = t; if ($("tdOut").innerHTML) go(); });
    $("tdClear").addEventListener("click", () => { $("tdA").value = $("tdB").value = ""; $("tdOut").innerHTML = ""; });
    ["tdCase", "tdSpace", "tdOnly"].forEach((id) => $(id).addEventListener("change", () => { if ($("tdOut").innerHTML) go(); }));

    return {
      destroy: () => {
        if (shared.drop) shared.drop.style.display = "";
        if (shared.exec) shared.exec.style.display = "";
      },
    };
  }

  return { configHtml, create, compare, words, stats };
})();

TOOLS.push({
  id: "text-diff",
  slug: "diff-checker",
  aliases: ["text-compare", "compare-text", "text-diff", "compare-two-texts", "code-diff"],
  name: "Diff Checker",
  desc: "Paste two versions of a text or code and see exactly what was added, removed and changed, side by side.",
  keywords: "diff checker text compare compare two texts find differences text difference code diff compare files online compare documents changes side by side",
  category: "ai",
  badge: "New",
  accept: ".txt,text/*",
  acceptLabel: "text",
  wide: true,
  caption: "Spot every change",
  configHtml: TextDiff.configHtml,
  onOpen: (ctx) => { ctx.td = TextDiff.create(ctx.el("tdRoot")); },
  onClose: (ctx) => ctx.td && ctx.td.destroy(),
  run: async () => { throw new ClientPDF.UserError("Use the Find differences button."); },
});
