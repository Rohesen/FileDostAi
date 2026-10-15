// Loads pdf.js (used for thumbnails, previews, PDF to image and PDF to text) and exposes it as window.pdfjsLib.
import * as pdfjsLib from "/static/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.mjs";
window.pdfjsLib = pdfjsLib;
window.dispatchEvent(new Event("pdfjs-ready"));
