// Reality Engine · services/slots — the slot filler (ALL OUR OWN CODE).
//
// THE INVERSION THIS EXISTS FOR. Most modes used to gate their value behind a
// phone-shaped form: Football wanted down, distance, field zone and both teams
// before it would say anything. On glasses that is useless — you'd have to pull
// out your phone before the glasses could help you.
//
// So modes stop asking for input and start declaring WHAT THEY NEED TO KNOW.
// This service resolves those declarations in one fixed order:
//
//   1. THE UTTERANCE   — "guide me through fixing the sink" already contains the
//                        pack; "coach my shot" the movement; "translate this into
//                        Spanish" the language. Parse before asking.
//   2. VISION          — if the mode names a vision source, LOOK BEFORE ASKING.
//                        The football scoreboard and the baseball graphic already
//                        carry the teams, the down, the distance and the count.
//                        This is the "it sees what you see" part and it is the
//                        whole point of the exercise.
//   3. CONTEXT         — last used, current session, a sensible default.
//   4. ASK             — last resort. ONE short spoken question, one slot at a
//                        time, accepting a spoken answer. Never a form.
//
// THE RULE THAT MATTERS MOST: never ask for anything it could infer. With a
// readable scoreboard it must not ask the down. Asking a question the camera
// already answered is the failure this whole layer exists to prevent, so the
// resolver cannot ask before vision has had its turn — the order is structural,
// not a policy a mode could get wrong.
//
// REGISTRY-DRIVEN, like the capability router: this file knows nothing about any
// specific mode. Everything comes from what a slot declares. Adding a future mode
// means writing a describeSlots() — never touching this file.

// ---------------------------------------------------------------- the contract
// A slot, as returned from a mode's describeSlots():
//
//   {
//     id: 'down',                       // unique within the mode
//     label: 'down',                    // human, used in spoken lines
//     required: true,                   // false → never blocks; see below
//     sources: ['vision','utterance','context'],   // ORDERED; tried in this order
//     visionSource: 'scoreboard',       // which existing path: scoreboard|ocr|look
//     ask: 'What down is it?',          // SHORT — this gets spoken aloud
//     parse: (spoken) => value | null,  // parse a spoken answer OR the utterance
//     fromVision: (payload) => value | null,   // pull this slot out of a vision read
//     fromContext: () => value | null,  // last used / session / current state
//     default: value,                   // used only after everything else fails
//     current: () => value | null,      // already known? then skip entirely
//     apply: (value) => void,           // write it into the mode
//     say: (value) => 'short line',     // how to state it aloud when assumed
//   }
//
// Only `id` and `apply` are truly required. Everything else is optional, and a
// slot with no `ask` simply never asks.
//
// `parse` does double duty on purpose: the thing that understands "into Spanish"
// in a sentence is the same thing that understands "Spanish" as an answer to
// "into what language?". One parser per slot, two jobs, no drift between them.

const MAX_ASK_RETRIES = 1;   // one re-ask on an unparseable answer, then move on

// Vision payloads are shared: several slots usually declare the SAME source
// (Football's teams, down, distance and zone all come off one scoreboard), and
// taking four photographs to answer one question would be absurd. Each source is
// read at most once per fill and the payload is handed to every slot that wants it.
async function readVisionSources(slots, ctx, log) {
  const needed = [...new Set(
    slots.filter((s) => wants(s, "vision") && s.visionSource).map((s) => s.visionSource))];
  const payloads = {};
  for (const source of needed) {
    if (typeof ctx.vision !== "function") { log.push({ stage: "vision", source, skipped: "no vision provider" }); continue; }
    try {
      const t0 = Date.now();
      const p = await ctx.vision(source);
      payloads[source] = p;
      log.push({ stage: "vision", source, ok: !!p, ms: Date.now() - t0 });
    } catch (err) {
      payloads[source] = null;
      log.push({ stage: "vision", source, ok: false, error: (err && err.message) || String(err) });
    }
  }
  return payloads;
}

function wants(slot, source) {
  const list = Array.isArray(slot.sources) ? slot.sources : [];
  return list.includes(source);
}
function has(value) {
  return value !== null && value !== undefined && value !== "" &&
    !(Array.isArray(value) && !value.length);
}
function tryParse(slot, text) {
  if (!text || typeof slot.parse !== "function") return null;
  try {
    const v = slot.parse(String(text));
    return has(v) ? v : null;
  } catch (err) {
    console.warn(`slots: parse threw for "${slot.id}" —`, err && err.message);
    return null;
  }
}

// ---------------------------------------------------------------- the resolver
//
// Returns { filled, missing, assumed, asked, log, ok }:
//   filled  — { slotId: { value, source } } for everything resolved
//   missing — REQUIRED slots still unresolved (the caller decides what to do)
//   assumed — optional slots that fell back to a default (stated aloud)
//   asked   — slot ids that cost the user a question
//
// The caller passes ctx:
//   { utterance, speak(text)->Promise, listen()->Promise<string>, vision(src)->Promise,
//     canAsk }
export async function fill(slots, ctx = {}) {
  const list = (Array.isArray(slots) ? slots : []).filter((s) => s && s.id && typeof s.apply === "function");
  const log = [];
  const filled = {}, assumed = [], asked = [];
  const utterance = String(ctx.utterance || "");

  const set = (slot, value, source) => {
    try { slot.apply(value); } catch (err) {
      console.warn(`slots: apply threw for "${slot.id}" —`, err && err.message);
      return false;
    }
    filled[slot.id] = { value, source };
    log.push({ stage: "filled", slot: slot.id, source, value: describe(value) });
    return true;
  };

  // ---- pass 0: already known. A slot the mode can already answer is not a
  // question, and re-deriving it would let vision overwrite something the user
  // just said.
  let pending = [];
  for (const s of list) {
    const cur = typeof s.current === "function" ? safe(s.current) : null;
    if (has(cur)) {
      filled[s.id] = { value: cur, source: "already-set" };
      log.push({ stage: "already-set", slot: s.id, value: describe(cur) });
    } else pending.push(s);
  }

  // ---- pass 1: the utterance. Free, instant, and the most likely to be right,
  // because the user just told us.
  pending = pending.filter((s) => {
    if (!wants(s, "utterance")) return true;
    const v = tryParse(s, utterance);
    if (v === null) return true;
    return !set(s, v, "utterance");
  });

  // ---- pass 2: VISION, before any question. One read per source, shared out.
  if (pending.some((s) => wants(s, "vision"))) {
    const payloads = await readVisionSources(pending, ctx, log);
    pending = pending.filter((s) => {
      if (!wants(s, "vision") || !s.visionSource) return true;
      const payload = payloads[s.visionSource];
      if (!payload) return true;
      let v = null;
      if (typeof s.fromVision === "function") { try { v = s.fromVision(payload); } catch (e) { v = null; } }
      if (!has(v)) return true;
      return !set(s, v, "vision");
    });
  }

  // ---- pass 3: context / last used.
  pending = pending.filter((s) => {
    if (!wants(s, "context")) return true;
    const v = typeof s.fromContext === "function" ? safe(s.fromContext) : null;
    if (!has(v)) return true;
    return !set(s, v, "context");
  });

  // ---- pass 4: ask. ONE short spoken question at a time, and only now.
  const stillPending = [];
  for (const s of pending) {
    // Optional slots NEVER cost a question and NEVER block: take the default and
    // say so out loud, so a stated assumption is always audible rather than
    // silently wrong.
    if (!s.required) {
      if (has(s.default)) {
        if (set(s, s.default, "default")) assumed.push(s.id);
      } else {
        log.push({ stage: "skipped-optional", slot: s.id });
      }
      continue;
    }
    if (!s.ask || ctx.canAsk === false || typeof ctx.listen !== "function") {
      // Can't ask (no question declared, or no voice available). A required slot
      // with a default still proceeds rather than dead-ending.
      if (has(s.default)) { if (set(s, s.default, "default")) assumed.push(s.id); }
      else { stillPending.push(s); log.push({ stage: "cannot-ask", slot: s.id }); }
      continue;
    }

    let got = null;
    for (let attempt = 0; attempt <= MAX_ASK_RETRIES && got === null; attempt++) {
      const question = attempt === 0 ? s.ask : (s.reask || s.ask);
      log.push({ stage: "ask", slot: s.id, question, attempt });
      asked.push(s.id);
      if (typeof ctx.speak === "function") await ctx.speak(question);
      let answer = "";
      try { answer = await ctx.listen(); } catch (err) { answer = ""; }
      log.push({ stage: "heard", slot: s.id, answer: String(answer || "").slice(0, 80) });
      if (!answer) break;                     // silence: stop pestering
      got = tryParse(s, answer);
      if (got === null) log.push({ stage: "unparsed", slot: s.id, answer: String(answer).slice(0, 80) });
    }
    if (got !== null) set(s, got, "asked");
    else if (has(s.default)) { if (set(s, s.default, "default")) assumed.push(s.id); }
    else stillPending.push(s);
  }

  // ---- state the assumptions aloud, in ONE short line (glasses copy, not a list).
  if (assumed.length && typeof ctx.speak === "function") {
    const lines = assumed
      .map((id) => {
        const s = list.find((x) => x.id === id);
        const v = filled[id] && filled[id].value;
        return s && typeof s.say === "function" ? safe(() => s.say(v)) : null;
      })
      .filter(Boolean);
    if (lines.length) await ctx.speak(assumptionLine(lines));
  }

  return {
    ok: stillPending.length === 0,
    filled,
    missing: stillPending.map((s) => ({ id: s.id, label: s.label || s.id })),
    assumed, asked, log,
  };
}

// "Assuming first and ten." / "Assuming first and ten, own side." — one line,
// however many assumptions there were.
function assumptionLine(lines) {
  const parts = lines.map((l) => String(l).replace(/\.$/, ""));
  return "Assuming " + parts.join(", ") + ".";
}

// ---------------------------------------------------------------- correction
//
// "No, the Chiefs are on offense."
//
// A spoken correction must re-fill THAT SLOT ONLY and continue — not restart the
// flow, not re-ask everything, not lose the four things already established.
// Without this, voice never feels usable: one wrong read and you'd start over.
//
// Every slot's own `parse` is tried against the correction. A slot only changes
// when its parser recognises something AND the value is actually different, so
// "no, the Chiefs are on offense" can't accidentally re-set the down as well.
export async function correct(slots, utterance, ctx = {}) {
  const list = (Array.isArray(slots) ? slots : []).filter((s) => s && s.id && typeof s.apply === "function");
  const text = String(utterance || "");
  if (!text) return { changed: null };

  // A correction is usually marked ("no…", "actually…", "I said…"), but it does
  // not have to be — "the Chiefs are on offense" mid-flow is a correction too.
  const marked = /^\s*(no|nope|not|actually|wait|i said|i meant|correction|change|make (it|that))\b/i.test(text);

  const candidates = [];
  for (const s of list) {
    const v = tryParse(s, text);
    if (v === null) continue;
    const cur = typeof s.current === "function" ? safe(s.current) : null;
    const same = has(cur) && sameValue(cur, v);
    candidates.push({ slot: s, value: v, same });
  }
  // Prefer a slot whose value actually CHANGES — that's what a correction is.
  const pick = candidates.find((c) => !c.same) || (marked ? candidates[0] : null);
  if (!pick) return { changed: null, marked, considered: candidates.map((c) => c.slot.id) };

  try { pick.slot.apply(pick.value); } catch (err) {
    return { changed: null, error: (err && err.message) || String(err) };
  }
  const line = typeof pick.slot.say === "function"
    ? safe(() => pick.slot.say(pick.value)) || `${pick.slot.label || pick.slot.id} updated`
    : `${pick.slot.label || pick.slot.id} updated`;
  const spoken = `Got it — ${String(line).replace(/^Assuming /i, "").replace(/\.$/, "")}.`;
  if (typeof ctx.speak === "function") await ctx.speak(spoken);
  return {
    changed: pick.slot.id, value: pick.value, text: spoken, marked,
    // Everything NOT touched — the proof that a correction is surgical.
    untouched: list.filter((s) => s.id !== pick.slot.id).map((s) => s.id),
  };
}

// ---------------------------------------------------------------- helpers
function safe(fn) { try { return fn(); } catch (e) { return null; } }
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function describe(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 60);
}

// What a mode declared, for the Diagnostics/verification surface.
export function summarize(slots) {
  return (Array.isArray(slots) ? slots : []).map((s) => ({
    id: s.id, label: s.label || s.id, required: !!s.required,
    sources: Array.isArray(s.sources) ? s.sources.slice() : [],
    visionSource: s.visionSource || null,
    asks: !!s.ask, hasDefault: has(s.default),
    canParse: typeof s.parse === "function",
  }));
}

export default { fill, correct, summarize };
