# Limitless

Cast Gojo's **Hollow Purple** 虚式「茈」 and **Reversal: Red** 術式反転「赫」 with your hands, using webcam hand tracking.

Made by [Harshit](https://www.harshit.page). Unofficial fan project, not affiliated with Jujutsu Kaisen or MAPPA.

## Web version (`web/`)
Runs entirely in the browser using MediaPipe Tasks (WASM), a Canvas 2D effects engine and Web Audio. It's a static site with no build step.

- **Exorcism:** curses come at you in waves. You get multi-kill multipliers, a PERFECT flick bonus, boss waves, 3 barrier lives, sorcerer grades from Grade 4 to Special Grade, and 8 achievements.
- **Free cast:** both techniques with no game.

```bash
cd web && python3 -m http.server 8765    # open http://localhost:8765
```
To deploy, publish the `web/` folder to any static host (Vercel, Netlify, Cloudflare Pages or GitHub Pages). The camera only works over HTTPS.

## Poses
| Technique | Pose |
|---|---|
| Hollow Purple | Curl your index finger onto your thumb tip, hold to charge (~6s), then flick open |
| Reversal: Red | Point your index finger up with the other fingers curled, and hold through the incantation (~16s) |
| Blue + Red fusion | Make the Purple pose with both hands, then bring them together |

## Desktop prototype (Python)
This is the original OpenCV + MediaPipe version.
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python hollow_purple.py
```
