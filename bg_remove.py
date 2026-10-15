"""
Background Remover, server side: finds the subject of a photo so visitors don't have to download
the 90 MB of models. Uses the same two models as the in-browser version
(static/vendor/bg-remove/): U²-Net "silueta" finds the whole subject at 320×320, and ISNet at
1024×1024 removes what it is sure is background (a balloon or chair right behind a shoulder).

Returns only the mask, as a 1024×1024 greyscale PNG (255 = keep); the browser stretches it back
to the photo's shape and does the rest (edges, colours, trimming), so the cut-out stays full size.
Runs inside the job sandbox like every other upload.
"""

import io
import os

import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 50_000_000

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "vendor", "bg-remove")
SMALL, BIG = 320, 1024
MASK_SIZE = BIG


from pdf_engine import ToolUnavailableError


def _model(name: str) -> bytes:
    parts = [os.path.join(MODEL_DIR, f"{name}.onnx.part{i}") for i in (0, 1)]
    if not all(os.path.exists(p) for p in parts):
        raise ToolUnavailableError("The background remover isn't installed on this server.")
    return b"".join(open(p, "rb").read() for p in parts)


def _session(name: str):
    try:
        import onnxruntime as ort  # imported here so the rest of the app starts without it
    except ImportError as e:
        raise ToolUnavailableError("The background remover isn't installed on this server.") from e

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    return ort.InferenceSession(_model(name), opts, providers=["CPUExecutionProvider"])


def _infer(name: str, rgb: Image.Image, size: int, mean, std) -> np.ndarray:
    s = _session(name)
    x = np.asarray(rgb.resize((size, size), Image.BILINEAR), dtype=np.float32)
    x = x / max(float(x.max()), 1.0)
    x = (x - np.array(mean, np.float32)) / np.array(std, np.float32)
    y = s.run(None, {s.get_inputs()[0].name: x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0, 0]
    lo, hi = float(y.min()), float(y.max())
    return (y - lo) / (hi - lo) if hi - lo > 1e-4 else np.zeros_like(y)


def mask_png(data: bytes) -> bytes:
    """The subject mask of an uploaded photo as a 1024×1024 greyscale PNG."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001 - any decoding failure means "not a usable picture"
        raise ValueError("That file isn't a picture we can read. Try a JPG, PNG or WebP.") from e
    rgb = ImageOps.exif_transpose(img).convert("RGB")
    a = _infer("silueta", rgb, SMALL, (0.485, 0.456, 0.406), (0.229, 0.224, 0.225))
    b = _infer("isnet", rgb, BIG, (0.5, 0.5, 0.5), (1, 1, 1))
    a = np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize((BIG, BIG), Image.BILINEAR))
    m = a * np.minimum(1.0, b / 0.3)
    out = io.BytesIO()
    Image.fromarray(np.clip(m * 255 + 0.5, 0, 255).astype(np.uint8), mode="L").save(out, "PNG", optimize=True)
    return out.getvalue()
