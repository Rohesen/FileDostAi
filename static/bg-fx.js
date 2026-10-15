// Animated background: file cards (PDF, JPG, DOC...) drift through 3D space, linked by
// faint lines like a network, and lean away from the pointer. Fewer cards on phones,
// paused when the tab is hidden or a tool is open, drawn at 30 frames a second, and still for
// visitors who ask for reduced motion. It all runs in the visitor's browser, so hosting is unaffected.

(() => {
  const host = document.getElementById("bgFx");
  if (!host) return;
  const canvas = document.createElement("canvas");
  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const g = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const KINDS = [
    { t: "PDF", c: "#ef4444" }, { t: "JPG", c: "#ec4899" }, { t: "PNG", c: "#a855f7" },
    { t: "DOC", c: "#3b82f6" }, { t: "XLS", c: "#10b981" }, { t: "PPT", c: "#f97316" },
    { t: "ZIP", c: "#eab308" }, { t: "TXT", c: "#64748b" },
  ];
  let W = 0, H = 0, dpr = 1, items = [], light = false, running = false, last = 0;
  const pointer = { x: -9999, y: -9999, px: 0, py: 0 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(Math.min(W < 700 ? 12 : 34, Math.max(10, (W * H) / 42000)));
    while (items.length < want) items.push(spawn(true));
    items.length = want;
  }

  function spawn(anywhere) {
    const z = 0.25 + Math.random() * 0.75; // depth: 1 is close
    return {
      x: Math.random() * W, y: anywhere ? Math.random() * H : H + 60,
      z, k: KINDS[(Math.random() * KINDS.length) | 0],
      vx: (Math.random() - 0.5) * 0.15, vy: -(0.12 + Math.random() * 0.3) * z,
      rot: (Math.random() - 0.5) * 0.6, vr: (Math.random() - 0.5) * 0.002,
      tilt: Math.random() * Math.PI * 2, ox: 0, oy: 0,
    };
  }

  function card(it, sx, sy) {
    const s = 22 + it.z * 26;             // size by depth
    const w = s * 0.78, h = s, fold = s * 0.22;
    const squash = 0.75 + 0.25 * Math.cos(it.tilt); // spinning in 3D around its vertical axis
    g.save();
    g.translate(sx, sy);
    g.rotate(it.rot);
    g.scale(squash, 1);
    g.globalAlpha = (light ? 0.4 : 0.42) * (0.35 + it.z * 0.65);
    // page with a folded corner
    g.beginPath();
    g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2 - fold, -h / 2); g.lineTo(w / 2, -h / 2 + fold);
    g.lineTo(w / 2, h / 2); g.lineTo(-w / 2, h / 2); g.closePath();
    g.fillStyle = light ? "rgba(255,255,255,0.95)" : "rgba(30,41,59,0.85)";
    if (it.z > 0.6) { g.shadowColor = it.k.c; g.shadowBlur = 12 * it.z; } // glow only on the near ones
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = it.k.c; g.lineWidth = 1;
    g.stroke();
    g.beginPath();
    g.moveTo(w / 2 - fold, -h / 2); g.lineTo(w / 2 - fold, -h / 2 + fold); g.lineTo(w / 2, -h / 2 + fold);
    g.stroke();
    // text lines and the format label
    g.fillStyle = light ? "rgba(15,23,42,0.18)" : "rgba(255,255,255,0.16)";
    for (let i = 0; i < 3; i++) g.fillRect(-w / 2 + w * 0.15, -h / 2 + h * (0.3 + i * 0.13), w * (i === 2 ? 0.4 : 0.6), Math.max(1, h * 0.05));
    g.fillStyle = it.k.c;
    const lh = h * 0.24;
    g.fillRect(-w / 2 + w * 0.12, h / 2 - lh - h * 0.08, w * 0.76, lh);
    g.fillStyle = "#fff";
    g.font = `800 ${Math.max(6, lh * 0.72)}px "Geist", sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(it.k.t, 0, h / 2 - lh / 2 - h * 0.08 + 0.5);
    g.restore();
  }

  const toolOpen = () => !!document.querySelector("#universalModal.open, #pipelineModal.open");
  let drawn = 0;
  function frame(t) {
    if (!running) return;
    // 30 frames a second is plenty for slow drift, and halves the work. Hold still behind an open tool.
    if (t - drawn < 32 || toolOpen()) { requestAnimationFrame(frame); return; }
    drawn = t;
    const dt = Math.min(64, t - (last || t)) / 16.7;
    last = t;
    g.clearRect(0, 0, W, H);
    pointer.px += ((pointer.x === -9999 ? W / 2 : pointer.x) / W - 0.5 - pointer.px) * 0.05;
    pointer.py += ((pointer.y === -9999 ? H / 2 : pointer.y) / H - 0.5 - pointer.py) * 0.05;
    const scroll = window.scrollY || 0;
    const pos = items.map((it) => {
      it.x += it.vx * dt; it.y += it.vy * dt; it.rot += it.vr * dt; it.tilt += 0.006 * dt * it.z;
      // lean away from the pointer
      const dx = it.x + it.ox - pointer.x, dy = it.y + it.oy - pointer.y, d2 = dx * dx + dy * dy;
      if (d2 < 22000) { const f = (1 - d2 / 22000) * 2.2 * it.z; it.ox += (dx / Math.sqrt(d2 + 1)) * f; it.oy += (dy / Math.sqrt(d2 + 1)) * f; }
      it.ox *= 0.95; it.oy *= 0.95;
      if (it.y < -80 || it.x < -100 || it.x > W + 100) Object.assign(it, spawn(false));
      const sx = it.x + it.ox - pointer.px * 60 * it.z;
      const sy = ((it.y + it.oy - pointer.py * 40 * it.z - scroll * 0.12 * it.z) % (H + 160) + H + 160) % (H + 160) - 80;
      return [sx, sy, it];
    });
    // network lines between neighbours at similar depth
    g.lineWidth = 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j];
        if (Math.abs(a[2].z - b[2].z) > 0.3) continue;
        const dx = a[0] - b[0], dy = a[1] - b[1], d = Math.hypot(dx, dy), max = 190 * a[2].z;
        if (d > max) continue;
        const alpha = (1 - d / max) * 0.35 * a[2].z;
        g.strokeStyle = light ? `rgba(79,70,229,${alpha})` : `rgba(129,140,248,${alpha})`;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        // a dot travelling along the line, like a file being sent
        const p = ((t / 2600) + i * 0.17) % 1;
        g.fillStyle = light ? `rgba(8,145,178,${alpha * 2})` : `rgba(103,232,249,${alpha * 2})`;
        g.beginPath(); g.arc(a[0] - dx * p, a[1] - dy * p, 1.6, 0, Math.PI * 2); g.fill();
      }
    }
    pos.sort((a, b) => a[2].z - b[2].z).forEach(([x, y, it]) => card(it, x, y));
    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    if (reduced.matches) { running = true; frame(performance.now()); running = false; return; }
    running = true; last = 0;
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  window.addEventListener("resize", () => { resize(); if (!running) start(); }, { passive: true });
  window.addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.x = pointer.y = -9999; });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduced.addEventListener("change", () => { stop(); start(); });
  const readTheme = () => { light = document.documentElement.dataset.theme === "light"; if (!running) start(); };
  document.addEventListener("themechange", readTheme);
  readTheme();
  resize();
  start();
})();
