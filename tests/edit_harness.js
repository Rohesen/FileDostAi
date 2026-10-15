// Runs the Edit PDF operation (static/edit-ops.js) under Node so the Python tests can check its output.
// Usage: node edit_harness.js <in.pdf> <out.pdf> <edits.json>
// In the edits JSON, { "$file": "/path/to/image.png" } stands for that file's bytes (a Uint8Array).
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "..", "static");
globalThis.PDFLib = require(path.join(STATIC, "vendor", "pdf-lib.min.js"));
globalThis.ClientPDF = require(path.join(STATIC, "client-tools.js"));
require(path.join(STATIC, "edit-ops.js"));

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    if (typeof value.$file === "string") return new Uint8Array(fs.readFileSync(value.$file));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

async function main() {
  const [input, output, editsPath] = process.argv.slice(2);
  const edits = revive(JSON.parse(fs.readFileSync(editsPath, "utf8")));
  const result = await ClientPDF.applyEdits(new Uint8Array(fs.readFileSync(input)), edits);
  fs.writeFileSync(output, result.bytes);
  process.stdout.write(JSON.stringify({ filename: result.filename, mime: result.mime, size: result.bytes.length }));
}

main().catch((e) => {
  process.stderr.write(`${e instanceof ClientPDF.UserError ? "USER_ERROR" : "ERROR"}: ${e.message}\n`);
  process.exit(1);
});
