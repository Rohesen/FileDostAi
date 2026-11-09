"""Link-preview pictures (Open Graph images): one 1200x630 PNG per page, drawn on first use and
kept in memory. WhatsApp, LinkedIn, X, Facebook and Google Discover show this picture when
someone shares a link to the site."""
import functools
import io
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
_FONT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "static", "fonts", "geist-latin-wght-normal.woff2")
TEAL, GREEN, LIME = (20, 184, 166), (34, 197, 94), (163, 230, 53)
BG = (8, 15, 30)


def _font(size: int, weight: str = "Regular"):
    try:
        f = ImageFont.truetype(_FONT, size)
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
        return f
    except Exception:  # FreeType built without WOFF2 support: plain built-in font
        return ImageFont.load_default(size)


def _wrap(draw, text, font, width, max_lines):
    words, lines, line = text.split(), [], ""
    for w in words:
        test = f"{line} {w}".strip()
        if draw.textlength(test, font=font) <= width or not line:
            line = test
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + "...", font=font) > width:
            last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
        lines[-1] = last.rstrip(",.:;") + "..."
    return lines


def _background() -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((700, -260, 1400, 380), fill=(12, 110, 100))
    g.ellipse((-260, 380, 420, 900), fill=(30, 90, 40))
    g.ellipse((900, 420, 1350, 800), fill=(70, 95, 20))
    glow = glow.filter(ImageFilter.GaussianBlur(140))
    img = Image.blend(img, glow, 0.55)
    # faint grid, like the site's background
    d = ImageDraw.Draw(img, "RGBA")
    for x in range(0, W, 48):
        d.line((x, 0, x, H), fill=(255, 255, 255, 9))
    for y in range(0, H, 48):
        d.line((0, y, W, y), fill=(255, 255, 255, 9))
    return img


def _logo(img: Image.Image, x: int, y: int, s: float) -> None:
    """The site's page icon (a document with a folded corner and lines), drawn with a gradient."""
    size = int(78 * s)
    grad = Image.new("RGB", (size, size))
    gd = ImageDraw.Draw(grad)
    for i in range(size * 2):
        t = i / (size * 2)
        a, b, u = (TEAL, GREEN, t / 0.55) if t < 0.55 else (GREEN, LIME, (t - 0.55) / 0.45)
        col = tuple(int(a[k] + (b[k] - a[k]) * u) for k in range(3))
        gd.line((i, 0, 0, i), fill=col)
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    p = lambda px, py: ((px - 16) * s, (py - 12) * s)
    md.rounded_rectangle((*p(24, 16), *p(74, 86)), radius=int(6 * s), fill=255)
    md.polygon([p(58, 15), p(75, 15), p(75, 32)], fill=0)
    img.paste(grad, (x, y), mask)
    d = ImageDraw.Draw(img, "RGBA")
    d.polygon([(x + a, y + b) for a, b in (p(58, 16), p(58, 28), p(62, 32), p(74, 32))], fill=(255, 255, 255, 140))
    for ly, lx2 in ((44, 66), (54, 66), (64, 66), (74, 54)):
        x1, y1 = p(34, ly)
        x2, _ = p(lx2, ly)
        d.line((x + x1, y + y1, x + x2, y + y1), fill=(255, 255, 255), width=max(2, int(4.6 * s)))


@functools.lru_cache(maxsize=512)
def render(title: str, description: str, brand: str, domain: str, tagline: str) -> bytes:
    img = _background()
    d = ImageDraw.Draw(img, "RGBA")
    pad = 72
    _logo(img, pad - 8, 52, 1.0)
    main, _, accent = brand.rpartition(" ") if " " in brand else (brand, "", "")
    f_brand = _font(40, "Bold")
    d.text((pad + 72, 66), main, font=f_brand, fill=(255, 255, 255))
    if accent:
        d.text((pad + 72 + d.textlength(main + " ", font=f_brand), 66), accent, font=f_brand, fill=LIME)

    size = 78
    while size > 50:
        f_title = _font(size, "Bold")
        lines = _wrap(d, title, f_title, W - 2 * pad, 2)
        if not lines[-1].endswith("..."):
            break
        size -= 6
    y = 190 if len(lines) == 2 else 215
    for i, line in enumerate(lines):
        d.text((pad, y), line, font=f_title, fill=(255, 255, 255))
        y += int(size * 1.12)
    # a short gradient underline
    for i in range(160):
        t = i / 160
        col = tuple(int(TEAL[k] + (LIME[k] - TEAL[k]) * t) for k in range(3))
        d.line((pad + i, y + 14, pad + i, y + 20), fill=col)

    f_desc = _font(32)
    y += 46
    for line in _wrap(d, description, f_desc, W - 2 * pad, 2):
        d.text((pad, y), line, font=f_desc, fill=(203, 213, 225))
        y += 44

    f_chip = _font(26, "Medium")
    cx, cy = pad, H - 92
    for chip in tagline.split("|"):
        chip = chip.strip()
        tw = d.textlength(chip, font=f_chip)
        d.rounded_rectangle((cx, cy, cx + tw + 40, cy + 48), radius=24, fill=(255, 255, 255, 18),
                            outline=(255, 255, 255, 50), width=2)
        d.text((cx + 20, cy + 9), chip, font=f_chip, fill=(226, 232, 240))
        cx += tw + 56
    f_dom = _font(30, "SemiBold")
    d.text((W - pad - d.textlength(domain, font=f_dom), cy + 7), domain, font=f_dom, fill=LIME)

    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()
