// Exorcism mode: cursed spirits creep toward you; Hollow Purple and Red exorcise them.
// Also: persistent progress (XP -> sorcerer grade, best score, achievements).
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const STORE = "limitless.v1";

export const GRADES = [["Grade 4", 0], ["Grade 3", 2000], ["Grade 2", 6000], ["Semi-Grade 1", 15000], ["Grade 1", 30000], ["Special Grade", 60000]];
export const ACH = {
  first_purple: ["Throughout Heaven and Earth", "Fire Hollow Purple"],
  first_red: ["Reversal", "Fire Reversal: Red"],
  perfect: ["Perfect Flick", "Flick within 0.75s of full charge"],
  fusion: ["Blue + Red", "Fire Purple from a two-hand fusion"],
  triple: ["Triple Exorcism", "Exorcise 3 curses with one blast"],
  untouched: ["Untouchable", "Clear a wave without losing a barrier"],
  wave6: ["Domain Cleared", "Reach wave 6"],
  special: ["The Strongest", "Reach Special Grade"],
};

export function gradeOf(xp) {
  let i = 0;
  GRADES.forEach(([, min], j) => { if (xp >= min) i = j; });
  const next = GRADES[i + 1];
  return { name: GRADES[i][0], idx: i, next: next ? next[0] : null,
           progress: next ? (xp - GRADES[i][1]) / (next[1] - GRADES[i][1]) : 1 };
}

export class Progress {
  constructor(onUnlock) {
    this.onUnlock = onUnlock;
    this.s = { xp: 0, best: 0, kills: 0, games: 0, ach: [] };
    try { Object.assign(this.s, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch {}
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.s)); } catch {} }
  unlock(id) {
    if (this.s.ach.includes(id)) return;
    this.s.ach.push(id); this.save();
    this.onUnlock(ACH[id][0], ACH[id][1]);
  }
  onFire(ev) {
    if (ev.test) return;                       // test buttons don't count
    this.unlock(ev.kind === "purple" ? "first_purple" : "first_red");
    if (ev.perfect) this.unlock("perfect");
    if (ev.fused && ev.kind === "purple") this.unlock("fusion");
  }
}

const TYPES = {
  small: { r: 0.034, speed: 0.06, hp: 1, pts: 100, color: "#a3e635", eyes: 2 },
  big:   { r: 0.058, speed: 0.04, hp: 1, pts: 250, color: "#fb923c", eyes: 4 },
  boss:  { r: 0.11, speed: 0.024, hp: 2, pts: 1500, color: "#f472b6", eyes: 7 },
};

export class Game {
  constructor(progress, ui) { this.p = progress; this.ui = ui; this.reset(); }

  reset() {
    Object.assign(this, { score: 0, wave: 0, lives: 3, kills: 0, curses: [], parts: [], texts: [],
      state: "break", timer: 1.2, queue: [], spawnT: 0, waveHurt: false, banner: null, hurtT: 0,
      bestKills: 0, over: false, t: 0 });
  }

  geom(W, H) {
    const u = Math.min(W, H);
    return { u, core: [W / 2, H * 0.55], coreR: u * 0.09, diag: Math.hypot(W, H) };
  }

  startWave() {
    this.wave++;
    const n = 2 + this.wave;
    this.queue = [];
    for (let i = 0; i < n; i++) this.queue.push(this.wave >= 3 && i % 3 === 2 ? "big" : "small");
    if (this.wave % 4 === 0) this.queue.splice(Math.floor(n / 2), 0, "boss");
    this.spawnT = 0.6; this.waveHurt = false; this.state = "fight";
    const boss = this.wave % 4 === 0;
    this.banner = { text: `Wave ${this.wave}`, sub: boss ? "Special grade curse approaching" : `${this.queue.length} curses`, t: 0 };
    this.ui.sfx("wave");
  }

  spawn(type, W, H) {
    const T = TYPES[type], { u } = this.geom(W, H), r = T.r * u;
    const side = Math.floor(Math.random() * 4);
    const pos = side === 0 ? [rand(0, W), -r] : side === 1 ? [rand(0, W), H + r] : side === 2 ? [-r, rand(0, H)] : [W + r, rand(0, H)];
    const eyes = Array.from({ length: T.eyes }, (_, i) => {
      const a = T.eyes === 2 ? (i ? -0.5 : 0.5) + Math.PI * 1.5 : rand(0, TAU), d = T.eyes === 2 ? 0.38 : rand(0.15, 0.55);
      return { dx: Math.cos(a) * d, dy: Math.sin(a) * d - (T.eyes === 2 ? 0 : 0.1), s: rand(0.14, 0.24) * (T.eyes > 4 ? 0.8 : 1) };
    });
    this.curses.push({ type, x: pos[0], y: pos[1], r, hp: T.hp, max: T.hp, color: T.color, pts: T.pts, eyes,
      speed: T.speed * u * (1 + 0.07 * (this.wave - 1)), seed: rand(0, 100), flash: 0, hitBy: null, born: this.t });
  }

  // does the blast touch curse c right now?
  hits(B, c, W, H) {
    const { diag } = this.geom(W, H);
    const t = B.t;
    if (B.kind === "purple") {
      const travel = diag * 1.2 * (1 - Math.exp(-t * 1.8));
      const R = B.r + diag * 0.07 * Math.min(1, t / 0.15);
      const sc = [B.c[0] + B.d[0] * travel, B.c[1] + B.d[1] * travel];
      // distance from curse to the segment the sphere has swept
      const vx = sc[0] - B.c[0], vy = sc[1] - B.c[1], L2 = vx * vx + vy * vy || 1;
      const k = Math.max(0, Math.min(1, ((c.x - B.c[0]) * vx + (c.y - B.c[1]) * vy) / L2));
      return Math.hypot(c.x - (B.c[0] + vx * k), c.y - (B.c[1] + vy * k)) < R * 1.3 + c.r;
    }
    const R = B.r + diag * 0.75 * (1 - Math.exp(-t * 4));
    return Math.hypot(c.x - B.c[0], c.y - B.c[1]) < R + c.r;
  }

  kill(c, B) {
    B.kills = (B.kills || 0) + 1;
    const mult = B.kills * (B.bonus || 1);
    const pts = Math.round(c.pts * mult * (1 + 0.1 * (this.wave - 1)));
    this.score += pts; this.kills++;
    this.text(c.x, c.y - c.r, `+${pts}`, c.color, 26);
    if (B.kills >= 2) {
      const names = { 2: "DOUBLE EXORCISM", 3: "TRIPLE EXORCISM", 5: "MASSACRE" };
      if (names[B.kills]) this.text(this.W / 2, this.H * 0.2, names[B.kills], "#ffffff", 40, 1.6);
      if (B.kills >= 3 && !B.test) this.p.unlock("triple");
    }
    for (let i = 0; i < (c.type === "boss" ? 70 : 28); i++) {
      const a = rand(0, TAU), v = rand(60, 380) * (c.type === "boss" ? 1.5 : 1);
      this.parts.push({ x: c.x, y: c.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.5, 1.1), max: 1.1,
        size: rand(2, 6), color: Math.random() < 0.6 ? "#0d0a10" : c.color });
    }
    this.ui.sfx(c.type === "boss" ? "boss" : "kill");
  }

  text(x, y, s, color, size, life = 1.1) { this.texts.push({ x, y, s, color, size, life, max: life }); }

  update(dt, engine, W, H) {
    this.t += dt; this.W = W; this.H = H;
    const { core, coreR } = this.geom(W, H);
    for (const ev of engine.events) {
      this.p.onFire(ev);
      if (ev.perfect && engine.blast) this.text(W / 2, H * 0.2, "PERFECT  ×1.5", "#e9d5ff", 40, 1.4);
    }
    this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.banner) { this.banner.t += dt; if (this.banner.t > 2.4) this.banner = null; }

    if (!this.over) {
      if (this.state === "break") {
        this.timer -= dt;
        if (this.timer <= 0) this.startWave();
      } else {
        this.spawnT -= dt;
        if (this.spawnT <= 0 && this.queue.length) {
          this.spawn(this.queue.shift(), W, H);
          this.spawnT = Math.max(1.1, 3.2 - 0.2 * this.wave);
        }
        if (!this.queue.length && !this.curses.length) {
          const bonus = 250 * this.wave;
          this.score += bonus;
          this.banner = { text: "Wave cleared", sub: `+${bonus} bonus${this.waveHurt ? "" : "  ·  untouched"}`, t: 0 };
          if (!this.waveHurt) this.p.unlock("untouched");
          if (this.wave + 1 >= 6) this.p.unlock("wave6");
          this.state = "break"; this.timer = 3.2;
          this.ui.sfx("clear");
        }
      }

      const B = engine.blast;
      for (const c of this.curses) {
        // creep toward the core, weaving side to side
        const dx = core[0] - c.x, dy = core[1] - c.y, d = Math.hypot(dx, dy) || 1;
        const weave = Math.sin(this.t * 1.7 + c.seed) * 0.6;
        c.x += (dx / d - dy / d * weave) * c.speed * dt;
        c.y += (dy / d + dx / d * weave) * c.speed * dt;
        c.flash = Math.max(0, c.flash - dt);
        if (B && B.t < B.T * 0.8 && c.hitBy !== B && this.hits(B, c, W, H)) {
          c.hitBy = B; c.hp--; c.flash = 0.18;
          if (c.hp <= 0) { c.dead = true; this.kill(c, B); }
          else { this.text(c.x, c.y - c.r, "HIT", "#ffffff", 22); this.ui.sfx("hit"); }
        }
        if (!c.dead && d < coreR + c.r * 0.5) {
          c.dead = true;
          this.lives--; this.waveHurt = true; this.hurtT = 0.6;
          this.text(core[0], core[1] - coreR - 20, "Barrier cracked", "#fca5a5", 24);
          this.ui.sfx("hurt");
          if (this.lives <= 0) this.end();
        }
      }
      this.curses = this.curses.filter((c) => !c.dead);
    }

    for (const p of this.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94; p.life -= dt; }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const tx of this.texts) { tx.y -= 40 * dt; tx.life -= dt; }
    this.texts = this.texts.filter((tx) => tx.life > 0);
  }

  end() {
    this.over = true;
    const s = this.p.s, before = gradeOf(s.xp);
    const newBest = this.score > s.best;
    s.xp += this.score; s.best = Math.max(s.best, this.score); s.kills += this.kills; s.games++;
    this.p.save();
    const after = gradeOf(s.xp);
    if (after.idx === GRADES.length - 1) this.p.unlock("special");
    this.ui.over({ score: this.score, best: s.best, newBest, wave: this.wave, kills: this.kills,
                   xpGain: this.score, grade: after, promoted: after.idx > before.idx });
  }

  get shake() { return this.hurtT > 0 ? 14 * this.hurtT : 0; }

  // drawn into the scene (graded world, under the effect glow)
  drawWorld(g, W, H) {
    const { core, coreR } = this.geom(W, H);
    g.save();
    // Infinity barrier: one ring per remaining life
    g.lineWidth = 1.5;
    for (let i = 0; i < this.lives; i++) {
      g.strokeStyle = `rgba(170, 205, 255, ${0.28 - i * 0.06})`;
      g.setLineDash([6 + i * 4, 10]);
      g.lineDashOffset = -this.t * (20 + i * 12) * (i % 2 ? -1 : 1);
      g.beginPath(); g.arc(core[0], core[1], coreR * (1 + i * 0.22), 0, TAU); g.stroke();
    }
    g.setLineDash([]);
    for (const c of this.curses) this.drawCurse(g, c, core);
    for (const p of this.parts) {
      g.globalAlpha = Math.max(0, p.life / p.max);
      g.fillStyle = p.color; g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    g.restore();
  }

  drawCurse(g, c, core) {
    const t = this.t, spawnIn = Math.min(1, (t - c.born) / 0.6);
    g.save();
    g.globalAlpha = spawnIn;
    g.translate(c.x, c.y);
    // wobbling body with a coloured aura
    g.beginPath();
    for (let i = 0; i <= 18; i++) {
      const a = i / 18 * TAU, rr = c.r * (1 + 0.13 * Math.sin(t * 3.2 + i * 2.3 + c.seed) + 0.06 * Math.sin(t * 7 + i));
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr * 0.92;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    g.shadowColor = c.color; g.shadowBlur = c.r * 0.9;
    g.fillStyle = "#0d0a10"; g.fill();
    g.shadowBlur = 0; g.strokeStyle = c.color; g.lineWidth = 2; g.stroke();
    // eyes that track you
    const look = [core[0] - c.x, core[1] - c.y], ll = Math.hypot(look[0], look[1]) || 1;
    for (const e of c.eyes) {
      const ex = e.dx * c.r, ey = e.dy * c.r, s = e.s * c.r;
      const blink = Math.sin(t * 0.9 + c.seed + e.dx * 10) > 0.97 ? 0.15 : 1;
      g.fillStyle = "#f5f0e6"; g.beginPath(); g.ellipse(ex, ey, s, s * 0.8 * blink, 0, 0, TAU); g.fill();
      g.fillStyle = c.color; g.beginPath(); g.arc(ex + look[0] / ll * s * 0.35, ey + look[1] / ll * s * 0.3, s * 0.45 * blink, 0, TAU); g.fill();
      g.fillStyle = "#000"; g.beginPath(); g.arc(ex + look[0] / ll * s * 0.4, ey + look[1] / ll * s * 0.35, s * 0.2 * blink, 0, TAU); g.fill();
    }
    // jagged mouth
    g.strokeStyle = "#f5f0e6"; g.lineWidth = 1.5; g.beginPath();
    const mw = c.r * 0.7, my = c.r * 0.45, teeth = 6;
    for (let i = 0; i <= teeth; i++) {
      const x = -mw / 2 + mw * i / teeth, y = my + (i % 2 ? 1 : -1) * c.r * 0.07 * (1 + 0.5 * Math.sin(t * 9 + c.seed));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    if (c.flash > 0) {
      g.globalAlpha = c.flash / 0.18; g.fillStyle = "#fff";
      g.beginPath(); g.arc(0, 0, c.r * 1.1, 0, TAU); g.fill();
    }
    if (c.max > 1) {   // boss health pips
      g.globalAlpha = 1;
      for (let i = 0; i < c.max; i++) {
        g.fillStyle = i < c.hp ? c.color : "rgba(255,255,255,0.2)";
        g.fillRect(-c.max * 9 + i * 18, -c.r - 18, 14, 5);
      }
    }
    g.restore();
  }

  // drawn on the final view: floating text, banners, damage flash
  drawOverlay(g, W, H) {
    g.save();
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const tx of this.texts) {
      g.globalAlpha = Math.min(1, tx.life / tx.max * 2);
      g.font = `700 ${tx.size}px Inter, sans-serif`;
      g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,0.6)"; g.strokeText(tx.s, tx.x, tx.y);
      g.fillStyle = tx.color; g.fillText(tx.s, tx.x, tx.y);
    }
    if (this.banner) {
      const b = this.banner, a = Math.min(1, b.t / 0.25) * Math.min(1, (2.4 - b.t) / 0.4);
      const u = Math.min(W, H);
      g.globalAlpha = Math.max(0, a);
      g.fillStyle = "#fff"; g.font = `700 ${u * 0.1}px Inter, sans-serif`;
      g.fillText(b.text, W / 2, H * 0.36 - (1 - Math.min(1, b.t / 0.25)) * 20);
      g.fillStyle = "rgba(255,255,255,0.75)"; g.font = `500 ${u * 0.032}px Inter, sans-serif`;
      g.fillText(b.sub, W / 2, H * 0.36 + u * 0.08);
    }
    if (this.hurtT > 0) {
      g.globalAlpha = this.hurtT / 0.6 * 0.5;
      g.fillStyle = "#ef4444";
      g.fillRect(0, 0, W, H * 0.04); g.fillRect(0, H * 0.96, W, H * 0.04);
      g.fillRect(0, 0, W * 0.03, H); g.fillRect(W * 0.97, 0, W * 0.03, H);
    }
    g.restore();
  }
}
