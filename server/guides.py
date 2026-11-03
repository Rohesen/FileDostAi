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

GUIDES["pan-card-photo-size"] = {
    "tool": "resize-image",
    "name": "PAN Card Photo and Signature Size Resizer",
    "description": ("Resize your photo (2.5 × 3.5 cm) and signature (4.5 × 2 cm) for the PAN card form, under 50 KB at 300 dpi. "
                    "Free, the photo is never uploaded."),
    "intro": ("The online PAN application (Protean/NSDL and UTIITSL) asks for a scanned photo and signature at a fixed size, "
              "300 dpi and a small file size. The resizer below is already set for the PAN photo: add your picture, drag "
              "the box over your face and save."),
    "table": (["Upload", "Size", "File size", "Format"], [
        ("Photo", "295 × 413 px (2.5 × 3.5 cm, 300 dpi)", "Under 50 KB", "JPG"),
        ("Signature", "531 × 236 px (4.5 × 2 cm, 300 dpi)", "Under 50 KB", "JPG"),
    ]),
    "steps": [
        "Take a photo against a plain white wall, looking straight at the camera.",
        "Add it to the resizer at the top of this page.",
        "Drag the box so your face and the top of your shoulders fill it, then press Save photo.",
        "For the signature, sign in black ink on white paper, take a photo, and pick “PAN card signature” in “Made for”.",
        "Tick “Clean signature” to make the paper pure white and the ink darker.",
    ],
    "faqs": [
        ("Is my photo uploaded anywhere?", "No. The resizer runs in your browser, so the picture stays on your phone or computer."),
        ("The portal says a different size. What do I do?",
         "Check the latest instructions on the PAN portal, then change the width, height and KB numbers in the tool. Everything stays editable."),
        ("Can I upload a PDF instead?", "Some PAN forms take the documents as one PDF. Turn your photos into a PDF with JPG to PDF, then use Compress PDF to Exact Size."),
    ],
}

GUIDES["signature-resize-20kb"] = {
    "tool": "resize-image",
    "name": "Resize Signature to 20 KB",
    "description": "Make a photo of your signature smaller than 20 KB for exam and job forms, with clean white paper and dark ink. Free, nothing is uploaded.",
    "intro": ("Most forms want the signature as a JPG under 20 KB, and often over 10 KB. The resizer below is set for "
              "it: add a photo of your signature, drag the box tight around it and save."),
    "table": (["Form says", "Set in the tool", "Common forms"], [
        ("10–20 KB", "Minimum 10, maximum 20", "SSC, many state exams"),
        ("Under 20 KB", "Maximum 20", "Bank and job forms"),
        ("4–30 KB", "Pick NEET or CUET signature", "NEET, CUET"),
    ]),
    "steps": [
        "Sign in black or blue ink on plain white paper and take a photo from straight above.",
        "Add the photo to the resizer at the top of this page.",
        "Drag the box tight around the signature, with a little white space on each side.",
        "Keep “Clean signature” ticked for a white background, set the pixels if the form gives them, and press Save.",
    ],
    "faqs": [
        ("Is my signature uploaded anywhere?", "No. It is resized in your browser and stays on your device."),
        ("The form also asks for a minimum size.", "Type it in Minimum KB. The tool keeps the file between the two numbers."),
    ],
}

GUIDES["photo-resize-20kb"] = {
    "tool": "resize-image",
    "name": "Resize Photo to 20 KB",
    "description": "Reduce any photo to under 20 KB for online forms, with the best quality that fits. Set exact pixels too if the form asks. Free, nothing is uploaded.",
    "intro": ("Online forms often take photos only under 20 KB, while a phone photo is 2–5 MB. The resizer below is set "
              "to 20 KB: add your photo, crop it if you like and save."),
    "table": (["Form says", "Set in the tool"], [
        ("Under 20 KB", "Maximum 20 (already set)"),
        ("10–20 KB", "Minimum 10, maximum 20"),
        ("Under 50 KB", "Pick “Any photo under 50 KB”"),
        ("Exact pixels, e.g. 200 × 230", "Type them in Width and Height"),
    ]),
    "steps": [
        "Add your photo to the resizer at the top of this page.",
        "Drag the box to keep only the part you need.",
        "Change the KB numbers if the form gives a different limit.",
        "Press Save photo. The result shows the final size, so you can see it fits before uploading.",
    ],
    "faqs": [
        ("Is my photo uploaded anywhere?", "No. It runs in your browser."),
        ("The photo looks blurry at 20 KB.", "Set a smaller width and height (for example 200 × 230 px). Fewer pixels look sharper at the same KB."),
    ],
}

GUIDES["passport-photo-maker"] = {
    "tool": "resize-image",
    "name": "Passport Photo Maker Online",
    "description": "Make a passport photo from a phone picture: crop to 35 × 45 mm at 300 dpi, add a white background, and print several on one sheet. Free.",
    "intro": ("Skip the studio: take a photo at home against a light wall and turn it into a passport photo here. "
              "The tool below is set to 35 × 45 mm at 300 dpi (413 × 531 pixels), the size used for Indian passports and most visa forms."),
    "table": (["Use", "Size", "Pixels at 300 dpi"], [
        ("Indian passport, most visas", "35 × 45 mm", "413 × 531 px"),
        ("US passport and visa", "2 × 2 in (51 × 51 mm)", "600 × 600 px"),
        ("Many exam forms", "3.5 × 4.5 cm", "413 × 531 px"),
    ]),
    "steps": [
        "Stand in front of a plain light wall in daylight and have someone take the photo at eye level.",
        "Add it to the tool at the top of this page and drag the box over your head and shoulders.",
        "For a white background, run the photo through the Background Remover first and pick white.",
        "Press Save photo. To print, make a PDF with JPG to PDF, then use Pages per Sheet to fit 6 or 8 on a page.",
    ],
    "faqs": [
        ("Is my photo uploaded anywhere?", "No. It stays in your browser."),
        ("Will the passport office accept it?", "It is made at the official size. Check the latest rules for face size, glasses and background before you print."),
    ],
}

GUIDES["aadhaar-card-compress"] = {
    "tool": "compress-pdf-to-size",
    "name": "Compress Aadhaar Card PDF",
    "description": "Make your e-Aadhaar or scanned Aadhaar PDF small enough for forms: 100 KB, 200 KB or any limit. Free, files are never stored.",
    "intro": ("Forms often want the Aadhaar card as a PDF under 100 or 200 KB. The tool above is set to 200 KB: add the "
              "file and press Compress to size. The e-Aadhaar downloaded from UIDAI is locked with a password, so unlock it first."),
    "table": (["Step", "Tool"], [
        ("Unlock e-Aadhaar (password = first 4 letters of your name in capitals + birth year, e.g. RAHU1998)", "Unlock PDF"),
        ("Make it smaller than the limit", "Compress PDF to Exact Size (this page)"),
        ("Only the front side needed", "Remove Pages or Split PDF"),
    ]),
    "steps": [
        "If you downloaded e-Aadhaar from UIDAI, open Unlock PDF and type the password to remove it.",
        "Add the unlocked PDF to the tool at the top of this page.",
        "Change the size limit if the form asks for something else, then press Compress to size.",
        "Download the file. The result shows the new size so you can check it fits.",
    ],
    "faqs": [
        ("Is my Aadhaar stored?", "No. The file is compressed in memory and deleted as soon as you get the result. Nothing is kept."),
        ("Can I make a photo of my Aadhaar into a PDF?", "Yes. Use JPG to PDF (or Scan to PDF on a phone), then compress it here."),
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

GUIDES["aadhaar-card-compress"]["tips"] = _PDF_TIPS

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
