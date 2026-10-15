# Background remover files

Used by the server (bg_remove.py) and, when a visitor chooses "This device", downloaded and run in the browser.

- `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`: ONNX Runtime Web 1.22.0 (MIT, `onnxruntime-web.LICENSE`), WebAssembly build only.
- `silueta.onnx.part0` + `silueta.onnx.part1` (44 MB together, joined in the browser): the "silueta" model from rembg (MIT, `rembg.LICENSE`), a smaller copy of U²-Net by Xuebin Qin et al. (Apache-2.0, `u2net.LICENSE`). SHA-256 75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb.
- `isnet.onnx.part0` + `isnet.onnx.part1` (46.7 MB together, joined in the browser): "isnet-general-use" from DIS by Xuebin Qin et al. (Apache-2.0, `isnet.LICENSE`), as published by rembg. The weights are stored as 8-bit numbers with a scale per channel (turned back into float by DequantizeLinear when the model loads), so the download is a quarter of the original 179 MB; results differ from the original by under 0.1% on average. Input 1024×1024. SHA-256 66ef7ae5528ef7ea336a4b31995494c18e49c6a575cbbb4eee98e000fe7d9cdf.

Both models run together: silueta finds the whole subject, and ISNet removes what it is sure is background (a balloon or chair right behind a shoulder). By default the server runs them (bg_remove.py reads these same files), so visitors download nothing; these files are downloaded only by visitors who choose "This device".
