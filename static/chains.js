// Tool chains: after any tool finishes, carry the result straight into the next tool without
// downloading and re-uploading it, and save a run of steps (say OCR → Compress → Page numbers)
// as a one-click recipe. Recipes live in this browser only (localStorage); nothing is uploaded.

const Chains = (() => {
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/chains.css?v=33" }));

  const KEY = "ultrapdf-recipes";
  // Tools that need clicks on the page itself can be a next step, but can't run unattended.
  const HANDS_ON = new Set(["sign", "edit", "crop", "organize", "scan", "compare", "redact", "remove-pages", "split", "exam-form-kit", "fill-pdf-form", "trim-media", "recipes", "qr-code", "zip-tools"]);
  // What people usually do next, by kind of file.
  const NEXT = {
    pdf: ["compress", "compress-pdf-to-size", "page-numbers", "watermark", "protect", "sign", "merge", "ocr", "pdf-to-jpg", "organize", "n-up-pdf", "pdf-bookmarks", "fill-pdf-form", "extract-images", "split"],
    image: ["img-to-pdf", "photo-resize", "image-convert", "compress-any", "qr-code"],
    other: ["compress-any", "zip-tools"],
  };
  const STARTERS = [
    { name: "Searchable & small", builtIn: true, steps: [{ tool: "ocr", settings: {} }, { tool: "compress", settings: {} }] },
    { name: "Number pages, then compress", builtIn: true, steps: [{ tool: "page-numbers", settings: {} }, { tool: "compress", settings: {} }] },
  ];

  let chain = [];        // steps done on the current file, in order
  let lastOutput = null; // the File the last step produced
  let playing = null;    // { recipe, index } while a recipe runs

  const toolById = (id) => TOOLS.find((t) => t.id === id);
  const kindOf = (file) => (isPdf(file) ? "pdf" : /^image\//.test(file.type) || /\.(heic|heif|avif|bmp)$/i.test(file.name) ? "image" : "other");

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function store(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  const allRecipes = () => [...load(), ...STARTERS];

  /** Every setting in the open tool's panel, except passwords (asked for again when a recipe runs). */
  function snapshot() {
    const out = {};
    document.querySelectorAll("#toolConfig input[id], #toolConfig select[id], #toolConfig textarea[id]").forEach((el) => {
      if (el.type === "file" || el.type === "password") return;
      out[el.id] = el.type === "checkbox" || el.type === "radio" ? { checked: el.checked } : el.value;
    });
    return out;
  }
  function apply(settings) {
    for (const [id, v] of Object.entries(settings || {})) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (v && typeof v === "object") el.checked = v.checked;
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  const asFile = (result) => new File([result.bytes], result.filename, { type: result.mime || "application/octet-stream" });

  function box() {
    let el = document.getElementById("chainBox");
    if (!el) {
      el = document.createElement("div");
      el.id = "chainBox";
      el.className = "chain-box";
      const anchor = document.getElementById("resultBox");
      anchor.parentNode.insertBefore(el, anchor);
    }
    return el;
  }
  function hide() { const el = document.getElementById("chainBox"); if (el) el.remove(); }

  /** Called by app.js after a tool hands over a file. Offers next steps on that same file. */
  function offerNext(tool, result) {
    const file = asFile(result);
    const step = { tool: tool.id, settings: snapshot() };
    chain = currentFiles.length === 1 && lastOutput && currentFiles[0] === lastOutput ? [...chain, step] : [step];
    lastOutput = file;

    const kind = kindOf(file);
    const usable = TOOLS.filter((t) => t.id !== tool.id && acceptsFile(t, file));
    const top = NEXT[kind].map(toolById).filter((t) => t && usable.includes(t)).slice(0, 6);
    const rest = usable.filter((t) => !top.includes(t));
    const names = chain.map((s) => (toolById(s.tool) || { name: s.tool }).name);
    const handsOn = chain.map((s) => toolById(s.tool)).filter((t) => t && (t.board || HANDS_ON.has(t.id)));

    const el = box();
    el.innerHTML = `
      <div class="chain-head">
        <strong>Keep going with ${escapeHtml(file.name)}</strong>
        <span class="chain-sub">No need to download and upload again.</span>
      </div>
      <div class="chain-next">
        ${top.map((t) => `<button type="button" class="chain-btn" data-next="${t.id}">${Icons.tool(t, "ti-xs")}${escapeHtml(t.name)}</button>`).join("")}
        ${rest.length ? `<select class="form-select chain-more" aria-label="Other tools"><option value="">More tools…</option>${rest.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select>` : ""}
      </div>
      ${chain.length > 1 ? `
      <div class="chain-save">
        <span class="chain-steps">${names.map((n, i) => `<b>${i + 1}</b> ${escapeHtml(n)}`).join(" <i>→</i> ")}</span>
        ${handsOn.length
          ? `<span class="chain-note">${escapeHtml(handsOn[0].name)} needs you to click on the page, so these steps can't be saved as a recipe.</span>`
          : `<input class="form-input chain-name" maxlength="40" placeholder="Name this recipe" value="${escapeHtml(names.join(" + ").slice(0, 40))}">
             <button type="button" class="btn btn-xs chain-keep">${Icons.ui("star")} Save as recipe</button>`}
      </div>` : ""}`;

    el.querySelectorAll("[data-next]").forEach((b) => b.addEventListener("click", () => continueWith(b.dataset.next)));
    const more = el.querySelector(".chain-more");
    if (more) more.addEventListener("change", () => more.value && continueWith(more.value));
    const keep = el.querySelector(".chain-keep");
    if (keep) keep.addEventListener("click", () => {
      const name = el.querySelector(".chain-name").value.trim() || names.join(" + ");
      const list = load().filter((r) => r.name !== name);
      list.unshift({ name, steps: chain.map((s) => ({ tool: s.tool, settings: s.settings })) });
      if (!store(list)) return showToast("This browser won't let us save recipes (private mode?).", "error");
      showToast(`Saved "${name}". Find it under My Recipes.`, "success");
      keep.disabled = true;
      keep.textContent = "✓ Saved";
    });
  }

  async function continueWith(id) {
    const file = lastOutput;
    if (!file) return;
    hide();
    openToolModal(id);
    await addFilesToTool([file]);
  }

  /** Runs every step of a recipe on one file, showing each tool as it works. */
  async function play(recipe, file) {
    const usable = recipe.steps.map((s) => toolById(s.tool));
    const missing = recipe.steps.find((s, i) => !usable[i]);
    if (missing) return showToast(`This recipe uses a tool that no longer exists (${missing.tool}).`, "error");
    let cur = file;
    playing = { recipe, index: 0 };
    try {
      for (let i = 0; i < recipe.steps.length; i++) {
        const step = recipe.steps[i], tool = usable[i];
        playing.index = i;
        openToolModal(tool.id, { push: false });
        banner(recipe, i);
        if (!acceptsFile(tool, cur)) throw new Error(`Step ${i + 1} (${tool.name}) can't take ${cur.name}.`);
        apply(step.settings);
        await addFilesToTool([cur]);
        apply(step.settings);
        // Passwords are never saved, so ask for them each time.
        for (const pw of document.querySelectorAll("#toolConfig input[type=password]")) {
          const label = pw.closest(".form-group") && pw.closest(".form-group").querySelector("label");
          const v = window.prompt(`${tool.name}: enter the ${label ? label.textContent.toLowerCase() : "password"}`);
          if (v === null) throw new Error("Recipe stopped.");
          pw.value = v;
        }
        const result = await executeCurrentTool({ keep: true });
        if (!result) throw new Error(`Recipe stopped at step ${i + 1} (${tool.name}).`);
        if (!result.bytes) throw new Error(`${tool.name} shows a result instead of a file, so it has to be the last step.`);
        cur = asFile(result);
      }
      downloadBlob(cur, cur.name);
      showToast(`Recipe "${recipe.name}" done. Downloaded ${cur.name}.`, "success");
      const last = toolById(recipe.steps[recipe.steps.length - 1].tool);
      lastOutput = null;
      offerNext(last, { bytes: new Uint8Array(await cur.arrayBuffer()), mime: cur.type, filename: cur.name });
      chain = recipe.steps.map((s) => ({ ...s }));
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      playing = null;
      banner(null);
    }
  }

  function banner(recipe, i) {
    let el = document.getElementById("recipeBanner");
    if (!recipe) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "recipeBanner";
      el.className = "recipe-banner";
      document.querySelector("#universalModal .modal-card").prepend(el);
    }
    el.innerHTML = `${Icons.ui("star")} Recipe <b>${escapeHtml(recipe.name)}</b>: step ${i + 1} of ${recipe.steps.length}
      <span>${recipe.steps.map((s, j) => `<i class="${j < i ? "done" : j === i ? "now" : ""}">${escapeHtml((toolById(s.tool) || { name: s.tool }).name)}</i>`).join("")}</span>`;
  }

  // ---------- The "My Recipes" tool ----------
  function listHtml() {
    return allRecipes().map((r, i) => `
      <label class="recipe-row">
        <input type="radio" name="recipePick" value="${i}" ${i === 0 ? "checked" : ""}>
        <span class="recipe-name">${escapeHtml(r.name)}${r.builtIn ? ` <small>starter</small>` : ""}</span>
        <span class="recipe-steps">${r.steps.map((s) => escapeHtml((toolById(s.tool) || { name: s.tool }).name)).join(" → ")}</span>
        ${r.builtIn ? "" : `<button type="button" class="btn btn-xs recipe-del" data-del="${escapeHtml(r.name)}" aria-label="Delete ${escapeHtml(r.name)}">Delete</button>`}
      </label>`).join("");
  }
  function refresh(root) {
    root.innerHTML = listHtml();
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      store(load().filter((r) => r.name !== b.dataset.del));
      refresh(root);
    }));
  }

  TOOLS.push({
    id: "recipes",
    slug: "my-recipes",
    name: "My Recipes",
    desc: "Run several tools in a row with one click, like OCR then Compress. Save your own from the \"Keep going\" bar after any tool.",
    keywords: "recipe recipes workflow workflows chain automate automation batch steps pipeline one click repeat",
    icon: "⭐",
    category: "organize",
    badge: "Workflow",
    caption: "Many steps, one click",
    scene: "shuffle",
    accept: "*/*",
    acceptLabel: "a file",
    actionLabel: "Run recipe",
    configHtml: `
      <div class="recipe-list" id="recipeList"></div>
      <p class="drop-hint">Make your own: use any tool, pick the next tool in the "Keep going" bar, then press Save as recipe. Recipes are kept in this browser only.</p>`,
    onOpen: () => refresh(document.getElementById("recipeList")),
    run: async (ctx) => {
      const pick = document.querySelector("input[name=recipePick]:checked");
      const recipe = allRecipes()[pick ? Number(pick.value) : 0];
      if (!recipe) throw new ClientPDF.UserError("Pick a recipe first.");
      const file = ctx.files[0];
      setTimeout(() => play(recipe, file), 50);
      return { json: { recipe: recipe.name }, message: `Starting "${recipe.name}"…` };
    },
    renderResult: (data, el) => { el.innerHTML = `<p>Running <b>${escapeHtml(data.recipe)}</b>…</p>`; },
  });

  return { offerNext, play, hide, isPlaying: () => !!playing, recipes: allRecipes };
})();
