// Donate / sponsor buttons at the bottom of the page.
//
// ✏️  FILL THESE IN: replace each "REPLACE_ME" link with your own. A button whose link
// still says REPLACE_ME shows "not set up yet" instead of going anywhere. Delete any you don't use.
const SUPPORT_LINKS = [
  { label: "Pay with UPI", icon: "🇮🇳", note: "GPay, PhonePe, Paytm", url: `upi://pay?pa=REPLACE_ME@upi&pn=${encodeURIComponent((window.BRAND && window.BRAND.name) || "UltraPDF")}&cu=INR` },
  { label: "Buy me a coffee", icon: "☕", note: "One-time", url: "https://www.buymeacoffee.com/REPLACE_ME" },
  { label: "GitHub Sponsors", icon: "💜", note: "Monthly", url: "https://github.com/sponsors/REPLACE_ME" },
  { label: "PayPal", icon: "🌍", note: "From any country", url: "https://paypal.me/REPLACE_ME" },
];
// Where companies can write to you about sponsoring (an email or a page).
const SPONSOR_CONTACT = "mailto:REPLACE_ME@example.com?subject=Sponsorship";

(() => {
  const box = document.getElementById("supportLinks");
  if (!box) return;
  const ready = (url) => url && !url.includes("REPLACE_ME");
  box.innerHTML = SUPPORT_LINKS.map((l, i) => `
    <a class="support-btn" href="${ready(l.url) ? l.url : "#support"}" data-i="${i}" ${ready(l.url) && l.url.startsWith("http") ? 'target="_blank" rel="noopener"' : ""}>
      <span class="support-icon">${l.icon}</span>
      <span><strong>${l.label}</strong><small>${l.note}</small></span>
    </a>`).join("");
  const notYet = (e) => {
    e.preventDefault();
    showToast("This donation link isn't set up yet. Thanks for wanting to help!", "success");
  };
  box.querySelectorAll(".support-btn").forEach((a) => {
    if (!ready(SUPPORT_LINKS[a.dataset.i].url)) a.addEventListener("click", notYet);
  });
  const sponsor = document.getElementById("sponsorLink");
  if (ready(SPONSOR_CONTACT)) sponsor.href = SPONSOR_CONTACT;
  else sponsor.addEventListener("click", notYet);
})();
