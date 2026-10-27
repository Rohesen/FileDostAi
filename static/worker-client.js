// Runs ClientPDF operations in pdf-worker.js and falls back to the page itself if workers are unavailable.
const PdfWorker = (() => {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  // Same ?v= as this script, so the worker's pdf-lib comes from the copy the page already downloaded.
  const version = (document.currentScript && new URL(document.currentScript.src).search) || "";

  function start() {
    if (worker || typeof Worker === "undefined") return worker;
    try {
      worker = new Worker(`/static/pdf-worker.js${version}`);
      worker.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.ok) p.resolve(data.result);
        else p.reject(data.userError ? new ClientPDF.UserError(data.message) : new Error(data.message));
      };
      worker.onerror = (e) => {
        for (const p of pending.values()) p.reject(new Error(e.message || "Worker failed"));
        pending.clear();
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
    return worker;
  }

  function run(op, ...args) {
    const w = start();
    if (!w) return ClientPDF[op](...args);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  }

  // Start the worker while the user is still picking files, so its scripts are ready by the first click.
  function warm() { start(); }

  return { run, warm };
})();
