// Limitless - Hollow Purple & Reversal: Red, in the browser.
// Hand tracking: MediaPipe Tasks (WASM). Effects: Canvas 2D with additive
// blending + a downsample bloom chain. Audio: Web Audio.
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { Game, Progress, gradeOf, ACH } from "./game.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "models/hand_landmarker.task";
const AUDIO = { purple_charge: "audio/purple_charge.m4a", purple_blast: "audio/purple_blast.m4a", red: "audio/red.m4a" };

// --- tuning (same as the Python version) -----------------------------------
const PINCH_ON = 0.42, PINCH_OFF = 0.62;
const CURL_ON = 150, CURL_OFF = 165;
const RED_IDX_ON = 1.6, RED_IDX_OFF = 1.4;
const RED_OTH_ON = 1.3, RED_OTH_OFF = 1.5;
const PURPLE_CHARGE = 5.8, FIRE_MIN = 0.9;
const RED_HIT = 15.78, RED_GRACE = 0.6;
const PURPLE_BLAST = 2.6, RED_BLAST = 3.0;
const S = 0.5;                               // effect layer scale
const TAU = Math.PI * 2;

// RGB, 0..1 (values > 1 push toward white)
const WHITE = [1, 1, 1], PURPLE = [0.72, 0.22, 1.0], VIOLET = [0.9, 0.55, 1.0];
const BLUE = [0.08, 0.55, 1.0], RED = [1.0, 0.08, 0.1], CRIMSON = [0.55, 0.03, 0.05], HOTRED = [1.0, 0.6, 0.55];

// --- small helpers -----------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a) => { const l = len(a) + 1e-6; return [a[0] / l, a[1] / l]; };
const mixc = (a, b, ka, kb) => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
const rgb = (c, k = 1) => `rgb(${Math.min(255, c[0] * k * 255) | 0},${Math.min(255, c[1] * k * 255) | 0},${Math.min(255, c[2] * k * 255) | 0})`;
function angle(a, b, c) {
  const v1 = sub(a, b), v2 = sub(c, b);
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (len(v1) * len(v2) + 1e-6);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}
function canvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }

// drawing primitives (all on an additive 'lighter' context)
function disc(g, p, r, c, k) { if (r <= 0 || k <= 0) return; g.fillStyle = rgb(c, k); g.beginPath(); g.arc(p[0], p[1], r, 0, TAU); g.fill(); }
function haze(g, p, r, c, k) {
  if (r <= 0 || k <= 0) return;
  const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
  gr.addColorStop(0, rgb(c, k)); gr.addColorStop(0.45, rgb(c, k * 0.45)); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.beginPath(); g.arc(p[0], p[1], r, 0, TAU); g.fill();
}
function ring(g, p, r, c, k, w = 1) { if (r <= 0 || k <= 0) return; g.strokeStyle = rgb(c, k); g.lineWidth = w; g.beginPath(); g.arc(p[0], p[1], r, 0, TAU); g.stroke(); }
function seg(g, a, b, c, k, w = 1) { if (k <= 0) return; g.strokeStyle = rgb(c, k); g.lineWidth = w; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
function poly(g, pts, c, k, w = 1) {
  if (k <= 0 || pts.length < 2) return;
  g.strokeStyle = rgb(c, k); g.lineWidth = w; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
}

// --- gesture -----------------------------------------------------------------
class Hand {
  constructor(lm, W, H, label) {
    this.label = label;
    this.pts = lm.map((p) => [(1 - p.x) * W, p.y * H]);  // mirrored, selfie view
    const p = this.pts;
    this.palm = dist(p[0], p[9]) + 1e-6;
    this.pinch = dist(p[4], p[8]) / this.palm;
    this.curl = angle(p[5], p[6], p[8]);
    const reach = (m, t) => dist(p[t], p[0]) / (dist(p[m], p[0]) + 1e-6);
    this.indexReach = reach(5, 8);
    this.others = Math.max(reach(9, 12), reach(13, 16), reach(17, 20));
    this.center = mul(add(p[4], p[8]), 0.5);
    this.dir = unit(sub(this.center, p[0]));
    this.redC = add(p[8], mul(unit(sub(p[8], p[5])), this.palm * 0.3));
    this.posed = this.red = false;
  }
  classify([wasP, wasR]) {
    this.posed = wasP ? (this.pinch < PINCH_OFF && this.curl < CURL_OFF) : (this.pinch < PINCH_ON && this.curl < CURL_ON);
    this.red = wasR ? (this.indexReach > RED_IDX_OFF && this.others < RED_OTH_OFF)
                    : (this.indexReach > RED_IDX_ON && this.others < RED_OTH_ON && this.curl > 155);
    this.red = this.red && !this.posed;
    return [this.posed, this.red];
  }
}

// --- effect primitives ---------------------------------------------------------
class Swirl {
  constructor(n = 80) { this.p = Array.from({ length: n }, () => Swirl.spawn(false)); }
  static spawn(far = true) { return [rand(0, TAU), far ? rand(5, 10) : rand(1.2, 10), rand(0.6, 1.5)]; }
  step(dt, k) {
    for (let i = 0; i < this.p.length; i++) {
      let [a, r, s] = this.p[i];
      r -= dt * s * (2 + 6 * k); a += dt * s * (3 / Math.max(r, 0.6));
      this.p[i] = r < 1 ? Swirl.spawn() : [a, r, s];
    }
  }
  draw(g, c, rad, color, k) {
    const col = mixc(color, WHITE, 0.6, 0.6);
    for (const [a, r, s] of this.p) {
      const fade = Math.min(1, (10 - r) / 3) * k;
      disc(g, [c[0] + Math.cos(a) * r * rad, c[1] + Math.sin(a) * r * rad], s < 1.1 ? 0.8 : 1.4, col, fade);
    }
  }
}

function jagPath(a, b, rough, levels) {
  let pts = [a.slice(), b.slice()];
  let d = dist(a, b) * rough;
  for (let l = 0; l < levels; l++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1], s = sub(q, p), n = unit([-s[1], s[0]]), o = rand(-d, d);
      out.push([(p[0] + q[0]) / 2 + n[0] * o, (p[1] + q[1]) / 2 + n[1] * o], q);
    }
    pts = out; d *= 0.55;
  }
  return pts;
}

function makeBolt(a, b, rough = 0.2, levels = 6, branches = 4) {
  const main = jagPath(a, b, rough, levels);
  const out = [[main, 1]];
  const L = dist(a, b);
  for (let i = 0; i < branches; i++) {
    const j = randi(Math.floor(main.length / 6), Math.floor(main.length * 4 / 5));
    const s = sub(main[Math.min(j + 1, main.length - 1)], main[Math.max(j - 1, 0)]);
    const ang = Math.atan2(s[1], s[0]) + (Math.random() < 0.5 ? -1 : 1) * rand(0.3, 0.9);
    const q = add(main[j], mul([Math.cos(ang), Math.sin(ang)], L * rand(0.12, 0.35)));
    out.push([jagPath(main[j], q, rough * 1.3, Math.max(2, levels - 2)), 0.5]);
  }
  return out;
}

function drawBolt(g, bolt, color, k, width) {
  for (const [pts, wf] of bolt) poly(g, pts, color, 0.9 * k, Math.max(1, width * wf * 3));
  for (const [pts, wf] of bolt) poly(g, pts, WHITE, 1.4 * k, Math.max(0.8, width * wf));
}

function smallBolt(g, a, b, color, k, jag, segs = 7) {
  const d = sub(b, a), n = unit([-d[1], d[0]]);
  const pts = [a];
  for (let i = 1; i < segs; i++) pts.push(add(add(a, mul(d, i / segs)), mul(n, rand(-jag, jag))));
  pts.push(b);
  poly(g, pts, color, k, 1);
}

class Dashes {
  constructor(sw, sh, n = 110) { this.sw = sw; this.sh = sh; this.p = Array.from({ length: n }, () => [Math.random(), Math.random(), Math.random(), Math.random()]); }
  draw(g, color, k, t, vx = -30, vy = -12) {
    if (k <= 0.02) return;
    for (const [x, y, l, ph] of this.p) {
      const a = k * Math.max(0, Math.sin(t * 5 + ph * 40));
      if (a < 0.05) continue;
      const px = ((x * this.sw + vx * t * (0.5 + l)) % this.sw + this.sw) % this.sw;
      const py = ((y * this.sh + vy * t * (0.5 + ph)) % this.sh + this.sh) % this.sh;
      seg(g, [px, py], [px + 2 + l * 9, py], color, 1.6 * a, 1);
    }
  }
}

class Veins {
  constructor(sw, sh, origin) {
    this.segs = [];
    const step = sh * 0.035;
    for (let i = 0; i < 13; i++) {
      const side = randi(0, 3);
      const p = side === 0 ? [rand(0, sw), 0] : side === 1 ? [rand(0, sw), sh] : side === 2 ? [0, rand(0, sh)] : [sw, rand(0, sh)];
      const a = Math.atan2(origin[1] - p[1], origin[0] - p[0]) + rand(-0.8, 0.8);
      this.grow(p, a, randi(16, 26), step, rand(0, 0.4), 0);
    }
    for (let i = 0; i < 6; i++) {
      const a = rand(0, TAU);
      this.grow(add(origin, mul([Math.cos(a), Math.sin(a)], sh * 0.08)), a, randi(10, 16), step * 0.8, rand(0.3, 0.6), 1);
    }
  }
  grow(p, a, steps, step, t0, depth) {
    const dt = (depth === 0 ? 0.5 : 0.3) / steps;
    let t = t0;
    for (let i = 0; i < steps; i++) {
      a += rand(-0.45, 0.45);
      const q = add(p, mul([Math.cos(a), Math.sin(a)], step));
      const w = Math.max(1, Math.round((3 - depth) * (1 - 0.6 * i / steps)));
      this.segs.push([p[0], p[1], q[0], q[1], t, w]);
      if (depth < 2 && Math.random() < 0.13)
        this.grow(q, a + (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1.2), Math.max(3, steps >> 1), step * 0.8, t, depth + 1);
      p = q; t += dt;
    }
  }
  draw(g, progress, k, t) {
    if (k <= 0.01) return;
    const pulse = 0.75 + 0.25 * Math.sin(t * 4);
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const all = new Path2D();
    for (const [x1, y1, x2, y2, st, w] of this.segs) {
      if (st > progress) continue;
      buckets[w].moveTo(x1, y1); buckets[w].lineTo(x2, y2);
      all.moveTo(x1, y1); all.lineTo(x2, y2);
    }
    g.strokeStyle = rgb(CRIMSON, 0.7 * k * pulse);
    for (let w = 1; w <= 3; w++) { g.lineWidth = w + 1; g.stroke(buckets[w]); }
    g.strokeStyle = rgb(RED, 0.45 * k * pulse); g.lineWidth = 1; g.stroke(all);
  }
}

// --- technique visuals -------------------------------------------------------------
function drawPurpleOrb(g, c, r, t, k, swirl) {
  r = Math.max(r, 2);
  haze(g, c, r * 3.6, PURPLE, 0.55 * k);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + t * 0.7 + 0.25 * Math.sin(t * 3 + i * 2.1);
    const L = r * (2.2 + 5.5 * k * (0.55 + 0.45 * Math.sin(t * 11 + i * 1.7)));
    seg(g, c, [c[0] + Math.cos(a) * L, c[1] + Math.sin(a) * L], mixc(PURPLE, WHITE, 0.6, 0.5), k * 0.8, 1);
  }
  swirl.draw(g, c, r, PURPLE, k);
  for (let i = 0; i < 3; i++) if (Math.random() < 0.35 * k) {
    const a = rand(0, TAU), L = r * rand(2.5, 5.5);
    smallBolt(g, c, [c[0] + Math.cos(a) * L, c[1] + Math.sin(a) * L], mixc(WHITE, PURPLE, 0.9, 0.9), k, r * 0.6);
  }
  ring(g, c, r * (1.9 + 0.1 * Math.sin(t * 7)), mixc(WHITE, PURPLE, 0.8, 0.4), k, 1);
  disc(g, c, r, PURPLE, 1.1);
  disc(g, c, r * 0.72, WHITE, 1);
}

function drawSplitOrb(g, c, r, color, k, swirl) {
  haze(g, c, r * 3, color, 0.5 * k);
  swirl.draw(g, c, r, color, k);
  disc(g, c, r, color, 1.1);
  disc(g, c, r * 0.6, WHITE, k);
}

function drawRedOrb(g, c, r, t, k, swirl) {
  r = Math.max(r, 2);
  haze(g, c, r * 4.8, RED, 0.45 * k);
  swirl.draw(g, c, r, RED, k);
  disc(g, c, r * 1.15 * (1 + 0.05 * Math.sin(t * 17)), RED, 1.1);
  disc(g, c, r * 0.6, HOTRED, 0.8 + 0.6 * k);
}

function drawRedSparks(g, c, r, k, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), R = r * rand(1.6, 6.5);
    const p = [c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R];
    const ta = a + Math.PI / 2 + rand(-0.6, 0.6);
    const q = add(p, mul([Math.cos(ta), Math.sin(ta)], r * rand(0.8, 2.2)));
    const pts = jagPath(p, q, 0.45, 3);
    poly(g, pts, WHITE, 0.6 * k, 0.8);
    for (let j = 0; j < pts.length; j += 2) disc(g, pts[j], 1, WHITE, 1.4 * k);
  }
}

function drawRibbon(g, c, R, t, k) {
  const pts = [];
  for (let i = 0; i < 140; i++) {
    const th = i / 139 * TAU * 1.15 + t * 1.6;
    const rad = R * (1 + 0.35 * Math.sin(th * 2.5 + t * 2));
    pts.push([c[0] + rad * Math.cos(th), c[1] + rad * Math.sin(th) * 0.55]);
  }
  g.lineCap = "round";
  poly(g, pts, RED, 0.45 * k, Math.max(2, R * 0.16));
  poly(g, pts, HOTRED, 0.45 * k, 1);
}

class Blast {
  constructor(kind, c, d, r) {
    Object.assign(this, { kind, c: c.slice(), d: unit(d), r, t: 0, bolts: [], boltT: -1 });
    this.T = kind === "purple" ? PURPLE_BLAST : RED_BLAST;
  }
}

function drawPurpleBlast(g, B, sw, sh) {
  const t = B.t, c = mul(B.c, S), d = B.d, diag = Math.hypot(sw, sh), r0 = B.r * S;
  const fade = t < 1.1 ? 1 : Math.max(0, 1 - (t - 1.1) / (B.T - 1.1));
  const kp = Math.max(0, 1 - t / 0.5);
  haze(g, c, r0 * 4 * kp, PURPLE, 0.9 * kp);
  disc(g, c, r0 * (0.5 + 0.8 * kp), WHITE, kp);
  // hollow sphere tearing outward with a filament trail
  const sc = add(c, mul(d, diag * 1.2 * (1 - Math.exp(-t * 1.8))));
  const R = r0 + diag * 0.07 * Math.min(1, t / 0.15);
  const perp = [-d[1], d[0]];
  for (let i = 0; i < ((16 * fade) | 0) + 1; i++) {
    const off = rand(-1, 1);
    poly(g, jagPath(add(c, mul(perp, off * r0 * 0.6)), add(sc, mul(perp, off * R * 0.9)), 0.03, 4),
         mixc(VIOLET, WHITE, 0.6, 0.2), fade * rand(0.4, 1), 1);
  }
  haze(g, sc, R * 2, PURPLE, 0.7 * fade);
  disc(g, sc, R, PURPLE, 0.2 * fade);
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = rgb(VIOLET, rand(0.6, 1.1) * fade); g.lineWidth = 1;
    g.beginPath();
    g.ellipse(sc[0], sc[1], Math.max(1, R * rand(0.4, 0.95)), Math.max(1, R * rand(0.15, 0.6)),
              (t * 7 + i * 1.05) % TAU, 0, rand(2.1, 5.2));
    g.stroke();
  }
  ring(g, sc, R, mixc(WHITE, VIOLET, 1.1, 0.5), fade, 2);
  ring(g, sc, R * 1.15, PURPLE, 0.9 * fade, 1);
  // branching lightning across the screen, re-struck ~12x per second
  if (t - B.boltT > 0.08 && t < B.T * 0.85) {
    B.boltT = t; B.bolts = [];
    for (let i = randi(3, 5); i > 0; i--) {
      const ang = Math.atan2(d[1], d[0]) + rand(-2, 2);
      B.bolts.push(makeBolt(c, add(c, mul([Math.cos(ang), Math.sin(ang)], diag)), 0.22, 7, randi(3, 6)));
    }
  }
  for (const b of B.bolts) drawBolt(g, b, PURPLE, fade * rand(0.6, 1), 1);
  return { flash: Math.max(0, 1 - t / 0.16), shake: 22 * Math.max(0, 1 - t) ** 2,
           zoom: 1 + 0.06 * Math.exp(-t * 5), ghost: 0.012 * Math.max(0, 1 - t / 0.6) };
}

function drawRedBlast(g, B, sw, sh, veins) {
  const t = B.t, c = mul(B.c, S), diag = Math.hypot(sw, sh), r0 = B.r * S;
  const fade = t < 0.9 ? 1 : Math.max(0, 1 - (t - 0.9) / (B.T - 0.9));
  if (veins) veins.draw(g, 2, 1.0 * fade, t);
  const R = r0 + diag * 0.75 * (1 - Math.exp(-t * 4)), a = Math.max(0, 1 - t / 1.3);
  haze(g, c, R, RED, 0.35 * a);
  for (let i = 0; i < 4; i++) {
    const tt = t - i * 0.09;
    if (tt <= 0) continue;
    const aa = Math.max(0, 1 - tt / 0.9);
    ring(g, c, tt * diag * 1.1, i === 0 ? mixc(RED, WHITE, 1.2, 0.3) : RED, 1.2 * aa, Math.max(1, 6 * aa));
  }
  const reach = Math.min(1, t * 3);
  for (let i = 0; i < ((90 * fade) | 0); i++) {
    const ang = rand(0, TAU), u = [Math.cos(ang), Math.sin(ang)];
    const r1 = rand(0.15, 1) * diag * reach, L = diag * rand(0.08, 0.3);
    seg(g, add(c, mul(u, r1)), add(c, mul(u, r1 + L)), Math.random() < 0.7 ? RED : WHITE, fade * rand(0.3, 1.2), 1);
  }
  const core = r0 * (0.6 + Math.min(1, t / 0.1)) * fade;
  haze(g, c, core * 2.2, RED, 0.9 * fade);
  disc(g, c, core, RED, 1.1 * fade);
  disc(g, c, core * 0.35, HOTRED, fade);
  drawRedSparks(g, c, Math.max(r0, 4) * 2, fade, (30 * fade) | 0);
  return { flash: Math.max(0, 1 - t / 0.14), shake: 26 * Math.max(0, 1 - t / 1.1) ** 2,
           zoom: 1 + 0.09 * Math.exp(-t * 6) * (1 + 0.3 * Math.sin(t * 40)), ghost: 0.016 * Math.max(0, 1 - t / 0.7) };
}

// --- compositor ------------------------------------------------------------------
const TITLES = { purple: ["虚式「茈」", "HOLLOW PURPLE"], red: ["術式反転「赫」", "REVERSAL RED"] };

class Renderer {
  constructor(view) { this.view = view; this.vctx = view.getContext("2d"); this.resize(1280, 720); this.makeGrain(); }
  resize(W, H) {
    if (this.W === W && this.H === H) return;
    this.W = W; this.H = H;
    this.view.width = W; this.view.height = H;
    this.scene = canvas(W, H); this.sctx = this.scene.getContext("2d");
    this.fx = canvas(W * S, H * S); this.fctx = this.fx.getContext("2d");
    this.b1 = canvas(this.fx.width / 4, this.fx.height / 4);
    this.b2 = canvas(this.fx.width / 16, this.fx.height / 16);
    this.sw = this.fx.width; this.sh = this.fx.height;
  }
  makeGrain() {
    this.grain = canvas(256, 256);
    const g = this.grain.getContext("2d"), img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    this.grainPat = this.sctx ? null : null;
  }
  beginFx() {
    const g = this.fctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.clearRect(0, 0, this.sw, this.sh);
    g.globalCompositeOperation = "lighter"; g.lineCap = "round"; g.lineJoin = "round";
    return g;
  }
  compose(src, mirror, gr, world) {
    const { W, H } = this, s = this.sctx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = "source-over"; s.globalAlpha = 1;
    if (mirror) { s.save(); s.translate(W, 0); s.scale(-1, 1); s.drawImage(src, 0, 0, W, H); s.restore(); }
    else s.drawImage(src, 0, 0, W, H);

    const amt = gr.amount;
    if (amt > 0.01) {
      s.globalCompositeOperation = "multiply";            // squaring the image = crushed shadows
      s.globalAlpha = Math.min(1, gr.crush * 0.7 * amt);
      s.drawImage(this.scene, 0, 0);
      s.globalAlpha = 1;                                  // overall exposure drop
      const lv = Math.round(255 * (1 - gr.dark * amt));
      s.fillStyle = `rgb(${lv},${lv},${lv})`; s.fillRect(0, 0, W, H);
      s.globalCompositeOperation = "color";               // keep luminance, take the technique's hue
      s.globalAlpha = 0.85 * amt; s.fillStyle = rgb(gr.tint, 0.85); s.fillRect(0, 0, W, H);
      if (gr.wash > 0) { s.globalCompositeOperation = "lighter"; s.globalAlpha = gr.wash * amt; s.fillStyle = rgb(gr.tint); s.fillRect(0, 0, W, H); }
      s.globalCompositeOperation = "source-over";
      const v = s.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.hypot(W, H) * 0.62);
      v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${0.92 * amt})`);
      s.globalAlpha = 1; s.fillStyle = v; s.fillRect(0, 0, W, H);
    }

    if (world) { s.globalCompositeOperation = "source-over"; s.globalAlpha = 1; world(s); }

    // bloom: progressively downsampled copies of the effect layer, added back up
    const b1 = this.b1.getContext("2d"), b2 = this.b2.getContext("2d");
    b1.clearRect(0, 0, this.b1.width, this.b1.height); b1.drawImage(this.fx, 0, 0, this.b1.width, this.b1.height);
    b2.clearRect(0, 0, this.b2.width, this.b2.height); b2.drawImage(this.b1, 0, 0, this.b2.width, this.b2.height);
    s.globalCompositeOperation = "lighter"; s.imageSmoothingEnabled = true; s.imageSmoothingQuality = "high";
    s.globalAlpha = 0.85; s.drawImage(this.b2, 0, 0, W, H);
    s.globalAlpha = 0.6; s.drawImage(this.b1, 0, 0, W, H);
    s.globalAlpha = 1; s.drawImage(this.fx, 0, 0, W, H);

    if (gr.flash > 0) { s.globalAlpha = Math.min(1, gr.flash); s.fillStyle = rgb(mixc(WHITE, gr.tint, 0.7, 0.3)); s.fillRect(0, 0, W, H); }
    if (amt > 0.01) {
      s.globalCompositeOperation = "overlay"; s.globalAlpha = 0.14 * amt;
      const pat = s.createPattern(this.grain, "repeat");
      s.save(); s.translate(rand(0, 256), rand(0, 256)); s.fillStyle = pat; s.fillRect(-256, -256, W + 512, H + 512); s.restore();
    }
    if (gr.title && gr.titleA > 0) this.title(s, TITLES[gr.title], gr.titleA, gr.tint);

    // camera: zoom punch + shake + a ghosted impact copy
    const v = this.vctx;
    v.setTransform(1, 0, 0, 1, 0, 0); v.globalCompositeOperation = "source-over"; v.globalAlpha = 1;
    const z = gr.zoom, sx = rand(-gr.shake, gr.shake), sy = rand(-gr.shake, gr.shake);
    v.setTransform(z, 0, 0, z, W / 2 * (1 - z) + sx, H / 2 * (1 - z) + sy);
    v.drawImage(this.scene, 0, 0);
    if (gr.ghost > 0.001) {
      const z2 = z * (1 + gr.ghost * 3);
      v.setTransform(z2, 0, 0, z2, W / 2 * (1 - z2) - sx, H / 2 * (1 - z2) - sy);
      v.globalCompositeOperation = "screen"; v.globalAlpha = 0.35; v.drawImage(this.scene, 0, 0);
    }
    v.setTransform(1, 0, 0, 1, 0, 0); v.globalAlpha = 1; v.globalCompositeOperation = "source-over";
  }
  title(s, [kanji, latin], a, tint) {
    const { W, H } = this, u = Math.min(W, H);
    s.save();
    s.globalCompositeOperation = "source-over"; s.globalAlpha = a;
    s.textAlign = "center"; s.textBaseline = "middle";
    s.shadowColor = rgb(tint); s.shadowBlur = u * 0.04;
    s.fillStyle = "#fff";
    s.font = `800 ${u * 0.12}px "Shippori Mincho", serif`;
    s.fillText(kanji, W / 2, H * 0.78);
    s.font = `600 ${u * 0.032}px Inter, sans-serif`;
    s.fillStyle = "#eee2ee";
    s.fillText(latin.split(" ").map((w) => w.split("").join(" ")).join("   "), W / 2, H * 0.78 + u * 0.1);
    s.restore();
  }
}

// --- sound -------------------------------------------------------------------------
class Sound {
  constructor() { this.ctx = null; this.buf = {}; this.src = null; this.startedAt = 0; this.key = null; }
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    await Promise.all(Object.entries(AUDIO).map(async ([k, url]) => {
      try { this.buf[k] = await this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()); }
      catch (e) { console.warn("audio missing:", url, e); }
    }));
  }
  has(k) { return !!this.buf[k]; }
  play(k, offset = 0) {
    if (!this.ctx || !this.buf[k]) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buf[k]; s.connect(this.ctx.destination); s.start(0, offset);
    return s;
  }
  chargeOn(k) { if (this.src === null) { this.src = this.play(k) || false; this.startedAt = this.ctx ? this.ctx.currentTime : 0; this.key = k; } }
  chargeOff() { if (this.src) try { this.src.stop(); } catch {} this.src = null; this.key = null; }
  elapsed() { return this.src && this.ctx ? this.ctx.currentTime - this.startedAt : null; }  // audio clock keeps Red in sync
  oneshot(k, offset = 0) { this.play(k, offset); }
  // tiny synthesized game sounds
  tone(f0, f1, dur, type = "sine", vol = 0.2, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  sfx(name) {
    const s = {
      kill: () => { this.tone(520, 120, 0.25, "square", 0.08); this.tone(1400, 300, 0.18, "sine", 0.1); },
      boss: () => { this.tone(200, 40, 0.9, "sawtooth", 0.15); this.tone(900, 120, 0.6, "square", 0.08); },
      hit: () => this.tone(300, 150, 0.15, "square", 0.08),
      hurt: () => { this.tone(140, 45, 0.5, "sawtooth", 0.2); this.tone(90, 40, 0.6, "sine", 0.3); },
      wave: () => { this.tone(330, 330, 0.15, "triangle", 0.12); this.tone(494, 494, 0.25, "triangle", 0.12, 0.12); },
      clear: () => [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.22, "triangle", 0.12, i * 0.08)),
      ach: () => [880, 1175, 1568].forEach((f, i) => this.tone(f, f * 1.01, 0.35, "sine", 0.12, i * 0.09)),
      over: () => [392, 330, 262, 196].forEach((f, i) => this.tone(f, f * 0.98, 0.4, "triangle", 0.14, i * 0.16)),
    }[name];
    if (s) s();
  }
}

// --- engine --------------------------------------------------------------------------
class Engine {
  constructor(renderer, sound) {
    this.r = renderer; this.snd = sound;
    this.swirl = new Swirl(); this.swirlRed = new Swirl(60); this.swirlB = new Swirl(40); this.swirlR = new Swirl(40);
    this.dashes = new Dashes(renderer.sw, renderer.sh);
    this.mode = null; this.charge = 0; this.chargeT = 0;
    this.orbC = null; this.orbDir = [0, -1]; this.orbPalm = 120;
    this.merged = false; this.lost = 0; this.blast = null; this.veins = null;
    this.poses = {}; this.t = 0;
    this.events = []; this.fullAt = null;
  }
  track(c, d, palm) {
    if (!this.orbC) { this.orbC = c.slice(); this.orbDir = unit(d); this.orbPalm = palm; }
    this.orbC = add(mul(this.orbC, 0.45), mul(c, 0.55));
    this.orbDir = unit(add(mul(this.orbDir, 0.7), mul(d, 0.3)));
    this.orbPalm = this.orbPalm * 0.8 + palm * 0.2;
  }
  fire(kind, c, d, palm) {
    const test = !!palm;
    const perfect = !test && kind === "purple" && this.fullAt !== null && this.t - this.fullAt < 0.75;
    this.events.push({ type: "fire", kind, perfect, fused: this.merged, test });
    this.fullAt = null;
    if (palm) this.orbPalm = palm;
    c = c || this.orbC || [this.r.W / 2, this.r.H / 2];
    d = d || this.orbDir;
    this.blast = new Blast(kind, c, d, this.orbPalm * 0.25);
    this.blast.bonus = perfect ? 1.5 : 1;
    this.blast.test = test;
    if (kind === "red" && !this.veins) this.veins = new Veins(this.r.sw, this.r.sh, mul(c, S));
    if (kind === "red" && this.mode !== "red" && this.snd.has("red")) { this.snd.chargeOff(); this.snd.oneshot("red", RED_HIT - 0.05); }
    else if (kind === "purple" || this.mode !== "red" || !this.snd.has("red")) { this.snd.chargeOff(); this.snd.oneshot("purple_blast"); }
    this.mode = kind; this.charge = this.chargeT = 0;
  }
  step(hands, dt) {
    this.t += dt;
    const g = this.r.beginFx();
    const gr = { amount: 0, tint: PURPLE, crush: 1.4, dark: 0.6, wash: 0, flash: 0, title: null, titleA: 0, shake: 0, zoom: 1, ghost: 0 };

    const prev = this.poses; this.poses = {};
    for (const h of hands) {
      const key = this.poses[h.label] ? h.label + "2" : h.label;
      this.poses[key] = h.classify(prev[key] || [false, false]);
    }
    const purple = hands.filter((h) => h.posed), reds = hands.filter((h) => h.red);
    let target = null, split = null;
    if (purple.length >= 2) {
      const [a, b] = purple;
      const thr = (a.palm + b.palm) / 2 * (this.merged ? 1.7 : 1.15);
      if (dist(a.center, b.center) < thr) {
        this.merged = true;
        target = [mul(add(a.center, b.center), 0.5), unit(add(a.dir, b.dir)), (a.palm + b.palm) / 2];
      } else { this.merged = false; split = [a, b].sort((x, y) => x.center[0] - y.center[0]); }
    } else if (purple.length === 1) { this.merged = false; target = [purple[0].center, purple[0].dir, purple[0].palm]; }
    const redT = reds.length ? [reds[0].redC, reds[0].palm] : null;

    // state machine
    if (this.blast) {
      this.blast.t += dt;
      if (this.blast.t > this.blast.T + 0.6) { this.blast = null; this.mode = null; this.veins = null; this.orbC = null; }
    } else {
      if (this.mode === null) {
        if (target) { this.mode = "purple"; this.chargeT = 0; this.orbC = null; this.fullAt = null; }
        else if (redT) {
          this.mode = "red"; this.chargeT = 0; this.orbC = null;
          this.veins = new Veins(this.r.sw, this.r.sh, mul(redT[0], S));
          this.snd.chargeOn(this.snd.has("red") ? "red" : "purple_charge");
        }
      }
      if (this.mode === "purple") {
        if (target) {
          this.lost = 0; this.track(target[0], target[1], target[2]);
          this.chargeT += dt; this.charge = Math.min(1, this.chargeT / PURPLE_CHARGE);
          if (this.charge >= 1 && this.fullAt === null) this.fullAt = this.t;
          this.snd.chargeOn("purple_charge");
        } else {
          this.lost += dt;
          if (this.lost >= 0.06) {
            this.snd.chargeOff();
            if (this.charge >= FIRE_MIN) this.fire("purple");
            else {
              this.charge = Math.max(0, this.charge - dt * 0.6); this.chargeT = this.charge * PURPLE_CHARGE;
              if (this.charge <= 0) this.mode = null;
            }
          }
        }
      } else if (this.mode === "red") {
        if (redT) { this.lost = 0; this.track(redT[0], this.orbDir, redT[1]); } else this.lost += dt;
        if (this.lost < RED_GRACE) {
          const el = this.snd.key === "red" ? this.snd.elapsed() : null;
          this.chargeT = el !== null ? el : this.chargeT + dt;
          this.charge = Math.min(1, this.chargeT / RED_HIT);
          if (this.chargeT >= RED_HIT && this.orbC) this.fire("red");
        } else { this.mode = "red_out"; this.snd.chargeOff(); }
      } else if (this.mode === "red_out") {
        this.charge = Math.max(0, this.charge - dt * 1.2);
        if (this.charge <= 0) { this.mode = null; this.veins = null; }
      }
    }

    // draw
    if (split && (this.mode === null || this.mode === "purple") && !this.blast) {
      for (const [h, color, sw] of [[split[0], BLUE, this.swirlB], [split[1], RED, this.swirlR]]) {
        sw.step(dt, 0.6);
        drawSplitOrb(g, mul(h.center, S), h.palm * 0.14 * S, color, 0.65 + 0.15 * Math.sin(this.t * 8), sw);
      }
      gr.amount = 0.3;
    }
    if (!this.blast && this.orbC && this.charge > 0.01) {
      const k = this.charge, c = mul(this.orbC, S);
      if (this.mode === "purple") {
        this.swirl.step(dt, k);
        const rad = this.orbPalm * (0.08 + 0.16 * k) * (1 + 0.06 * Math.sin(this.t * 20));
        drawPurpleOrb(g, c, rad * S, this.t, k, this.swirl);
        this.dashes.draw(g, PURPLE, k, this.t);
        gr.amount = Math.max(gr.amount, 0.9 * k); gr.tint = PURPLE;
        gr.shake = 3 * Math.max(0, k - 0.8) / 0.2;
      } else if (this.mode === "red" || this.mode === "red_out") {
        const amb = Math.min(1, k * 4);
        if (this.veins) this.veins.draw(g, k * 1.15, 0.4 + 0.6 * amb, this.t);
        this.swirlRed.step(dt, k);
        const rad = this.orbPalm * (0.07 + 0.13 * k) * (1 + 0.05 * Math.sin(this.t * 23));
        if (k > 0.55) drawRibbon(g, c, rad * S * (3 + 3 * k), this.t, (k - 0.55) / 0.45);
        drawRedOrb(g, c, rad * S, this.t, amb, this.swirlRed);
        drawRedSparks(g, c, Math.max(rad * S, 3), amb, (4 + 22 * k) | 0);
        this.dashes.draw(g, RED, amb * 0.7, this.t, 8, -25);
        Object.assign(gr, { amount: Math.max(gr.amount, amb), tint: RED, crush: 0.8, dark: 0.45, wash: 0.05,
                            shake: 4 * Math.max(0, k - 0.9) / 0.1 });
      }
    }
    if (this.blast) {
      const B = this.blast, live = B.t < B.T;
      let fx = { flash: 0, shake: 0, zoom: 1, ghost: 0 };
      if (B.kind === "purple") {
        if (live) fx = drawPurpleBlast(g, B, this.r.sw, this.r.sh);
        this.dashes.draw(g, PURPLE, 1, this.t, -120, 0);
        gr.tint = PURPLE;
      } else {
        if (live) fx = drawRedBlast(g, B, this.r.sw, this.r.sh, this.veins);
        Object.assign(gr, { tint: RED, crush: 0.8, dark: 0.45, wash: 0.05 });
      }
      Object.assign(gr, fx);
      gr.amount = live ? 1 : Math.max(0, 1 - (B.t - B.T) / 0.6);
      gr.title = B.kind;
      const end = B.T + 0.6;
      if (B.t > 0.2 && B.t < end) gr.titleA = Math.min(1, (B.t - 0.2) / 0.25) * Math.min(1, (end - B.t) / 0.6);
    }
    return gr;
  }
}

// --- app -----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const view = $("view"), hud = $("hud"), msg = $("msg"), bar = $("bar"), fill = bar.firstElementChild;
const renderer = new Renderer(view);
const sound = new Sound();
let engine = new Engine(renderer, sound);
let video = null, landmarker = null, debug = false, lastVideoTime = -1, hands = [];
let mode = "free", game = null, paused = true, camReady = false;
const params = new URLSearchParams(location.search);
const demo = params.get("demo");          // ?demo=purple | red | game | 1  (no camera, simulated hand)
window.__limitless = { engine: () => engine, game: () => game };

// --- progress, toasts ---
const toastQ = [];
let toastBusy = false;
function showToast(name, desc) {
  toastQ.push([name, desc]);
  if (!toastBusy) nextToast();
}
function nextToast() {
  const t = toastQ.shift();
  if (!t) { toastBusy = false; return; }
  toastBusy = true;
  $("toastName").textContent = t[0]; $("toastDesc").textContent = t[1];
  const el = $("toast");
  el.classList.remove("hidden"); el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  sound.sfx("ach");
  setTimeout(() => { el.classList.remove("show"); setTimeout(nextToast, 400); }, 3200);
}
const progress = new Progress(showToast);

function renderStats() {
  const s = progress.s, g = gradeOf(s.xp);
  $("sGrade").textContent = g.name;
  $("sNext").textContent = g.next ? `${Math.round(g.progress * 100)}% to ${g.next}` : "Max grade";
  $("sXp").style.width = `${(g.progress * 100).toFixed(1)}%`;
  $("sBest").textContent = s.best.toLocaleString();
  $("sKills").textContent = s.kills.toLocaleString();
  $("sAch").textContent = `${s.ach.length}/${Object.keys(ACH).length}`;
  $("achList").innerHTML = Object.entries(ACH).map(([id, [n, d]]) =>
    `<li class="${s.ach.includes(id) ? "got" : ""}"><b>${n}</b><span>${d}</span></li>`).join("");
}

// --- in-game HUD ---
let lastHud = "";
function updateGameHud() {
  if (!game) return;
  const g = gradeOf(progress.s.xp + (game.over ? 0 : game.score));
  const key = `${game.score}|${game.wave}|${game.lives}|${g.name}|${g.progress.toFixed(3)}`;
  if (key === lastHud) return;
  lastHud = key;
  $("gScore").textContent = game.score.toLocaleString();
  $("gWave").textContent = game.wave ? `Wave ${game.wave}` : "Get ready";
  $("gLives").innerHTML = [0, 1, 2].map((i) => `<i class="${i < game.lives ? "on" : ""}"></i>`).join("");
  $("gGrade").textContent = g.name;
  $("gXp").style.width = `${(g.progress * 100).toFixed(1)}%`;
}

function gameOver(r) {
  sound.sfx("over");
  $("oScore").textContent = r.score.toLocaleString();
  $("oBest").textContent = r.newBest ? "New best!" : `Best ${r.best.toLocaleString()}`;
  $("oWave").textContent = r.wave;
  $("oKills").textContent = r.kills;
  $("oXp").textContent = `+${r.xpGain.toLocaleString()} XP`;
  $("oGrade").textContent = r.promoted ? `Promoted to ${r.grade.name}!` : r.grade.name;
  $("oBar").style.width = `${(r.grade.progress * 100).toFixed(1)}%`;
  setTimeout(() => $("over").classList.remove("hidden"), 900);
}

function updateHud() {
  const e = engine;
  if (e.blast) { msg.textContent = ""; hud.style.visibility = "hidden"; return; }
  if (e.mode === "purple") {
    const ready = e.charge >= FIRE_MIN;
    msg.textContent = e.charge >= 1 ? "FULL - flick now for PERFECT!" : ready ? "Charged - flick open to fire!" : "Hollow Purple charging…";
    fill.style.background = "#a855f7"; fill.style.opacity = ready ? 1 : 0.6;
  } else if (e.mode === "red") {
    msg.textContent = "Reversal: Red - keep pointing…";
    fill.style.background = "#ef4444"; fill.style.opacity = e.charge > 0.9 ? 1 : 0.6;
  } else {
    msg.textContent = "PURPLE: index curled onto thumb  ·  RED: index finger pointing up";
  }
  bar.style.display = e.mode === "purple" || e.mode === "red" ? "block" : "none";
  hud.style.visibility = msg.textContent ? "visible" : "hidden";
  fill.style.width = `${(e.charge * 100).toFixed(1)}%`;
}

function drawDebug() {
  const v = renderer.vctx;
  v.font = "13px Inter, sans-serif";
  for (const h of hands) {
    if (!h.pts.length) continue;
    v.fillStyle = h.posed ? "#ff40ff" : h.red ? "#ff3030" : "#30d050";
    for (const p of h.pts) { v.beginPath(); v.arc(p[0], p[1], 3, 0, TAU); v.fill(); }
    v.fillStyle = "#fff";
    v.fillText(`${h.label} pinch=${h.pinch.toFixed(2)} curl=${h.curl.toFixed(0)} reach=${h.indexReach.toFixed(2)} others=${h.others.toFixed(2)}`,
               h.pts[0][0] + 10, h.pts[0][1] + 20);
  }
}

function demoBackground() {
  const c = canvas(1280, 720), g = c.getContext("2d");
  g.fillStyle = "#4a5260"; g.fillRect(0, 0, 1280, 720);
  g.fillStyle = "#c9b8a8"; g.beginPath(); g.ellipse(640, 300, 110, 140, 0, 0, TAU); g.fill();
  g.fillStyle = "#1d1f2a"; g.beginPath(); g.ellipse(640, 760, 330, 320, 0, 0, TAU); g.fill();
  g.fillStyle = "#e8e8f0"; g.beginPath(); g.ellipse(640, 180, 150, 70, 0, 0, TAU); g.fill();
  return c;
}

class FakeHand {
  constructor(p, kind) { this.label = "Right"; this.center = p; this.redC = p; this.dir = unit([0.6, -0.8]); this.palm = 150; this.pts = []; this.kind = kind; }
  classify() { this.posed = this.kind === "purple"; this.red = this.kind === "red"; return [this.posed, this.red]; }
}

let last = performance.now(), demoBg = null, demoT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (paused) return;
  let src, mirror;
  if (demo) {
    src = demoBg; mirror = false; demoT += dt;
    hands = [];
    if (demo === "purple") {
      if (demoT < PURPLE_CHARGE + 0.3) hands = [new FakeHand([760, 430], "purple")];
      else if (demoT > PURPLE_CHARGE + 4) demoT = 0;
    } else if (demo === "red") {
      if (demoT < RED_HIT + 0.5) hands = [new FakeHand([640, 470], "red")];
      else if (demoT > RED_HIT + 5) demoT = 0;
    }
  } else {
    if (!video || video.readyState < 2) return;
    renderer.resize(video.videoWidth, video.videoHeight);
    if (engine.r.sw !== engine.dashes.sw) engine = new Engine(renderer, sound);
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const res = landmarker.detectForVideo(video, now);
      const hd = res.handedness || res.handednesses || [];
      hands = res.landmarks.map((lm, i) => new Hand(lm, renderer.W, renderer.H, hd[i]?.[0]?.categoryName || "Hand" + i));
    }
    src = video; mirror = true;
  }
  const gr = engine.step(hands, dt);
  let world = null;
  if (mode === "game" && game) {
    game.update(dt, engine, renderer.W, renderer.H);
    gr.shake += game.shake;
    world = (s) => game.drawWorld(s, renderer.W, renderer.H);
  } else {
    for (const ev of engine.events) progress.onFire(ev);
  }
  engine.events.length = 0;               // consumed (fires from key presses land here too)
  renderer.compose(src, mirror, gr, world);
  if (game && mode === "game") game.drawOverlay(renderer.vctx, renderer.W, renderer.H);
  if (debug) drawDebug();
  updateHud();
  updateGameHud();
}

function test(kind) {
  if (engine.blast || (mode === "game" && !demo)) return;
  const h = hands.find((x) => x.pts && x.pts.length);
  engine.fire(kind, h ? h.center : [renderer.W / 2, renderer.H * 0.55], h ? h.dir : [0.5, -0.85], renderer.H * 0.2);
}

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "d") debug = !debug;
  if (k === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  if (k === "1") test("purple");
  if (k === "2") test("red");
  if (k === "escape" && !paused) toMenu();
});
for (const b of document.querySelectorAll("#tests button")) b.addEventListener("click", () => test(b.dataset.k));

function showStage(m) {
  mode = m;
  $("start").classList.add("hidden");
  $("over").classList.add("hidden");
  dispatchEvent(new Event("limitless:start"));
  for (const id of ["hud", "credit", "menuBtn"]) $(id).classList.remove("hidden");
  $("keys").classList.toggle("hidden", m === "game" && !demo);
  $("tests").classList.toggle("hidden", m === "game");
  $("ghud").classList.toggle("hidden", m !== "game");
  engine = new Engine(renderer, sound);
  if (m === "game") { game = new Game(progress, { sfx: (n) => sound.sfx(n), over: gameOver }); lastHud = ""; }
  else game = null;
  paused = false;
}

function toMenu() {
  paused = true; sound.chargeOff();
  for (const id of ["hud", "credit", "menuBtn", "keys", "tests", "ghud", "over"]) $(id).classList.add("hidden");
  renderStats();
  $("start").classList.remove("hidden");
  dispatchEvent(new Event("limitless:menu"));
}

async function start(m) {
  const err = $("err"), btns = document.querySelectorAll(".cta button");
  if (camReady || demo) { showStage(m); return; }
  btns.forEach((b) => (b.disabled = true)); err.textContent = "";
  const label = $("play").textContent;
  try {
    $("play").textContent = "Loading…";
    const audio = sound.init();
    video = document.createElement("video");
    video.playsInline = true; video.muted = true;
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    await video.play();
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
    await audio;
    camReady = true;
    showStage(m);
  } catch (e) {
    console.error(e);
    err.textContent = e && e.name === "NotAllowedError"
      ? "Camera permission was blocked. Allow camera access for this site and try again."
      : `Couldn't start: ${e && e.message ? e.message : e}`;
  } finally {
    btns.forEach((b) => (b.disabled = false)); $("play").textContent = label;
  }
}

$("play").addEventListener("click", () => start("game"));
$("free").addEventListener("click", () => start("free"));
$("again").addEventListener("click", () => showStage("game"));
$("toMenu").addEventListener("click", toMenu);
$("menuBtn").addEventListener("click", toMenu);
renderStats();
requestAnimationFrame(frame);

if (demo) {
  demoBg = demoBackground();
  if (demo === "game") showStage("game");
  else if (demo !== "menu") showStage("free");
}
