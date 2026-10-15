// Ratings and feedback: stars after a tool works, average ratings on tool cards,
// and "Report a problem" / "Request a tool" forms. Only the rating and the words typed
// are sent; files never are.

const Feedback = (() => {
  let ratings = {};
  const ASKED_KEY = "ultrapdf-rated";

  function asked() {
    try { return JSON.parse(localStorage.getItem(ASKED_KEY) || "{}"); } catch (e) { return {}; }
  }
  function remember(slug) {
    try {
      const a = asked();
      a[slug] = Date.now();
      localStorage.setItem(ASKED_KEY, JSON.stringify(a));
    } catch (e) { /* private mode: just ask again next time */ }
  }

  async function send(fields) {
    const body = new FormData();
    Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null) body.append(k, v); });
    const res = await fetch("/api/feedback", { method: "POST", body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : "Couldn't send that right now. Please try again later.");
    }
  }

  async function loadRatings() {
    if (!navigator.onLine) return;
    try {
      const res = await fetch("/api/ratings");
      if (res.ok) ratings = await res.json();
    } catch (e) { /* offline */ }
    decorate();
  }

  function stars(avg) {
    const full = Math.round(avg);
    return "★".repeat(full) + "☆".repeat(5 - full);
  }

  /** Adds "★★★★★ 4.8 (120)" to each tool card that has ratings. */
  function decorate() {
    document.querySelectorAll(".tool-card").forEach((card) => {
      const slug = card.getAttribute("href").slice(1);
      const r = ratings[slug];
      const footer = card.querySelector(".card-footer");
      if (!r || !footer || footer.querySelector(".card-rating")) return;
      const el = document.createElement("span");
      el.className = "card-rating";
      el.title = `Rated ${r.average} out of 5 by ${r.count} ${r.count === 1 ? "person" : "people"}`;
      el.innerHTML = `<span class="stars">${stars(r.average)}</span> ${r.average} <span class="count">(${r.count})</span>`;
      footer.appendChild(el);
    });
  }

  /** Shown under the result after a tool succeeds, unless this person rated the tool recently. */
  function askForRating(tool) {
    const old = document.getElementById("rateBox");
    if (old) old.remove();
    const when = asked()[tool.slug];
    if (when && Date.now() - when < 30 * 24 * 3600 * 1000) return;
    const box = document.createElement("div");
    box.id = "rateBox";
    box.className = "rate-box";
    box.innerHTML = `
      <div class="rate-row">
        <span>How did ${escapeHtml(tool.name)} do?</span>
        <div class="rate-stars" role="radiogroup" aria-label="Rate this tool">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? "s" : ""}" data-n="${n}">★</button>`).join("")}
        </div>
        <button type="button" class="rate-close" aria-label="No thanks">&times;</button>
      </div>
      <div class="rate-more" hidden>
        <textarea class="form-input" id="rateComment" rows="2" maxlength="2000" placeholder="Anything we should fix or add? (optional)"></textarea>
        <button type="button" class="btn btn-primary btn-xs" id="rateSend">Send</button>
      </div>`;
    const anchor = document.getElementById("resultBox");
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
    let chosen = 0;
    const buttons = box.querySelectorAll(".rate-stars button");
    const paint = (n) => buttons.forEach((b) => b.classList.toggle("on", Number(b.dataset.n) <= n));
    buttons.forEach((b) => {
      b.addEventListener("mouseenter", () => paint(Number(b.dataset.n)));
      b.addEventListener("mouseleave", () => paint(chosen));
      b.addEventListener("click", () => {
        chosen = Number(b.dataset.n);
        buttons.forEach((x) => x.setAttribute("aria-checked", String(Number(x.dataset.n) === chosen)));
        paint(chosen);
        box.querySelector(".rate-more").hidden = false;
        box.querySelector("#rateComment").placeholder = chosen <= 3
          ? "What went wrong? We read every message. (optional)"
          : "Anything we should add? (optional)";
        box.querySelector("#rateComment").focus();
      });
    });
    box.querySelector(".rate-close").addEventListener("click", () => { remember(tool.slug); box.remove(); });
    box.querySelector("#rateSend").addEventListener("click", async () => {
      try {
        await send({ kind: "rating", tool: tool.slug, rating: chosen, comment: box.querySelector("#rateComment").value });
        remember(tool.slug);
        box.innerHTML = `<p class="rate-thanks">Thanks! Your rating helps us decide what to improve next.</p>`;
        loadRatingsSoon();
      } catch (e) {
        showToast(e.message, "error");
      }
    });
  }

  let refresh = null;
  function loadRatingsSoon() {
    clearTimeout(refresh);
    refresh = setTimeout(() => {
      document.querySelectorAll(".card-rating").forEach((el) => el.remove());
      loadRatings();
    }, 500);
  }

  function clearRatingPrompt() {
    const old = document.getElementById("rateBox");
    if (old) old.remove();
  }

  /** "Report a problem" or "Request a tool" form in its own small modal. */
  function openForm(kind) {
    const modal = document.getElementById("feedbackModal");
    const problem = kind === "problem";
    modal.querySelector("#fbTitle").textContent = problem ? "Report a problem" : "Request a tool";
    modal.querySelector("#fbIntro").textContent = problem
      ? "Tell us what happened and with which tool. Please don't paste private document text."
      : "Which PDF tool should we build next, and what would you use it for?";
    const select = modal.querySelector("#fbTool");
    select.innerHTML = `<option value="">${problem ? "Which tool? (optional)" : "Not about a specific tool"}</option>` +
      TOOLS.map((t) => `<option value="${t.slug}">${escapeHtml(t.name)}</option>`).join("");
    if (problem && typeof activeTool !== "undefined" && activeTool) select.value = activeTool.slug;
    modal.querySelector("#fbComment").value = "";
    modal.dataset.kind = kind;
    modal.classList.add("open");
    modal.querySelector("#fbComment").focus();
  }

  function setup() {
    const modal = document.getElementById("feedbackModal");
    if (!modal) return;
    document.querySelectorAll("[data-feedback]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      openForm(a.dataset.feedback);
    }));
    modal.querySelector("#fbCancel").addEventListener("click", () => modal.classList.remove("open"));
    modal.querySelector("#fbSend").addEventListener("click", async () => {
      try {
        await send({
          kind: modal.dataset.kind,
          tool: modal.querySelector("#fbTool").value,
          comment: modal.querySelector("#fbComment").value,
          contact: modal.querySelector("#fbContact").value,
        });
        modal.classList.remove("open");
        showToast("Thanks! We got your message.", "success");
      } catch (e) {
        showToast(e.message, "error");
      }
    });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("open"); });
    loadRatings();
  }

  document.addEventListener("DOMContentLoaded", setup);
  return { askForRating, clearRatingPrompt, decorate, openForm, loadRatings };
})();
