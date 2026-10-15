# Image Upscaler model

Loaded only when someone runs the Image Upscaler. Runs in the browser with ONNX Runtime Web (the copy in `../bg-remove/`).

- `realesr-general-x4v3.onnx` (4.9 MB): Real-ESRGAN "general x4 v3" (SRVGGNetCompact) by Xintao Wang et al., BSD-3-Clause (`Real-ESRGAN.LICENSE`). Converted from the official `realesr-general-x4v3.pth` release weights to ONNX (opset 13) without changes to the weights. Input: RGB 0-1, any size; output: 4× size.
