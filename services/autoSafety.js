// Reality Engine · services/autoSafety — the Automotive hazard gate and the
// vendored verdict tables.
//
// THIS FILE IS THE MODE. Everything in modes/automotive.js is presentation; the
// decisions live here, in plain data and pure functions, because every one of
// them is a decision a hallucination could kill someone over.
//
// THE ORDER MATTERS AND IS ENFORCED STRUCTURALLY:
//   1. hazardCheck()  — runs FIRST, before any network call of any kind. A
//                       refusal produces no steps, no tools, no partial
//                       procedure and no hints, because the hint is the part
//                       that was worth refusing.
//   2. the tables     — leaks and warning lights are answered from vendored
//                       data. The model is never asked and cannot be asked.
//   3. the model      — optional colour on an answer the tables already fixed,
//                       and its output is filtered before display.
//
// WHY A CAR IS DIFFERENT FROM A BLOCKED SINK. Cooking can burn you. A flooded
// bathroom is expensive. A car parked on a jack can drop two tonnes onto
// someone's chest while they're lying under it, and the people most likely to
// try it are exactly the people who'd ask an app first. Under-vehicle work is
// refused permanently and is not a judgement call the mode gets to make.

// ---------------------------------------------------------------- 1. HAZARD
//
// Ordered most-lethal first, so a sentence that trips several is refused for the
// worst reason rather than whichever regex happened to be written first.
//
// Deliberately broad. A false refusal costs someone a DIY job they could have
// done; a false accept can cost them their life. That trade is not close.
//
// TWO KINDS OF RULE, and getting this wrong breaks the mode in one direction or
// kills someone in the other:
//
//   onMention  — merely being in that situation is the danger, so the words are
//                enough. Nothing about "I'm going under the car" needs a verb to
//                be alarming, and neither does an orange HV cable.
//
//   work-intent — the SYSTEM is dangerous to work on, but talking about it is
//                not. Verification caught this the first time the hazard set was
//                run: "there's a grinding noise when I brake" was refused, which
//                would have killed the mode's headline feature — the handoff's
//                own example of a noise to diagnose. Refusing on mention refuses
//                the very question worth answering, exactly as it would have in
//                chemistry. So these need a verb that means "I am going to do
//                this myself".
//
// A symptom involving brakes therefore reaches the triage, where the outcome is
// "stop and get this looked at" — never a procedure. The moment the sentence
// turns into "how do I change them", this gate fires.
const WORK_INTENT_RE = new RegExp([
  /\b(replace|replacing|replacement|change|changing|changed|fix|fixing|repair|repairing|mend|swap|swapping)\b/,
  /\b(remove|removing|removal|refit|install|installing|fitting|fit a|adjust|adjusting|adjustment)\b/,
  /\b(bleed|bleeding|drain|draining|siphon|top up the brake|undo|loosen|tighten|torque)\b/,
  /\b(disconnect|disconnecting|disassemble|take (it |them )?(off|apart)|strip (it |them )?down)\b/,
  /\b(service|servicing|rebuild|overhaul|do (my|the|a) \w+ (job|myself))\b/,
  /\b(guide me|walk me through|talk me through|help me (do|with)|how do i|how would i|can i do|diy)\b/,
].map((r) => r.source).join("|"), "i");

export const AUTO_HAZARD_RULES = [
  {
    id: "under-vehicle", onMention: true,
    // "just for a second" is the exact phrasing of the decision that kills
    // people, so the wording is matched rather than treated as a mitigation.
    // A PERSON going under, or the car going up. Deliberately NOT a bare
    // "under my car": verification caught that matching the preposition alone
    // refused "what colour is the fluid leaking under my car" — a puddle's
    // location, and one of the three things this mode exists to answer. The
    // danger is a body beneath a raised weight, so that is what's matched.
    re: /\b(jack(ing)? (it|the car|a car|my car|the van|the truck)? ?up|jack ?stands?|axle stands?|on (a|the) jack|(car|wheel|drive[- ]?up) ramps?|(use|using|drive up on|drive it up|get it up) (some |the |a set of )?ramps?|(get|getting|crawl|crawling|slide|sliding|climb|climbing|go|going|reach|reaching|work|working|lie|lying|lay|laying|slither|slithering) (in |back |right |myself |underneath )?(under|underneath)\b|under(neath)? (it|there) (while|when|with|to)|rais(e|ing) the (car|vehicle)|lift(ing)? the (car|vehicle)|on (a|the) (lift|hoist|two[- ]post))/i,
    why: "working under a lifted vehicle",
    because: "a car coming off a jack is the single most common way a home mechanic is killed, and I can't see your setup",
  },
  {
    id: "ev-hv", onMention: true,
    re: /\b(high[- ]voltage|hv (batter|cable|system|pack)|orange cables?|service disconnect|traction batter|battery pack|inverter|hybrid batter|ev batter|drive motor|dc[- ]?dc converter)/i,
    why: "hybrid or EV high-voltage systems",
    because: "those orange cables carry enough voltage to stop a heart through dry skin, and the pack stays live with the car switched off",
  },
  {
    id: "co", onMention: true,
    re: /\b((engine|it|car) (is )?running in (a|the)?\s*(garage|shed|closed|enclosed)|run(ning)? the (engine|car|motor) in (a|the)|idl(e|ing) (it|the car|the engine)? ?in (a|the)|warm (it|the car|the engine) up in (a|the)|(closed|shut|enclosed) garage|enclosed space|garage door (shut|closed|down))/i,
    why: "running an engine in an enclosed space",
    because: "carbon monoxide has no smell and a closed garage reaches a lethal concentration in minutes",
  },
  {
    id: "hot-cooling", onMention: true,
    re: /\b(open(ing)? the (radiator|coolant|expansion) cap|(radiator|coolant|expansion) cap (while|when|with)|(hot|boiling|steaming|overheating) (radiator|cooling system|engine) cap|pressuri[sz]ed cooling|bleed the cooling system while)/i,
    why: "opening a pressurised cooling system while it's hot",
    because: "the coolant is above boiling and flashes to steam the moment the cap lifts",
  },
  {
    id: "welding", onMention: true,
    re: /\b(weld(ing|er)?|cutting torch|angle grind(er|ing) (on|near) the (tank|fuel|car)|oxy[- ]?acetylene|plasma cut|braz(e|ing))/i,
    why: "welding or cutting on a vehicle",
    because: "the fuel and the fuel vapour are never as far from the sparks as they look",
  },
  {
    id: "brakes", onMention: false,
    re: /\b(brakes?|brake (pad|shoe|disc|rotor|caliper|line|hose|fluid)s?|handbrake cable|parking brake|abs (module|pump|sensor))/i,
    why: "brakes",
    because: "brakes are the system that stops you, and a mistake shows up the first time you actually need them",
  },
  {
    // BEFORE steering, deliberately. "Remove the airbag from the steering
    // wheel" trips both, and the first version answered it with the suspension
    // reason — a refusal for the wrong reason teaches the wrong lesson, and the
    // whole point of saying why is that "an airbag is an explosive charge"
    // stops someone in a way "I can't help with that" does not.
    id: "srs", onMention: false,
    re: /\b(air ?bags?|srs|pretensioners?|seat ?belts?|clock ?spring)/i,
    why: "airbags, seat belts or other restraint parts",
    because: "an airbag is a small explosive charge that deploys faster than you can move your hands",
  },
  {
    id: "steering-susp", onMention: false,
    re: /\b(steering (rack|column|arm|joint|wheel)|track rods?|tie rods?|ball ?joints?|control arms?|wishbones?|suspension|struts?|shock absorbers?|coil springs?|spring compressor|subframe|wheel bearings?)/i,
    why: "steering or suspension",
    because: "a spring or a joint letting go at speed takes the car away from you instantly",
  },
  {
    id: "fuel", onMention: false,
    re: /\b(fuel (line|tank|pump|rail|injector|filter|hose|pressure|system)s?|petrol tank|gas tank|diesel tank|fuel)\b/i,
    why: "the fuel system",
    because: "fuel lines hold pressure and petrol vapour ignites from a spark you'd never notice",
  },
];

// Runs before anything else, on the raw utterance. Pure, synchronous, no I/O —
// so it CANNOT be skipped by a network failure, a slow model, or a race.
export function autoHazardCheck(text) {
  const t = String(text || "");
  const hasWorkIntent = WORK_INTENT_RE.test(t);
  for (const r of AUTO_HAZARD_RULES) {
    if (!r.re.test(t)) continue;
    if (r.onMention || hasWorkIntent) return r;
  }
  return null;
}

// Exposed so verification can assert on the two halves separately rather than
// only on the combined outcome.
export function hasWorkIntent(text) { return WORK_INTENT_RE.test(String(text || "")); }

// One short sentence, the reason, and where to go. Nothing else — no "the
// general principle is", no "if you must", no tool list, no first step. A
// partial procedure for any of the above is worse than a flat no, because it
// gets someone started.
export function autoRefusal(rule) {
  return `No — I won't help with ${rule.why}: ${rule.because}. That's a job for a shop with a proper lift and the right equipment.`;
}

// ---------------------------------------------------------------- 2. NEVER CLEAR
//
// The chemistry bar, applied to vehicles: a photo cannot establish that a car is
// safe to drive, and neither can a description. The mode may report URGENCY from
// the vendored tables — that is a fixed string attached to a fixed row — but no
// sentence anywhere may tell someone their car is fine.
//
// This runs over EVERY model-generated sentence the mode displays. It is not a
// prompt instruction, because a prompt instruction can be hallucinated past.
export const DRIVE_CLAIM_RE = new RegExp([
  /\b(safe|fine|ok|okay|alright|all right|no problem|good) to drive\b/,
  /\b(safe|fine|ok|okay|roadworthy|driveable|drivable) (to|for) (drive|driving|the road)\b/,
  /\byou (can|could|should be able to|may) (safely |still |probably |certainly )?(drive|keep driving|carry on driving)\b/,
  /\b(it'?s|that'?s|the car is|she'?s) (perfectly |completely |totally |quite )?(safe|fine|ok|okay|roadworthy)\b/,
  /\bno (need|reason) to (worry|stop|pull over)\b/,
  /\b(nothing|not) (to worry about|serious|urgent|dangerous)\b/,
  /\bkeep driving\b/,
  /\bcarry on (driving|as normal)\b/,
  /\bdrive it (home|to the garage|as normal|normally)\b/,
  /\bwon'?t (cause|do) any (harm|damage)\b/,
  /\bit'?s not (a problem|an issue|dangerous|urgent)\b/,
].map((r) => r.source).join("|"), "i");

// OUR OWN DISCLAIMERS, exempted by exact text.
//
// The first version of the sweep flagged all 21 rendered verdicts, and it was
// right to: every one of them ends with "I can't tell you a car is safe to
// drive", which contains the exact phrase the checker hunts for. The tempting
// fix — teach the regex about negation — puts a hole in it, because "I can't
// tell you it isn't safe to drive" would then sail through.
//
// So the exemption is a WHITELIST OF FIXED STRINGS WE WROTE, matched exactly.
// A model cannot produce an exemption; it can only produce a claim.
const AUTHORED_DISCLAIMERS = [
  "I can't tell you a car is safe to drive — nobody can from a description or a photo.",
  "If in doubt, the cheap option is a phone call to a garage; the expensive one is finding out.",
];
function isAuthoredDisclaimer(sentence) {
  const s = sentence.trim();
  return AUTHORED_DISCLAIMERS.some((d) => d === s);
}

// Drop any sentence that clears the vehicle. Returns the surviving text and
// what was removed, so verification can assert on it rather than eyeball it.
export function dropDriveClaims(text) {
  const src = String(text || "");
  // Split on sentence ends but keep them, so surviving prose still reads.
  const parts = src.split(/(?<=[.!?])\s+/);
  const kept = [], dropped = [];
  for (const p of parts) {
    if (!isAuthoredDisclaimer(p) && DRIVE_CLAIM_RE.test(p)) dropped.push(p.trim()); else kept.push(p);
  }
  let out = kept.join(" ").replace(/\s+/g, " ").trim();
  if (dropped.length) {
    out += (out ? " " : "") +
      "(I've dropped a line there that said the car was fine to drive — nothing I can see from a photo or a " +
      "description can establish that.)";
  }
  return { text: out, dropped };
}

// ---------------------------------------------------------------- 3. OBD-II
//
// We have no dongle and no Bluetooth pairing, so a code is something we cannot
// read. The only dishonest answer available is a plausible one, so the gate is
// explicit: recognise the ask, refuse it, point at a reader, and NEVER produce
// a code or a meaning for one the user recites.
// Plurals matter here and the first version got them wrong: `code\b` does not
// match "codes", so "can you read my fault codes" — the single most likely way
// anyone phrases this — fell straight through the gate to the model. Caught by
// running the set rather than reading it.
export const OBD_RE = /\b(obd2?|obd-?ii|dtcs?|(fault|error|engine|trouble) codes?|scan(ner)? tool|code readers?|p[01][0-9]{3}|(read|pull|check|get|scan)(ing)? (the |my |its )?(fault |error |trouble |engine )?codes?)\b/i;

export function obdRefusal() {
  return "I can't read fault codes — there's no dongle here and I'm not going to guess at one, because a wrong " +
    "code sends you replacing the wrong part. A basic OBD-II reader is about £20, and most chain parts shops " +
    "will read the codes for free while you wait. Bring me the code once you have it and I'll tell you what it means.";
}

// ---------------------------------------------------------------- 4. TABLES
//
// THE VERDICT COMES FROM DATA. These functions are pure and synchronous: they
// take a sentence and return a row from data/automotive-tables.json, or nothing.
// There is no branch in here that calls a model, awaits anything, or composes a
// sentence a model wrote — which is the only way to be able to say that a
// hallucinating model cannot change a verdict, rather than hoping it won't.
//
// Every outcome is either a listed row with its fixed urgency, or an explicit
// "not in my table". There is deliberately no path that returns reassurance.

let TABLES = null;
export function setTables(t) { TABLES = t; }
export function getTables() { return TABLES; }

function norm(text) {
  return " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
}
function has(hay, needle) { return hay.includes(" " + needle.toLowerCase() + " "); }

// --- leaks: colour is the strong signal, position and texture break ties ---
//
// Scored rather than first-match, because "clear fluid at the front" and "clear
// fluid under the passenger side" are two completely different answers (fuel
// versus air-conditioning condensation) and only the position separates them.
export function leakVerdict(text) {
  if (!TABLES) return null;
  const t = norm(text);
  let best = null, bestScore = 0;
  for (const row of TABLES.leaks) {
    let score = 0;
    for (const c of row.colours) if (has(t, c)) score += c.split(" ").length * 2;
    // Position words, individually — "passenger" alone is decisive for AC.
    for (const w of norm(row.position).trim().split(" ")) {
      if (w.length >= 5 && has(t, w)) score += 1;
    }
    for (const w of norm(row.texture).trim().split(" ")) {
      if (w.length >= 5 && has(t, w)) score += 1;
    }
    if (has(t, row.id.replace(/-/g, " "))) score += 3;
    if (score > bestScore) { best = row; bestScore = score; }
  }
  // A single weak signal isn't an identification. The floor was 2 and let
  // "some kind of grey sludge under the middle" come back as engine oil purely
  // on the words "under" and "middle" — a confident wrong fluid is worse than
  // "I don't know", because the urgency line rides along with it.
  if (!best || bestScore < 3) return { known: false, row: null, score: bestScore };
  return { known: true, row: best, score: bestScore };
}

// --- warning lights: match on the name people actually use ---
export function lightVerdict(text) {
  if (!TABLES) return null;
  const t = norm(text);
  let best = null, bestScore = 0;
  for (const row of TABLES.lights) {
    let score = 0;
    for (const m of row.match) if (has(t, m)) score += m.split(" ").length * 2;
    for (const w of norm(row.name).trim().split(" ")) {
      if (w.length >= 5 && has(t, w)) score += 1;
    }
    if (score > bestScore) { best = row; bestScore = score; }
  }
  if (!best || bestScore < 2) return { known: false, row: null, score: bestScore };
  return { known: true, row: best, score: bestScore };
}

// Render a verdict. Also pure: every word below comes either from the table or
// from a fixed string in this file. Nothing here is generated.
export function renderVerdict(kind, v) {
  if (!TABLES) return null;
  const always = TABLES.always.join(" ");
  if (!v || !v.known) {
    return {
      known: false,
      headline: kind === "leak" ? "Not in my table" : "Not a symbol I know",
      urgency: null, urgencyLabel: "UNKNOWN",
      text: (kind === "leak" ? TABLES.unknownLeak : TABLES.unknownLight) + " " + always,
    };
  }
  const row = v.row;
  const u = TABLES.urgency[row.urgency];
  const name = kind === "leak" ? row.fluid : row.name;
  const body = kind === "leak"
    ? `${row.why} What you'd notice: ${row.notice}`
    : `${row.means} ${row.why}`;
  return {
    known: true, id: row.id, headline: name,
    urgency: row.urgency, urgencyLabel: u.label, urgencyRank: u.rank,
    text: `${name} — ${u.label}. ${u.line} ${body}${row.extra ? " " + row.extra : ""} ${always}`,
  };
}

export { AUTHORED_DISCLAIMERS, isAuthoredDisclaimer };

export default {
  AUTO_HAZARD_RULES, autoHazardCheck, autoRefusal, hasWorkIntent,
  DRIVE_CLAIM_RE, dropDriveClaims, OBD_RE, obdRefusal,
  AUTHORED_DISCLAIMERS, isAuthoredDisclaimer,
  setTables, getTables, leakVerdict, lightVerdict, renderVerdict,
};
