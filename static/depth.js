// 3D touches: the hero's page stack follows the pointer, and tool cards tilt toward it.
// Only on devices with a mouse, and never when the visitor asks for reduced motion.

(() => {
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const enabled = () => finePointer.matches && !reducedMotion.matches;

  // Hero: the whole scene turns gently toward the pointer.
  const rigs = document.querySelectorAll(".scene-rig");
  if (rigs.length) {
    let frame = 0;
    window.addEventListener("pointermove", (e) => {
      if (!enabled() || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        rigs.forEach((rig) => {
          rig.style.setProperty("--look-y", `${(x * 16).toFixed(2)}deg`);
          rig.style.setProperty("--look-x", `${(-y * 10).toFixed(2)}deg`);
        });
      });
    }, { passive: true });
  }

  // Tool cards: tilt toward the pointer with a moving highlight. Cards are re-created
  // whenever the grid is filtered, so listen on the grid instead of each card.
  const grid = document.getElementById("toolsGrid");
  if (!grid) return;
  const MAX_TILT = 9;
  let active = null;

  function reset(card) {
    card.classList.remove("is-tilting");
    card.style.removeProperty("--tilt-x");
    card.style.removeProperty("--tilt-y");
  }

  grid.addEventListener("pointermove", (e) => {
    if (!enabled()) return;
    const card = e.target.closest(".tool-card");
    if (active && active !== card) reset(active);
    active = card;
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    card.classList.add("is-tilting");
    card.style.setProperty("--tilt-y", `${((px - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
    card.style.setProperty("--tilt-x", `${((0.5 - py) * 2 * MAX_TILT).toFixed(2)}deg`);
    card.style.setProperty("--glare-x", `${(px * 100).toFixed(1)}%`);
    card.style.setProperty("--glare-y", `${(py * 100).toFixed(1)}%`);
  }, { passive: true });

  grid.addEventListener("pointerleave", () => {
    if (active) reset(active);
    active = null;
  });
})();
