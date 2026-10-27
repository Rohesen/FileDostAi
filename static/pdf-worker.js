// Background worker for the in-browser tools, so big PDFs never freeze the page.
// Messages in:  { id, op, args }   where op is a ClientPDF function name.
// Messages out: { id, ok: true, result } or { id, ok: false, message, userError }.
// The ?v= this worker was started with is reused so these come straight from the browser cache.
importScripts(...["vendor/pdf-lib.min.js", "vendor/jszip.min.js", "client-tools.js", "edit-ops.js"].map((f) => f + self.location.search));

self.onmessage = async (event) => {
  const { id, op, args } = event.data;
  try {
    const fn = self.ClientPDF[op];
    if (typeof fn !== "function" || op === "UserError") throw new Error(`Unknown operation ${op}`);
    const result = await fn(...args);
    const transfer = result && result.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({
      id, ok: false, message: err.message || String(err),
      userError: err instanceof self.ClientPDF.UserError,
    });
  }
};
