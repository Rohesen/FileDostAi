// Privacy Check results: a score, what was found, and one-click fixes.

const PrivacyView = (() => {
  const SEV = { high: ["High", "#f87171"], medium: ["Medium", "#fbbf24"], low: ["Low", "#94a3b8"] };

  async function post(endpoint, file, fields = {}) {
    const body = new FormData();
    body.append("file", file);
    Object.entries(fields).forEach(([k, v]) => body.append(k, v));
    const res = await fetch(endpoint, { method: "POST", body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(typeof err.detail === "string" ? err.detail : "That didn't work."), { userFacing: true });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  function render(data, box, ctx) {
    const score = data.score;
    const colour = score >= 85 ? "#34d399" : score >= 60 ? "#fbbf24" : "#f87171";
    const fixes = new Set(data.findings.map((f) => f.fix).filter(Boolean));
    box.innerHTML = `
      <div class="pv-head">
        <div class="pv-score" style="--c:${colour};--p:${score}"><span>${score}</span></div>
        <div>
          <strong>${score >= 85 ? "Looks safe to share" : score >= 60 ? "Some private data found" : "Private data found"}</strong>
          <p class="drop-hint">${data.findings.length ? `${data.findings.length} thing${data.findings.length > 1 ? "s" : ""} to check before you share this file.` : "No hidden personal data found."}</p>
        </div>
      </div>
      <ul class="pv-list">
        ${data.findings.map((f) => `
          <li><span class="pv-sev" style="color:${SEV[f.severity][1]}">${SEV[f.severity][0]}</span>
            <div><strong>${escapeHtml(f.title)}</strong><p>${escapeHtml(f.detail)}</p></div></li>`).join("")}
      </ul>
      <div class="sign-row pv-fixes">
        ${fixes.has("remove-metadata") ? `<button type="button" class="btn btn-primary btn-xs" data-fix="strip">Remove hidden data</button>` : ""}
        ${fixes.has("redact") ? `<button type="button" class="btn btn-xs" data-fix="redact">Redact ${data.found_terms.length} personal detail${data.found_terms.length === 1 ? "" : "s"}</button>` : ""}
        ${fixes.has("flatten") ? `<button type="button" class="btn btn-xs" data-fix="flatten">Flatten comments and forms</button>` : ""}
      </div>`;
    box.querySelectorAll("[data-fix]").forEach((b) => b.addEventListener("click", async () => {
      const file = ctx.files[0];
      const stem = file.name.replace(/\.pdf$/i, "");
      b.disabled = true;
      try {
        let bytes, name;
        if (b.dataset.fix === "strip") {
          bytes = await post("/api/strip-private", file);
          name = `${stem}_clean.pdf`;
        } else if (b.dataset.fix === "redact") {
          bytes = await post("/api/redact", file, { keywords: data.found_terms.join(","), redact_emails: "true", redact_phones: "true" });
          name = `${stem}_redacted.pdf`;
        } else {
          bytes = await post("/api/flatten", file);
          name = `${stem}_flattened.pdf`;
        }
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
        showToast(`Done! Downloaded ${name}. Run the check again on it to confirm.`, "success");
      } catch (e) {
        reportError(e);
      } finally {
        b.disabled = false;
      }
    }));
  }

  return { render };
})();
