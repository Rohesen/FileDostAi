// Loads pdf.js (used for thumbnails, previews, PDF to image and PDF to text) and exposes it as window.pdfjsLib.
// PdfRender.ready() imports this on first use; the ?v= of this file is passed on so updates bust the cache.
const version = new URL(import.meta.url).search;
const pdfjsLib = await import(`/static/vendor/pdfjs/pdf.min.mjs${version}`);

pdfjsLib.GlobalWorkerOptions.workerSrc = `/static/vendor/pdfjs/pdf.worker.min.mjs${version}`;
window.pdfjsLib = pdfjsLib;
window.dispatchEvent(new Event("pdfjs-ready"));
