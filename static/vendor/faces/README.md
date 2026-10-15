# Face finder model

Loaded only when someone uses Blur Faces. Runs in the browser with ONNX Runtime Web (the copy in `../bg-remove/`).

- `ultraface-640.onnx` (1.6 MB): "Ultra-Light-Fast-Generic-Face-Detector-1MB", version RFB-640, by Linzaer (MIT, `UltraFace.LICENSE`). Same weights as the official ONNX file; only the weights were removed from the list of graph inputs, and unused batch-norm counters dropped, so the runtime loads it cleanly. Input 640×480 RGB, (pixel - 127) / 128.
