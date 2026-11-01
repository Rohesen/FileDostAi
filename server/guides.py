"""Short how-to guides for phrases people search for (exam photo sizes, compress a PDF to N KB).

Each guide is its own page (own address, title, description, sitemap entry). The tool opens on
top, set up for the job (app.js LANDING_PRESETS), and the guide is written into the page by the
server under the heading, so search engines read it without running scripts.

Sizes come from the presets in static/photo-tool.js; keep the two in step. Forms change every
year, so every page tells people to check the latest official notice.
"""

import html

# slug -> tool slug, page name, meta description, guide
GUIDES = {}


def _exam(slug, exam, rows, extra_faq=()):
    photo = rows[0]
    GUIDES[slug] = {
        "tool": "resize-image",
        "name": f"{exam} Photo and Signature Size Resizer",
        "description": (f"Resize your photo and signature for the {exam} form: {photo[1]}, {photo[2]}, JPG. "
                        "Crop, set the exact pixels and KB, and save in one go. Free, the photo is never uploaded."),
        "intro": (f"The {exam} application asks for a photo and a signature at a fixed size and file size. "
                  f"The resizer below is already set for the {exam} photo: add your picture, drag the box over "
                  "your face and save. The file comes out at the right pixels and inside the KB range."),
        "table": (["Upload", "Size", "File size", "Format"], rows),
        "steps": [
            "Take the photo against a plain, light wall with your face in the middle. A phone camera is fine.",
            "Add the photo to the resizer (it opens at the top of this page).",
            "Drag the box so your face and shoulders fill it. Use Rotate if the picture is sideways.",
            "Press Save photo. The JPG is made at the right pixels and inside the KB range, named for the form.",
            f"For the signature, sign in black or blue ink on white paper, take a photo, and pick “{exam} signature” in “Made for”.",
        ],
        "faqs": [
            ("Is my photo uploaded anywhere?", "No. The resizer runs in your browser, so the picture stays on your phone or computer."),
            ("The form says a different size. What do I do?",
             "Sizes change between years. Check the latest official notice, then change the width, height and KB numbers in the tool. Everything stays editable."),
            *extra_faq,
        ],
    }


_exam("ssc-photo-size", "SSC", [
    ("Photo", "350 × 450 px (3.5 × 4.5 cm)", "20–50 KB", "JPG"),
    ("Signature", "400 × 200 px (4 × 2 cm)", "10–20 KB", "JPG"),
])
_exam("upsc-photo-size", "UPSC", [
    ("Photo", "600 × 600 px (square)", "20–200 KB", "JPG"),
    ("Signature", "600 × 300 px", "20–100 KB", "JPG"),
])
_exam("jee-main-photo-size", "JEE Main", [
    ("Photo", "350 × 450 px (3.5 × 4.5 cm)", "10–300 KB", "JPG"),
    ("Signature", "350 × 150 px", "10–50 KB", "JPG"),
])
_exam("neet-photo-size", "NEET", [
    ("Passport photo", "350 × 450 px (3.5 × 4.5 cm)", "10–200 KB", "JPG"),
    ("Postcard photo", "600 × 900 px (4 × 6 in)", "10–200 KB", "JPG"),
    ("Signature", "350 × 150 px", "4–30 KB", "JPG"),
    ("Left thumb impression", "Any", "10–200 KB", "JPG"),
], extra_faq=[("Does it make the NEET postcard photo and thumb impression too?",
               "Yes. Pick “NEET postcard-size photo” or “NEET left thumb impression” in “Made for”.")])
_exam("cuet-photo-size", "CUET", [
    ("Photo", "350 × 450 px (3.5 × 4.5 cm)", "10–200 KB", "JPG"),
    ("Signature", "350 × 150 px", "4–30 KB", "JPG"),
])

GUIDES["passport-size-photo"] = {
    "tool": "resize-image",
    "name": "Passport Size Photo Maker (35 × 45 mm)",
    "description": "Make a passport size photo (35 × 45 mm at 300 dpi) from any picture: crop, resize and save as JPG. Free, nothing is uploaded.",
    "intro": ("A passport size photo is 35 × 45 mm. At 300 dpi that is 413 × 531 pixels. The resizer below is set "
              "for it: add a photo, drag the box over your face and save."),
    "table": (["Upload", "Size", "Resolution", "Format"], [("Passport photo", "413 × 531 px (35 × 45 mm)", "300 dpi", "JPG")]),
    "steps": [
        "Use a photo taken against a plain white or light background, looking straight at the camera.",
        "Add it to the resizer at the top of this page.",
        "Drag the box so your head and the top of your shoulders fill it.",
        "Press Save photo. To change the background to white first, use the Background Remover.",
    ],
    "faqs": [
        ("Is my photo uploaded anywhere?", "No. It runs in your browser and the picture stays on your device."),
        ("Can I print several on one sheet?", "Save the photo, then use Pages per Sheet (N-up) after turning it into a PDF with JPG to PDF."),
    ],
}

_PDF_STEPS = [
    "Add your PDF to the tool at the top of this page.",
    "The size limit is already filled in. Change it if your form asks for something else.",
    "Press Compress to size. It tries the gentlest settings first and keeps text sharp when it can.",
    "Download the file. The result shows the new size, so you can see it fits before you upload it.",
]
_PDF_TIPS = [
    "Scanned pages shrink the most. A 20-page scan usually fits in a few hundred KB.",
    "If it still doesn't fit, leave “turn pages into pictures” ticked. The text can't be selected afterwards, but the file gets much smaller.",
    "Very long files may never reach 100 KB. Split the PDF and upload only the pages the form asks for.",
    "Scanning again in black and white or grey at 150 dpi gives a smaller file than a colour scan.",
]
_PDF_FAQ = [
    ("Is my PDF stored?", "No. The file is compressed in memory and deleted as soon as you get the result. Nothing is kept."),
    ("Will the text stay readable?", "Yes. It lowers image quality step by step and stops at the best quality that fits. It tells you plainly if a size can't be reached."),
]


def _pdf(slug, size, why):
    GUIDES[slug] = {
        "tool": "compress-pdf-to-size",
        "name": f"Compress PDF to {size}",
        "description": f"Make a PDF smaller than {size} for {why}. Text stays sharp when possible, and it says plainly if it can't fit. Free, files are never stored.",
        "intro": f"Many {why} only take PDFs under {size}. The tool above is already set to {size}: add your file and press Compress to size.",
        "steps": _PDF_STEPS, "tips": _PDF_TIPS, "faqs": _PDF_FAQ,
    }


_pdf("compress-pdf-to-100kb", "100 KB", "exam, job and scholarship portals")
_pdf("compress-pdf-to-200kb", "200 KB", "government and university upload forms")
_pdf("compress-pdf-to-500kb", "500 KB", "job portals and bank KYC uploads")
_pdf("compress-pdf-to-1mb", "1 MB", "email attachments and online applications")

GUIDES["reduce-pdf-size-in-kb"] = {
    "tool": "compress-pdf-to-size",
    "name": "Reduce PDF Size in KB (MB to KB)",
    "description": "Turn a PDF of several MB into one of a few hundred KB: type the limit (100 KB, 200 KB, 500 KB…) and get a file that fits. Free.",
    "intro": ("Upload forms often say “PDF under 200 KB” while a phone scan is 2–5 MB. Type the limit into the tool "
              "above, or tap one of the sizes, and it makes the PDF small enough with the best quality that fits."),
    "table": (["Form says", "Type in the tool", "Good for"], [
        ("Under 100 KB", "100 KB", "Certificates, ID proofs on exam portals"),
        ("Under 200 KB", "200 KB", "Mark sheets, caste and income certificates"),
        ("Under 500 KB", "500 KB", "Resumes and job portal uploads"),
        ("Under 1 MB / 2 MB", "1 MB or 2 MB", "Email and longer documents"),
    ]),
    "steps": _PDF_STEPS, "tips": _PDF_TIPS, "faqs": _PDF_FAQ,
}


def guide_html(slug: str) -> str:
    """The guide written as plain HTML, or "" when the page has none."""
    g = GUIDES.get(slug)
    if not g:
        return ""
    e = html.escape
    out = [f'<section class="guide" id="guide"><div class="container guide-card">',
           f'<p class="guide-intro">{e(g["intro"])}</p>']
    if g.get("table"):
        head, rows = g["table"]
        out.append('<div class="guide-table-wrap"><table class="guide-table"><thead><tr>'
                   + "".join(f"<th>{e(h)}</th>" for h in head) + "</tr></thead><tbody>"
                   + "".join("<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in rows)
                   + "</tbody></table></div>")
        if g["tool"] == "resize-image" and "passport" not in slug:
            out.append('<p class="guide-note">Typical sizes from recent notices. Always check the latest official notice; every number in the tool can be changed.</p>')
    out.append(f'<h2>How to do it</h2><ol class="guide-steps">' + "".join(f"<li>{e(s)}</li>" for s in g["steps"]) + "</ol>")
    out.append(f'<p><a class="btn btn-primary guide-open" href="/{e(slug)}" data-slug="{e(slug)}">Open the tool</a></p>')
    if g.get("tips"):
        out.append("<h2>Tips</h2><ul class=\"guide-tips\">" + "".join(f"<li>{e(t)}</li>" for t in g["tips"]) + "</ul>")
    if g.get("faqs"):
        out.append("<h2>Questions</h2>" + "".join(
            f'<details class="guide-faq"><summary>{e(q)}</summary><p>{e(a)}</p></details>' for q, a in g["faqs"]))
    out.append("</div></section>")
    return "".join(out)
