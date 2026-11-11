# Limitless (web)

Cast Hollow Purple and Reversal: Red with your hands, in the browser.

The site is entirely static: HTML, JS, the hand model and audio. There's no build step and no server code.

## Modes
- **Exorcism (game):** curses creep toward you in waves.
  - Hollow Purple exorcises everything in the sphere's path. Red clears the whole screen.
  - Multi-kills multiply your score, and flicking within 0.75s of full charge gives a ×1.5 PERFECT bonus.
  - Every 4th wave brings a special-grade boss. You have 3 barrier lives.
  - Score becomes XP, which ranks you from Grade 4 up to Special Grade. There are 8 achievements.
  - Progress is saved in the browser (localStorage).
- **Free cast:** both techniques with no game, as before.

## Run locally
```bash
python3 -m http.server 8765
```
Then open http://localhost:8765. Browsers allow camera access on `localhost` without HTTPS.

Demo mode simulates a hand, so you can test without a camera: `?demo=purple`, `?demo=red`, `?demo=game` (press 1/2 to fire), or `?demo=1`.

## Deploy (free, HTTPS included, which the camera requires)
Deploy **this `web` folder** with any of these:
- **Netlify Drop:** drag the folder onto https://app.netlify.com/drop.
- **Vercel:** run `npx vercel` in this folder, or import the repo with *Root Directory* set to `web`.
- **Cloudflare Pages:** create a project, upload the folder.
- **GitHub Pages:** push to a repo, then go to Settings → Pages and serve from the folder.

## Files
- `index.html`: the landing page (liquid glass) and HUD
- `landing.js`: the animated background
- `app.js`: tracking, effects, audio and the app shell
- `game.js`: Exorcism mode, scoring, grades and achievements
- `models/hand_landmarker.task`: the MediaPipe hand model
- `audio/`: `purple_charge.m4a`, `purple_blast.m4a`, `red.m4a`
