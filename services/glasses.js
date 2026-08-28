// Reality Engine · services/glasses — the glasses adapter (ALL OUR OWN CODE).
//
// Bridges the app to a heads-up display like the Brilliant Labs Halo BEFORE the
// hardware exists. Nothing here is copied from any third-party project; it is
// built from public hardware facts and one design idea:
//
//   PUBLIC HARDWARE FACTS this is shaped around
//       (CORRECTED 2026-08-10 against docs.brilliant.xyz — see HANDOFF_RE_TECH_SWEEP.md)
//     • The HUD is a 256x256 drawable area on a 640x480 OLEDoS panel (safe radius
//       ~112). Light-on-black: black is not drawn, so we design for short bright
//       text on black, never dense UI.
//     • It is FULL RGB, not monochrome. Draw calls take 0xRRGGBB directly. The
//       16-entry named palette (VOID / WHITE / GREY / RED / ... / CLOUDBLUE) is for
//       INDEXED BITMAPS, not for the display as a whole — mapping a colour onto a
//       palette slot is a transport-layer concern, not part of this contract.
//     • "Circular" is STILL single-sourced after reading the firmware. The Lua API
//       page says "256x256 (round)"; the hardware manual never states a shape; and
//       the firmware treats the panel as a SQUARE framebuffer — boards/arm/halo/
//       halo.dts sets width=256 height=256 rgb-888 with the window at (0,0)-(256,
//       256), and there is no mask, vignette or circular clip anywhere in
//       modules/canvas/ or lua_display.c. Whether the OPTICS present a round
//       aperture is a physical question source cannot answer. Corner behaviour
//       remains undocumented, so the safe radius stays conservative until the
//       device pass confirms it. (canvas.h storing 3 bytes/pixel does independently
//       re-confirm FULL RGB above.)
//     • The BLE link is low-bandwidth. A tiny TEXT CARD is effectively free to
//       send. A camera SNAPSHOT is a deliberate one-per-look event (our existing
//       /vision "look" flow already matches).
//       ⚠️ CORRECTED 2026-08-24 FROM FIRMWARE SOURCE (v0.8.x). This line used to
//       read "there is NO live video", which overstated a true thing. Accurately:
//       the Lua API gives a script capture -> poll -> read JPEG in chunks, and no
//       video streaming path. A dedicated video characteristic (7A230004) IS
//       declared in the GATT table and its transport function IS implemented —
//       but it has ZERO callers in firmware, and the primary protocol spec never
//       mentions it. So it is unavailable to a Lua app, NOT impossible on the
//       wire. Brilliant staff say low-FPS streaming is achievable with custom
//       development, and NOBODY HAS PUBLISHED A FRAMERATE. Do not design around
//       it until measured. See HALO_INTEGRATION_NOTES.md §0 and §2.
//     • Therefore a mode CANNOT ship its phone screen to the glasses. It emits
//       one short glanceable card plus an optional spoken line.
//
//   DESIGN IDEA (ours to implement)
//     • A card is PLAIN DATA, never anything executable, and every safety limit
//       is enforced HERE on the device — a misbehaving mode cannot flash the
//       display, overflow it, or smuggle non-text through.
//
// ----------------------------------------------------------------------------
// The GlanceCard contract (plain data):
//   {
//     title:    string    // headline, clamped to <= TITLE_MAX chars
//     lines:    string[]  // body, <= MAX_LINES entries, each <= LINE_MAX chars
//     spoken?:  string    // sentence to say aloud (may differ from the text)
//     holdMs?:  number    // min time to keep it up; clamped to [MIN_HOLD, MAX_HOLD]
//     priority?:'normal' | 'alert'   // 'alert' preempts the min-hold/rate cap
//     color?:   string    // '#rrggbb' accent for the whole card; null = renderer's choice
//   }
// Anything else on the object is dropped. Non-string title/lines are rejected.
//
// WHY color IS ONE FIELD AND NOT PER-LINE: lines are strings, and that is the
// safety promise — a mode cannot smuggle a non-string through. Per-line colour
// would make lines objects and break it for every existing caller. One accent per
// card covers the real use ("COOLANT · don't drive" in red) at no cost to that.
//
// WHY HEX AND NOT PALETTE NAMES: 0xRRGGBB is confirmed in the official Lua API.
// The full 16 palette slot names are only partially documented publicly, so this
// contract refuses to guess at them; the transport maps hex -> slot when it needs to.
// ----------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  TITLE_MAX: 20,     // headline chars
  LINE_MAX: 24,      // per body line chars
  MAX_LINES: 4,      // body lines
  SPOKEN_MAX: 220,   // spoken sentence chars
  MIN_HOLD: 500,     // a card is visible at least this long (anti-flash)
  MAX_HOLD: 30000,   // and at most this long
  DEFAULT_HOLD: 5000,
  MIN_GAP: 500,      // >= this between rendered cards (rate cap)
});

// A card colour must be a literal #rrggbb. Anything else (a name, a CSS colour,
// a function, an object) is DROPPED with a note and the default is used — same
// discipline as every other field: never coerce, never guess.
const HEX_RE = /^#[0-9a-f]{6}$/i;

const subscribers = new Set();   // preview / future renderers
let current = null;              // last card actually rendered
let lastRenderAt = 0;
let pendingCard = null;          // latest card waiting out the rate cap
let pendingTimer = 0;
let clampLog = [];               // recent clamp/reject notes (for debug + tests)

function note(msg) {
  clampLog.push({ t: nowMs(), msg });
  if (clampLog.length > 50) clampLog = clampLog.slice(-50);
  console.warn("glasses:", msg);
}
// Date.now via a wrapper so tests can read it back; real time in the app.
function nowMs() { return Date.now(); }

function clampStr(v, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Validate + CLAMP a partial card into a safe GlanceCard, or return null if it
// cannot be made into text at all. This is the single choke point: send() never
// renders anything that didn't pass through here.
export function makeCard(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    note("rejected non-object card"); return null;
  }
  const title = clampStr(input.title, LIMITS.TITLE_MAX);
  if (title === null) { note("rejected card with non-string title"); return null; }
  if (title !== (typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : input.title)) {
    note(`clamped title to ${LIMITS.TITLE_MAX} chars`);
  }

  let lines = [];
  if (input.lines != null) {
    if (!Array.isArray(input.lines)) { note("dropped non-array lines"); }
    else {
      const raw = input.lines;
      for (const l of raw) {
        // TEXT ONLY: anything that isn't a string (object, function, number,
        // nested array) is refused, never coerced — that's the safety promise.
        if (typeof l !== "string") { note("dropped non-string line"); continue; }
        const c = clampStr(l, LIMITS.LINE_MAX);
        if (c) lines.push(c);
        if (lines.length >= LIMITS.MAX_LINES) break;
      }
      if (raw.length > LIMITS.MAX_LINES) note(`clamped ${raw.length} lines to ${LIMITS.MAX_LINES}`);
    }
  }
  if (!title && !lines.length) { note("rejected empty card (no title, no lines)"); return null; }

  let spoken;
  if (input.spoken != null) {
    if (typeof input.spoken !== "string") note("dropped non-string spoken");
    else {
      spoken = input.spoken.replace(/\s+/g, " ").trim();
      if (spoken.length > LIMITS.SPOKEN_MAX) { spoken = spoken.slice(0, LIMITS.SPOKEN_MAX - 1) + "…"; note("clamped spoken text"); }
    }
  }

  let holdMs = LIMITS.DEFAULT_HOLD;
  if (input.holdMs != null) {
    const h = Number(input.holdMs);
    if (!isFinite(h)) note("ignored non-numeric holdMs");
    else {
      holdMs = Math.max(LIMITS.MIN_HOLD, Math.min(LIMITS.MAX_HOLD, h));
      if (holdMs !== h) note(`clamped holdMs ${h} -> ${holdMs}`);
    }
  }

  const priority = input.priority === "alert" ? "alert" : "normal";

  // null means "the renderer picks" — NOT a colour. That keeps every existing
  // caller byte-identical: a card that never mentions colour renders exactly as
  // it did before this field existed.
  let color = null;
  if (input.color != null) {
    if (typeof input.color !== "string") note("dropped non-string color");
    else if (!HEX_RE.test(input.color.trim())) note(`dropped invalid color ${JSON.stringify(input.color)} (want #rrggbb)`);
    else color = input.color.trim().toLowerCase();
  }

  // A fresh, frozen object — no reference to caller state, nothing executable.
  return Object.freeze({ title, lines: Object.freeze(lines), spoken, holdMs, priority,
    color,
    dismissible: true });   // every card is always dismissible on the device
}

function render(card) {
  current = card;
  lastRenderAt = nowMs();
  for (const fn of subscribers) { try { fn(card); } catch (e) { console.error("glasses subscriber threw:", e); } }
}

// Send a card to the glasses (today: the preview; tomorrow: BLE — see the seam
// at the bottom). Clamps first; then enforces the rate cap so a chatty mode
// can't strobe the display. 'alert' cards preempt immediately.
export function send(input) {
  const card = makeCard(input);
  if (!card) return null;

  if (card.priority === "alert") {
    clearTimeout(pendingTimer); pendingCard = null;
    render(card);
    return card;
  }
  const since = nowMs() - lastRenderAt;
  if (since >= LIMITS.MIN_GAP) {
    clearTimeout(pendingTimer); pendingCard = null;
    render(card);
  } else {
    // Too soon — hold the LATEST card and flush it once the gap has elapsed, so
    // rapid updates collapse to one render instead of flashing.
    pendingCard = card;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = 0;
      if (pendingCard) { const c = pendingCard; pendingCard = null; render(c); }
    }, LIMITS.MIN_GAP - since);
  }
  return card;
}

// The preview (and any future renderer) subscribes here.
export function subscribe(fn) { subscribers.add(fn); if (current) { try { fn(current); } catch (e) {} } return () => subscribers.delete(fn); }
export function currentCard() { return current; }
export function clear() { clearTimeout(pendingTimer); pendingCard = null; current = null; render(null); }
export function _clampLog() { return clampLog.slice(); }

// Greedy word-wrap into <= maxLines lines of <= width chars, for callers that
// have a sentence to show rather than pre-shaped short lines. The last line is
// ellipsised when the text overflows — the full text should live in `spoken`.
export function wrap(text, width = LIMITS.LINE_MAX, maxLines = LIMITS.MAX_LINES) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= width) { cur = next; continue; }
    if (cur) lines.push(cur);
    if (lines.length >= maxLines) { cur = ""; break; }
    cur = w.length <= width ? w : w.slice(0, width - 1) + "…";
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const shown = lines.join(" ").replace(/…/g, "").split(/\s+/).filter(Boolean).length;
  if (shown < words.length && lines.length) {
    const i = lines.length - 1, last = lines[i];
    if (!last.endsWith("…")) lines[i] = (last.length >= width ? last.slice(0, width - 1) : last) + "…";
  }
  return lines;
}

// ---------------------------------------------------------------------------
// BLE TRANSPORT SEAM — intentionally EMPTY until the Halo is in hand.
//
// When the hardware arrives we implement OUR OWN Web Bluetooth client here:
// request the device, discover its GATT service, and write each rendered card
// as a short framed text payload. `send()` already produced a clamped, text-
// only card, so the transport only has to serialise + write it.
//
//   BUDGET DISCIPLINE (why the contract is shaped the way it is):
//     • A card is a few dozen bytes of text — effectively free to push; that is
//       why cards, not screens, are the unit.
//     • Camera SNAPSHOTS are on-demand only (the /vision "look" gesture), one
//       frame per deliberate look — never a stream.
//     • Do NOT attempt live video or continuous raw-audio streaming here — but
//       for the accurate reason, not the old one. It is not that "the link can't
//       carry it": that claim was too strong. It is that no firmware producer
//       exists for the video characteristic, the achievable framerate is
//       unmeasured, and continuous streaming would drain the device. Voice stays
//       on the phone; the glasses get text + the occasional snapshot request.
//       Revisit only with a measured number in hand.
//
// To wire it later: call setTransport(fn). `fn(card)` receives every rendered
// card (in addition to the preview) and does the BLE write. Left null today.
// ---------------------------------------------------------------------------
let bleTransport = null;
export function setTransport(fn) {
  bleTransport = typeof fn === "function" ? fn : null;
  // Mirror renders to the transport when one is attached.
  if (bleTransport) subscribe((c) => { if (c && bleTransport) { try { bleTransport(c); } catch (e) { console.error("glasses BLE transport threw:", e); } } });
  return !!bleTransport;
}
export function hasTransport() { return !!bleTransport; }

export default { LIMITS, makeCard, send, subscribe, currentCard, clear, setTransport, hasTransport, wrap, _clampLog };
