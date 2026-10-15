// FileDost AI's own icon set: one line icon per tool, drawn on a 24×24 grid with round 1.8px
// strokes, shown white on a rounded tile coloured by category (like the category colours on
// the menu and the tabs). Also the few interface icons (search, heart, download...), so the
// site doesn't lean on emoji. Everything is inline SVG: no requests, sharp at any size.

const Icons = (() => {
  // Category colours: tile gradient [from, to].
  const CAT = {
    organize: ["#f0643f", "#e0452a"],
    edit: ["#a463e8", "#8446d6"],
    convert: ["#f5a524", "#e8870b"],
    image: ["#16b4a6", "#0e958a"],
    optimize: ["#34b864", "#22984d"],
    security: ["#3f83f8", "#2563eb"],
    ai: ["#7c6cf8", "#5b4be6"],
  };
  const CAT_LABEL = { organize: "Organize", edit: "Edit & Sign", convert: "Convert", image: "Images", optimize: "Optimize", security: "Security", ai: "Read & Compare" };

  // Pieces used by several icons.
  const DOC = "M8 3h8l4 4v14H8z M16 3v4h4";            // page with a folded corner, right side
  const IN = "M2 12h5 M5 9.8 7.2 12 5 14.2";           // arrow going into the page (to PDF)
  const OUT = "M7.5 12H2 M4.2 9.8 2 12l2.2 2.2";       // arrow coming out of the page (from PDF)
  const G = {                                           // glyphs drawn inside DOC
    word: "M10.6 10.5l1.1 5.5 2.3-4.2 2.3 4.2 1.1-5.5",
    excel: "M11.5 10.5l5 6.5 M16.5 10.5l-5 6.5",
    ppt: "M12 17.5v-7h2.6a2 2 0 0 1 0 4H12",
    img: "M10.5 17l2.4-2.8 1.8 1.8 1.2-1.2 2 2.2 M16.2 11.2h.01",
    text: "M11 10.5h6 M11 13.5h6 M11 16.5h3.5",
    code: "M12.6 10.5 10.6 13.5l2 3 M15.4 10.5l2 3-2 3",
    a: "M11.3 17.5 14 10.5l2.7 7 M12.2 15.2h3.6",
  };
  const doc = (glyph, arrow) => `<path d="${DOC}"/><path d="${glyph}"/>${arrow ? `<path d="${arrow}"/>` : ""}`;
  const P = (d) => `<path d="${d}"/>`;

  const TOOL = {
    // Organize
    merge: P("M3 3.5h7v8H3z M14 3.5h7v8h-7z M6.5 11.5v2a2.5 2.5 0 0 0 2.5 2.5h6a2.5 2.5 0 0 0 2.5-2.5v-2 M12 16v4.5 M9.8 18.3 12 20.5l2.2-2.2"),
    split: P("M8 3h8v8H8z M12 11v3 M12 14l-6.5 6.5 M12 14l6.5 6.5 M5.5 16.5v4h4 M18.5 16.5v4h-4"),
    organize: P("M3 3h7v8H3z M14 13h7v8h-7z M14 6.5h2.5a2.5 2.5 0 0 1 2.5 2.5v1.5 M17 8.8l2 2 2-2 M10 17.5H7.5A2.5 2.5 0 0 1 5 15v-1.5 M3 15.2l2-2 2 2"),
    "remove-pages": doc("M10.8 11l5.4 5.4 M16.2 11l-5.4 5.4"),
    rotate: P("M9 8h8v12H9z M3.5 13A8.5 8.5 0 0 1 17 4.6 M17.5 1.5v3.6h-3.6"),
    "n-up": P("M4 3h16v18H4z M7 6h4v5H7z M13 6h4v5h-4z M7 13h4v5H7z M13 13h4v5h-4z"),
    booklet: P("M12 6.5C9.8 5 6.6 4.5 3 5v14c3.6-.5 6.8 0 9 1.5 2.2-1.5 5.4-2 9-1.5V5c-3.6-.5-6.8 0-9 1.5z M12 6.5v14"),
    "split-by-bookmarks": P("M5 3h14v18H5z M9.5 3v6.5l2.5-1.8 2.5 1.8V3 M2.5 14.5h2 M7.5 14.5h3 M13.5 14.5h3 M19.5 14.5h2"),
    recipes: P("M3 4h6v6H3z M15 4h6v6h-6z M9 14h6v6H9z M9 7h6 M18 10v2.5a1.5 1.5 0 0 1-1.5 1.5H15 M6 10v2.5A1.5 1.5 0 0 0 7.5 14H9"),

    // Edit & sign
    sign: P("M15 3.5l4.5 4.5-9 9H6v-4.5z M12.5 6l4.5 4.5 M3 21c1.4-1.6 2.8-1.6 4 0s2.6 1.6 4 0 2.6-1.6 4 0"),
    edit: P("M12 3H5v18h13v-8 M19 2.5l2.5 2.5-8 8H11v-2.5z"),
    watermark: doc("M14 9.2c-2 2.4-3 4-3 5.3a3 3 0 0 0 6 0c0-1.3-1-2.9-3-5.3z"),
    "page-numbers": doc("M12.3 10l-.9 7.5 M15.3 10l-.9 7.5 M10.5 12.5h6.5 M10 15h6.5"),
    crop: P("M7 2v15h15 M2 7h15v15"),
    resize: P("M3 10h11v11H3z M13 3h8v8 M21 3l-8 8"),
    "header-footer": P("M5 3h14v18H5z M8 6.5h8 M8 17.5h8 M8 11h8 M8 13.5h5"),
    invert: P("M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"),
    metadata: P("M3 12.5V4a1 1 0 0 1 1-1h8.5l9 9-9.5 9.5z M7.5 7.5h.01"),
    "pdf-bookmarks": P("M6.5 3h11v18l-5.5-4.2L6.5 21z"),
    "fill-form": P("M4 3h16v18H4z M7 7h3v3H7z M13 8.5h4 M7 14h3v3H7z M7.6 15.6l.9.9 1.6-1.9 M13 15.5h4"),
    "trim-media": P("M8.2 7.5 20 17.5 M8.2 16.5 20 6.5 M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),

    // Convert
    "img-to-pdf": doc(G.img, IN),
    scan: P("M3.5 8V5a1.5 1.5 0 0 1 1.5-1.5h3 M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3 M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3 M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3 M2.5 12h19"),
    "word-to-pdf": doc(G.word, IN),
    "excel-to-pdf": doc(G.excel, IN),
    "powerpoint-to-pdf": doc(G.ppt, IN),
    "markdown-to-pdf": doc(G.code, IN),
    "pdf-to-jpg": doc(G.img, OUT),
    "pdf-to-text": doc(G.text, OUT),
    "pdf-to-docx": doc(G.word, OUT),
    "pdf-to-excel": doc(G.excel, OUT),
    "pdf-to-powerpoint": doc(G.ppt, OUT),
    "pdf-to-pdfa": doc(G.a, IN),
    "extract-images": P("M3 8h13v12H3z M7 4.5h12.5a1.5 1.5 0 0 1 1.5 1.5v10.5 M3 17l3.5-3.5 3 3 2-2L16 19 M12 11.5h.01"),
    "video-to-mp3": P("M9 18V5.5l11-2V16 M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 18.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),

    // Images
    "image-convert": P("M4 10a8 8 0 0 1 14.6-4.5 M20 14a8 8 0 0 1-14.6 4.5 M18.8 2v3.8H15 M5.2 22v-3.8H9 M9.5 9.5h5v5h-5z"),
    "photo-resize": P("M2.5 5h19v14h-19z M8 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M5 16.5c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4 M14 10h4.5 M14 13.5h3"),
    "exam-form-kit": P("M2 9l10-5 10 5-10 5z M6 11v5c3.3 2.6 8.7 2.6 12 0v-5 M22 9v5"),
    "heic-to-jpg": P("M6 2h12v20H6z M10.5 19h3 M8.5 14.5l2.3-2.5 2 2 1.5-1.5 1.7 2 M14.5 7.5h.01"),
    "remove-bg": P("M3 7.5V5a2 2 0 0 1 2-2h2.5 M16.5 3H19a2 2 0 0 1 2 2v2.5 M21 16.5V19a2 2 0 0 1-2 2h-2.5 M7.5 21H5a2 2 0 0 1-2-2v-2.5 M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6.8 18c.8-2.4 2.8-3.7 5.2-3.7s4.4 1.3 5.2 3.7"),
    "image-to-text": P("M3 7.5V5a2 2 0 0 1 2-2h2.5 M16.5 3H19a2 2 0 0 1 2 2v2.5 M21 16.5V19a2 2 0 0 1-2 2h-2.5 M7.5 21H5a2 2 0 0 1-2-2v-2.5 M7.5 8.5h9 M12 8.5v8 M9.5 16.5h5"),
    "jpg-to-word": P(DOC + " " + G.word + " M2 5.5h4.5v4.5H2z M2 9 3.6 7.4l1 1 .9-.9.9 1.1"),
    "upscale-image": P("M3 13h8v8H3z M14 3h7v7 M21 3l-8 8 M14 21h7v-7 M6.5 3H3v3.5"),
    "signature-maker": P("M3 17.5c2.5-6 4.5-9.5 6-9.5 2.5 0-1 9.5 1.5 9.5 1.6 0 2.4-3.4 3.6-3.4 1 0 .6 2.6 1.9 2.6 1 0 1.9-1.1 2.6-1.8 M3 21h18"),
    "remove-exif": P("M12 21.5s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M3 3l18 18"),
    "blur-image": P("M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M5 20.5c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5 M2.5 3.5h.01 M2.5 8h.01 M2.5 12.5h.01 M21.5 3.5h.01 M21.5 8h.01 M21.5 12.5h.01"),
    "watermark-image": P("M3 4h18v14H3z M3 14.5l4.5-4.5 3.5 3.5 2-2 3 3 M15.5 8.5h.01 M13 21l2.2-5 2.2 5 M13.8 19.5h2.8"),
    "video-to-gif": P("M2.5 5h19v14h-19z M9.5 10H7.5a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2v-2H8.5 M12.5 10v4 M15.5 14v-4h3 M15.5 12h2"),
    "compress-gif": P("M2.5 5h19v14h-19z M8.5 9l3.5 3 3.5-3 M8.5 15.5l3.5-3 3.5 3"),
    "reels-resizer": P("M8.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20V4a1.5 1.5 0 0 1 1.5-1.5z M2 9v6 M22 9v6 M11 10v4l3-2z"),
    "media-speed": P("M12 21a8.5 8.5 0 1 1 8.5-8.5 M12 12.5l4-4 M12 13a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z M17 17.5l2.5 2 2.5-2 M19.5 19.5V14"),
    "volume-booster": P("M3 9.5h3.5L11 5.5v13l-4.5-4H3z M15 9a4.5 4.5 0 0 1 0 6 M17.5 6.5a8 8 0 0 1 0 11 M20.5 3v4 M18.5 5h4"),
    "audio-joiner": P("M3 12h2 M6 8.5v7 M9 6v12 M12 10v4 M15 8v8 M18 5.5v13 M21 11v2"),
    "text-diff": P("M4 3h7v18H4z M13 3h7v18h-7z M6.5 8h2.5 M6.5 12h2.5 M15.5 8h2.5 M15.5 12h2.5 M16.75 15v3 M15.25 16.5h3 M6.5 16.5h2.5"),
    "qr-code": P("M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M6 6h1v1H6z M17 6h1v1h-1z M6 17h1v1H6z M14 14h3v3h-3z M20 14v.01 M14 20.5h.01 M17 17.5h4v3.5h-4z"),

    // Optimize
    compress: P("M4 9.5h5.5V4 M20 9.5h-5.5V4 M4 14.5h5.5V20 M20 14.5h-5.5V20"),
    "compress-any": P("M3 4h18v4H3z M5 8v11.5h14V8 M12 10.5v6.5 M9.5 14.5 12 17l2.5-2.5"),
    ocr: P("M3.5 8V5a1.5 1.5 0 0 1 1.5-1.5h3 M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3 M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3 M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3 M8 8.5h8 M12 8.5v8"),
    repair: P("M15 3.5a5 5 0 0 0-4.7 6.7l-6.8 6.8a1.9 1.9 0 0 0 2.7 2.7l6.8-6.8A5 5 0 0 0 19.8 9l-2.8.9-2-2 .9-2.8z"),
    "compress-to-size": P("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z"),
    "zip-tools": P("M6 3h12v18H6z M11 3v2 M13 5v2 M11 7v2 M13 9v2 M10.5 12.5h3V16h-3z"),
    "compress-video": P("M2.5 6h13v12h-13z M15.5 10.5 21.5 7v10l-6-3.5 M6 10l2 2-2 2 M12 10l-2 2 2 2"),

    // Security
    protect: P("M5 10.5h14V21H5z M8 10.5V7a4 4 0 0 1 8 0v3.5 M12 14.5v3"),
    unlock: P("M5 10.5h14V21H5z M8 10.5V7a4 4 0 0 1 7.8-1.3 M12 14.5v3"),
    redact: `<path d="M5 3h14v18H5z M8 17.5h5"/><path d="M8 7h8v2.6H8z M8 11.8h5.5v2.6H8z" fill="currentColor" stroke="none"/>`,
    "privacy-check": P("M12 2.8 20 6v6c0 4.6-3.4 8.2-8 9.2C7.4 20.2 4 16.6 4 12V6z M8.5 12l2.5 2.5 4.5-5"),
    flatten: P("M12 3l9 4.5-9 4.5-9-4.5z M3 12l9 4.5 9-4.5 M3 16.5 12 21l9-4.5"),

    // Read & compare
    compare: P("M3 4h7.5v16H3z M13.5 4H21v16h-7.5z M5.5 8h2.5 M5.5 11.5h2.5 M16 8h2.5 M16 11.5h2.5 M5.5 15h2.5 M16 15h2.5"),
    summarize: P("M3.5 5.5h12 M3.5 9.5h17 M3.5 13.5h9 M3.5 17.5h6 M18 13l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"),
    translate: P("M3.5 5h9 M8 3v2 M5.5 5c.6 3 2.7 5.6 5.6 6.6 M10.6 5c-.7 3.3-3 6.1-6.6 7.2 M12.5 21l4-9.5 4 9.5 M14 17.8h5"),
    audio: P("M3.5 9.5h3.5l4.5-4v13l-4.5-4H3.5z M15.5 9a4 4 0 0 1 0 6 M18.2 6.3a7.6 7.6 0 0 1 0 11.4"),
    "ai-analyze": P("M3.5 20.5h17 M6 12h3v6H6z M10.5 6h3v12h-3z M15 14h3v4h-3z"),
  };

  // Category marks for the menu headings and tabs.
  const CATEGORY = {
    organize: P("M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z"),
    edit: P("M15 3.5l4.5 4.5L9 18.5H4.5V14z M12.5 6l4.5 4.5"),
    convert: P("M4 8.5h14 M14.5 5 18 8.5 14.5 12 M20 15.5H6 M9.5 12 6 15.5 9.5 19"),
    image: P("M3 4.5h18v15H3z M3 16l5-5 4 4 3-3 6 6 M15.5 9h.01"),
    optimize: P("M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"),
    security: P("M12 2.8 20 6v6c0 4.6-3.4 8.2-8 9.2C7.4 20.2 4 16.6 4 12V6z"),
    ai: P("M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9z M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"),
  };

  // Interface icons.
  const UI = {
    search: P("M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z M20.5 20.5l-4.2-4.2"),
    heart: `<path d="M12 20.5s-8-4.6-8-10.5A4.5 4.5 0 0 1 12 7.2 4.5 4.5 0 0 1 20 10c0 5.9-8 10.5-8 10.5z" fill="currentColor" stroke="none"/>`,
    bolt: `<path d="M13.5 2 4.5 13.5H11L10 22l9-11.5h-6.5z" fill="currentColor" stroke="none"/>`,
    menu: P("M4 7h16 M4 12h16 M4 17h16"),
    close: P("M6 6l12 12 M18 6 6 18"),
    folder: P("M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"),
    upload: P("M12 16V4 M7.5 8.5 12 4l4.5 4.5 M4 15v4.5h16V15"),
    download: P("M12 4v12 M7.5 11.5 12 16l4.5-4.5 M4 19.5h16"),
    file: P("M6 3h8l4 4v14H6z M14 3v4h4"),
    files: P("M8 3h8l4 4v12H8z M16 3v4h4 M5 7v14h10"),
    lock: P("M5 10.5h14V21H5z M8 10.5V7a4 4 0 0 1 8 0v3.5"),
    cloud: P("M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9a4.8 4.8 0 0 1-.5 9.5z"),
    sparkle: P("M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9z M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"),
    clock: P("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5V12l3 2"),
    chain: P("M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1 M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"),
    star: P("M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"),
    camera: P("M3 8a1.5 1.5 0 0 1 1.5-1.5h3L9 4h6l1.5 2.5h3A1.5 1.5 0 0 1 21 8v10.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"),
    rotate: P("M20 12a8 8 0 1 1-2.6-5.9 M20.5 3v4.5H16"),
    save: P("M5 3h11l4 4v14H5z M8 3v5h7V3 M8 21v-7h8v7"),
    chat: P("M4 5h16v11H9l-5 4z"),
    rocket: P("M14 4.5c3-1.5 5.5-1.5 5.5-1.5s0 2.5-1.5 5.5L12 14.5 9.5 12z M9.5 12l-4-.5 3-3 3.5.5 M12 14.5l.5 4 3-3-.5-3.5 M6.5 15.5c-1.5.5-2.5 2.5-2.5 4.5 2 0 4-1 4.5-2.5"),
    edit: P("M15 3.5l4.5 4.5L9 18.5H4.5V14z"),
    image: P("M3 4.5h18v15H3z M3 16l5-5 4 4 3-3 6 6 M15.5 9h.01"),
    coffee: P("M4 9h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16 M8 3.5v2.5 M12 3.5v2.5"),
    globe: P("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"),
    rupee: P("M6.5 4h11 M6.5 8.5h11 M9.5 4c2.5 0 4.5 1.7 4.5 4.3S12 12.5 9.5 12.5h-3l8 7.5"),
    phone: P("M7 2h10v20H7z M11 18.5h2"),
    pen: P("M15 3.5l4.5 4.5-9 9H6v-4.5z M3 21c1.4-1.6 2.8-1.6 4 0s2.6 1.6 4 0 2.6-1.6 4 0"),
    archive: P("M3 4h18v4H3z M5 8v11.5h14V8 M10 12h4"),
    music: P("M9 18V5.5l11-2V16 M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 18.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
    video: P("M2.5 6h13v12h-13z M15.5 10.5 21.5 7v10l-6-3.5"),
    table: P("M3 4h18v16H3z M3 9.5h18 M3 15h18 M9 4v16"),
    copy: P("M8.5 8.5h11v12h-11z M15.5 8.5V3.5h-12v12h5"),
    warn: P("M12 3.5 2.5 20h19z M12 10v4.5 M12 17.5h.01"),
  };

  const svg = (inner, size = 24) =>
    `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

  const colors = (cat) => CAT[cat] || CAT.organize;

  /** A tool's icon on its category tile. `cls` adds size classes (ti-sm, ti-lg...). */
  function tool(t, cls = "") {
    const inner = TOOL[t.id];
    const [a, b] = colors(t.category);
    return `<span class="ti ${cls}" style="--ti-a:${a};--ti-b:${b}">${inner ? svg(inner) : `<span class="ti-emoji">${t.icon || ""}</span>`}</span>`;
  }
  /** Just the glyph, no tile (for the 3D card scenes, which have their own tile). */
  const glyph = (t) => (TOOL[t.id] ? svg(TOOL[t.id]) : t.icon || "");
  function category(cat, cls = "") {
    const [a, b] = colors(cat);
    return `<span class="ci ${cls}" style="--ti-a:${a};--ti-b:${b}">${svg(CATEGORY[cat] || CATEGORY.organize)}</span>`;
  }
  const ui = (name, size) => (UI[name] ? svg(UI[name], size) : "");
  const has = (id) => !!TOOL[id];

  /** Fills <span data-ico="name"> and <span data-cat-ico="category"> placeholders in the page. */
  function decorate(root = document) {
    root.querySelectorAll("[data-ico]:not([data-ico-done])").forEach((el) => { el.innerHTML = ui(el.dataset.ico); el.dataset.icoDone = "1"; });
    root.querySelectorAll("[data-cat-ico]:not([data-ico-done])").forEach((el) => { el.outerHTML = category(el.dataset.catIco, el.className); });
    // Donate buttons (support.js is yours to edit, so its emoji are swapped here instead).
    const SUPPORT = { "🇮🇳": "rupee", "☕": "coffee", "💜": "heart", "🌍": "globe" };
    root.querySelectorAll(".support-icon").forEach((el) => {
      if (el.querySelector("svg")) return;
      el.innerHTML = ui(SUPPORT[el.textContent.trim()] || "heart");
    });
  }
  document.addEventListener("DOMContentLoaded", () => decorate());

  return { tool, glyph, category, ui, has, colors, decorate, CAT_LABEL };
})();
