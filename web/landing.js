// Landing background: Blue and Red drift together, fuse into Purple, burst. Loops.
(() => {
  // Liquid refraction on backdrop-filter only works in Chromium; elsewhere keep plain frosted glass.
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  if (brands.some((b) => /Chromium|Google Chrome|Edge/.test(b.brand))) document.documentElement.classList.add("liquid");

  const cv = document.getElementById("bg");
  const g = cv.getContext("2d");
  const TAU = Math.PI * 2, CYCLE = 12;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, running = true, t0 = performance.now();

  function resize() {
    const k = Math.min(devicePixelRatio || 1, 1.5) * 0.6;   // render below native res; it's all glow anyway
    W = cv.width = Math.round(innerWidth * k);
    H = cv.height = Math.round(innerHeight * k);
  }
  addEventListener("resize", resize);
  resize();

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
  const BLUE = [61, 139, 255], RED = [255, 59, 59], PURPLE = [184, 77, 255], WHITE = [255, 255, 255];
  const parts = Array.from({ length: 140 }, () => ({ a: Math.random() * TAU, r: Math.random(), s: 0.4 + Math.random(), side: Math.random() < 0.5 ? 0 : 1 }));
  const dust = Array.from({ length: 90 }, () => [Math.random(), Math.random(), Math.random(), Math.random()]);

  function glow(x, y, r, c, a) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(c, a)); gr.addColorStop(0.4, rgba(c, a * 0.35)); gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  function orb(x, y, r, c, k) {
    glow(x, y, r * 6, c, 0.35 * k);
    glow(x, y, r * 2.2, c, 0.9 * k);
    g.fillStyle = rgba(WHITE, 0.95 * k); g.beginPath(); g.arc(x, y, r * 0.55, 0, TAU); g.fill();
    g.strokeStyle = rgba(WHITE, 0.35 * k); g.lineWidth = 1; g.beginPath(); g.arc(x, y, r * 1.6, 0, TAU); g.stroke();
  }
  function bolt(a, b, c, k, rough = 0.25) {
    let pts = [a, b], d = Math.hypot(b[0] - a[0], b[1] - a[1]) * rough;
    for (let l = 0; l < 5; l++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, o = (Math.random() * 2 - 1) * d;
        out.push([(p[0] + q[0]) / 2 - dy / L * o, (p[1] + q[1]) / 2 + dx / L * o], q);
      }
      pts = out; d *= 0.55;
    }
    for (const [w, col, a] of [[4, c, 0.5 * k], [1.2, WHITE, 0.9 * k]]) {
      g.strokeStyle = rgba(col, a); g.lineWidth = w; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) g.lineTo(p[0], p[1]);
      g.stroke();
    }
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const T = (now - t0) / 1000, t = reduce ? 3 : T % CYCLE;
    const cx = W * 0.5, cy = H * 0.46, u = Math.min(W, H);
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#08070b"; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";

    // drifting energy dashes
    for (const [x, y, l, ph] of dust) {
      const a = Math.max(0, Math.sin(T * 1.5 + ph * 40));
      if (a < 0.05) continue;
      const px = ((x * W - T * 12 * (0.5 + l)) % W + W) % W, py = ((y * H - T * 6 * (0.5 + ph)) % H + H) % H;
      g.strokeStyle = rgba(ph < 0.5 ? PURPLE : RED, 0.5 * a); g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + 3 + l * 10, py); g.stroke();
    }

    const merge = Math.min(1, Math.max(0, (t - 1) / 6));           // 0 -> 1 as they approach
    const ease = merge * merge * (3 - 2 * merge);
    const sep = u * (0.42 - 0.38 * ease);
    const spin = T * 0.35;
    const b = [cx - Math.cos(spin) * sep, cy - Math.sin(spin) * sep * 0.35];
    const r = [cx + Math.cos(spin) * sep, cy + Math.sin(spin) * sep * 0.35];
    const orbR = u * 0.022;

    if (t < 7.2) {
      for (const p of parts) {   // particles spiralling into each orb
        p.r -= 0.004 * p.s; p.a += 0.02 * p.s / Math.max(p.r, 0.15);
        if (p.r < 0.05) { p.r = 1; p.a = Math.random() * TAU; }
        const c = p.side ? r : b, R = p.r * u * 0.16;
        g.fillStyle = rgba(p.side ? [255, 160, 150] : [160, 200, 255], (1 - p.r) * 0.9);
        g.beginPath(); g.arc(c[0] + Math.cos(p.a) * R, c[1] + Math.sin(p.a) * R * 0.8, 1.2, 0, TAU); g.fill();
      }
      const k = 0.7 + 0.3 * Math.sin(T * 4);
      orb(b[0], b[1], orbR, BLUE, k);
      orb(r[0], r[1], orbR, RED, k);
      if (merge > 0.55 && Math.random() < merge * 0.5) bolt(b, r, PURPLE, merge);
    } else if (t < 10) {
      const k = Math.min(1, (t - 7.2) / 0.4), grow = 1 + 1.6 * Math.min(1, (t - 7.2) / 1.5);
      orb(cx, cy, orbR * grow * (1 + 0.05 * Math.sin(T * 25)), PURPLE, k);
      g.strokeStyle = rgba(PURPLE, 0.6 * k); g.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.ellipse(cx, cy, orbR * grow * (1.6 + i * 0.25), orbR * grow * (0.6 + i * 0.12), T * (2 + i * 0.3) + i, 0, 4);
        g.stroke();
      }
      if (Math.random() < 0.45) {
        const a = Math.random() * TAU;
        bolt([cx, cy], [cx + Math.cos(a) * u * 0.5, cy + Math.sin(a) * u * 0.35], PURPLE, k, 0.3);
      }
    } else {
      const e = (t - 10) / 2;   // burst + fade
      g.fillStyle = rgba([235, 210, 255], Math.max(0, 0.5 - e * 2)); g.fillRect(0, 0, W, H);
      for (let i = 0; i < 3; i++) {
        const ee = e - i * 0.06;
        if (ee <= 0) continue;
        g.strokeStyle = rgba(i ? PURPLE : WHITE, Math.max(0, 0.8 - ee)); g.lineWidth = Math.max(1, 5 * (1 - ee));
        g.beginPath(); g.arc(cx, cy, ee * u * 1.2, 0, TAU); g.stroke();
      }
      glow(cx, cy, u * 0.4 * (1 + e), PURPLE, Math.max(0, 0.5 - e * 0.5));
    }
  }
  requestAnimationFrame(frame);
  addEventListener("limitless:start", () => { running = false; });
  addEventListener("limitless:menu", () => { if (!running) { running = true; requestAnimationFrame(frame); } });
})();
