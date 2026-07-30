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

  // ---- OPTIONAL: declare what this mode can be asked to do from anywhere ----
  describeCapabilities() {},      // return an array of capabilities for the voice
                                  // intent router (below). STATIC data — it is read
                                  // without the mode being open. Additive; modes
                                  // without it are simply never routed to.

  // ---- OPTIONAL: declare what this mode needs to KNOW before it can act ----
  describeSlots() {},             // return an array of slots (below). The shell fills
                                  // them from the utterance, then the camera, then
                                  // context, and only then asks — one short spoken
                                  // question at a time. Additive; modes without it
                                  // behave exactly as before.

  // ---- OPTIONAL: a glanceable card for a heads-up display ----
  getGlanceCard() {},             // return a GlanceCard (below) representing the mode's
                                  // current state, or null. The shell pulls this while the
                                  // Glasses preview is open. Additive; modes without it are
                                  // simply skipped. Do NOT change any other mode behaviour.
};
```

## GlanceCards & the glasses adapter

The Halo-class HUD is a small **circular additive display** (~256×256, safe
radius ~112) on a low-bandwidth BLE link: a short **text card** is effectively
free, there is **no live video**, and a camera snapshot is a deliberate
one-per-look event. So a mode cannot ship its phone screen to the glasses — it
emits one short **GlanceCard** (plain data) plus an optional spoken line.

```js
{
  title:    string,           // headline, clamped to <= 20 chars
  lines:    string[],         // body, <= 4 lines, each <= 24 chars
  spoken?:  string,           // sentence to say aloud (may differ from the text)
  holdMs?:  number,           // min visible time; clamped to [500, 30000]
  priority?:'normal'|'alert'  // 'alert' preempts the rate cap / min-hold
}
```

**The card is data, never anything executable.** Every limit is enforced by the
adapter ([`services/glasses.js`](services/glasses.js)) — `glasses.send(card)`
clamps title/line length, drops lines beyond four, **refuses non-string lines**
(no objects/functions/numbers coerced), enforces a minimum hold and a rate cap
so cards can't flash, marks every card dismissible, and **logs** what it clamped
rather than crashing. A mode therefore cannot misbehave on the glasses even if it
emits a malformed card.

`glasses.wrap(text, width, maxLines)` is provided for callers that have a
sentence to show rather than pre-shaped short lines (the companion answer and a
Guide step use it), so long text word-wraps across the lens instead of being
truncated to one line. The full text should still go in `spoken`.

**Transport seam:** `send()` renders to the Glasses preview today. When the Halo
is in hand we implement our own Web Bluetooth client behind `setTransport(fn)` —
`fn` receives each already-clamped card and does the BLE write. Budget discipline
is documented at that seam: cards are tiny/free, snapshots are on-demand only
(the `/vision` "look" flow), and live video / continuous raw audio are never
attempted over BLE.

**Glasses preview:** the 🕶️ toggle in the companion strip renders the live card
in a 256×256 circular safe area exactly as the Halo would — our develop-before-
hardware harness. It is labelled a simulation. Implemented today for the companion
(ask + look), actions (save confirmation + due-reminder `alert`), Guide (current
step), and Football + Baseball (instant read). Visual modes (Astronomy returns
null; Pendulum/Projectile return a simple numeric summary) — their 3D/camera views
are never shrunk.

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

## Baseball prediction providers (the same seam, one sport over)

Baseball mode answers "what's coming and what happens?" through the seam in
[`services/baseballData.js`](services/baseballData.js). It is built so **Alex's
own analytics site (`mithrandir-metrics`) becomes provider #2** — its predictive
models are sharper than public aggregates — **without touching the mode**.

A provider implements:

```js
{
  id, label,
  async ready(),                                     // load once; true if usable
  pitchers(): [{id, name}],  batters(): [{id, name}],
  predict(pitcherId, batterId, { balls, strikes }, situation)
    // -> { pitch:{code,name,share}, location:{cell,phrase,share}, locationGrid,
    //      outcome:{hit,walk,k,out,n,basis}, zoneRate, mix, fallbacks[] }  (partial is fine)
}
```

`PROVIDERS` is ordered and `getPrediction()` **overlays later results onto earlier
ones field-by-field**. That matters here: provider #2 can sharpen only the pitch
call and still inherit public outcome percentages and location for everything it
doesn't model. Verified: overlaying a stub `mithrandir` provider replaced the
pitch (slider 71%) while the location ("low and away") and outcome (K 49%,
`basis: batter`) were inherited from public data, with `sources: ["statcast",
"mithrandir"]`.

Provider #1 today is the vendored public **Statcast** dataset
(`data/baseball/{pitchers,batters,league}.json` — compact aggregates only, built
offline by a local script that is never committed). Thin cells are omitted at
build time; the provider then falls back to the league baseline and **labels it**
(`outcome.basis: "league"`, plus a `fallbacks` list the card and read surface).

**To add Alex's site as provider #2:** his data lives locally on his desktop, so
the provider should read it locally ($0/local, no cloud) — the repo is
`github.com/alexgraz360/mithrandir-metrics`, and whatever it exposes (saved model
files, generated CSV/JSON, a local DB, or a local read endpoint) gets wrapped in
the interface above and appended to `PROVIDERS`. Nothing else changes; it will be
preferred automatically and labelled as his model.

## The voice intent router & `describeCapabilities()`

Say anything, anywhere, and it reaches the right capability — switching modes for
you. Without this, a spoken request only reaches the mode you already opened,
which is unusable on glasses.

[`services/router.js`](services/router.js) knows **nothing about any specific
mode**. Every capability is registered, and matching is driven purely by what
each capability declares, so **adding a mode never requires editing the router**:

```js
describeCapabilities() {
  return [{
    id: "translate.read",          // unique
    label: "Translate",            // used when announcing a switch
    needsMode: true,               // router switches to this mode first
    sideEffect: false,             // true = writes/deletes (never routed on a guess)
    patterns: [/\bwhat does (this|that) say\b/i],   // decisive: a match scores 1.0
    examples: ["read this sign"],  // weaker keyword evidence, capped below 1.0
    run: (text, ctx) => "…",       // string | Promise | null to decline
  }];
}
```

`run()` may return `null` to **decline** after inspecting the text — the request
then falls through to the normal companion answer, which is exactly what
`memory.recall` does (global retrieval already handles it correctly, so routing
it elsewhere would risk regressing it). `ctx.callActiveCommand(text)` lets a
mode capability reuse its own `handleCommand` once the mode is active instead of
duplicating that parsing.

**Deterministic first, model last.** A declared pattern matches in microseconds
with **no model call** — the same discipline as the football instant read. The
local model is used only as a tightly-constrained fallback (it may return one
registered id or "none", validated against the registry) and **only on a
near-miss**: input with no capability overlap at all skips it entirely, so a
general question never pays for a classification round-trip. Every decision is
logged (`router.recentDecisions()`).

**Precedence is unchanged:** the active mode's `handleCommand` still wins first
(so "next" in Guide is still Guide's), then the router, then today's companion
answer. Anything the router doesn't claim behaves exactly as before — that is
the regression bar. Side-effectful routes still pass through the **same
confirmation gate**; the router changes how a request arrives, never whether
it's confirmed. If two readings are close and either writes something, the
router **asks one short question** instead of guessing.

## `describeSlots()` — voice & vision first, forms as fallback

Modes used to gate their value behind a phone-shaped form: Football wanted the
down, the distance, the field zone and both teams before it would say anything.
**On glasses that is useless** — you'd have to pull out your phone before the
glasses could help you. So a mode stops demanding input and instead **declares
what it needs to know**; [`services/slots.js`](services/slots.js) resolves it.

```js
describeSlots() {
  return [{
    id: 'down',                        // unique within the mode
    label: 'the down',                 // human; used in spoken lines
    required: true,                    // false → never blocks (see below)
    sources: ['utterance','vision','context'],  // ORDERED — tried in this order
    visionSource: 'scoreboard',        // 'scoreboard' | 'ocr' | 'look'
    ask: 'What down is it?',           // SHORT — this gets spoken aloud
    parse: (spoken) => value | null,   // parses the utterance AND a spoken answer
    fromVision: (payload) => value | null,
    fromContext: () => value | null,   // last used / session
    default: 1,                        // last resort, stated aloud
    current: () => value | null,       // already known? then skip entirely
    apply: (value) => { ... },         // write it into the mode
    say: (value) => '1st down',        // how it's stated when assumed
  }];
}
```

Only `id` and `apply` are truly required. A slot with no `ask` never asks.

### The resolution order IS the design

1. **The utterance.** "Guide me through fixing the sink" already contains the
   pack; "coach my shot" the movement; "translate this into Spanish" the
   language. Free, instant, and most likely right — the user just said it.
2. **Vision.** If the mode names a `visionSource`, **look before asking**. The
   football scoreboard and the baseball graphic already carry the teams, the
   down, the distance and the count.
3. **Context.** Last used, current session, a sensible default.
4. **Ask** — last resort, one short spoken question at a time, spoken answer
   accepted. Never a form.

**Never ask for anything it could infer.** With a readable scoreboard the mode
must not ask the down. This is enforced structurally, not by policy: the resolver
*cannot* reach its ask pass before vision has had its turn, so a mode can't get
this wrong by writing its slots in the wrong order.

`parse` does double duty on purpose — the thing that understands "into Spanish"
inside a sentence is the same thing that understands "Spanish" as an answer to
"into what language?". One parser, two jobs, no drift.

### Rules the filler enforces for you

- **One vision read per source.** Several slots usually declare the *same*
  source; the payload is fetched once and shared. Football does not take four
  photographs to answer one question.
- **Optional slots never block.** An unresolved optional slot takes its default
  and the assumption is **stated aloud** in one line ("Assuming first and ten").
- **Corrections are surgical.** `slots.correct()` re-fills **one** slot and
  continues — "no, the Chiefs are on offense" doesn't restart the flow or lose
  the four things already established. A slot only changes when its own parser
  claims the sentence *and* the value actually differs.
- **Gates are untouched.** Filling a slot by voice never bypasses a confirmation
  gate; a voice-filled side-effectful action still gates exactly as before.
- **Router precedence is untouched.** Slot filling happens *before* a capability
  runs; it changes what is known, never which capability wins.

### Opting in

Add `fillsSlots: true` to a capability in `describeCapabilities()`. The shell
fills that mode's slots before the capability runs. **That is the entire
integration** — a new mode declares slots and sets one flag, and never touches
the filler, exactly like the capability registry.

### Forms are the fallback, not the entry point

Every mode keeps its manual panel, but **collapsed and secondary** behind a
`▸ Set manually` expander. Typing must keep working everywhere — loud rooms,
privacy, and precision are all real.

## Reference implementation

[`modes/pendulum.js`](modes/pendulum.js) exercises the whole surface: gesture-gated
DeviceMotion via the sensors service, a canvas graph via the overlay service, persisted
settings via storage, idempotent start/stop, full teardown, and a live `getContext()`.
