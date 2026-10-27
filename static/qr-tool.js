// QR codes: make one (link, text, Wi-Fi, UPI payment, contact card) and download it as PNG or SVG,
// or read one from a photo, a screenshot, a PDF page or the phone camera.
// Runs in the browser with qrcode-generator (MIT) and jsQR (Apache-2.0), both loaded only when needed.

const QrTool = (() => {
  const UserError = (msg) => new ClientPDF.UserError(msg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!document.querySelector("link[data-qr-css]")) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/static/qr-tool.css?v=33" });
    link.dataset.qrCss = "1";
    document.head.append(link);
  }

  const loaders = {};
  function loadScript(src, global) {
    if (window[global]) return Promise.resolve(window[global]);
    if (!loaders[src]) {
      loaders[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => (window[global] ? resolve(window[global]) : reject(UserError("Couldn't start the QR code helper.")));
        s.onerror = () => { delete loaders[src]; s.remove(); reject(UserError("Couldn't load the QR code helper. Check your connection and try again.")); };
        document.head.append(s);
      });
    }
    return loaders[src];
  }
  async function loadMaker() {
    const qrcode = await loadScript("/static/vendor/qrcode-generator.js?v=13", "qrcode");
    // Encode text as UTF-8 so Hindi, emoji and accents survive (every modern reader expects UTF-8).
    qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));
    return qrcode;
  }
  const loadReader = () => loadScript("/static/vendor/jsQR.js?v=13", "jsQR");

  // ---------- Building the text inside the code ----------

  const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
  const wifiEscape = (s) => String(s).replace(/([\\;,:"])/g, "\\$1");
  const vcardEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

  /** Returns { text } or { error } for the chosen type and the values typed in. */
  function payload(type, v) {
    if (type === "link") {
      let url = (v.url || "").trim();
      if (!url) return { error: "Type or paste a link." };
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      if (/\s/.test(url)) return { error: "A link can't contain spaces." };
      return { text: url };
    }
    if (type === "text") {
      const t = v.text || "";
      if (!t.trim()) return { error: "Type the text to put in the QR code." };
      return { text: t };
    }
    if (type === "wifi") {
      const ssid = v.ssid || "";
      if (!ssid) return { error: "Type the Wi-Fi network name." };
      const sec = v.security || "WPA";
      if (sec !== "nopass" && !v.password) return { error: "Type the Wi-Fi password, or choose “No password”." };
      if (sec === "WEP" && ![5, 13, 10, 26].includes(v.password.length)) return { warning: "WEP passwords are usually 5, 13, 10 or 26 characters long.", text: wifiText() };
      return { text: wifiText() };
      function wifiText() {
        return `WIFI:T:${sec};S:${wifiEscape(ssid)};${sec === "nopass" ? "" : `P:${wifiEscape(v.password)};`}${v.hidden ? "H:true;" : ""};`;
      }
    }
    if (type === "upi") {
      const pa = (v.upiId || "").trim();
      if (!pa) return { error: "Type the UPI ID that should receive the money, like name@okbank or 9876543210@ybl." };
      if (!UPI_ID.test(pa)) return { error: `“${pa}” doesn't look like a UPI ID. It should look like name@bank, for example 9876543210@ybl.` };
      const parts = [`pa=${pa}`];
      const pn = (v.upiName || "").trim();
      if (pn) parts.push(`pn=${encodeURIComponent(pn)}`);
      const am = (v.upiAmount || "").trim().replace(/,/g, "");
      if (am) {
        if (!/^\d{1,9}(\.\d{1,2})?$/.test(am) || Number(am) <= 0) return { error: "The amount should be a number like 250 or 99.50." };
        parts.push(`am=${Number(am).toFixed(2)}`);
      }
      parts.push("cu=INR");
      const tn = (v.upiNote || "").trim();
      if (tn) parts.push(`tn=${encodeURIComponent(tn)}`);
      return { text: `upi://pay?${parts.join("&")}`, warning: pn ? "" : "Tip: add the payee name so people see who they are paying." };
    }
    if (type === "contact") {
      const first = (v.first || "").trim(), last = (v.last || "").trim();
      if (!first && !last && !v.org) return { error: "Type a name or an organisation." };
      const lines = ["BEGIN:VCARD", "VERSION:3.0",
        `N:${vcardEscape(last)};${vcardEscape(first)};;;`,
        `FN:${vcardEscape([first, last].filter(Boolean).join(" ") || v.org)}`];
      if (v.org) lines.push(`ORG:${vcardEscape(v.org)}`);
      if (v.phone) lines.push(`TEL;TYPE=CELL:${v.phone.replace(/[^\d+]/g, "")}`);
      if (v.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return { error: "That email address doesn't look right." };
        lines.push(`EMAIL:${v.email.trim()}`);
      }
      if (v.website) lines.push(`URL:${v.website.trim()}`);
      lines.push("END:VCARD");
      return { text: lines.join("\r\n") };
    }
    return { error: "Choose what to put in the QR code." };
  }

  // ---------- Drawing the code ----------

  async function matrix(text, ecl = "M") {
    const qrcode = await loadMaker();
    const q = qrcode(0, ecl);
    q.addData(text, "Byte");
    try {
      q.make();
    } catch (e) {
      throw UserError("That's too much for one QR code. Make the text shorter, or choose a lower “Damage tolerance”.");
    }
    const n = q.getModuleCount();
    return { n, dark: (r, c) => q.isDark(r, c) };
  }

  function toSvg(m, { size = 512, margin = 4, fg = "#000000", bg = "#ffffff" } = {}) {
    const total = m.n + margin * 2;
    let d = "";
    for (let r = 0; r < m.n; r++) {
      for (let c = 0; c < m.n; c++) {
        if (!m.dark(r, c)) continue;
        // Merge runs of dark modules in a row into one rectangle to keep the file small.
        let len = 1;
        while (c + len < m.n && m.dark(r, c + len)) len++;
        d += `M${c + margin} ${r + margin}h${len}v1h-${len}z`;
        c += len - 1;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="${bg}"/><path fill="${fg}" d="${d}"/></svg>`;
  }

  function toCanvas(m, { size = 512, margin = 4, fg = "#000000", bg = "#ffffff" } = {}) {
    const total = m.n + margin * 2;
    const s = size / total;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);
    g.fillStyle = fg;
    for (let r = 0; r < m.n; r++) {
      const y0 = Math.round((r + margin) * s), y1 = Math.round((r + margin + 1) * s);
      for (let c = 0; c < m.n; c++) {
        if (!m.dark(r, c)) continue;
        const x0 = Math.round((c + margin) * s), x1 = Math.round((c + margin + 1) * s);
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    return canvas;
  }

  function luminance(hex) {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function colourWarning(fg, bg) {
    const a = luminance(fg), b = luminance(bg);
    if (a > b) return "Light code on a dark background: many phone cameras can't read that. Swap the colours.";
    if ((b + 0.05) / (a + 0.05) < 3) return "The two colours are too close; cameras may struggle to read it. Use a darker code colour.";
    return "";
  }

  // ---------- Reading codes ----------

  /** Finds up to 6 QR codes in a canvas. Each found code is blanked out and the picture searched again. */
  function scanCanvas(jsQR, canvas) {
    const found = [];
    const tries = [];
    const maxDim = Math.max(canvas.width, canvas.height);
    for (const target of [1800, 1000, 600]) {
      if (maxDim > target * 1.2 || target === 1800) tries.push(Math.min(1, target / maxDim));
    }
    for (const scale of [...new Set(tries)]) {
      const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
      const work = document.createElement("canvas");
      work.width = w; work.height = h;
      const g = work.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingQuality = "high";
      g.drawImage(canvas, 0, 0, w, h);
      for (let k = 0; k < 6; k++) {
        const img = g.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
        if (!code || (!code.data && !code.binaryData.length)) break;
        const text = code.data || new TextDecoder().decode(new Uint8Array(code.binaryData));
        if (!found.includes(text)) found.push(text);
        // Cover this code (a little larger than its corners) and look for another one.
        const L = code.location;
        const pts = [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner];
        const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
        g.fillStyle = "#808080";
        g.beginPath();
        pts.forEach((p, i) => { const x = cx + (p.x - cx) * 1.25, y = cy + (p.y - cy) * 1.25; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.closePath();
        g.fill();
      }
      if (found.length) break;
    }
    return found;
  }

  async function imageCanvas(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      if (/\.(heic|heif)$/i.test(file.name)) throw UserError(`${file.name} is a HEIC photo. Take a screenshot of it or save it as JPG first.`);
      throw UserError(`${file.name} couldn't be opened as a picture.`);
    }
    const c = document.createElement("canvas");
    const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  async function readFiles(files, buffers, progress = () => {}) {
    const jsQR = await loadReader();
    const results = [];
    let pdfPages = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        const doc = await PdfRender.open(buffers[i]);
        const pages = Math.min(doc.numPages, 50);
        for (let p = 1; p <= pages; p++) {
          progress((i + (p - 1) / pages) / files.length, `Looking at page ${p} of ${pages}`);
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
          const c = document.createElement("canvas");
          await PdfRender.renderPage(page, c, { scale });
          page.cleanup();
          scanCanvas(jsQR, c).forEach((text) => results.push({ text, from: `${file.name}, page ${p}` }));
          pdfPages++;
        }
        if (doc.numPages > 50) results.push({ note: `Only the first 50 pages of ${file.name} were checked.` });
        await doc.destroy();
      } else {
        progress(i / files.length, `Looking at ${file.name}`);
        const c = await imageCanvas(file);
        scanCanvas(jsQR, c).forEach((text) => results.push({ text, from: file.name }));
      }
    }
    return { results, files: files.length, pdfPages };
  }

  // ---------- Understanding what was read ----------

  function parseUpi(text) {
    try {
      const u = new URL(text);
      const p = u.searchParams;
      return { id: p.get("pa") || "", name: p.get("pn") || "", amount: p.get("am") || "", note: p.get("tn") || "", currency: p.get("cu") || "" };
    } catch (e) { return null; }
  }
  function parseWifi(text) {
    const get = (k) => {
      const m = text.match(new RegExp(`[:;]${k}:((?:\\\\.|[^;])*)`));
      return m ? m[1].replace(/\\(.)/g, "$1") : "";
    };
    return { ssid: get("S"), password: get("P"), security: get("T") || "nopass", hidden: get("H") === "true" };
  }

  function describe(text) {
    if (/^https?:\/\//i.test(text)) return { kind: "Link", icon: "chain" };
    if (/^upi:\/\/pay\?/i.test(text)) return { kind: "UPI payment", icon: "rupee" };
    if (/^WIFI:/i.test(text)) return { kind: "Wi-Fi", icon: "globe" };
    if (/^BEGIN:VCARD/i.test(text)) return { kind: "Contact", icon: "file" };
    if (/^mailto:/i.test(text)) return { kind: "Email", icon: "chat" };
    if (/^tel:/i.test(text)) return { kind: "Phone number", icon: "phone" };
    return { kind: "Text", icon: "file" };
  }

  function renderResults(data, box) {
    box.innerHTML = "";
    box.classList.add("qr-results");
    const found = data.results.filter((r) => r.text !== undefined);
    if (!found.length) {
      box.innerHTML = `<div class="qr-none"><strong>No QR code found.</strong>
        <span>Try a sharper, closer picture with the whole code in view and good light. Damaged or very small codes may not read.</span></div>`;
      return;
    }
    const head = document.createElement("p");
    head.className = "qr-res-head";
    head.textContent = found.length === 1 ? "Found 1 QR code" : `Found ${found.length} QR codes`;
    box.append(head);
    found.forEach((r) => box.append(resultCard(r)));
    data.results.filter((r) => r.note).forEach((r) => {
      const p = document.createElement("p"); p.className = "drop-hint"; p.textContent = r.note; box.append(p);
    });
  }

  function resultCard(r) {
    const { kind, icon } = describe(r.text);
    const card = document.createElement("div");
    card.className = "qr-card";
    let details = "";
    let actions = `<button type="button" class="btn btn-xs" data-qr-copy>Copy text</button>`;
    if (kind === "Link") {
      actions = `<a class="btn btn-xs btn-primary" href="${esc(r.text)}" target="_blank" rel="noopener noreferrer nofollow">Open link ↗</a>` + actions;
      details = `<p class="qr-warn">Check the address before you open it: ${esc((() => { try { return new URL(r.text).hostname; } catch (e) { return r.text; } })())}</p>`;
    } else if (kind === "UPI payment") {
      const u = parseUpi(r.text);
      if (u) {
        details = `<dl class="qr-dl"><dt>Pays to</dt><dd>${esc(u.id)}</dd>${u.name ? `<dt>Name</dt><dd>${esc(u.name)}</dd>` : ""}${u.amount ? `<dt>Amount</dt><dd>₹${esc(u.amount)}</dd>` : ""}${u.note ? `<dt>Note</dt><dd>${esc(u.note)}</dd>` : ""}</dl>
          <p class="qr-warn">Before paying, make sure the UPI ID and name are who you expect. Scanning a QR code never gives you money.</p>`;
      }
    } else if (kind === "Wi-Fi") {
      const w = parseWifi(r.text);
      details = `<dl class="qr-dl"><dt>Network</dt><dd>${esc(w.ssid)}</dd><dt>Password</dt><dd>${w.password ? esc(w.password) : "(none)"}</dd><dt>Security</dt><dd>${esc(w.security === "nopass" ? "Open" : w.security)}${w.hidden ? ", hidden network" : ""}</dd></dl>`;
      if (w.password) actions += `<button type="button" class="btn btn-xs" data-qr-copy-pass>Copy password</button>`;
    } else if (kind === "Contact") {
      actions += `<button type="button" class="btn btn-xs" data-qr-vcf>Save contact (.vcf)</button>`;
    }
    card.innerHTML = `
      <div class="qr-card-head"><span class="qr-kind">${Icons.ui(icon)} ${esc(kind)}</span>${r.from ? `<span class="qr-from">${esc(r.from)}</span>` : ""}</div>
      <pre class="qr-text">${esc(r.text)}</pre>
      ${details}
      <div class="qr-actions">${actions}</div>`;
    const copy = (t) => {
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        () => showToast("Copied.", "success"), () => showToast("Couldn't copy. Select the text and copy it yourself.", "error"));
    };
    card.querySelector("[data-qr-copy]").onclick = () => copy(r.text);
    const cp = card.querySelector("[data-qr-copy-pass]");
    if (cp) cp.onclick = () => copy(parseWifi(r.text).password);
    const vcf = card.querySelector("[data-qr-vcf]");
    if (vcf) vcf.onclick = () => downloadBlob(new Blob([r.text], { type: "text/vcard" }), "contact.vcf");
    return card;
  }

  // ---------- UI ----------

  const TYPES = [
    ["link", "Link"], ["text", "Text"], ["wifi", "Wi-Fi"], ["upi", "UPI payment"], ["contact", "Contact"],
  ];
  const configHtml = `
    <div class="qr" id="qrRoot">
      <div class="qr-modes" role="tablist">
        <button type="button" role="tab" class="qr-mode" data-mode="make" aria-selected="true">Make a QR</button>
        <button type="button" role="tab" class="qr-mode" data-mode="read" aria-selected="false">Read a QR</button>
      </div>
      <section class="qr-make" id="qrMake">
        <div class="qr-types" role="radiogroup" aria-label="What goes in the QR code">
          ${TYPES.map(([k, l], i) => `<label class="qr-type"><input type="radio" name="qrType" value="${k}"${i === 0 ? " checked" : ""}><span>${l}</span></label>`).join("")}
        </div>
        <div class="qr-grid">
          <div class="qr-fields">
            <div class="qr-set" data-type="link">
              <div class="form-group"><label class="form-label" for="qrUrl">Link</label><input type="url" id="qrUrl" class="form-input" placeholder="https://example.com" autocomplete="off" inputmode="url"></div>
            </div>
            <div class="qr-set" data-type="text" hidden>
              <div class="form-group"><label class="form-label" for="qrText">Text</label><textarea id="qrText" class="form-input" rows="4" placeholder="Any text, in any language"></textarea></div>
            </div>
            <div class="qr-set" data-type="wifi" hidden>
              <div class="form-group"><label class="form-label" for="qrSsid">Network name (SSID)</label><input type="text" id="qrSsid" class="form-input" autocomplete="off"></div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrWifiPass">Password</label><input type="text" id="qrWifiPass" class="form-input" autocomplete="off"></div>
                <div class="form-group"><label class="form-label" for="qrWifiSec">Security</label>
                  <select id="qrWifiSec" class="form-select"><option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP (old)</option><option value="nopass">No password</option></select></div>
              </div>
              <label class="checkbox-group"><input type="checkbox" id="qrWifiHidden"> Hidden network</label>
            </div>
            <div class="qr-set" data-type="upi" hidden>
              <div class="form-group"><label class="form-label" for="qrUpiId">UPI ID</label><input type="text" id="qrUpiId" class="form-input" placeholder="yourname@okbank or 9876543210@ybl" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrUpiName">Payee name</label><input type="text" id="qrUpiName" class="form-input" placeholder="Shop or person" autocomplete="off"></div>
                <div class="form-group"><label class="form-label" for="qrUpiAmount">Amount ₹ (optional)</label><input type="text" id="qrUpiAmount" class="form-input" inputmode="decimal" placeholder="Payer types it"></div>
              </div>
              <div class="form-group"><label class="form-label" for="qrUpiNote">Note (optional)</label><input type="text" id="qrUpiNote" class="form-input" maxlength="50" placeholder="e.g. Invoice 42"></div>
              <p class="drop-hint">Works with Google Pay, PhonePe, Paytm, BHIM and any UPI app. Leave the amount empty to let the payer choose it.</p>
            </div>
            <div class="qr-set" data-type="contact" hidden>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrFirst">First name</label><input type="text" id="qrFirst" class="form-input" autocomplete="off"></div>
                <div class="form-group"><label class="form-label" for="qrLast">Last name</label><input type="text" id="qrLast" class="form-input" autocomplete="off"></div>
              </div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrPhone">Phone</label><input type="tel" id="qrPhone" class="form-input" placeholder="+91 98765 43210" autocomplete="off"></div>
                <div class="form-group"><label class="form-label" for="qrEmail">Email</label><input type="email" id="qrEmail" class="form-input" autocomplete="off"></div>
              </div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrOrg">Organisation</label><input type="text" id="qrOrg" class="form-input" autocomplete="off"></div>
                <div class="form-group"><label class="form-label" for="qrWeb">Website</label><input type="url" id="qrWeb" class="form-input" autocomplete="off"></div>
              </div>
            </div>
            <details class="qr-style">
              <summary>Size, colours and margin</summary>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrSize">Size (PNG)</label>
                  <select id="qrSize" class="form-select"><option value="256">256 × 256 px</option><option value="512" selected>512 × 512 px</option><option value="1024">1024 × 1024 px</option><option value="2048">2048 × 2048 px (print)</option></select></div>
                <div class="form-group"><label class="form-label" for="qrMargin">Margin</label>
                  <select id="qrMargin" class="form-select"><option value="0">None</option><option value="2">Small</option><option value="4" selected>Standard (4 squares)</option><option value="8">Large</option></select></div>
              </div>
              <div class="grid-2">
                <div class="form-group"><label class="form-label" for="qrFg">Code colour</label><input type="color" id="qrFg" class="qr-color" value="#000000"></div>
                <div class="form-group"><label class="form-label" for="qrBg">Background</label><input type="color" id="qrBg" class="qr-color" value="#ffffff"></div>
              </div>
              <div class="form-group"><label class="form-label" for="qrEcl">Damage tolerance</label>
                <select id="qrEcl" class="form-select"><option value="L">Low (7%), smallest code</option><option value="M" selected>Medium (15%), recommended</option><option value="Q">High (25%)</option><option value="H">Highest (30%), for printing or stickers</option></select></div>
            </details>
          </div>
          <div class="qr-out">
            <div class="qr-preview" id="qrPreview" aria-live="polite"></div>
            <p class="qr-info" id="qrInfo"></p>
            <div class="qr-dl-row">
              <button type="button" class="btn btn-primary" id="qrPng" disabled>${Icons.ui("download")} PNG</button>
              <button type="button" class="btn btn-secondary" id="qrSvg" disabled>${Icons.ui("download")} SVG</button>
            </div>
          </div>
        </div>
      </section>
      <section class="qr-read" id="qrRead" hidden>
        <p class="drop-hint">Add a photo, screenshot or PDF above and the codes in it are read straight away. Or use your camera.</p>
        <div class="qr-cam-row">
          <button type="button" class="btn btn-secondary" id="qrCam">${Icons.ui("camera")} Scan with camera</button>
        </div>
        <div class="qr-cam" id="qrCamBox" hidden>
          <video id="qrVideo" playsinline muted></video>
          <span class="qr-cam-frame" aria-hidden="true"></span>
          <button type="button" class="btn btn-xs qr-cam-stop" id="qrCamStop">Stop camera</button>
        </div>
        <div class="qr-live" id="qrLive"></div>
      </section>
    </div>`;

  function create(root, ctx, tool) {
    const $ = (id) => root.querySelector(`#${id}`);
    let mode = "make";
    let current = null; // { text, m, opts, type }
    let token = 0;
    let stream = null, camTimer = null;
    const shared = {
      drop: document.getElementById("dropZone"),
      exec: document.getElementById("btnExecute"),
    };

    function type() { return root.querySelector('input[name="qrType"]:checked').value; }
    function values() {
      const v = (id) => ($(id) ? $(id).value : "");
      return {
        url: v("qrUrl"), text: v("qrText"), ssid: v("qrSsid"), password: v("qrWifiPass"), security: v("qrWifiSec"), hidden: $("qrWifiHidden").checked,
        upiId: v("qrUpiId"), upiName: v("qrUpiName"), upiAmount: v("qrUpiAmount"), upiNote: v("qrUpiNote"),
        first: v("qrFirst"), last: v("qrLast"), phone: v("qrPhone"), email: v("qrEmail"), org: v("qrOrg"), website: v("qrWeb"),
      };
    }
    function opts() {
      return { size: Number($("qrSize").value), margin: Number($("qrMargin").value), fg: $("qrFg").value, bg: $("qrBg").value, ecl: $("qrEcl").value };
    }

    async function refresh() {
      const my = ++token;
      const t = type();
      const p = payload(t, values());
      const info = $("qrInfo");
      const o = opts();
      $("qrPng").disabled = $("qrSvg").disabled = true;
      if (p.error) {
        current = null;
        $("qrPreview").innerHTML = `<div class="qr-placeholder">${esc(p.error)}</div>`;
        info.textContent = "";
        info.className = "qr-info";
        return;
      }
      let m;
      try {
        m = await matrix(p.text, o.ecl);
      } catch (e) {
        if (my !== token) return;
        current = null;
        $("qrPreview").innerHTML = `<div class="qr-placeholder">${esc(e.message)}</div>`;
        info.textContent = "";
        return;
      }
      if (my !== token) return;
      current = { text: p.text, m, opts: o, type: t };
      $("qrPreview").innerHTML = toSvg(m, { ...o, size: 240 });
      const warn = colourWarning(o.fg, o.bg) || p.warning || "";
      info.className = `qr-info${warn ? " warn" : ""}`;
      info.innerHTML = `${warn ? `${esc(warn)}<br>` : ""}<span class="qr-encoded" title="What the code contains">${esc(p.text.length > 160 ? p.text.slice(0, 160) + "…" : p.text)}</span>`;
      $("qrPng").disabled = $("qrSvg").disabled = false;
    }

    const fileBase = () => ({ link: "qr-link", text: "qr-text", wifi: "qr-wifi", upi: "upi-qr", contact: "qr-contact" }[current.type] || "qr-code");
    async function downloadPng() {
      if (!current) return;
      const canvas = toCanvas(current.m, current.opts);
      canvas.toBlob((blob) => {
        if (!blob) return showToast("Couldn't make the picture.", "error");
        downloadBlob(blob, `${fileBase()}.png`);
        showToast(`Done! Downloaded ${fileBase()}.png. Nothing was uploaded.`, "success");
      }, "image/png");
    }
    function downloadSvg() {
      if (!current) return;
      downloadBlob(new Blob([toSvg(current.m, current.opts)], { type: "image/svg+xml" }), `${fileBase()}.svg`);
      showToast(`Done! Downloaded ${fileBase()}.svg. Nothing was uploaded.`, "success");
    }

    function setMode(m) {
      mode = m;
      root.querySelectorAll(".qr-mode").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
      $("qrMake").hidden = m !== "make";
      $("qrRead").hidden = m !== "read";
      // Making a code needs no file: hide the drop zone and the footer button.
      if (shared.drop) shared.drop.style.display = m === "make" ? "none" : "";
      if (shared.exec) {
        shared.exec.style.display = m === "make" ? "none" : "";
        shared.exec.querySelector(".btn-text").textContent = "Read QR code";
      }
      const box = document.getElementById("resultBox");
      if (box && m === "make") box.style.display = "none";
      if (m === "make") stopCamera();
      else loadReader().catch(() => {});
    }

    // Camera scanning (phones and laptops with a webcam).
    async function startCamera() {
      const live = $("qrLive");
      live.innerHTML = "";
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        live.innerHTML = `<p class="qr-warn">This browser can't use the camera here. Take a photo of the code and add it above instead.</p>`;
        return;
      }
      let jsQR;
      try {
        jsQR = await loadReader();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      } catch (e) {
        const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
        live.innerHTML = `<p class="qr-warn">${denied ? "Camera access was blocked. Allow the camera for this site in your browser settings, or add a photo of the code above." : "Couldn't start the camera. Add a photo of the code above instead."}</p>`;
        stream = null;
        return;
      }
      const video = $("qrVideo");
      video.srcObject = stream;
      $("qrCamBox").hidden = false;
      $("qrCam").hidden = true;
      try { await video.play(); } catch (e) { /* autoplay blocked; frames still arrive */ }
      const c = document.createElement("canvas");
      const g = c.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (!stream) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
          g.drawImage(video, 0, 0, c.width, c.height);
          const img = g.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, c.width, c.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            stopCamera();
            if (navigator.vibrate) navigator.vibrate(80);
            live.innerHTML = "";
            const box = document.createElement("div");
            box.className = "result-box";
            live.append(box);
            renderResults({ results: [{ text: code.data, from: "Camera" }] }, box);
            return;
          }
        }
        camTimer = setTimeout(tick, 180);
      };
      tick();
    }
    function stopCamera() {
      clearTimeout(camTimer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      const video = $("qrVideo");
      if (video) video.srcObject = null;
      if ($("qrCamBox")) $("qrCamBox").hidden = true;
      if ($("qrCam")) $("qrCam").hidden = false;
    }

    root.addEventListener("input", () => refresh());
    root.addEventListener("change", (e) => {
      if (e.target.name === "qrType") {
        root.querySelectorAll(".qr-set").forEach((s) => { s.hidden = s.dataset.type !== type(); });
        const first = root.querySelector(`.qr-set[data-type="${type()}"] input, .qr-set[data-type="${type()}"] textarea`);
        if (first) first.focus({ preventScroll: true });
      }
      refresh();
    });
    root.querySelectorAll(".qr-mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("qrPng").onclick = downloadPng;
    $("qrSvg").onclick = downloadSvg;
    $("qrCam").onclick = startCamera;
    $("qrCamStop").onclick = stopCamera;

    // Open in the mode the address asks for (/qr-code-scanner, /upi-qr-code).
    const path = location.pathname;
    if (/scan|read/.test(path)) setMode("read");
    else setMode("make");
    if (/upi/.test(path)) { root.querySelector('input[name="qrType"][value="upi"]').checked = true; root.querySelectorAll(".qr-set").forEach((s) => { s.hidden = s.dataset.type !== "upi"; }); }
    refresh();

    return {
      mode: () => mode,
      setMode,
      current: () => current,
      destroy() {
        stopCamera();
        token++;
        if (shared.drop) shared.drop.style.display = "";
        if (shared.exec) shared.exec.style.display = "";
      },
    };
  }

  async function run(ctx) {
    const ui = ctx.qr;
    if (ui && ui.mode() === "make") {
      const cur = ui.current();
      if (!cur) throw UserError("Fill in what goes in the QR code first.");
      const canvas = toCanvas(cur.m, cur.opts);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), filename: "qr-code.png", mime: "image/png" };
    }
    ctx.progress(0.05, "Loading the QR reader…");
    const data = await readFiles(ctx.files, ctx.buffers, (f, label) => ctx.progress(0.1 + f * 0.85, label));
    const n = data.results.filter((r) => r.text !== undefined).length;
    return { json: data, message: n ? `Found ${n} QR code${n === 1 ? "" : "s"}.` : "No QR code found." };
  }

  return { configHtml, create, run, renderResults, payload, matrix, toSvg, toCanvas, readFiles, UPI_ID };
})();

TOOLS.push({
  id: "qr-code",
  slug: "qr-code",
  name: "QR Code Maker & Reader",
  desc: "Make a QR code for a link, text, Wi-Fi, UPI payment or contact card, or read a QR code from a photo, PDF or your camera.",
  keywords: "qr code generator qr maker create qr make qr upi qr code payment qr gpay phonepe paytm bhim wifi qr wi-fi password qr vcard contact qr link to qr url qr scan qr code reader scanner decode qr read qr from image read qr from pdf camera barcode",
  icon: "🔳",
  category: "image",
  badge: "New",
  accept: "image/*,.pdf,application/pdf,.heic,.heif",
  acceptLabel: "pictures or PDFs with a QR code",
  multipleFiles: true,
  actionLabel: "Read QR code",
  caption: "Make or scan in a tap",
  scene: "scan",
  configHtml: QrTool.configHtml,
  onOpen: (ctx) => { ctx.qr = QrTool.create(ctx.el("qrRoot"), ctx); },
  onFiles: (ctx) => {
    if (!ctx.files.length) return;
    if (ctx.qr.mode() !== "read") ctx.qr.setMode("read");
    // Read straight away, like a scanner would.
    setTimeout(() => { if (activeTool && activeTool.id === "qr-code" && currentFiles.length) executeCurrentTool(); }, 0);
  },
  onClose: (ctx) => ctx.qr && ctx.qr.destroy(),
  renderResult: (data, box) => QrTool.renderResults(data, box),
  run: QrTool.run,
});
