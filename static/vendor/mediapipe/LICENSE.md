# MediaPipe Tasks Vision

- `vision_bundle.mjs`, `wasm/vision_wasm_internal.*`: @mediapipe/tasks-vision 1.2.0 from npm,
  Copyright Google LLC, Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
- `models/face_landmarker.task` (float16, v1) and `models/selfie_segmenter.tflite` (float16):
  MediaPipe models published by Google under the Apache License 2.0
  (model cards: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker,
  https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter).

Only the SIMD wasm build is shipped (every current browser supports wasm SIMD).
Self-hosted so the Screen Recorder's face filters work without calling any outside server.
