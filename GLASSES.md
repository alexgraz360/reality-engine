# Reality Engine — Glasses Readiness (Halo)

The engine is **phone-first**; the glasses layer is **strictly additive**. Everything
below is designed so that when the Brilliant Labs **Halo** arrives, hooking it up is a
**configuration step, not a rebuild**. Two attach points are reserved in the code today.

## Attach point 1 — the AI Companion service (`services/companion.js`)

The Jarvis loop: **wake (tap / wake word) → capture mic + camera frame → send with the
active mode's `getContext()` to a multimodal model → answer by voice + overlay.**

What exists now (**Companion P0 — live**):
- `companion.ask(prompt, context)` — the stable seam every caller uses. It POSTs to a
  **personal bridge**: a token-gated, rate-limited proxy in front of a **local model**
  (Ollama) on the user's own machine, reached over HTTPS via a Tailscale Funnel.
  $0, private, nothing leaves the user's hardware. Text-first Q&A via the ✦ sheet.
- The endpoint URL + token are entered in **Settings → Companion** and stored in
  the device's localStorage only — **no secrets in this repo, ever**.
- Every mode implements `getContext()` (enforced by the mode API, see `MODES.md`), so
  answers are grounded in what the user is doing right now.
- Unconfigured devices get a friendly "not configured" message — the stub behavior.

Still future:
- Voice in/out (Web Speech STT/TTS — the planned fast-follow), camera frame capture
  via `services/sensors` for vision questions, streaming replies.
- Tools/actions (email, notes, APIs). **SAFETY (mandatory):** confirmation gates before
  any side-effectful action (send / post / delete / pay), scoped permissions. A misheard
  command must never auto-fire an irreversible action. P0 is deliberately Q&A only.

## Attach point 2 — the glasses adapter (`services/glassesAdapter.js`)

A stub with the final shape, so the Halo SDK bridge drops into one file:

| method | job when real |
|---|---|
| `connect()` / `disconnect()` | pair with Halo (BLE bonding, then the Lua service `7A230001-…`) |
| `mirrorHUD(hud)` | push the active mode's **glanceable** HUD to the glasses display (small declarative payload, not a video stream — Halo is monocular/glanceable by design) |
| `routeMic()` / `routeCamera()` | feed the glasses' mic + camera into `services/sensors`, so modes and the companion don't care whether input comes from the phone or the glasses |
| `onWake(fn)` | tap / wake-word hook that starts a companion interaction |

Because all modes already consume sensors through `services/sensors` and draw HUDs
through `services/overlay`, swapping the *source* (glasses mic/cam) and adding a
*second sink* (glasses display) never touches mode code.

## Configuring Halo — the checklist (for future-us)

1. **Unbox + firmware:** update Halo (MCUboot/SMP over BLE), then **settle the host
   question first — it is blocking.** ⚠️ **Web Bluetooth does not exist on iOS**, in
   Safari or in any other iOS browser, because Apple forces every one of them onto
   WebKit and WebKit lists it as "not considering". So "verify the WebBluetooth path
   works from Safari" — which this checklist used to say — is not a task, it is an
   impossibility. The candidate hosts are a third-party iOS browser that ships its own
   BLE stack (Bluefy / WebBLE), a Chromium browser on Android, or the bridge PC.
   See §7 of `REALITY_ENGINE_PLATFORM.md` and `HANDOFF_RE_TECH_SWEEP.md` PART 1.
2. **Pair:** implement `glassesAdapter.connect()` with the SDK handshake; confirm
   `isConnected()` flips true.
3. **Mirror the HUD:** define the small HUD payload (a few text lines + numbers, e.g.
   the pendulum's T and g), implement `mirrorHUD()`, verify glanceability outdoors.
4. **Route the mic:** implement `routeMic()` → `services/sensors`; test the companion
   loop end-to-end with the phone doing the thinking.
5. **Route the camera** (if/where Halo exposes it): implement `routeCamera()`.
6. **Map wake:** wire Halo's tap gesture / wake word to `onWake()` → companion.
7. **Battery pass:** confirm wake-on-demand (no always-on streaming), per the
   platform's battery doc.
8. **Device pass on iPhone + Halo together:** the PWA stays the brain; the glasses
   stay display + sense.

## PWA (already done)

The shell ships `manifest.webmanifest` + icons, so it installs to the iPhone home
screen (Share → Add to Home Screen) and launches standalone. A **service worker** for
full offline caching is intentionally deferred (it adds cache-invalidation complexity
while the shell iterates fast); the manifest is service-worker-ready when we want it.
