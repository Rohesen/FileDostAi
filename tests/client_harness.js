// Runs one in-browser tool under Node so the Python tests can check its output.
// Usage: node client_harness.js <op> <out_path> <json_options> <input_path>...
const fs = require("fs");
const path = require("path");
const ClientPDF = require(path.join(__dirname, "..", "static", "client-tools.js"));

async function main() {
  const [op, outPath, optsJson, ...inputs] = process.argv.slice(2);
  const opts = JSON.parse(optsJson || "{}");
  const files = inputs.map((p) => new Uint8Array(fs.readFileSync(p)));
  let result;
  switch (op) {
    case "merge": result = await ClientPDF.merge(files); break;
    case "split": result = await ClientPDF.split(files[0], opts.ranges); break;
    case "reorder": result = await ClientPDF.reorder(files[0], opts.order); break;
    case "remove": result = await ClientPDF.removePages(files[0], opts.pages); break;
    case "rotate": result = await ClientPDF.rotate(files[0], opts.angle, opts.pages); break;
    case "watermark": result = await ClientPDF.watermark(files[0], opts); break;
    case "page-numbers": result = await ClientPDF.pageNumbers(files[0], opts); break;
    case "img-to-pdf":
      result = await ClientPDF.imagesToPdf(files.map((bytes, i) => ({
        bytes, type: inputs[i].endsWith(".png") ? "image/png" : "image/jpeg",
      })));
      break;
    case "assemble":
      result = await ClientPDF.assemble(files, opts.plan);
      break;
    case "edit-metadata": result = await ClientPDF.editMetadata(files[0], opts); break;
    case "get-metadata":
      process.stdout.write(JSON.stringify(await ClientPDF.getMetadata(files[0])));
      return;
    case "stamp": {
      const imageBytes = new Uint8Array(fs.readFileSync(opts.image));
      result = await ClientPDF.stampImage(files[0], { imageBytes, imageType: "image/png", placements: opts.placements });
      break;
    }
    case "crop": result = await ClientPDF.crop(files[0], opts); break;
    case "resize": result = await ClientPDF.resize(files[0], opts); break;
    case "header-footer": result = await ClientPDF.headerFooter(files[0], opts); break;
    case "invert": result = await ClientPDF.invertColors(files[0], opts); break;
    case "parse":
      process.stdout.write(JSON.stringify(ClientPDF.parsePageList(opts.spec, opts.total, opts)));
      return;
    default: throw new Error(`unknown op ${op}`);
  }
  fs.writeFileSync(outPath, result.bytes);
  process.stdout.write(JSON.stringify({ filename: result.filename, mime: result.mime }));
}

main().catch((e) => {
  process.stderr.write(`${e instanceof ClientPDF.UserError ? "USER_ERROR" : "ERROR"}: ${e.message}\n`);
  process.exit(1);
});
