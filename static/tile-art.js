// A 3D hologram stage across the top of each tool card: the tool's icon glows and floats over a
// spinning neon ring, with a one-line caption of what you get. scene() keeps the older paper scenes.
// Pure CSS animation (holo.css); paused while a card is off screen or when motion is reduced.

const TileArt = (() => {
  const KIND = {
    merge: "merge", split: "split", organize: "shuffle", "remove-pages": "remove", rotate: "rotate",
    compress: "squash", "compress-any": "squash", scan: "scan", ocr: "ocr", "privacy-check": "check",
    repair: "repair", sign: "sign", edit: "write", protect: "lock", unlock: "unlock", redact: "redact",
    flatten: "flatten", watermark: "stamp", "page-numbers": "number", "header-footer": "number",
    crop: "crop", "photo-resize": "crop", resize: "resize", invert: "invert", metadata: "tag",
    compare: "compare", summarize: "summary", audio: "audio", "ai-analyze": "read",
  };
  const FLIP = {
    "img-to-pdf": ["PNG", "PDF"], "image-convert": ["PNG", "JPG"], "word-to-pdf": ["DOC", "PDF"],
    "excel-to-pdf": ["XLS", "PDF"], "powerpoint-to-pdf": ["PPT", "PDF"], "markdown-to-pdf": ["MD", "PDF"],
    "pdf-to-jpg": ["PDF", "JPG"], "pdf-to-text": ["PDF", "TXT"], "pdf-to-docx": ["PDF", "DOC"],
    "pdf-to-excel": ["PDF", "XLS"], "pdf-to-powerpoint": ["PDF", "PPT"], "pdf-to-pdfa": ["PDF", "PDF/A"],
    translate: ["A", "अ"],
  };
  // One line under each scene saying what you get.
  const CAPTION = {
    merge: "Many PDFs → one", split: "One PDF → many", organize: "Drag pages into order",
    "remove-pages": "Drop unwanted pages", rotate: "Turn pages 90° at a time", compress: "Smaller PDF, same look",
    "img-to-pdf": "100+ images → 1 PDF", "image-convert": "PNG · JPG · WebP · AVIF", "photo-resize": "Exact pixels & KB",
    "compress-any": "Any file, smaller", scan: "Camera → clean PDF", "word-to-pdf": "DOCX → PDF",
    "excel-to-pdf": "Every column fits", "powerpoint-to-pdf": "Slides → PDF", "markdown-to-pdf": "MD · HTML · CSV → PDF",
    "pdf-to-jpg": "Pages → images", "pdf-to-text": "Pull out all the text", "pdf-to-docx": "Editable Word file",
    "pdf-to-excel": "Tables → spreadsheet", "pdf-to-powerpoint": "Pages → slides", "pdf-to-pdfa": "Safe for archives",
    ocr: "Scans → searchable text", repair: "Fix damaged PDFs", sign: "Draw, type or upload",
    edit: "Add text, shapes, images", protect: "Lock with a password", unlock: "Remove the password",
    redact: "Black out text for real", "privacy-check": "Find hidden data", flatten: "Fix forms in place",
    watermark: "Stamp every page", "page-numbers": "1 · 2 · 3 …", crop: "Trim the margins", resize: "A4 · Letter · any size",
    "header-footer": "Text on every page", invert: "Easy on the eyes", metadata: "Title · author · tags",
    compare: "Spot every change", summarize: "Key points in seconds", translate: "Into any language",
    audio: "Listen instead", "ai-analyze": "Stats & insights",
  };
  const COLORS = {
    organize: ["#6366f1", "#06b6d4"], edit: ["#f59e0b", "#ef4444"], convert: ["#10b981", "#06b6d4"],
    image: ["#ec4899", "#f59e0b"], optimize: ["#06b6d4", "#6366f1"], security: ["#ef4444", "#a855f7"],
    ai: ["#a855f7", "#06b6d4"],
  };

  function scene(tool) {
    const flip = tool.flip || FLIP[tool.id];
    const kind = flip ? "flip" : tool.scene || KIND[tool.id] || "float";
    const label = (t) => (t ? ` data-l="${t}"` : "");
    return `
      <div class="tile3d k-${kind}" aria-hidden="true">
        <div class="t3-rig">
          <span class="t3-sheet a"${label(flip && flip[0])}></span>
          <span class="t3-sheet b"${label(flip && flip[1])}></span>
          <span class="t3-sheet c"></span>
          <span class="t3-fx"></span>
          <span class="t3-icon">${typeof Icons !== "undefined" ? Icons.tool(tool) : tool.icon}</span>
        </div>
      </div>`;
  }

  /** The card's stage: the tool's icon as a glowing hologram over a spinning neon ring,
      with a light beam, a scan line, sparks and a one-line caption of what you get. */
  function html(tool, badgeHtml = "") {
    const [c1, c2] = colors(tool);
    const cap = tool.caption || CAPTION[tool.id];
    const glyph = typeof Icons !== "undefined" ? Icons.glyph(tool) : tool.icon;
    return `
      <div class="tile-stage holo-stage" style="--c1:${c1};--c2:${c2}">
        <div class="holo" aria-hidden="true">
          <span class="h-floor"></span>
          <span class="h-scan"></span>
          <span class="h-ring"></span><span class="h-ring r2"></span>
          <span class="h-beam"></span>
          <span class="h-ico">${glyph}</span>
          <span class="h-dot d1"></span><span class="h-dot d2"></span><span class="h-dot d3"></span>
        </div>
        ${badgeHtml}
        ${cap ? `<span class="ts-cap">${cap}</span>` : ""}
      </div>`;
  }

  let observer = null;
  const mark = (el, on) => {
    el.classList.toggle("in-view", on);
    const t = el.querySelector(".tile3d, .holo");
    if (t) t.classList.toggle("in-view", on);
  };
  function watch(grid) {
    const stages = grid.querySelectorAll(".tile-stage");
    if (!("IntersectionObserver" in window)) {
      stages.forEach((s) => mark(s, true));
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        entries.forEach((e) => mark(e.target, e.isIntersecting));
      }, { rootMargin: "80px" });
    }
    stages.forEach((s, i) => {
      s.style.setProperty("--delay", `${-(i % 7) * 0.45}s`);
      observer.observe(s);
    });
  }

  function colors(tool) {
    if (typeof Icons !== "undefined") return Icons.colors(tool.category);
    return COLORS[tool.category] || COLORS.organize;
  }
  return { html, scene, watch, colors, CAPTION };
})();
