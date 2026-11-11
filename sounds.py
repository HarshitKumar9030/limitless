"""Procedurally synthesised sound effects (no copyrighted audio shipped).

Generates two files in assets/:
  charge.wav  - seamless looping energy hum while the orb charges
  blast.wav   - the Hollow Purple release (boom + impact + whoosh)

Drop your own clips in assets/ as charge_custom.(wav|ogg|mp3) or
blast_custom.(wav|ogg|mp3) and they will be used instead.
"""
import wave
from pathlib import Path

import numpy as np

SR = 44100


def _shaped_noise(n, rng, lo=None, hi=None):
    """Band-limited noise via FFT. It's circular, so it loops seamlessly."""
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    gain = np.ones_like(f)
    if hi:
        gain *= 1 / (1 + (f / hi) ** 4)
    if lo:
        gain *= 1 / (1 + (lo / np.maximum(f, 1e-3)) ** 4)
    y = np.fft.irfft(X * gain, n)
    return y / (np.abs(y).max() + 1e-9)


def _write(path, left, right):
    st = np.stack([left, right], axis=1)
    st = np.tanh(st * 1.4)
    st = st / (np.abs(st).max() + 1e-9) * 0.92
    data = (st * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def make_charge(path, dur=20.0, seed=1):
    rng = np.random.default_rng(seed)
    n = int(SR * dur)
    t = np.arange(n) / SR
    tau = 2 * np.pi
    # All frequencies are whole cycles per 4 s so the loop is seamless.
    def ch(detune):
        drone = (np.sin(tau * (55 + detune) * t)
                 + 0.6 * np.sin(tau * (110.5 + detune) * t)
                 + 0.35 * np.sin(tau * 165 * t + 0.4 * np.sin(tau * 0.5 * t)))
        drone *= 0.75 + 0.25 * np.sin(tau * 7 * t)
        shimmer = sum(np.sin(tau * f * t + p) for f, p in ((1320, 0), (1760.25, 1), (2217.5, 2)))
        shimmer *= 0.07 * (0.5 + 0.5 * np.sin(tau * 1.5 * t))
        return drone * 0.55 + shimmer

    hiss = _shaped_noise(n, rng, 1800, 6500) * 0.18 * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    # Electric crackle: sparse impulses, band-passed (circular -> loopable)
    imp = np.zeros(n)
    idx = rng.integers(0, n, 140)
    imp[idx] = rng.uniform(-1, 1, idx.size)
    X = np.fft.rfft(imp)
    f = np.fft.rfftfreq(n, 1 / SR)
    crackle = np.fft.irfft(X / (1 + ((f - 3500) / 1500) ** 2), n)
    crackle = crackle / (np.abs(crackle).max() + 1e-9) * 0.22

    # crescendo over the ~1.4 s charge time, then sustain
    swell = 0.2 + 0.8 * np.clip(t / 1.4, 0, 1) ** 1.5
    pitch_wobble = 1 + 0.15 * np.clip(t / 1.4, 0, 1)
    _write(path, (ch(0) * pitch_wobble + hiss + crackle) * swell,
           (ch(0.25) * pitch_wobble + hiss + np.roll(crackle, 900)) * swell)


def make_blast(path, dur=3.6, seed=2):
    rng = np.random.default_rng(seed)
    n = int(SR * dur)
    t = np.arange(n) / SR
    attack = np.clip(t / 0.006, 0, 1)

    freq = 32 + 110 * np.exp(-t * 5)
    boom = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 1.6) * attack
    impact = _shaped_noise(n, rng) * np.exp(-t * 22) * attack * 0.9
    rumble = _shaped_noise(n, rng, None, 180) * np.exp(-t * 1.1) * 0.9
    whoosh_env = np.exp(-((t - 0.18) / 0.22) ** 2)
    whoosh = _shaped_noise(n, rng, 600, 5000) * whoosh_env * 0.55
    tail = (np.sin(2 * np.pi * 880 * t) + np.sin(2 * np.pi * 1318.5 * t)) * np.exp(-t * 2.2) * 0.08

    mono = boom * 1.1 + impact + rumble + whoosh + tail
    side = _shaped_noise(n, rng, 300, 4000) * np.exp(-t * 3) * 0.15
    fade = np.clip((dur - t) / 0.4, 0, 1)
    _write(path, (mono + side) * fade, (mono - side) * fade)


def ensure_sounds(assets: Path):
    assets.mkdir(parents=True, exist_ok=True)
    if not (assets / "charge.wav").exists():
        make_charge(assets / "charge.wav")
    if not (assets / "blast.wav").exists():
        make_blast(assets / "blast.wav")


if __name__ == "__main__":
    a = Path(__file__).resolve().parent / "assets"
    make_charge(a / "charge.wav")
    make_blast(a / "blast.wav")
    print("wrote", a / "charge.wav", a / "blast.wav")
