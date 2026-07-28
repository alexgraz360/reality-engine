// Reality Engine · services/router — the voice intent router (ALL OUR OWN CODE).
//
// Say anything, anywhere, and it reaches the right capability — switching modes
// for you when needed. Today a spoken request only reaches the mode you already
// opened; on glasses that's unusable.
//
// TWO RULES SHAPE EVERYTHING HERE:
//
//  1. REGISTRY-DRIVEN. The router knows nothing about specific modes. Every
//     capability — global (remember, look, note) or mode-owned (translate,
//     football) — is REGISTERED, and matching is driven purely by what each
//     capability declares. Adding a future mode must never require editing this
//     file. Modes declare via the optional `describeCapabilities()` mode hook.
//
//  2. DETERMINISTIC FIRST, MODEL LAST. A clear command ("remember the passport
//     is in the drawer", "open astronomy") is matched by pattern in
//     microseconds with NO model call — the same discipline as the football
//     instant read. The local model is only a tightly-constrained fallback for
//     genuinely ambiguous input, and every decision logs which path it took.
//
// The regression bar: unmatched input falls through to exactly today's
// companion answer. The router may improve routing; it may never make the
// existing behaviour worse.

// Scores are 0..1. Tuned so a declared pattern is decisive, keyword overlap is
// suggestive, and anything weaker defers to the model or falls through.
const STRONG = 0.8;    // route immediately
const WEAK = 0.45;     // below this, deterministic matching has not really matched
const MARGIN = 0.15;   // two candidates closer than this are ambiguous
// The model fallback runs ONLY on a near-miss — input that looks like a command
// but didn't quite match. A question with no capability overlap at all ("how
// tall is Everest") goes straight to the companion exactly as it does today.
// Without this floor, every general question would pay for a classification
// round-trip first, which would be a real latency regression.
const MODEL_FLOOR = 0.25;

const capabilities = [];   // the whole registry
let decisionLog = [];

function log(entry) {
  decisionLog.push({ ...entry, t: Date.now() });
  if (decisionLog.length > 100) decisionLog = decisionLog.slice(-100);
  console.debug(`router: "${entry.text}" → ${entry.result} via ${entry.path}` +
    (entry.score != null ? ` (${entry.score.toFixed(2)})` : ""));
}

// A capability:
//   { id, label, modeId?, needsMode?, sideEffect?, patterns?[], examples?[],
//     run(text, ctx) -> string | Promise<string> | { text, handled } }
// `needsMode` means the router must switch to `modeId` before running.
// `sideEffect` marks anything that writes/deletes — those must never be
// routed on a weak guess (the app's confirmation gate is the second line).
export function register(cap) {
  if (!cap || !cap.id || typeof cap.run !== "function") {
    console.warn("router: ignoring malformed capability", cap);
    return false;
  }
  const i = capabilities.findIndex((c) => c.id === cap.id);
  const entry = {
    id: cap.id, label: cap.label || cap.id, modeId: cap.modeId || null,
    needsMode: !!cap.needsMode, sideEffect: !!cap.sideEffect,
    patterns: Array.isArray(cap.patterns) ? cap.patterns : [],
    examples: Array.isArray(cap.examples) ? cap.examples : [],
    run: cap.run,
  };
  if (i >= 0) capabilities[i] = entry; else capabilities.push(entry);
  return true;
}
export function unregister(id) {
  const i = capabilities.findIndex((c) => c.id === id);
  if (i >= 0) capabilities.splice(i, 1);
  return i >= 0;
}
export function list() {
  return capabilities.map((c) => ({ id: c.id, label: c.label, modeId: c.modeId,
    needsMode: c.needsMode, sideEffect: c.sideEffect, examples: c.examples.slice(0, 3) }));
}

// ---------------------------------------------------------------- matching
const STOP = new Set(["the", "a", "an", "to", "for", "me", "my", "is", "in", "on",
  "of", "it", "this", "that", "and", "please", "can", "you", "i", "do", "what",
  "at", "with", "about", "was", "are", "be"]);
function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
}
function contentWords(s) { return words(s).filter((w) => !STOP.has(w)); }

// Deterministic score for one capability against the text.
//   1.00  a declared pattern matched (a capability author's explicit claim)
//   ~0.5  strong keyword overlap with a declared example
function scoreCapability(cap, text) {
  for (const p of cap.patterns) {
    try {
      const hit = text.match(p);
      // `specificity` = how much of the utterance the pattern actually claimed.
      // Two capabilities can legitimately both match ("where's my …" for memory
      // recall vs "where's my car" for the navigator); the one that matched MORE
      // of the sentence is the more specific claim and should win, rather than
      // the result depending on registration order.
      if (hit) return { score: 1, why: "pattern", specificity: hit[0].length, pattern: String(p) };
    } catch (e) { /* a bad pattern must never break routing */ }
  }
  const tw = new Set(contentWords(text));
  if (!tw.size) return { score: 0, why: "empty" };
  let best = 0, bestEx = "";
  for (const ex of cap.examples) {
    const ew = contentWords(ex);
    if (!ew.length) continue;
    let hit = 0;
    for (const w of ew) if (tw.has(w)) hit++;
    // Fraction of the EXAMPLE's content words present in the utterance — asking
    // "how do the tides work" shouldn't match an example just because it's long.
    const frac = hit / ew.length;
    if (frac > best) { best = frac; bestEx = ex; }
  }
  // Cap keyword evidence below STRONG: only a declared pattern is decisive.
  return { score: Math.min(best * 0.75, 0.75), why: "keywords", example: bestEx };
}

// Rank every capability. Pure, synchronous, no model, no network.
export function rank(text) {
  return capabilities
    .map((cap) => ({ cap, specificity: 0, ...scoreCapability(cap, text) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.specificity - a.specificity));
}

// ---------------------------------------------------------------- decision
// Returns one of:
//   { action:'route',   cap, path, score }
//   { action:'clarify', question, options }
//   { action:'none' }                       → caller falls through to the companion
export function decide(text) {
  const ranked = rank(text);
  if (!ranked.length) return { action: "none", ranked };
  const top = ranked[0], second = ranked[1];
  // A clearly more specific pattern match settles it — that's a real signal,
  // not a coin flip, so it isn't ambiguity.
  const moreSpecific = second && top.specificity > second.specificity;
  const ambiguous = second && (top.score - second.score) < MARGIN && !moreSpecific;

  if (top.score >= STRONG && !ambiguous) {
    return { action: "route", cap: top.cap, path: "deterministic", score: top.score, why: top.why };
  }
  // Two plausible readings, and acting on the wrong one would write something:
  // ask ONE short question rather than guessing. ("remember that" vs "remind me")
  if (ambiguous && top.score >= WEAK && (top.cap.sideEffect || second.cap.sideEffect)) {
    return {
      action: "clarify",
      question: `Did you want me to ${top.cap.label.toLowerCase()}, or ${second.cap.label.toLowerCase()}?`,
      options: [top.cap.id, second.cap.id], score: top.score,
    };
  }
  if (top.score >= STRONG) {
    return { action: "route", cap: top.cap, path: "deterministic", score: top.score, why: top.why };
  }
  return { action: "none", ranked, weak: top.score };
}

// ---------------------------------------------------------------- model fallback
// Only for input the deterministic pass could not resolve. Tightly constrained:
// the model may return ONE registered id or "none", nothing else. Its answer is
// validated against the registry, so it can never invent a capability.
export async function classifyWithModel(text, ask) {
  if (typeof ask !== "function" || !capabilities.length) return null;
  const menu = capabilities
    .map((c) => `${c.id}: ${c.label}${c.examples.length ? ` (e.g. "${c.examples[0]}")` : ""}`)
    .join("\n");
  const prompt =
    "Classify the user's request into exactly ONE of these capability ids, or \"none\".\n" +
    "Reply with the id only — no punctuation, no explanation.\n\n" + menu +
    "\nnone: anything else, including general questions\n\nRequest: " + text;
  try {
    const res = await ask(prompt, "", [], { maxTokens: 12, temperature: 0, stable: true });
    if (!res || !res.ok || !res.text) return null;
    const id = String(res.text).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
    const cap = capabilities.find((c) => c.id.toLowerCase() === id);
    return cap || null;
  } catch (err) {
    console.warn("router: model classification failed —", err && err.message);
    return null;   // any failure = fall through to the normal answer
  }
}

// ---------------------------------------------------------------- the entry point
// ctx supplies everything the router must NOT own: how to switch modes, how to
// announce, and how to reach the model.
//   ctx = { activeModeId, switchTo(modeId), announce(text), ask, allowModel }
// Returns { handled:boolean, text?, cap?, path?, clarify?, switched? }.
export async function route(text, ctx = {}) {
  const q = String(text || "").trim();
  if (!q) return { handled: false };

  let d = decide(q);

  // Ambiguous → ask ONE question. Never fire a side-effectful action on a guess.
  if (d.action === "clarify") {
    log({ text: q, result: "clarify", path: "deterministic", score: d.score });
    return { handled: true, clarify: true, text: d.question, path: "deterministic" };
  }

  // Near-miss only → let the model classify, still constrained to the registry.
  // Anything with no capability overlap skips this entirely and falls through.
  if (d.action === "none" && (d.weak || 0) >= MODEL_FLOOR && ctx.allowModel !== false && ctx.ask) {
    const cap = await classifyWithModel(q, ctx.ask);
    if (cap) d = { action: "route", cap, path: "model", score: null };
    else log({ text: q, result: "model-said-none", path: "model" });
  }

  if (d.action !== "route") {
    log({ text: q, result: "fallthrough", path: "deterministic", score: d.weak || 0 });
    return { handled: false };   // ← the regression bar: today's behaviour, untouched
  }

  const cap = d.cap;
  let switched = false;
  // Switch only when the capability actually needs its mode. remember/look run
  // in place, so a memory never yanks you out of what you were doing.
  if (cap.needsMode && cap.modeId && ctx.activeModeId !== cap.modeId && typeof ctx.switchTo === "function") {
    if (typeof ctx.announce === "function") ctx.announce(`Switching to ${cap.label}…`);
    try { await ctx.switchTo(cap.modeId); switched = true; }
    catch (err) {
      console.warn("router: mode switch failed —", err && err.message);
      log({ text: q, result: "switch-failed", path: d.path });
      return { handled: false };   // couldn't switch → behave exactly as before
    }
  }

  log({ text: q, result: cap.id, path: d.path, score: d.score });
  try {
    const out = await cap.run(q, { ...ctx, switched });
    // A capability may decline after inspecting the text (returns null) — that
    // is not an error, it just falls through to the companion.
    if (out == null) { log({ text: q, result: "declined:" + cap.id, path: d.path }); return { handled: false }; }
    const asText = typeof out === "string" ? out : (out && out.text) || "";
    return { handled: true, text: asText, cap: cap.id, path: d.path, switched };
  } catch (err) {
    console.error("router: capability failed —", cap.id, err);
    return { handled: true, text: `That didn't work: ${(err && err.message) || err}` };
  }
}

export function recentDecisions() { return decisionLog.slice(-20); }
export function _reset() { capabilities.length = 0; decisionLog = []; }

export default { register, unregister, list, rank, decide, route, classifyWithModel, recentDecisions, _reset };
