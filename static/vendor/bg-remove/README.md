# Background remover files

Loaded only when someone opens the Background Remover tool. Everything runs in the browser.

- `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`: ONNX Runtime Web 1.22.0 (MIT, `onnxruntime-web.LICENSE`), WebAssembly build only.
- `silueta.onnx.part0` + `silueta.onnx.part1` (44 MB together, joined in the browser): the "silueta" model from rembg (MIT, `rembg.LICENSE`), a smaller copy of U²-Net by Xuebin Qin et al. (Apache-2.0, `u2net.LICENSE`). SHA-256 75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb.
