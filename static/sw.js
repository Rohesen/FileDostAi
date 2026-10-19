// Service worker: makes FileDost AI installable and lets the in-browser tools work offline.
// Pages and static files: network first, falling back to the cached copy when offline,
// so an update never mixes old and new files.
// The API is never cached, and no user file ever passes through here.
const VERSION = "filedost-v29";
const CORE = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/tools.js",
  "/static/client-tools.js",
  "/static/worker-client.js",
  "/static/pdf-worker.js",
  "/static/render-tools.js",
  "/static/page-board.js",
  "/static/sign-tool.js",
  "/static/depth.js",
  "/static/edit-tool.js",
  "/static/edit-tool.css",
  "/static/edit-ops.js",
  "/static/scan-tool.js",
  "/static/scan-tool.css",
  "/static/crop-tool.js",
  "/static/compare-tool.js",
  "/static/read-tools.js",
  "/static/feedback.js",
  "/static/privacy-view.js",
  "/static/image-tools.js",
  "/static/image-order.js",
  "/static/form-kit.js",
  "/static/pdf-extras.js",
  "/static/form-fill.js",
  "/static/qr-tool.js",
  "/static/bg-remove.js",
  "/static/bg-remove-worker.js",
  "/static/bg-remove.css",
  "/static/image-text.js",
  "/static/upscale-tool.js",
  "/static/upscale-worker.js",
  "/static/signature-maker.js",
  "/static/new-tools.css",
  "/static/exif-tool.js",
  "/static/blur-tool.js",
  "/static/face-worker.js",
  "/static/watermark-image.js",
  "/static/text-diff.js",
  "/static/media-extra.js",
  "/static/zip-tool.js",
  "/static/media-tool.js",
  "/static/chains.js",
  "/static/form-kit.css",
  "/static/pdf-extras.css",
  "/static/form-fill.css",
  "/static/qr-tool.css",
  "/static/zip-tool.css",
  "/static/media-tool.css",
  "/static/chains.css",
  "/static/photo-tool.js",
  "/static/tile-art.js",
  "/static/tiles.css",
  "/static/support.js",
  "/static/theme.css",
  "/static/theme.js",
  "/static/bg-fx.js",
  "/static/site.js",
  "/static/site.css",
  "/static/home-plus.js",
  "/static/home-plus.css",
  "/static/redesign.css",
  "/static/holo.css",
  "/static/lite.css",
  "/static/icons.js",
  "/static/icons.css",
  "/static/fonts.css",
  "/static/fonts/geist-latin-wght-normal.woff2",
  "/static/fonts/geist-latin-ext-wght-normal.woff2",
  "/static/fonts/geist-mono-latin-wght-normal.woff2",
  "/static/pdfjs-loader.mjs",
  "/static/vendor/pdf-lib.min.js",
  "/static/vendor/jszip.min.js",
  "/static/vendor/pdfjs/pdf.min.mjs",
  "/static/vendor/pdfjs/pdf.worker.min.mjs",
  "/static/icons/icon-192.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // ffmpeg's 31 MB engine is loaded only by the video tools; don't keep a copy in the offline cache.
  if (url.pathname.includes("/vendor/ffmpeg/")) return;
  // Same for the AI runtime and models (background remover, upscaler).
  if (url.pathname.includes("/vendor/bg-remove/") || url.pathname.includes("/vendor/upscale/") || url.pathname.includes("/vendor/faces/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
  }
});
