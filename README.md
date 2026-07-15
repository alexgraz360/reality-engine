# Reality Engine

**One open engine, many modes** — see, measure, and understand the world with the
sensors you carry. Phone-first now, glasses-ready (Brilliant Labs Halo) by design.
Fully open source, no build step, no frameworks, no CDN, no secrets.

**Live:** https://alexgraz360.github.io/reality-engine/

## What it is

A shell (launcher) + shared services + swappable **modes**:

- 🪀 **Pendulum** — the first fully native mode: measures a pendulum's period from the
  gyroscope and computes g in real units.
- 🔭 **Astronomy** / ⚗️ **Physics** — the existing live apps, linked from the home
  screen while they migrate in gradually (their repos are untouched).
- ✦ **AI Companion, 🏀 Basketball Coach, 🎭 Emotion, 🌐 Translation, 🧭 Navigation** —
  coming soon; each will be one module implementing the mode API.

## Architecture

```
index.html + app.js      the SHELL: home cards, mode registry, lifecycle, settings/about
services/
  sensors.js             ONE permission-gated sensor pipeline (camera/mic/motion/GPS,
                         iOS gesture handling in one place)
  overlay.js             HUD / canvas helpers
  storage.js             namespaced local persistence
  companion.js           the AI companion seam (stub — no LLM/keys yet)
  glassesAdapter.js      the Halo glasses attach point (stub)
modes/
  pendulum.js            the reference native mode
```

- **[MODES.md](MODES.md)** — the mode plug-in API (how to add a mode).
- **[GLASSES.md](GLASSES.md)** — the two glasses attach points + Halo config checklist.

## Principles

- **One mode active at a time** — open loads it on demand, Home tears it down fully.
- **ES modules + relative imports** — serve the folder statically and it runs;
  GitHub Pages is the whole deployment story.
- **Installable PWA** — Add to Home Screen on iPhone for an app-like launch.
- **`getContext()` everywhere** — every mode reports what the user is doing in one
  plain sentence; that's the seam that will make the AI companion smart across modes.

## Run locally

Any static server, e.g. `python -m http.server` in the repo root, then open
`http://localhost:8000`. Sensor modes want a real phone (HTTPS or localhost).
