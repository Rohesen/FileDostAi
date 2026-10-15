// Site chrome: the top menu (Convert and All Tools dropdowns, search, phone menu), the FAQ,
// the footer's tool links, and the About / Privacy / Terms pages.
// The app's name comes from brand.json through window.BRAND (see main.py).

const Site = (() => {
  const BRAND = Object.assign({ name: "FileDost AI", contact_email: "", source_code_url: "" }, window.BRAND || {});
  const N = BRAND.name;
  const esc = (s) => escapeHtml(s);
  const real = (v) => v && !v.includes("REPLACE_ME");
  const email = () => (real(BRAND.contact_email)
    ? `<a href="mailto:${esc(BRAND.contact_email)}">${esc(BRAND.contact_email)}</a>`
    : `the <a href="#" data-feedback="problem">contact form</a>`);
  const CATEGORIES = {
    organize: "Organize", edit: "Edit & Sign", convert: "Convert", image: "Images",
    optimize: "Optimize", security: "Security", ai: "Read & Compare",
  };
  const isLocal = (t) => !t.endpoint;
  const toolLink = (t) => `<a href="/${t.slug}" data-tool="${t.id}">${Icons.tool(t, "ti-sm")}${esc(t.name)}</a>`;

  // ---------- Top menu ----------

  function buildMenus() {
    const toPdf = TOOLS.filter((t) => t.category === "convert" && (/-to-pdf$/.test(t.slug) || t.id === "scan"));
    const fromPdf = TOOLS.filter((t) => /^pdf-to-/.test(t.slug));
    const images = TOOLS.filter((t) => t.category === "image" || t.id === "compress-any");
    document.getElementById("megaConvert").innerHTML = `
      <div class="mega-col"><h5>Convert to PDF</h5>${toPdf.map(toolLink).join("")}</div>
      <div class="mega-col"><h5>Convert from PDF</h5>${fromPdf.map(toolLink).join("")}</div>
      <div class="mega-col"><h5>Images &amp; files</h5>${images.map(toolLink).join("")}</div>`;
    document.getElementById("megaAll").innerHTML = Object.entries(CATEGORIES).map(([cat, label]) => {
      const list = TOOLS.filter((t) => t.category === cat);
      return list.length ? `<div class="mega-col"><h5>${Icons.category(cat, "ci-plain")}${esc(label)}</h5>${list.map(toolLink).join("")}</div>` : "";
    }).join("") + `
      <div class="mega-foot">
        <a href="#" data-action="pipeline">${Icons.ui("chain")} Chain several tools in one go</a>
        <a href="/#toolsGrid" data-action="grid">See every tool with descriptions →</a>
      </div>`;
    const popular = ["merge", "split", "compress", "pdf-to-docx", "word-to-pdf", "img-to-pdf", "image-convert", "photo-resize", "compress-any", "sign"];
    document.getElementById("footerTools").innerHTML = popular.map((id) => TOOLS.find((t) => t.id === id)).filter(Boolean)
      .map((t) => `<a href="/${t.slug}" data-tool="${t.id}">${esc(t.name)}</a>`).join("");
    const src = document.getElementById("sourceLink");
    if (real(BRAND.source_code_url)) src.href = BRAND.source_code_url;
    else src.addEventListener("click", (e) => { e.preventDefault(); showToast("The source code link isn't set up yet.", "success"); });
    document.getElementById("footerCopy").textContent = `© ${new Date().getFullYear()} ${N}. Free and open source under AGPL-3.0.`;
  }

  function closeMenus(except) {
    document.querySelectorAll(".nav-drop.open").forEach((d) => {
      if (d === except) return;
      d.classList.remove("open");
      d.querySelector("button").setAttribute("aria-expanded", "false");
    });
  }

  function setupNav() {
    document.querySelectorAll(".nav-drop > button").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const drop = b.parentElement;
        // A click right after the pointer opened it on hover keeps it open.
        const justHovered = Date.now() - Number(drop.dataset.hoverAt || 0) < 700;
        const open = justHovered || !drop.classList.contains("open");
        closeMenus(drop);
        drop.classList.toggle("open", open);
        b.setAttribute("aria-expanded", String(open));
      });
      // Desktop: open on hover too.
      b.parentElement.addEventListener("mouseenter", () => {
        if (!window.matchMedia("(hover: hover) and (min-width: 981px)").matches) return;
        closeMenus(b.parentElement);
        b.parentElement.dataset.hoverAt = Date.now();
        b.parentElement.classList.add("open");
        b.setAttribute("aria-expanded", "true");
      });
      b.parentElement.addEventListener("mouseleave", () => {
        if (!window.matchMedia("(hover: hover) and (min-width: 981px)").matches) return;
        b.parentElement.classList.remove("open");
        b.setAttribute("aria-expanded", "false");
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".nav-drop")) closeMenus();
      if (!e.target.closest("#navSearch")) hideResults();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenus(); hideResults(); closeInfo(); } });

    const burger = document.getElementById("navBurger");
    burger.addEventListener("click", () => {
      const open = !document.body.classList.contains("nav-open");
      document.body.classList.toggle("nav-open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.innerHTML = Icons.ui(open ? "close" : "menu");
    });

    // Any link to a tool or page opens it in place (Ctrl/Cmd-click still opens a new tab).
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-tool], a[data-page], a[data-action], a[href='/#support'], a[href='/#toolsGrid']");
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      closeMenus();
      document.body.classList.remove("nav-open");
      burger.innerHTML = Icons.ui("menu");
      if (a.dataset.tool) return openToolModal(a.dataset.tool);
      if (a.dataset.page) return go(a.dataset.page);
      if (a.dataset.action === "pipeline") return openPipelineModal();
      const id = (a.getAttribute("href") || "").split("#")[1];
      if (activeTool) closeModal("universalModal");
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ---------- Search: an icon that opens a box with instant results ----------

  function setupSearch() {
    const wrap = document.getElementById("navSearch");
    const input = document.getElementById("toolSearch");
    const toggle = document.getElementById("searchToggle");
    toggle.addEventListener("click", () => {
      const open = !wrap.classList.contains("open");
      wrap.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      if (open) input.focus(); else { input.value = ""; input.dispatchEvent(new Event("input")); hideResults(); }
    });
    input.addEventListener("input", () => showResults(input.value));
    input.addEventListener("keydown", (e) => {
      const items = [...document.querySelectorAll("#searchResults a")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
      if (e.key === "Enter" && items.length) { e.preventDefault(); items[0].click(); }
    });
    document.getElementById("searchResults").addEventListener("keydown", (e) => {
      const items = [...document.querySelectorAll("#searchResults a")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[i]).focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || input).focus(); }
    });
  }

  // Words people type that mean the same thing, so "combine jpeg", "join photos" and "merge png" all land.
  const SYNONYMS = {
    combine: "merge", join: "merge", unite: "merge", jpeg: "jpg", photo: "image", photos: "image",
    picture: "image", pictures: "image", pics: "image", pic: "image", images: "image", imgs: "image", img: "image",
    pdfs: "pdf", shrink: "compress", reduce: "compress", smaller: "compress", minimize: "compress",
    divide: "split", separate: "split", turn: "rotate", sign: "sign", signature: "sign", erase: "remove", bg: "background", backdrop: "background",
  };
  const STOP = new Set(["to", "into", "a", "an", "the", "my", "and", "of", "in", "file", "files", "make", "how", "i", "can", "with", "for", "multiple", "many", "all"]);
  const norm = (w) => SYNONYMS[w] || w;
  function hayOf(t) {
    if (!t._hay) {
      const raw = `${t.name} ${t.keywords || ""} ${t.desc} ${t.slug.replace(/-/g, " ")}`.toLowerCase();
      t._hay = raw + " " + raw.split(/[^a-z0-9]+/).map(norm).join(" ");
      t._kw = (t.keywords || "").toLowerCase();
    }
    return t._hay;
  }
  function score(t, words, partial) {
    const name = t.name.toLowerCase(), hay = hayOf(t);
    // The exact phrase in a tool's keywords ("png to jpg") beats scattered word matches.
    let s = t._kw.includes(words.join(" ")) && words.length > 1 ? 10 : 0, hit = 0;
    const terms = words.filter((w) => !STOP.has(w));
    for (const w of terms.length ? terms : words) {
      const n = norm(w);
      if (!hay.includes(w) && !hay.includes(n)) { if (partial) continue; return 0; }
      hit++;
      s += name.includes(w) || name.includes(n) ? 3 : t._kw.includes(w) || t._kw.includes(n) ? 2 : 1;
    }
    return hit ? s + hit * 4 : 0;
  }

  /** Best tools for what someone typed: { hits: [[score, tool]], close } (close = no exact match). */
  function rank(q, max = 8) {
    const words = q.toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
    if (!words.length) return { hits: [], close: false };
    const run = (partial) => TOOLS.map((t) => [score(t, words, partial), t]).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, max);
    let hits = run(false), close = false;
    if (!hits.length) { hits = run(true); close = hits.length > 0; }
    return { hits, close };
  }

  function showResults(q) {
    const box = document.getElementById("searchResults");
    if (!q.trim()) return hideResults();
    const { hits, close } = rank(q);
    box.innerHTML = hits.length
      ? (close ? `<p class="search-note">No exact match. Closest tools:</p>` : "") +
        hits.map(([, t]) => `<a href="/${t.slug}" data-tool="${t.id}" role="option">${Icons.tool(t, "ti-sm")}<span><strong>${esc(t.name)}</strong><small>${esc(t.desc)}</small></span></a>`).join("")
      : `<p class="search-empty">No tool matches “${esc(q)}”. <a href="#" data-feedback="request">Ask for it</a></p>`;
    box.hidden = false;
    const fb = box.querySelector("[data-feedback]");
    if (fb) fb.addEventListener("click", (e) => { e.preventDefault(); Feedback.openForm("request"); });
  }
  function hideResults() { const box = document.getElementById("searchResults"); if (box) box.hidden = true; }

  // ---------- FAQ ----------

  const GENERAL = () => {
    const local = TOOLS.filter(isLocal).length;
    return [
      ["Is it really free?", `Yes. Every tool is free with no sign-up, no watermarks and no "premium" tier. ${N} is kept running by donations and sponsors. To keep it fair for everyone, each person can run about 60 server jobs an hour; tools that run in your browser have no limit at all.`],
      ["Are my files safe? Do you see them?", `${local} of the ${TOOLS.length} tools run completely inside your browser, so the file never leaves your device; these are marked “Runs on your device” with a padlock. The others (marked “Server, deleted after”) send the file over an encrypted HTTPS connection to our server, which processes it in memory and deletes it as soon as you have the result. Nobody looks at your files.`],
      ["Do you keep a copy of my files?", "No. Files are never written to a database or kept after your download is ready. Browser tools never upload them in the first place."],
      ["How big can my file be?", "Server tools accept up to 100 MB per upload. Browser tools have no fixed limit; very large files (several hundred MB) depend on your device's memory."],
      ["How do I merge 100 PNG or JPG images into one PDF, in the right order?", `Open <a href="/jpg-to-pdf" data-tool="img-to-pdf">JPG &amp; PNG to PDF</a> and drop all the images at once. Pick the order from the list: date taken or saved (oldest or newest first), file name A to Z or Z to A (img2 comes before img10), or drag the pictures yourself. Then press Make PDF. Browsers can't read a file's creation date, so the date comes from the photo's camera info, or else the date the file was last saved.`],
      ["Do I need to make an account?", "No. There are no accounts, logins or emails needed for any tool."],
      ["Will my PDF get a watermark?", "Never. What you download is exactly your result, with nothing added."],
      ["Does it work on my phone?", `Yes. Every tool works in a phone browser, and Scan to PDF uses your camera. You can also install ${N} like an app: in Chrome tap ⋮ → "Add to Home screen" (on iPhone, Share → "Add to Home Screen").`],
      ["Can I use it offline?", "After your first visit, every tool marked “Runs on your device” keeps working without internet. Tools marked “Server” need a connection."],
      ["Which browsers are supported?", "Recent Chrome, Edge, Firefox, Safari and Samsung Internet. A few extras need Chrome or Edge: saving AVIF images, and the on-device Summarize and Translate tools."],
      ["Why is a conversion taking a while?", "Word, Excel and PowerPoint conversions open the file in a full office program on the server, which can take 10 to 60 seconds for big files. The progress bar shows each step, and you can cancel any time."],
      ["My PDF has a password. Can you open it?", "If you know the password, use Unlock PDF to remove it, then use any other tool. We can't open PDFs without the password and never try to break them."],
      ["How do I make a photo or signature the right size for JEE, NEET, SSC or UPSC?", "Open Exam Photo & Signature Resizer, pick your exam, drag the box over your face or signature, and press Save. It hits the exact pixel size, KB range and DPI the form asks for. Forms change their rules each year, so check the latest official notice and adjust the numbers if needed."],
      ["How do I get a file under 50 KB, 100 KB or any size?", "Use Compress Any File and type your limit in \"Target size in KB\". Photos are re-saved at the best quality that fits; for exam photos with an exact pixel size, use the Exam Photo resizer instead."],
      [`Is ${N} open source?`, `Yes, under the AGPL-3.0 licence. ${real(BRAND.source_code_url) ? `The code is at <a href="${esc(BRAND.source_code_url)}" target="_blank" rel="noopener">${esc(BRAND.source_code_url)}</a>.` : "Anyone can read, check and improve the code."}`],
      ["Do you use cookies or tracking?", "No tracking cookies, no ads and no analytics. Your browser only remembers small settings such as dark or light mode."],
      ["Something didn't work. How do I report it?", `Use <a href="#" data-feedback="problem">Report a problem</a> at the bottom of any page, or write to ${email()}. Please don't send private documents; describe what happened instead.`],
      ["How can I support the project?", `Use the <a href="/#support">Donate</a> buttons, tell your friends, or rate the tools you use. Companies and coaching institutes can sponsor ${N}.`],
    ];
  };

  // Extra details for tools where people usually have a specific question.
  const EXTRA = {
    compress: "Recommended keeps text sharp and brings images to 150 dpi; Extreme goes to 72 dpi for the smallest file. Text-only PDFs are often already small and shrink less.",
    "compress-any": "Photos are re-saved smaller, PDFs go through the PDF compressor, Word/Excel/PowerPoint files have their pictures shrunk inside, and anything else is zipped. Set a target in KB if a form has a limit.",
    "photo-resize": "Presets include JEE Main (photo 10–300 KB, signature 10–50 KB), NEET, SSC, UPSC and passport photos. You can also clean a signature's background to pure white and add your name and date under the photo.",
    "image-convert": "Converts between JPG, PNG, WebP, AVIF, BMP, ICO and PDF, and turns PDF pages into images. iPhone HEIC photos open in Safari; elsewhere set the camera to \"Most Compatible\".",
    "img-to-pdf": "Add as many JPG, PNG, WebP or other images as you like (100+ works) and they become one PDF, one image per page. Choose the order: date taken or saved (oldest or newest first), file name A to Z or Z to A, or drag pictures into your own order. Dates come from the camera info inside a photo when it has one, otherwise the date the file was last saved, because browsers cannot read a file's creation date. Nothing is uploaded.",
    ocr: "OCR reads the text in scanned pages and adds an invisible text layer, so you can search, select and copy. Pick the document's language for the best results.",
    "word-to-pdf": "Fonts, tables, images and page layout are kept. The first conversion after the server starts can take a few extra seconds.",
    "excel-to-pdf": "Every column is fitted across the page width (landscape when the sheet is wide), so no columns get cut off.",
    "powerpoint-to-pdf": "Every slide becomes one page. Animations and videos become still pictures.",
    "pdf-to-docx": "Works best with PDFs that contain real text. For scans, run OCR first.",
    protect: "Choose a password; the PDF is encrypted so it can't be opened without it. Keep the password safe, nobody can recover it for you.",
    unlock: "You need to know the current password. The tool removes it so the PDF opens without one.",
    redact: "Redaction really deletes the text and images under the black boxes, not just covers them, so they can't be copied out later.",
    sign: "Draw, type or upload your signature and place it on the page. This is a visual signature, not a certificate-based digital signature.",
    scan: "Take photos of pages; the tool finds the edges, straightens and cleans them, and saves one PDF.",
    summarize: "Runs on your device. Chrome and Edge can use their built-in AI; other browsers get a summary made from the document's key sentences.",
    translate: "Uses the translator built into Chrome. The first time, Chrome may download the language pack.",
    audio: "Reads the PDF aloud with your device's voices. Pick a voice and speed, and follow along as the words are highlighted.",
    "pdf-to-pdfa": "PDF/A is the archive format many courts, universities and government portals ask for.",
    repair: "Rebuilds damaged PDFs that won't open, and tells you what it fixed.",
    "privacy-check": "Finds hidden personal data such as names in metadata, hidden text, emails and phone numbers, and removes them with one click.",
    compare: "Shows text changes side by side in red and green, plus a visual difference view page by page.",
  };

  function toolAnswer(t) {
    const files = t.multipleFiles ? "your files" : "your file";
    const accepts = typeof acceptLabel === "function" ? acceptLabel(t) : "files";
    const action = t.actionLabel || (t.renderResult ? "Run" : "Save & download");
    const where = isLocal(t)
      ? "It runs entirely in your browser, so your file is never uploaded."
      : "Your file is sent over HTTPS, processed in memory on our server and deleted straight away.";
    return `${esc(t.desc)} Open <a href="/${t.slug}" data-tool="${t.id}">${esc(t.name)}</a>, add ${files} (${esc(accepts)}), choose the options and press “${esc(action)}”. ${where}${EXTRA[t.id] ? " " + EXTRA[t.id] : ""}`;
  }

  function buildFaq() {
    const body = document.getElementById("faqBody");
    const qa = (q, a) => `<details class="faq-item"><summary>${q}</summary><div class="faq-a">${a}</div></details>`;
    const groups = [`<div class="faq-group"><h3>General</h3>${GENERAL().map(([q, a]) => qa(esc(q), a)).join("")}</div>`];
    for (const [cat, label] of Object.entries(CATEGORIES)) {
      const list = TOOLS.filter((t) => t.category === cat);
      if (!list.length) continue;
      groups.push(`<div class="faq-group"><h3>${Icons.category(cat, "ci-plain")} ${esc(label)}</h3>${list.map((t) => qa(`How does ${esc(t.name)} work?`, toolAnswer(t))).join("")}</div>`);
    }
    body.innerHTML = groups.join("");
    body.querySelectorAll("[data-feedback]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); Feedback.openForm(a.dataset.feedback); }));
    document.getElementById("faqSearch").addEventListener("input", (e) => {
      const words = e.target.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      body.querySelectorAll(".faq-item").forEach((d) => {
        const text = d.textContent.toLowerCase();
        const show = words.every((w) => text.includes(w));
        d.hidden = !show;
        if (words.length && show) d.open = true;
      });
      body.querySelectorAll(".faq-group").forEach((g) => { g.hidden = !g.querySelector(".faq-item:not([hidden])"); });
    });
    // Search engines can show these answers directly in results.
    const ld = document.createElement("script");
    ld.type = "application/ld+json";
    ld.textContent = JSON.stringify({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: GENERAL().map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })),
    });
    document.head.appendChild(ld);
  }

  // ---------- About, privacy, terms... ----------

  const UPDATED = "12 October 2026";
  const PAGES = {
    about: ["About us", () => `
      <p>${N} is a free, open-source set of tools for PDFs, images and every other kind of file: merge, split, compress, convert, sign, OCR, resize photos for exam forms and much more.</p>
      <p>We built it because simple file jobs shouldn't need an account, a subscription or uploading private documents to a stranger's server. Most tools run right in your browser; the rest are processed in memory and never stored.</p>
      <p>${N} is free for everyone and paid for by <a href="/#support">donations and sponsors</a>. The code is open under the AGPL-3.0 licence.</p>`],
    contact: ["Contact us", () => `
      <p>Found a bug or want a new tool? Use <a href="#" data-feedback="problem">Report a problem</a> or <a href="#" data-feedback="request">Request a tool</a>; we read every message.</p>
      <p>For anything else, including sponsorship and press, write to ${email()}.</p>`],
    privacy: ["Privacy policy", () => `
      <p class="muted">Last updated ${UPDATED}</p>
      <h4>Your files</h4>
      <p>Tools marked “Runs on your device” process files inside your browser. Those files are never uploaded.</p>
      <p>Tools marked “Server, deleted after” send the file to our server over HTTPS. It is processed in memory or in a temporary folder, returned to you, and deleted immediately. We do not keep, read, share or train anything on your files.</p>
      <h4>What we do collect</h4>
      <ul>
        <li><strong>Ratings and messages you choose to send</strong> (the star rating, your comment, and an email address only if you type one). No file content is ever included.</li>
        <li><strong>Basic server logs</strong> (IP address, the page or tool requested and the time), kept briefly to stop abuse and keep the service running.</li>
      </ul>
      <p>We use no advertising, no analytics trackers and no tracking cookies, and we never sell data.</p>
      <h4>Your choices</h4>
      <p>To have a message you sent deleted, contact ${email()}.</p>`],
    terms: ["Terms of use", () => `
      <p class="muted">Last updated ${UPDATED}</p>
      <p>${N} is provided free of charge, as is, without warranties of any kind. Always keep a copy of your original files.</p>
      <ul>
        <li>Only process files you have the right to use.</li>
        <li>Don't use the service for anything illegal, or try to overload, attack or reverse the limits of the servers.</li>
        <li>You keep all rights to your files and results. We claim nothing.</li>
        <li>We may change or stop any tool at any time, and may limit use that harms the service for others.</li>
        <li>To the extent the law allows, we are not liable for lost data, damages or results that don't meet a requirement, such as a form's file rules. Check results before you submit them.</li>
      </ul>
      <p>The software is open source under the AGPL-3.0 licence.</p>`],
    security: ["Security", () => `
      <ul>
        <li><strong>Browser tools</strong> never send your file anywhere; it stays in your device's memory.</li>
        <li><strong>Server tools</strong> use encrypted HTTPS connections. Files are processed in memory or temporary folders and deleted as soon as the result is sent.</li>
        <li>Uploads are size-limited and rate-limited to protect the service.</li>
        <li>Redaction removes the content under the boxes for real, and Privacy Check finds hidden personal data before you share a PDF.</li>
        <li>The code is open source, so anyone can check how files are handled.</li>
      </ul>
      <p>Found a security problem? Please write to ${email()} before sharing it publicly.</p>`],
    cookies: ["Cookies", () => `
      <p>${N} uses no tracking or advertising cookies.</p>
      <p>Your browser stores a few small settings on your own device: your dark/light choice, which tools you've already rated, and offline copies of the app so it loads fast and works without internet. You can clear them any time in your browser's settings.</p>`],
  };

  function openInfo(slug) {
    const page = PAGES[slug];
    if (!page) return false;
    document.getElementById("infoTitle").textContent = page[0];
    const body = document.getElementById("infoBody");
    body.innerHTML = page[1]();
    body.querySelectorAll("[data-feedback]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); closeInfo(); Feedback.openForm(a.dataset.feedback);
    }));
    document.getElementById("infoModal").classList.add("open");
    document.title = `${page[0]} | ${N}`;
    return true;
  }
  function closeInfo(push = true) {
    const m = document.getElementById("infoModal");
    if (!m || !m.classList.contains("open")) return;
    m.classList.remove("open");
    if (push && PAGES[location.pathname.slice(1)]) history.pushState({}, "", "/");
  }

  function go(slug) {
    if (activeTool) closeModal("universalModal", { push: false });
    if (slug === "faq") {
      closeInfo(false);
      if (location.pathname !== "/faq") history.pushState({}, "", "/faq");
      document.getElementById("faq").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (openInfo(slug) && location.pathname !== `/${slug}`) history.pushState({}, "", `/${slug}`);
  }

  /** Called by app.js for addresses that aren't tools. Returns true when handled. */
  function route(slug) {
    if (slug === "faq") {
      closeInfo(false);
      requestAnimationFrame(() => document.getElementById("faq").scrollIntoView());
      return true;
    }
    if (PAGES[slug]) return openInfo(slug);
    closeInfo(false);
    return false;
  }

  document.addEventListener("DOMContentLoaded", () => {
    buildMenus();
    setupNav();
    setupSearch();
    buildFaq();
    document.getElementById("infoClose").addEventListener("click", () => closeInfo());
    document.getElementById("infoModal").addEventListener("click", (e) => { if (e.target.id === "infoModal") closeInfo(); });
  });

  return { route, go, openInfo, rank, BRAND };
})();
