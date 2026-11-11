"""Gojo's techniques - webcam hand tracking + cursed technique effects.

HOLLOW PURPLE  Curl your index finger onto your thumb tip (flick pose) and hold
               (~5.8 s, matches the charge clip). Flick open to fire.
               Two hands in the pose: Blue (left) + Red (right); bring them
               together to fuse into Purple.
REVERSAL: RED  Point your index finger straight up, other fingers curled, and
               keep holding. The incantation plays and Red fires on its own
               at the clip's hit (15.78 s in).

Keys: q/ESC quit   f fullscreen   d debug   1 test Purple blast   2 test Red blast
Run:  python hollow_purple.py [camera_index]      (render test: --selftest DIR)
"""
import math
import random
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from sounds import ensure_sounds

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
MODEL = ASSETS / "hand_landmarker.task"
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
             "hand_landmarker/float16/latest/hand_landmarker.task")

# --- tuning -----------------------------------------------------------------
PINCH_ON, PINCH_OFF = 0.42, 0.62     # purple: thumb-index tip distance / palm size
CURL_ON, CURL_OFF = 150, 165         # purple: index PIP angle (180 = straight)
RED_IDX_ON, RED_IDX_OFF = 1.6, 1.4   # red: index tip reach (tip-wrist / mcp-wrist)
RED_OTH_ON, RED_OTH_OFF = 1.3, 1.5   # red: other fingers must stay curled below this
PURPLE_CHARGE = 5.8                  # s to full charge = build-up of the purple clip
FIRE_MIN = 0.9                       # purple: min charge to fire on release
RED_HIT = 15.78                      # s into the Red clip where the blast hits
RED_GRACE = 0.6                      # s the Red pose may drop out before cancelling
PURPLE_BLAST, RED_BLAST = 2.6, 3.0   # blast animation lengths (s)
FX_SCALE = 0.5                       # effect layer resolution

# BGR float colours
WHITE = np.array([1.0, 1.0, 1.0], np.float32)
PURPLE = np.array([1.0, 0.22, 0.72], np.float32)
VIOLET = np.array([1.0, 0.55, 0.9], np.float32)
BLUE = np.array([1.0, 0.55, 0.08], np.float32)
RED = np.array([0.1, 0.08, 1.0], np.float32)
CRIMSON = np.array([0.05, 0.03, 0.55], np.float32)
HOTRED = np.array([0.55, 0.6, 1.0], np.float32)


def col(c):
    return tuple(float(v) for v in c)


def ip(p):
    return (int(round(float(p[0]))), int(round(float(p[1]))))


def unit(v):
    v = np.asarray(v, np.float32)
    return v / (np.linalg.norm(v) + 1e-6)


# --- gesture ----------------------------------------------------------------
def angle(a, b, c):
    v1, v2 = a - b, c - b
    cosv = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6)
    return math.degrees(math.acos(np.clip(cosv, -1, 1)))


class Hand:
    def __init__(self, lm, w, h, label):
        self.label = label
        self.pts = np.array([[p.x * w, p.y * h] for p in lm], np.float32)
        p = self.pts
        self.palm = float(np.linalg.norm(p[0] - p[9])) + 1e-6
        self.pinch = float(np.linalg.norm(p[4] - p[8])) / self.palm
        self.curl = angle(p[5], p[6], p[8])
        reach = lambda mcp, tip: float(np.linalg.norm(p[tip] - p[0]) / (np.linalg.norm(p[mcp] - p[0]) + 1e-6))
        self.index_reach = reach(5, 8)
        self.others = max(reach(9, 12), reach(13, 16), reach(17, 20))
        self.center = (p[4] + p[8]) / 2
        self.dir = unit(self.center - p[0])
        self.red_c = p[8] + unit(p[8] - p[5]) * self.palm * 0.3
        self.posed = self.red = False

    def classify(self, prev):
        was_p, was_r = prev
        if was_p:
            self.posed = self.pinch < PINCH_OFF and self.curl < CURL_OFF
        else:
            self.posed = self.pinch < PINCH_ON and self.curl < CURL_ON
        if was_r:
            self.red = self.index_reach > RED_IDX_OFF and self.others < RED_OTH_OFF
        else:
            self.red = self.index_reach > RED_IDX_ON and self.others < RED_OTH_ON and self.curl > 155
        self.red = self.red and not self.posed
        return self.posed, self.red


# --- effect primitives ------------------------------------------------------
class Swirl:
    """Particles spiralling into an orb."""

    def __init__(self, n=80):
        self.p = [self._spawn(far=False) for _ in range(n)]

    @staticmethod
    def _spawn(far=True):
        return [random.uniform(0, math.tau),
                random.uniform(5, 10) if far else random.uniform(1.2, 10),
                random.uniform(0.6, 1.5)]

    def step(self, dt, k):
        for i, (a, r, s) in enumerate(self.p):
            r -= dt * s * (2 + 6 * k)
            a += dt * s * (3 / max(r, 0.6))
            self.p[i] = self._spawn() if r < 1.0 else [a, r, s]

    def draw(self, cv_, c, rad, color, k):
        for a, r, s in self.p:
            pos = (c[0] + math.cos(a) * r * rad, c[1] + math.sin(a) * r * rad)
            fade = min(1.0, (10 - r) / 3) * k
            cv2.circle(cv_, ip(pos), 1 if s < 1.1 else 2, col((color * 0.6 + WHITE * 0.6) * fade), -1, cv2.LINE_AA)


def jag_path(a, b, rough, levels):
    """Midpoint-displacement jagged path from a to b."""
    pts = np.array([a, b], np.float32)
    d = float(np.linalg.norm(pts[1] - pts[0])) * rough
    for _ in range(levels):
        seg = pts[1:] - pts[:-1]
        perp = np.stack([-seg[:, 1], seg[:, 0]], 1) / (np.linalg.norm(seg, axis=1, keepdims=True) + 1e-6)
        mids = (pts[:-1] + pts[1:]) / 2 + perp * np.random.uniform(-d, d, (len(seg), 1)).astype(np.float32)
        new = np.empty((len(pts) + len(mids), 2), np.float32)
        new[0::2], new[1::2] = pts, mids
        pts, d = new, d * 0.55
    return pts


def make_bolt(a, b, rough=0.2, levels=6, branches=4):
    """A branching lightning bolt: list of (points, width_factor)."""
    main = jag_path(a, b, rough, levels)
    out = [(main, 1.0)]
    L = float(np.linalg.norm(np.asarray(b) - np.asarray(a)))
    for _ in range(branches):
        i = random.randint(len(main) // 6, len(main) * 4 // 5)
        seg = main[min(i + 1, len(main) - 1)] - main[max(i - 1, 0)]
        ang = math.atan2(seg[1], seg[0]) + random.choice((-1, 1)) * random.uniform(0.3, 0.9)
        q = main[i] + L * random.uniform(0.12, 0.35) * np.array([math.cos(ang), math.sin(ang)], np.float32)
        out.append((jag_path(main[i], q, rough * 1.3, max(2, levels - 2)), 0.5))
    return out


def draw_bolt(cv_, bolt, color, k, width):
    for pts, wf in bolt:
        P = [np.int32(pts)]
        cv2.polylines(cv_, P, False, col(color * 0.9 * k), max(1, int(width * wf * 3)), cv2.LINE_AA)
    for pts, wf in bolt:
        cv2.polylines(cv_, [np.int32(pts)], False, col(WHITE * 1.8 * k), max(1, int(width * wf)), cv2.LINE_AA)


def small_bolt(cv_, a, b, color, jag, segs=7):
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    d = b - a
    perp = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-6)
    pts = [a] + [a + d * i / segs + perp * random.uniform(-jag, jag) for i in range(1, segs)] + [b]
    cv2.polylines(cv_, [np.int32(pts)], False, col(color), 1, cv2.LINE_AA)


class Dashes:
    """Short horizontal energy streaks drifting through the frame."""

    def __init__(self, sw, sh, n=110):
        self.sw, self.sh = sw, sh
        self.p = np.random.rand(n, 4).astype(np.float32)

    def draw(self, cv_, color, k, t, vx=-30.0, vy=-12.0):
        if k <= 0.02:
            return
        for x, y, l, ph in self.p:
            px = (x * self.sw + vx * t * (0.5 + l)) % self.sw
            py = (y * self.sh + vy * t * (0.5 + ph)) % self.sh
            a = k * max(0.0, math.sin(t * 5 + ph * 40))
            if a > 0.05:
                L = 2 + l * 9
                cv2.line(cv_, (int(px), int(py)), (int(px + L), int(py)), col(color * 1.6 * a), 1)


class Veins:
    """Red veins that creep across the screen while Red charges."""

    def __init__(self, sw, sh, origin):
        self.sw, self.sh = sw, sh
        segs = []
        step = sh * 0.035
        for _ in range(13):  # from the screen edges, wandering inward
            side = random.randrange(4)
            if side == 0:
                p = (random.uniform(0, sw), 0)
            elif side == 1:
                p = (random.uniform(0, sw), sh)
            elif side == 2:
                p = (0, random.uniform(0, sh))
            else:
                p = (sw, random.uniform(0, sh))
            a = math.atan2(origin[1] - p[1], origin[0] - p[0]) + random.uniform(-0.8, 0.8)
            self._grow(segs, np.array(p, np.float32), a, random.randint(16, 26), step, random.uniform(0, 0.4), 0)
        for _ in range(6):  # bursting out around the hand
            a = random.uniform(0, math.tau)
            p = np.array(origin, np.float32) + sh * 0.08 * np.array([math.cos(a), math.sin(a)], np.float32)
            self._grow(segs, p, a, random.randint(10, 16), step * 0.8, random.uniform(0.3, 0.6), 1)
        self.segs = np.array(segs, np.float32)

    def _grow(self, segs, p, a, steps, step, t0, depth):
        dt = (0.5 if depth == 0 else 0.3) / steps
        t = t0
        for i in range(steps):
            a += random.uniform(-0.45, 0.45)
            q = p + step * np.array([math.cos(a), math.sin(a)], np.float32)
            w = max(1.0, (3 - depth) * (1 - 0.6 * i / steps))
            segs.append((p[0], p[1], q[0], q[1], t, w))
            if depth < 2 and random.random() < 0.13:
                self._grow(segs, q, a + random.choice((-1, 1)) * random.uniform(0.5, 1.2),
                           max(3, steps // 2), step * 0.8, t, depth + 1)
            p, t = q, t + dt

    def draw(self, cv_, progress, k, t):
        if k <= 0.01 or not len(self.segs):
            return
        vis = self.segs[self.segs[:, 4] <= progress]
        pulse = 0.75 + 0.25 * math.sin(t * 4)
        c_glow = col(CRIMSON * 0.7 * k * pulse)
        c_core = col(RED * 0.45 * k * pulse)
        for x1, y1, x2, y2, _, w in vis:
            a, b = (int(x1), int(y1)), (int(x2), int(y2))
            cv2.line(cv_, a, b, c_glow, int(w) + 1, cv2.LINE_AA)
            cv2.line(cv_, a, b, c_core, 1, cv2.LINE_AA)


# --- technique visuals ------------------------------------------------------
def draw_purple_orb(cv_, c, r, t, k, swirl):
    """c, r in fx-canvas pixels; k = intensity 0..1."""
    color = PURPLE
    r = max(r, 2.0)
    cv2.circle(cv_, ip(c), int(r * 3.4), col(color * 0.28 * k), -1, cv2.LINE_AA)
    n = 18
    for i in range(n):
        a = i / n * math.tau + t * 0.7 + 0.25 * math.sin(t * 3 + i * 2.1)
        L = r * (2.2 + 5.5 * k * (0.55 + 0.45 * math.sin(t * 11 + i * 1.7)))
        e = (c[0] + math.cos(a) * L, c[1] + math.sin(a) * L)
        cv2.line(cv_, ip(c), ip(e), col((color * 0.6 + WHITE * 0.5) * k), 1, cv2.LINE_AA)
    swirl.draw(cv_, c, r, color, k)
    for _ in range(3):
        if random.random() < 0.35 * k:
            a = random.uniform(0, math.tau)
            L = r * random.uniform(2.5, 5.5)
            small_bolt(cv_, c, (c[0] + math.cos(a) * L, c[1] + math.sin(a) * L), (WHITE + color) * 0.9 * k, r * 0.6)
    ring = r * (1.9 + 0.1 * math.sin(t * 7))
    cv2.circle(cv_, ip(c), int(ring), col((WHITE * 0.8 + color * 0.4) * k), 1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(r), col(color * 1.6), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(r * 0.72), col(WHITE * (1.5 + 2 * k)), -1, cv2.LINE_AA)


def draw_split_orb(cv_, c, r, color, t, k, swirl):
    cv2.circle(cv_, ip(c), int(r * 3), col(color * 0.25 * k), -1, cv2.LINE_AA)
    swirl.draw(cv_, c, r, color, k)
    cv2.circle(cv_, ip(c), int(r), col(color * 1.6), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(r * 0.6), col(WHITE * 2.5 * k), -1, cv2.LINE_AA)


def draw_red_orb(cv_, c, r, t, k, swirl):
    r = max(r, 2.0)
    cv2.circle(cv_, ip(c), int(r * 4.5), col(RED * 0.22 * k), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(r * 2.2), col(RED * 0.45 * k), -1, cv2.LINE_AA)
    swirl.draw(cv_, c, r, RED, k)
    wob = 1 + 0.05 * math.sin(t * 17)
    cv2.circle(cv_, ip(c), int(r * 1.15 * wob), col(RED * 1.7), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(r * 0.6), col(HOTRED * (1.2 + 1.5 * k)), -1, cv2.LINE_AA)


def draw_red_sparks(cv_, c, r, k, n):
    """White crackling dotted arcs around the hand."""
    for _ in range(n):
        a = random.uniform(0, math.tau)
        R = r * random.uniform(1.6, 6.5)
        p = np.array([c[0] + math.cos(a) * R, c[1] + math.sin(a) * R], np.float32)
        ta = a + math.pi / 2 + random.uniform(-0.6, 0.6)
        q = p + r * random.uniform(0.8, 2.2) * np.array([math.cos(ta), math.sin(ta)], np.float32)
        pts = jag_path(p, q, 0.45, 3)
        cv2.polylines(cv_, [np.int32(pts)], False, col(WHITE * 0.7 * k), 1, cv2.LINE_AA)
        for pt in pts[::2]:
            cv2.circle(cv_, ip(pt), 1, col(WHITE * 2.0 * k), -1)


def draw_ribbon(cv_, c, R, t, k):
    th = np.linspace(0, math.tau * 1.15, 140, dtype=np.float32) + t * 1.6
    rad = R * (1 + 0.35 * np.sin(th * 2.5 + t * 2))
    pts = np.stack([c[0] + rad * np.cos(th), c[1] + rad * np.sin(th) * 0.55], 1)
    cv2.polylines(cv_, [np.int32(pts)], False, col(RED * 0.5 * k), max(2, int(R * 0.16)), cv2.LINE_AA)
    cv2.polylines(cv_, [np.int32(pts)], False, col(HOTRED * 0.5 * k), 1, cv2.LINE_AA)


class Blast:
    def __init__(self, kind, c, d, r):
        self.kind, self.t = kind, 0.0
        self.c, self.d, self.r = np.array(c, np.float32), unit(d), float(r)
        self.T = PURPLE_BLAST if kind == "purple" else RED_BLAST
        self.bolts, self.frame = [], 0
        self.fired = False


def draw_purple_blast(cv_, B, s, sw, sh):
    """Returns (flash, shake, zoom, chroma)."""
    t, c, d = B.t, B.c * s, B.d
    diag = math.hypot(sw, sh)
    r0 = B.r * s
    fade = 1.0 if t < 1.1 else max(0.0, 1 - (t - 1.1) / (B.T - 1.1))
    # brief palm discharge
    kp = max(0.0, 1 - t / 0.5)
    if kp > 0:
        cv2.circle(cv_, ip(c), int(r0 * 3 * kp), col(PURPLE * 0.5 * kp), -1, cv2.LINE_AA)
        cv2.circle(cv_, ip(c), int(r0 * (0.5 + 0.8 * kp)), col(WHITE * 1.6 * kp), -1, cv2.LINE_AA)
    # the hollow sphere tearing outward, with an energy trail of filaments
    travel = diag * 1.2 * (1 - math.exp(-t * 1.8))
    sc = c + d * travel
    R = r0 * 1.0 + diag * 0.07 * min(1.0, t / 0.15)
    perp = np.array([-d[1], d[0]], np.float32)
    for _ in range(int(16 * fade) + 1):
        off = random.uniform(-1, 1)
        a = c + perp * off * r0 * 0.6
        b = sc + perp * off * R * 0.9
        cv2.polylines(cv_, [np.int32(jag_path(a, b, 0.03, 4))], False,
                      col((VIOLET * 0.6 + WHITE * 0.2) * fade * random.uniform(0.4, 1)), 1, cv2.LINE_AA)
    # dim void body, swirling inner arcs, bright rim
    cv2.circle(cv_, ip(sc), int(R * 1.8), col(PURPLE * 0.3 * fade), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(sc), int(R), col(PURPLE * 0.22 * fade), -1, cv2.LINE_AA)
    for i in range(6):
        ax = (max(1, int(R * random.uniform(0.4, 0.95))), max(1, int(R * random.uniform(0.15, 0.6))))
        cv2.ellipse(cv_, ip(sc), ax, (t * 400 + i * 60) % 360, 0, random.randint(120, 300),
                    col(VIOLET * random.uniform(0.6, 1.2) * fade), 1, cv2.LINE_AA)
    cv2.circle(cv_, ip(sc), int(R), col((WHITE * 1.2 + VIOLET * 0.6) * fade), 2, cv2.LINE_AA)
    cv2.circle(cv_, ip(sc), int(R * 1.15), col(PURPLE * 0.9 * fade), 1, cv2.LINE_AA)
    # massive branching lightning across the screen, re-struck every few frames
    if B.frame % 3 == 0 and t < B.T * 0.85:
        B.bolts = []
        for _ in range(random.randint(3, 5)):
            ang = math.atan2(d[1], d[0]) + random.uniform(-2.0, 2.0)
            tgt = c + diag * np.array([math.cos(ang), math.sin(ang)], np.float32)
            B.bolts.append(make_bolt(c, tgt, 0.22, 7, random.randint(3, 6)))
    B.frame += 1
    for bolt in B.bolts:
        draw_bolt(cv_, bolt, PURPLE, fade * random.uniform(0.6, 1.0), 1.0)
    flash = max(0.0, 1 - t / 0.16)
    shake = 22 * max(0.0, 1 - t / 1.0) ** 2
    zoom = 1 + 0.06 * math.exp(-t * 5)
    chroma = 0.012 * max(0.0, 1 - t / 0.6)
    return flash, shake, zoom, chroma


def draw_red_blast(cv_, B, s, sw, sh, veins):
    t, c = B.t, B.c * s
    diag = math.hypot(sw, sh)
    r0 = B.r * s
    fade = 1.0 if t < 0.9 else max(0.0, 1 - (t - 0.9) / (B.T - 0.9))
    if veins is not None:
        veins.draw(cv_, 2.0, 1.6 * fade, t)
    # red repulsion wave filling the screen
    R = r0 + diag * 0.75 * (1 - math.exp(-t * 4))
    a = max(0.0, 1 - t / 1.3)
    for j in range(6):   # outside-in so it reads as a soft radial gradient
        cv2.circle(cv_, ip(c), int(R * (1 - j * 0.15)), col(RED * (0.05 + 0.05 * j) * a), -1, cv2.LINE_AA)
    for i in range(4):
        tt = t - i * 0.09
        if tt > 0:
            rr = tt * diag * 1.1
            aa = max(0.0, 1 - tt / 0.9)
            cv2.circle(cv_, ip(c), int(rr), col((RED * 1.2 + WHITE * 0.3 * (i == 0)) * aa), max(1, int(6 * aa)), cv2.LINE_AA)
    # radial speed lines
    reach = min(1.0, t * 3)
    for _ in range(int(90 * fade)):
        ang = random.uniform(0, math.tau)
        u = np.array([math.cos(ang), math.sin(ang)], np.float32)
        r1 = random.uniform(0.15, 1.0) * diag * reach
        L = diag * random.uniform(0.08, 0.3)
        colr = (RED * 1.2 if random.random() < 0.7 else WHITE * 1.4) * fade * random.uniform(0.3, 1)
        cv2.line(cv_, ip(c + u * r1), ip(c + u * (r1 + L)), col(colr), 1, cv2.LINE_AA)
    # core
    core = r0 * (0.6 + 1.0 * min(1.0, t / 0.1)) * fade
    cv2.circle(cv_, ip(c), int(core * 1.6), col(RED * 0.6 * fade), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(core), col(RED * 1.3 * fade), -1, cv2.LINE_AA)
    cv2.circle(cv_, ip(c), int(core * 0.35), col(HOTRED * 1.1 * fade), -1, cv2.LINE_AA)
    draw_red_sparks(cv_, c, max(r0, 4) * 2, fade, int(30 * fade))
    flash = max(0.0, 1 - t / 0.14)
    shake = 26 * max(0.0, 1 - t / 1.1) ** 2
    zoom = 1 + 0.09 * math.exp(-t * 6) * (1 + 0.3 * math.sin(t * 40))
    chroma = 0.016 * max(0.0, 1 - t / 0.7)
    return flash, shake, zoom, chroma


# --- compositor -------------------------------------------------------------
def make_title(kanji, latin):
    """Render a technique title once, as float BGR + alpha + glow."""
    try:
        from PIL import Image as PImg, ImageDraw, ImageFont
    except ImportError:
        return None
    fonts = ["/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc",
             "/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/AquaKana.ttc"]
    big = None
    for f in fonts:
        try:
            big = ImageFont.truetype(f, 92)
            break
        except OSError:
            continue
    try:
        small = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", 28)
    except OSError:
        small = ImageFont.load_default()
    img = PImg.new("RGBA", (1000, 190), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    if big is not None:
        dr.text((500, 70), kanji, font=big, fill=(255, 255, 255, 255), anchor="mm")
    dr.text((500, 160), "   ".join(" ".join(w) for w in latin.split()), font=small,
            fill=(235, 225, 235, 255), anchor="mm")
    a = np.asarray(img, np.float32) / 255
    alpha = a[..., 3:4]
    glow = cv2.GaussianBlur(alpha, (0, 0), 10)[..., None]
    return a[..., [2, 1, 0]], alpha, glow


class Grade:
    def __init__(self):
        self.amount = 0.0      # 0..1 cinematic grade strength
        self.tint = PURPLE
        self.crush = 1.4       # how hard shadows get crushed
        self.wash = 0.0        # flat tint added over the whole frame
        self.flash = 0.0
        self.flash_col = WHITE
        self.title = None
        self.title_a = 0.0
        self.shake = 0.0
        self.zoom = 1.0
        self.chroma = 0.0


class Renderer:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.sw, self.sh = int(w * FX_SCALE), int(h * FX_SCALE)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
        self.vignette = (np.clip(r / 1.3, 0, 1) ** 1.5)[..., None]
        self.grain = [np.random.randn(h, w, 1).astype(np.float32) for _ in range(4)]
        self.titles = {"purple": make_title("虚式「茈」", "HOLLOW PURPLE"),
                       "red": make_title("術式反転「赫」", "REVERSAL RED")}

    def new_layer(self):
        return np.zeros((self.sh, self.sw, 3), np.float32)

    def compose(self, frame, layer, g):
        if g.amount <= 0.01 and g.flash <= 0 and g.title_a <= 0 and not layer.any():
            return frame.copy()
        g1 = cv2.GaussianBlur(layer, (0, 0), 2.5)
        small = cv2.resize(layer, (self.sw // 4, self.sh // 4), interpolation=cv2.INTER_AREA)
        g2 = cv2.resize(cv2.GaussianBlur(small, (0, 0), 3), (self.sw, self.sh), interpolation=cv2.INTER_LINEAR)
        glow = layer * 0.6 + g1 + g2 * 1.8
        glow += np.clip(glow - 0.7, 0, None).sum(axis=2, keepdims=True) * 0.35   # hot spots bloom white
        glow = cv2.resize(glow, (self.w, self.h), interpolation=cv2.INTER_LINEAR)

        amt = g.amount
        if amt > 0.01:
            # crush shadows, then desaturate into the technique's colour (one 3x3 matrix)
            lut = (np.power(np.arange(256) / 255.0, 1 + g.crush * amt) * 255).astype(np.uint8)
            f8 = cv2.LUT(frame, lut)
            a = 0.85 * amt
            lum = np.full((3, 3), 1 / 3, np.float32) * (g.tint * 1.15)[:, None]
            M = np.eye(3, dtype=np.float32) * (1 - a + 0.2 * a) + lum * a
            f = cv2.transform(f8, M).astype(np.float32) * (1 / 255)
            if g.wash > 0:
                f += g.tint * (g.wash * amt)
            f *= 1 - self.vignette * (0.92 * amt)
        else:
            f = frame.astype(np.float32) * (1 / 255)
        out = cv2.add(f, glow)
        if g.flash > 0:
            out += g.flash * g.flash_col
        if amt > 0.01:
            out += self.grain[random.randrange(4)] * (0.045 * amt)

        title = self.titles.get(g.title) if g.title else None
        if g.title_a > 0 and title is not None:
            rgb, alpha, glw = title
            th, tw = alpha.shape[:2]
            x0, y0 = (self.w - tw) // 2, int(self.h * 0.8) - th // 2
            xs0, ys0, xs1, ys1 = max(0, x0), max(0, y0), min(self.w, x0 + tw), min(self.h, y0 + th)
            if xs1 > xs0 and ys1 > ys0:
                sl = (slice(ys0 - y0, ys1 - y0), slice(xs0 - x0, xs1 - x0))
                region = out[ys0:ys1, xs0:xs1]
                region += glw[sl] * g.tint * 1.3 * g.title_a
                al = alpha[sl] * g.title_a
                out[ys0:ys1, xs0:xs1] = region * (1 - al) + rgb[sl] * al * 1.2

        out = cv2.convertScaleAbs(out, alpha=255)
        if g.chroma > 0.001:   # chromatic aberration: scale R and B apart
            ctr = (self.w / 2, self.h / 2)
            b, gg, r = cv2.split(out)
            b = cv2.warpAffine(b, cv2.getRotationMatrix2D(ctr, 0, 1 + g.chroma), (self.w, self.h),
                               borderMode=cv2.BORDER_REFLECT)
            r = cv2.warpAffine(r, cv2.getRotationMatrix2D(ctr, 0, 1 - g.chroma), (self.w, self.h),
                               borderMode=cv2.BORDER_REFLECT)
            out = cv2.merge([b, gg, r])
        if g.shake > 0.5 or abs(g.zoom - 1) > 0.002:
            M = cv2.getRotationMatrix2D((self.w / 2, self.h / 2), 0, g.zoom)
            M[:, 2] += (random.uniform(-g.shake, g.shake), random.uniform(-g.shake, g.shake))
            out = cv2.warpAffine(out, M, (self.w, self.h), borderMode=cv2.BORDER_REFLECT)
        return out


# --- sound ------------------------------------------------------------------
class Sound:
    """Plays clips with macOS `afplay` (no SDL/pygame, so no clash with OpenCV)."""

    def __init__(self):
        ensure_sounds(ASSETS)
        self.player = shutil.which("afplay")
        if not self.player:
            print("[sound disabled] afplay not found (this sound backend is macOS-only)")
        self.purple_charge = self._pick("charge")
        self.purple_blast = self._pick("blast")
        red = ASSETS / "red_custom.wav"
        self.red_full = red if red.exists() else None
        self.proc = None

    @staticmethod
    def _pick(name):
        for ext in ("wav", "mp3", "m4a", "aiff"):
            p = ASSETS / f"{name}_custom.{ext}"
            if p.exists():
                return p
        return ASSETS / f"{name}.wav"

    def _play(self, path):
        if not self.player:
            return None
        return subprocess.Popen([self.player, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def charge_on(self, path):
        """Start a charge clip once; holding past its end stays silent."""
        if self.proc is None:
            self.proc = self._play(path) or False

    def charge_off(self):
        if self.proc:
            if self.proc.poll() is None:
                self.proc.terminate()
        self.proc = None

    def oneshot(self, path):
        self._play(path)

    def close(self):
        self.charge_off()


class NullSound(Sound):
    def __init__(self):
        self.player = None
        self.purple_charge = self.purple_blast = self.red_full = None
        self.proc = None


# --- engine -----------------------------------------------------------------
class Engine:
    def __init__(self, w, h, sound=None):
        self.w, self.h = w, h
        self.r = Renderer(w, h)
        self.snd = sound or NullSound()
        self.swirl, self.swirl_red = Swirl(), Swirl(60)
        self.swirl_b, self.swirl_r = Swirl(40), Swirl(40)
        self.dashes = Dashes(self.r.sw, self.r.sh)
        self.mode = None           # None | 'purple' | 'red' | 'red_out'
        self.charge = self.charge_t = 0.0
        self.orb_c = None
        self.orb_dir = np.array([0, -1], np.float32)
        self.orb_palm = 120.0
        self.merged = False
        self.lost = 0.0
        self.blast = None
        self.veins = None
        self.poses = {}
        self.rising = False
        self.t = 0.0

    def _track(self, c, d, palm):
        if self.orb_c is None:
            self.orb_c, self.orb_dir, self.orb_palm = np.array(c, np.float32), unit(d), palm
        self.orb_c = self.orb_c * 0.45 + np.asarray(c, np.float32) * 0.55
        self.orb_dir = unit(self.orb_dir * 0.7 + np.asarray(d, np.float32) * 0.3)
        self.orb_palm = self.orb_palm * 0.8 + palm * 0.2

    def fire(self, kind, c=None, d=None, palm=None):
        if palm is not None:
            self.orb_palm = palm
        c = c if c is not None else (self.orb_c if self.orb_c is not None else (self.w / 2, self.h / 2))
        d = d if d is not None else self.orb_dir
        self.blast = Blast(kind, c, d, self.orb_palm * 0.25)
        if kind == "red" and self.veins is None:
            self.veins = Veins(self.r.sw, self.r.sh, np.asarray(c) * FX_SCALE)
        if kind == "purple" or not self.snd.red_full or self.mode != "red":
            self.snd.charge_off()
            self.snd.oneshot(self.snd.purple_blast)
        self.mode = kind
        self.charge = self.charge_t = 0.0
        return kind + "_fire"

    def step(self, frame, hands, dt):
        """Advance state & render. Returns (image, event)."""
        self.t += dt
        event = None
        s = FX_SCALE
        layer = self.r.new_layer()
        g = Grade()

        prev, self.poses = self.poses, {}
        for h in hands:
            key = h.label if h.label not in self.poses else h.label + "2"
            self.poses[key] = h.classify(prev.get(key, (False, False)))
        purple = [h for h in hands if h.posed]
        reds = [h for h in hands if h.red]

        target, split = None, None
        if len(purple) >= 2:
            a, b = purple[:2]
            dist = float(np.linalg.norm(a.center - b.center))
            thr = (a.palm + b.palm) / 2 * (1.7 if self.merged else 1.15)
            if dist < thr:
                self.merged = True
                target = ((a.center + b.center) / 2, unit(a.dir + b.dir), (a.palm + b.palm) / 2, 1.0)
            else:
                self.merged = False
                split = sorted((a, b), key=lambda h: h.center[0])
        elif len(purple) == 1:
            self.merged = False
            h = purple[0]
            target = (h.center, h.dir, h.palm, 1.0)
        red_t = (reds[0].red_c, reds[0].palm) if reds else None

        # --- state machine
        self.rising = False
        if self.blast is not None:
            self.blast.t += dt
            if self.blast.t > self.blast.T + 0.6:
                self.blast, self.mode, self.veins, self.orb_c = None, None, None, None
        else:
            if self.mode is None:
                if target is not None:
                    self.mode, self.charge_t, self.orb_c = "purple", 0.0, None
                elif red_t is not None:
                    self.mode, self.charge_t, self.orb_c = "red", 0.0, None
                    self.veins = Veins(self.r.sw, self.r.sh, red_t[0] * s)
                    self.snd.charge_on(self.snd.red_full or self.snd.purple_charge)
                    event = "red_start"

            if self.mode == "purple":
                if target is not None:
                    c, d, palm, rate = target
                    self.lost, self.rising = 0.0, True
                    self._track(c, d, palm)
                    self.charge_t += dt * rate
                    self.charge = min(1.0, self.charge_t / PURPLE_CHARGE)
                    self.snd.charge_on(self.snd.purple_charge)
                else:
                    self.lost += dt
                    if self.lost >= 0.06:
                        self.snd.charge_off()
                        if self.charge >= FIRE_MIN:
                            event = self.fire("purple")
                        else:
                            self.charge = max(0.0, self.charge - dt * 0.6)
                            self.charge_t = self.charge * PURPLE_CHARGE
                            if self.charge <= 0:
                                self.mode = None
            elif self.mode == "red":
                if red_t is not None:
                    self.lost = 0.0
                    self._track(red_t[0], self.orb_dir, red_t[1])
                else:
                    self.lost += dt
                if self.lost < RED_GRACE:
                    self.rising = True
                    self.charge_t += dt
                    self.charge = min(1.0, self.charge_t / RED_HIT)
                    if self.charge_t >= RED_HIT and self.orb_c is not None:
                        event = self.fire("red")
                else:
                    self.mode = "red_out"
                    self.snd.charge_off()
                    event = "red_cancel"
            elif self.mode == "red_out":
                self.charge = max(0.0, self.charge - dt * 1.2)
                if self.charge <= 0:
                    self.mode, self.veins = None, None

        # --- draw
        if split is not None and self.mode in (None, "purple") and self.blast is None:
            for h, color, sw in ((split[0], BLUE, self.swirl_b), (split[1], RED, self.swirl_r)):
                sw.step(dt, 0.6)
                draw_split_orb(layer, h.center * s, h.palm * 0.14 * s, color, self.t,
                               0.65 + 0.15 * math.sin(self.t * 8), sw)
            g.amount, g.tint = 0.3, PURPLE

        if self.blast is None and self.orb_c is not None and self.charge > 0.01:
            k = self.charge
            if self.mode == "purple":
                self.swirl.step(dt, k)
                rad = self.orb_palm * (0.08 + 0.16 * k) * (1 + 0.06 * math.sin(self.t * 20))
                draw_purple_orb(layer, self.orb_c * s, rad * s, self.t, k, self.swirl)
                self.dashes.draw(layer, PURPLE, k, self.t)
                g.amount, g.tint = max(g.amount, 0.9 * k), PURPLE
                g.shake = 3 * max(0.0, k - 0.8) / 0.2
            elif self.mode in ("red", "red_out"):
                amb = min(1.0, k * 4)
                if self.veins is not None:
                    self.veins.draw(layer, k * 1.15, 0.4 + 0.6 * amb, self.t)
                self.swirl_red.step(dt, k)
                rad = self.orb_palm * (0.07 + 0.13 * k) * (1 + 0.05 * math.sin(self.t * 23))
                c = self.orb_c * s
                if k > 0.55:
                    draw_ribbon(layer, c, rad * s * (3 + 3 * k), self.t, (k - 0.55) / 0.45)
                draw_red_orb(layer, c, rad * s, self.t, amb, self.swirl_red)
                draw_red_sparks(layer, c, max(rad * s, 3), amb, int(4 + 22 * k))
                self.dashes.draw(layer, RED, amb * 0.7, self.t, vx=8, vy=-25)
                g.amount, g.tint = max(g.amount, amb), RED
                g.crush, g.wash = 0.5, 0.12
                g.shake = 4 * max(0.0, k - 0.9) / 0.1

        if self.blast is not None:
            B = self.blast
            if B.kind == "purple":
                fx = draw_purple_blast(layer, B, s, self.r.sw, self.r.sh) if B.t < B.T else (0, 0, 1, 0)
                tint = PURPLE
                self.dashes.draw(layer, PURPLE, 1.0, self.t, vx=-120, vy=0)
            else:
                fx = draw_red_blast(layer, B, s, self.r.sw, self.r.sh, self.veins) if B.t < B.T else (0, 0, 1, 0)
                tint = RED
                g.crush, g.wash = 0.5, 0.12
            g.flash, g.shake, g.zoom, g.chroma = fx
            g.flash_col = WHITE * 0.7 + tint * 0.3
            g.amount, g.tint = (1.0 if B.t < B.T else max(0.0, 1 - (B.t - B.T) / 0.6)), tint
            g.title = B.kind
            end = B.T + 0.6
            if 0.2 < B.t < end:
                g.title_a = min(1.0, (B.t - 0.2) / 0.25) * min(1.0, (end - B.t) / 0.6)

        return self.r.compose(frame, layer, g), event


# --- app --------------------------------------------------------------------
def ensure_model():
    if MODEL.exists():
        return
    print("downloading hand model (~7.5 MB) from Google's MediaPipe storage ...")
    ASSETS.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(MODEL_URL, MODEL)


def draw_hud(img, engine, hands, debug, fps):
    h = img.shape[0]
    if engine.blast is None:
        k = engine.charge
        if engine.mode == "purple":
            msg = "CHARGED - flick open to fire!" if k >= FIRE_MIN else "Hollow Purple charging..."
            ready, color = k >= FIRE_MIN, (255, 120, 230)
        elif engine.mode == "red":
            msg, ready, color = "Reversal: Red - keep pointing...", k > 0.9, (60, 60, 255)
        else:
            msg, ready, color = "PURPLE: index curled onto thumb  |  RED: index finger pointing up", False, (255, 255, 255)
            k = 0
        cv2.putText(img, msg, (20, h - 50), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (235, 225, 235), 2, cv2.LINE_AA)
        if engine.mode:
            cv2.rectangle(img, (20, h - 32), (320, h - 20), (90, 60, 90), 1)
            dim = tuple(int(v * (1.0 if ready else 0.65)) for v in color)
            cv2.rectangle(img, (21, h - 31), (21 + int(298 * k), h - 21), dim, -1)
    if debug:
        for hd in hands:
            for p in hd.pts:
                cv2.circle(img, ip(p), 3, (255, 0, 255) if hd.posed else (0, 0, 255) if hd.red else (0, 200, 0), -1)
            cv2.putText(img, f"{hd.label} pinch={hd.pinch:.2f} curl={hd.curl:.0f} "
                             f"reach={hd.index_reach:.2f} others={hd.others:.2f}",
                        ip(hd.pts[0] + [10, 20]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(img, f"{fps:.0f} fps", (20, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)


def main():
    from mediapipe import Image, ImageFormat
    from mediapipe.tasks.python import BaseOptions, vision

    cam = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0
    ensure_model()
    sound = Sound()

    cap = cv2.VideoCapture(cam)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    ok, frame = cap.read()
    if not ok:
        sys.exit("Could not open the camera. On macOS: System Settings > Privacy & Security > Camera, "
                 "allow your terminal app, then run again. (Try another index: python hollow_purple.py 1)")
    H, W = frame.shape[:2]

    detector = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=0.6, min_hand_presence_confidence=0.5, min_tracking_confidence=0.5))

    engine = Engine(W, H, sound)
    win = "Gojo"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, W, H)
    debug, full = False, False
    t0 = last = time.monotonic()
    fps = 30.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.flip(frame, 1)
        now = time.monotonic()
        dt = min(0.1, now - last)
        last = now
        fps = fps * 0.9 + 0.1 / max(dt, 1e-3)

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        res = detector.detect_for_video(Image(image_format=ImageFormat.SRGB, data=rgb), int((now - t0) * 1000))
        hands = [Hand(lm, W, H, res.handedness[i][0].category_name)
                 for i, lm in enumerate(res.hand_landmarks)]

        img, _ = engine.step(frame, hands, dt)
        draw_hud(img, engine, hands, debug, fps)
        cv2.imshow(win, img)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord("d"):
            debug = not debug
        if key == ord("f"):
            full = not full
            cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN,
                                  cv2.WINDOW_FULLSCREEN if full else cv2.WINDOW_NORMAL)
        if key in (ord("1"), ord("2")) and engine.blast is None:
            hand = hands[0] if hands else None
            c = hand.center if hand is not None else (W / 2, H / 2)
            engine.fire("purple" if key == ord("1") else "red", c,
                        hand.dir if hand is not None else (0, -1), H * 0.2)

    sound.close()
    cap.release()
    detector.close()
    cv2.destroyAllWindows()


def selftest(out_dir):
    """Render effect frames on a synthetic background (no camera needed)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    W, H = 1280, 720
    yy, xx = np.mgrid[0:H, 0:W]
    bg = np.dstack([(xx / W * 120 + 40), (yy / H * 100 + 50), np.full((H, W), 90)]).astype(np.uint8)
    cv2.circle(bg, (640, 330), 160, (150, 170, 200), -1)          # a "person"
    cv2.rectangle(bg, (450, 470), (830, 720), (60, 50, 50), -1)

    class Fake:
        def __init__(self, c, purple=False, red=False):
            self.label, self.center = "Right", np.array(c, np.float32)
            self.red_c = self.center
            self.dir, self.palm = unit([0.6, -0.8]), 150.0
            self.pts = np.zeros((21, 2), np.float32)
            self.p, self.r = purple, red

        def classify(self, _):
            self.posed, self.red = self.p, self.r
            return self.p, self.r

    timings = []

    def run(name, hands_fn, frames, snaps):
        eng_events = []
        for i in range(frames):
            t = time.perf_counter()
            img, ev = eng.step(bg, hands_fn(i), 1 / 30)
            timings.append(time.perf_counter() - t)
            if ev:
                eng_events.append((i, ev))
            if i in snaps:
                cv2.imwrite(str(out / f"{name}_{i:03d}.png"), img)
        print(name, "events:", eng_events)

    eng = Engine(W, H)
    pf = int(PURPLE_CHARGE * 30) + 2
    run("purple_charge", lambda i: [Fake((700, 420), purple=True)], pf, {pf - 1})
    run("purple_blast", lambda i: [], 90, {3, 8, 18, 35, 60})
    eng = Engine(W, H)
    rf = int(RED_HIT * 30) + 2
    run("red_charge", lambda i: [Fake((640, 470), red=True)], rf, {60, 240, rf - 5})
    run("red_blast", lambda i: [], 100, {2, 8, 20, 45})
    eng = Engine(W, H)
    run("red_cancel", lambda i: [Fake((640, 470), red=True)] if i < 90 else [], 140, set())
    print(f"render: avg {np.mean(timings) * 1000:.1f} ms, p95 {np.percentile(timings, 95) * 1000:.1f} ms; frames in {out}")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        selftest(sys.argv[i + 1] if len(sys.argv) > i + 1 else "selftest_out")
    else:
        main()
