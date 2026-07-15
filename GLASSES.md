# Reality Engine — Glasses Readiness (Halo)

The engine is **phone-first**; the glasses layer is **strictly additive**. Everything
below is designed so that when the Brilliant Labs **Halo** arrives, hooking it up is a
**configuration step, not a rebuild**. Two attach points are reserved in the code today.

## Attach point 1 — the AI Companion service (`services/companion.js`)

The Jarvis loop: **wake (tap / wake word) → capture mic + camera frame → send with the
active mode's `getContext()` to a multimodal model → answer by voice + overlay.**

What exists now:
- `companion.ask(prompt, context)` — the stable seam every caller already uses. It
  currently returns a "not configured yet" placeholder; the shell's ✦ button
  demonstrates the full path (active mode → `getContext()` → companion → reply UI).
- Every mode implements `getContext()` (enforced by the mode API, see `MODES.md`), so
  the companion is situation-aware across all modes from day one.

What wiring it will involve (future handoff):
- A **tiny server-side proxy** to hold the LLM API key (Cloudflare Workers or similar —
  the key never ships in the client), or a local agent (OpenClaw) on the mini PC.
- Voice in/out (Web Speech or streaming), camera frame capture via `services/sensors`.
- **SAFETY (mandatory):** confirmation gates before any side-effectful action
  (send / post / delete / pay), scoped permissions, keys handled server-side only.
  A misheard command must never auto-fire an irreversible action.

## Attach point 2 — the glasses adapter (`services/glassesAdapter.js`)

A stub with the final shape, so the Halo SDK bridge drops into one file:

| method | job when real |
|---|---|
| `connect()` / `disconnect()` | pair with Halo (SDK handshake, likely BLE/WebBluetooth) |
| `mirrorHUD(hud)` | push the active mode's **glanceable** HUD to the glasses display (small declarative payload, not a video stream — Halo is monocular/glanceable by design) |
| `routeMic()` / `routeCamera()` | feed the glasses' mic + camera into `services/sensors`, so modes and the companion don't care whether input comes from the phone or the glasses |
| `onWake(fn)` | tap / wake-word hook that starts a companion interaction |

Because all modes already consume sensors through `services/sensors` and draw HUDs
through `services/overlay`, swapping the *source* (glasses mic/cam) and adding a
*second sink* (glasses display) never touches mode code.

## Configuring Halo — the checklist (for future-us)

1. **Unbox + firmware:** update Halo, install the Brilliant Labs SDK / verify the
   phone-side bridge app or WebBluetooth path works from Safari.
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
