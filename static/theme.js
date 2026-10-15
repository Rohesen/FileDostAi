// Light/dark theme: follows the device setting until the visitor picks one, then remembers it.
// (The first lines run in <head> as well, so the page never flashes the wrong theme.)
const Theme = (() => {
  const KEY = "filedost-theme";
  const OLD_KEYS = ["mypdfdost-theme", "ultrapdf-theme"]; // earlier names; still read so nobody loses their choice
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const saved = () => { try { return localStorage.getItem(KEY) || OLD_KEYS.map((k) => localStorage.getItem(k)).find(Boolean) || null; } catch (e) { return null; } };
  const current = () => document.documentElement.dataset.theme || "dark";

  function apply(theme, animate) {
    const root = document.documentElement;
    if (animate) {
      root.classList.add("theme-fade");
      setTimeout(() => root.classList.remove("theme-fade"), 500);
    }
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#f4f6fb" : "#0b0f19";
    const btn = document.getElementById("themeToggle");
    if (btn) {
      btn.setAttribute("aria-pressed", String(theme === "light"));
      btn.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    }
    document.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  }

  function toggle() {
    const next = current() === "light" ? "dark" : "light";
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: just this visit */ }
    apply(next, true);
  }

  media.addEventListener("change", (e) => { if (!saved()) apply(e.matches ? "light" : "dark", true); });
  document.addEventListener("DOMContentLoaded", () => {
    apply(saved() || (media.matches ? "light" : "dark"), false);
    const btn = document.getElementById("themeToggle");
    if (btn) btn.addEventListener("click", toggle);
  });
  return { toggle, current };
})();
