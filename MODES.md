# Reality Engine — the Mode Plug-in API

A **mode** is a self-contained plug-in the shell loads on demand (astronomy, physics,
coaching, translation…). Adding a mode to the engine = **one file in `modes/` + one
entry in the `REGISTRY` in `app.js`**. Nothing else changes.

## The interface

Every native mode is an ES module that **default-exports** this object:

```js
export default {
  // ---- identity ----
  id: "pendulum",                 // unique, kebab/lowercase
  title: "Pendulum · period & g", // shown on the card + mode bar
  icon: "🪀",                     // emoji (keeps us dependency-free)
  family: "Physics",              // "Astronomy" | "Physics" | "Assistant" | "Coaching" | "Perception"

  // ---- what it needs ----
  permissions: ["motion"],        // any of: "camera" "mic" "motion" "orientation" "geolocation"

  // ---- lifecycle (called by the shell, in this order) ----
  async init(ctx) {},             // build your DOM under ctx.root; wire ctx.services
  async start() {},               // begin sensor/render work (ALSO called on tab-visible resume)
  stop() {},                      // pause all work (tab hidden, or right before teardown)
  teardown() {},                  // release EVERYTHING — streams, listeners, GPU, timers

  // ---- the forward-looking hook ----
  getContext() { return ""; },    // short natural-language string of what the user is
                                  // doing/seeing right now — the AI companion reads this

  // ---- OPTIONAL: voice/typed command hook ----
  handleCommand(text) {},         // the shell offers every companion input here first;
                                  // return a string (or Promise<string>) to handle it
                                  // locally — it is shown/spoken through the normal
                                  // path — or null to let the model answer instead

  // ---- OPTIONAL: prime fall-through companion answers ----
  getSystemContext() {},          // return an extra system-prompt string and the shell
                                  // passes it to companion.ask as opts.systemExtra, so
                                  // model answers WHILE THIS MODE IS ACTIVE are primed
                                  // (e.g. an analyst persona). Additive; modes without
                                  // it are unaffected.
};
```

## The `ctx` object

`init(ctx)` receives:

| field | what it is |
|---|---|
| `ctx.root` | the DOM element your mode owns; cleared by the shell after `teardown()` |
| `ctx.services.sensors` | permission-gated camera / mic / motion / orientation / GPS (iOS gesture handling included) |
| `ctx.services.overlay` | HUD/canvas helpers (`createCanvas`, `fit2d`, `cssVar`) |
| `ctx.services.storage` | namespaced local persistence — use `storage.scope(yourId)` |
| `ctx.services.companion` | the AI companion — `ask(prompt, context)` answers via the user's own local-model bridge if configured in Settings (see `services/companion.js` and `GLASSES.md`); also `vision(imageBase64, prompt)` |
| `ctx.services.actions` | local notes & reminders (`addReminder` powers mode timers — they fire via the shell's existing ticker) |
| `ctx.services.speak(text)` | speak through the shell's voice path (Piper or system, honors the Speak toggle) |

Always get sensors through `ctx.services.sensors`, never raw browser APIs: the service
owns iOS's user-gesture permission dance, fans events out, and lets the shell
force-release everything as a teardown safety net.

## Lifecycle rules

1. **One mode active at a time.** The shell enforces it; design for full ownership of
   the screen and sensors while active.
2. `start()` / `stop()` may be called **repeatedly** (the shell pauses you on
   `visibilitychange` and resumes on return). They must be idempotent.
3. `teardown()` must leave nothing running: no listeners, no `requestAnimationFrame`,
   no timers, no media streams. The shell additionally calls `sensors.releaseAll()`
   after teardown, but do not rely on that — clean up your own mess.
4. **Permission requests must come from a user gesture** (iOS). Ship a gate panel with
   an "Enable …" button and call `sensors.request*()` from its click handler
   (see `modes/pendulum.js` for the pattern).

## `getContext()` — why it matters

This one method is what will make the AI companion smart across every mode. When the
user talks to the companion, the shell sends the active mode's `getContext()` string
along with the prompt, so the answer is grounded in what they're actually doing.

Guidelines:
- One short sentence, plain language, present tense, **real values** when you have them:
  `"Measuring a pendulum: period T ≈ 1.42 s, computed g ≈ 9.79 m/s² with length 0.50 m (reading locked)."`
- Update it as state changes — it's called at ask-time, so just derive from live state.
- Return `""` if there is genuinely nothing meaningful to report.
- Never include secrets or raw sensor dumps — it's a human-readable sentence.

Try it today: open any mode and tap the **✦** button in the mode bar — the (stub)
companion sheet shows exactly what your mode is reporting.

## Registry entry

```js
{
  id: "mymode", title: "My Mode", family: "Perception", icon: "🌐",
  permissions: ["camera"],
  blurb: "One line shown on the home card.",
  load: () => import("./modes/mymode.js"),   // native mode, lazy-loaded
}
```

Two other entry flavors need **no module**:
- `{ ..., url: "https://…", external: true }` — links a live external app in a new tab
  (used for astronomy/physics during the gradual migration).
- `{ ..., soon: true }` — a greyed "coming soon" card.

## Football tendency providers (a mode-local data seam)

Football mode grounds its reads in real numbers through a small **provider seam**
in [`services/footballData.js`](services/footballData.js), designed so a second
data source can be added later without touching the mode.

A provider implements:

```js
{
  id, label,
  async ready(),                        // load once; return true if usable
  teams(): string[],                    // team codes it knows
  lookup(team, { down, distance, zone }) // raw tendency rows, or null
}
```

`PROVIDERS` is an ordered list. `footballData.getTendencies(team, situation)` calls
each provider and **overlays** later results onto earlier ones, so a future
provider (e.g. Alex's own analytics pages) can add or override fields without the
mode changing. Today there is one provider: the vendored **nflverse** public
dataset (`data/football/tendencies.json` + `league.json`), built offline and
committed as compact aggregates only. The mode reads tendencies synchronously
after `footballData.ready()` resolves in `init()`, injects them into the analyst
prompt via `getSystemContext()`, and shows a couple of raw numbers on the card.
To add the second provider: append it to `PROVIDERS`; nothing else changes.

## Reference implementation

[`modes/pendulum.js`](modes/pendulum.js) exercises the whole surface: gesture-gated
DeviceMotion via the sensors service, a canvas graph via the overlay service, persisted
settings via storage, idempotent start/stop, full teardown, and a live `getContext()`.
