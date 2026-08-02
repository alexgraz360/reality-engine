// Automotive — the third domain on the Guide engine, and the most dangerous one
// we've attempted.
//
// WHAT THIS FILE IS AND ISN'T. It is a diagnosis surface and a hazard gate. It
// is NOT a step engine: every DIY-safe job here is a pack in data/automotive.json
// run by modes/guide.js, and every noise is narrowed by the SAME triage
// functions a blocked sink uses. Nothing was forked. The one genuinely new thing
// is the refusal layer, which is why it lives in its own module
// (services/autoSafety.js) and was written before any feature.
//
// THE THREE RULES, in the order they execute:
//
//   1. REFUSE FIRST. autoHazardCheck() runs on the raw utterance before any
//      network call exists. Under-vehicle work is refused permanently — a car
//      dropping off a jack is the single most likely way this mode kills
//      someone, and it is not a judgement call the mode gets to make.
//
//   2. THE TABLE OWNS THE VERDICT. Leaks and warning lights are answered from
//      data/automotive-tables.json by pure synchronous functions. The model is
//      never asked what a light means. It cannot be: there is no code path from
//      a verdict to /chat.
//
//   3. NOTHING CLEARS THE VEHICLE. Every model-written sentence goes through
//      dropDriveClaims() before it is displayed. "It's fine to drive" is the
//      automotive equivalent of "that's safe to eat", and it is the one claim
//      that turns a wrong answer into a hospital visit.
//
// HONEST LIMITS, stated in the mode as well as here: we cannot read OBD-II
// codes and will not guess one; a photo can identify a fluid colour or a
// warning symbol and cannot tell you whether a belt is about to fail; and the
// owner's manual outranks anything in here for a specific car.

import auto from "../services/autoSafety.js";

let root, svc, els = {};
let tables = null;
let view = "home";              // "home" | "leak" | "light" | "noise" | "log"
let lastVerdict = null;         // { kind, headline, urgencyLabel, text, ... }
let lastRefusal = "";
let camStream = null;
let busy = false;
let logEntries = [];            // mirrored locally for the panel; memory is the store
let store = null;

// How each entry reads back in a question, so the confirmation suggests
// "when did I last change the oil" rather than "when did I last oil change".
const ASK_PHRASE = {
  oil: "change the oil", filter: "change a filter", tyres: "check the tyres",
  wipers: "change the wipers", battery: "do the battery", service: "have it serviced",
  other: "do that",
};

const LOG_KINDS = [
  { id: "oil", label: "Oil change" },
  { id: "filter", label: "Filter" },
  { id: "tyres", label: "Tyres" },
  { id: "wipers", label: "Wipers" },
  { id: "battery", label: "Battery" },
  { id: "service", label: "Service" },
  { id: "other", label: "Other" },
];

export default {
  id: "automotive",
  title: "Car · what's it doing?",
  icon: "🚗",
  family: "Live",
  permissions: ["camera", "mic"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    store = svc.storage;
    root.innerHTML = `
      <video data-el="cam" playsinline muted autoplay
        style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000; display:none;"></video>
      <div data-el="shade" style="position:absolute; inset:0; background:radial-gradient(120% 90% at 50% 0%, #16110d 0%, var(--bg) 70%);"></div>
      <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
        padding: 14px 14px 220px;"></div>`;
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    try {
      const r = await fetch(new URL("../data/automotive-tables.json", import.meta.url));
      tables = await r.json();
      auto.setTables(tables);
    } catch (e) {
      console.error("automotive tables failed to load:", e);
    }
    logEntries = store.get("auto.log", []) || [];
    busy = false;                       // belt and braces with teardown
    render();
  },

  async start() {},
  stop() {},
  teardown() {
    if (camStream) { svc.sensors.releaseStream(camStream); camStream = null; }
    // `busy` is module scope, so leaving it set survives the teardown and the
    // NEXT time the mode opens both action buttons read "Working…" and do
    // nothing. Found by closing the mode mid-explain during verification, which
    // is exactly what a user does when an answer is taking too long.
    view = "home"; lastVerdict = null; lastRefusal = ""; busy = false;
    noiseQuestion = ""; noiseOptions = []; noiseStop = "";
    els = {}; root = null;
  },

  getContext() {
    if (lastRefusal) return `Car Mode — just refused a job as unsafe for a driveway. ${lastRefusal}`;
    if (lastVerdict) {
      return `Car Mode — last read: ${lastVerdict.headline}, urgency ${lastVerdict.urgencyLabel}. ` +
        `This came from a vendored table, not from a model. I cannot say whether the car is safe to drive.`;
    }
    if (view === "log") return "Car Mode — looking at the maintenance log.";
    return "Car Mode — identifying a noise, a warning light or a leak. No OBD-II reader, so no fault codes.";
  },

  // A text-only card, verdict first and urgency with it — the two things worth
  // reading at a glance with your head under a bonnet.
  getGlanceCard() { return glanceCard(); },

  // ---------------------------------------------------------------- router
  describeCapabilities() {
    return [
      { id: "auto.noise", label: "Car", needsMode: true, fillsSlots: true,
        patterns: [/\bwhat'?s that noise\b/i, /\bwhat is that (noise|sound)\b/i,
                   /\b(grinding|squealing|knocking|rattling|whining|clunking|humming|droning) (noise|sound|when|from)\b/i,
                   /\bmy car (is )?(making|makes) a (noise|sound)\b/i,
                   /\bthere'?s a (noise|sound|grinding|squeal|knock|rattle|whine)\b/i],
        examples: ["what's that noise", "there's a grinding when I brake", "my car is making a knocking sound"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "auto.light", label: "Car", needsMode: true, fillsSlots: true,
        patterns: [/\bwhat does (this|that) (warning )?light mean\b/i,
                   /\b(warning|dashboard|dash) light\b/i,
                   /\b(check engine|engine management|oil|battery|abs|airbag|tyre pressure|tire pressure) light\b/i,
                   /\ba light (came|come|has come) on\b/i],
        examples: ["what does this light mean", "my check engine light is on", "a light came on"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "auto.leak", label: "Car", needsMode: true, fillsSlots: true,
        patterns: [/\bwhat'?s leaking\b/i, /\bmy car is leaking\b/i,
                   /\bwhat is (this|that) (fluid|puddle|liquid)\b/i,
                   /\b(puddle|leak|dripping) (under|beneath) (my|the) car\b/i],
        examples: ["what's leaking", "there's a puddle under my car", "what is this fluid"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
      { id: "auto.log", label: "Car", needsMode: true,
        patterns: [/\bwhen did i last (change|do|replace|service)\b/i,
                   /\blog (the |my )?(oil|filter|tyres?|tires?|wipers?|battery|service)\b/i,
                   /\b(car|vehicle|maintenance|service) (log|history|record)\b/i],
        examples: ["when did I last change the oil", "log the oil change", "show my car log"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null) },
    ];
  },

  // ---------------------------------------------------------------- slots
  //
  // All three come from the utterance first, exactly as the slot layer requires,
  // and none of them is the hazard gate. The gate is not a slot and must never
  // become one: a slot can be filled from context or by asking, and a refusal
  // that can be satisfied by answering a question isn't a refusal.
  describeSlots() {
    return [
      {
        id: "symptom", label: "what the car is doing", required: false,
        sources: ["utterance", "context"],
        parse: (t) => {
          const s = String(t || "").toLowerCase();
          const m = s.match(/\b(grinding|squeal(ing)?|screech(ing)?|knock(ing)?|rattl(e|ing)|whin(e|ing)|clunk(ing)?|hum(ming)?|dron(e|ing)|tick(ing)?|clicking)\b/);
          return m ? m[1].replace(/ing$/, "") : null;
        },
        fromContext: () => null, current: () => null,
        apply: (v) => { setView("noise"); noteSymptom(v); },
        say: (v) => `a ${v}`,
      },
      {
        id: "when", label: "when it happens", required: false,
        sources: ["utterance", "context"],
        parse: (t) => {
          const s = String(t || "").toLowerCase();
          if (/\bwhen i brake|braking|on the brakes\b/.test(s)) return "braking";
          if (/\bwhen i turn|turning|on full lock|cornering\b/.test(s)) return "turning";
          if (/\baccelerat|pulling away|under load\b/.test(s)) return "accelerating";
          if (/\bcold start|first thing|when it'?s cold|in the morning\b/.test(s)) return "cold start";
          if (/\bwith speed|faster i go|at speed|motorway|highway\b/.test(s)) return "speed";
          return null;
        },
        fromContext: () => null, current: () => null,
        apply: (v) => { setView("noise"); noteWhen(v); },
        say: (v) => `when ${v === "speed" ? "speed rises" : v}`,
      },
      {
        id: "vehicle", label: "which car", required: false,
        sources: ["utterance", "context"],
        parse: (t) => {
          const m = String(t || "").match(/\b(?:my |the )?((?:19|20)\d{2})?\s*(ford|vauxhall|opel|volkswagen|vw|bmw|audi|mercedes|toyota|honda|nissan|kia|hyundai|renault|peugeot|citro[eë]n|skoda|seat|mazda|volvo|fiat|mini|tesla|jeep|chevrolet|subaru)\b/i);
          return m ? [m[1], m[2]].filter(Boolean).join(" ") : null;
        },
        fromContext: () => store.get("auto.vehicle", null),
        current: () => store.get("auto.vehicle", null),
        apply: (v) => { store.set("auto.vehicle", v); render(); },
        say: (v) => `your ${v}`,
      },
    ];
  },

  // ---------------------------------------------------------------- commands
  handleCommand(text) {
    const q = String(text || "");

    // (1) THE GATE. First statement in the function, before anything that could
    //     touch the network, and before any parsing that might reinterpret the
    //     sentence into something more agreeable.
    const rule = auto.autoHazardCheck(q);
    if (rule) {
      lastRefusal = auto.autoRefusal(rule);
      lastVerdict = null;
      setView("home");
      return lastRefusal;
    }
    lastRefusal = "";

    // (2) OBD-II: recognised, refused, pointed at a reader. Never a guessed code.
    if (auto.OBD_RE.test(q)) return auto.obdRefusal();

    const lower = q.toLowerCase().replace(/[.,!?]/g, "").trim();

    // (3) The maintenance log, in the EXISTING personal memory store.
    if (/^(show |open )?(my )?(car|vehicle|maintenance|service) (log|history|record)$/.test(lower)) {
      setView("log");
      return logSummary();
    }
    const logM = lower.match(/^log (?:the |my |a )?(oil|filter|tyres?|tires?|wipers?|battery|service)(?: change| service)?$/);
    if (logM) return addLogEntry(logM[1]);
    if (/\bwhen did i last\b/.test(lower)) return recallLog(lower);

    // (4) The three reads. Tables only — see the verdict functions.
    // "some kind of grey sludge under the middle" has none of the obvious leak
    // words, and it is exactly how someone describes a puddle they can't name —
    // so a substance word plus "under the car" counts too. It still reaches the
    // table, and the table still answers "not in mine, don't guess".
    if (/\b(leak|leaking|puddle|dripping|fluid|liquid)\b/.test(lower)
        || (/\b(sludge|stain|patch|drips?|wet spot|something)\b/.test(lower)
            && /\b(under|underneath|beneath)\b/.test(lower))) return answerLeak(q);
    if (/\blight\b/.test(lower) || /\bsymbol\b/.test(lower)) return answerLight(q);
    if (/\b(noise|sound|grinding|squeal|knock|rattle|whine|clunk|hum|drone)\b/.test(lower)) {
      setView("noise");
      return startNoiseTriage();
    }

    // (5) Triage answers, forwarded to the SHARED engine.
    const nm = lower.match(/^(?:option )?(one|two|three|four|five|six|1|2|3|4|5|6)$/);
    if (nm && view === "noise") {
      const map = { one: 0, two: 1, three: 2, four: 3, five: 4, six: 5 };
      const i = nm[1] in map ? map[nm[1]] : parseInt(nm[1], 10) - 1;
      return answerNoiseTriage(i);
    }
    return null;   // anything else: ordinary conversation, grounded by getContext
  },

  // ---------------- verification hooks ----------------
  _state: () => ({ view, lastVerdict, lastRefusal, vehicle: store && store.get("auto.vehicle", null),
                   logCount: logEntries.length }),
  _hazard: (t) => auto.autoHazardCheck(t),
  _refusal: (t) => { const r = auto.autoHazardCheck(t); return r ? auto.autoRefusal(r) : null; },
  _leak: (t) => auto.renderVerdict("leak", auto.leakVerdict(t)),
  _light: (t) => auto.renderVerdict("light", auto.lightVerdict(t)),
  _drop: (t) => auto.dropDriveClaims(t),
  _obd: (t) => (auto.OBD_RE.test(t) ? auto.obdRefusal() : null),
  _log: () => logEntries.slice(),
  _addLog: (kind, note) => addLogEntry(kind, note),
  _tables: () => tables,
  // The triage proof: this returns the guide engine's own functions, so a test
  // can assert identity rather than take "it reuses the triage" on faith.
  _triageFns: async () => {
    const g = (await import("./guide.js")).default;
    return { start: g._triage.start, answer: g._triage.answer, node: g._triage.node, stop: g._triage.stop };
  },
};

// ---------------------------------------------------------------- verdicts
//
// Both of these are table lookups and string assembly. Note what is absent:
// there is no `await`, no fetch, and no svc.companion in either one. That
// absence is the guarantee — a stubbed, broken or actively hallucinating model
// changes nothing here, because nothing here asks it anything.
function answerLeak(text) {
  if (!tables) return "The fluid table hasn't loaded — I won't guess at a leak without it.";
  const v = auto.leakVerdict(text);
  lastVerdict = { kind: "leak", ...auto.renderVerdict("leak", v) };
  setView("leak");
  emitCard();
  return lastVerdict.text;
}

function answerLight(text) {
  if (!tables) return "The warning-light table hasn't loaded — I won't guess at a symbol without it.";
  const v = auto.lightVerdict(text);
  lastVerdict = { kind: "light", ...auto.renderVerdict("light", v) };
  setView("light");
  emitCard();
  return lastVerdict.text;
}

// THE CARD LEADS WITH THE VERDICT AND ITS URGENCY, and then says something the
// title hasn't already said. The first version wrapped the headline into the
// body as well, so a four-line lens showed the fluid's name twice and the
// reason not at all — with your head under a bonnet, "COOLANT · DON'T DRIVE IT ·
// overheating warps the head" is the whole message.
function glanceCard() {
  if (lastRefusal) {
    const rule = auto.autoHazardCheck(lastRefusal) || {};
    return {
      title: "Not a DIY job",
      lines: ["REFUSED", ...svc.glasses.wrap(cap(rule.why || "unsafe for a driveway"), 24, 3)].slice(0, 4),
      // Short enough to survive the 220-char spoken clamp intact.
      spoken: `No — I won't help with ${rule.why || "that"}. That's a job for a shop with a lift.`,
      holdMs: 9000,
    };
  }
  if (!lastVerdict) return null;
  const why = shortWhy(lastVerdict);
  return {
    title: String(lastVerdict.headline).slice(0, 20),
    lines: [lastVerdict.urgencyLabel, ...svc.glasses.wrap(why, 24, 3)].slice(0, 4),
    spoken: `${lastVerdict.headline}. ${lastVerdict.urgencyLabel}. ${why}`.slice(0, 220),
    holdMs: 10000,
  };
}

// The one-line consequence, from the table — not a repeat of the headline and
// not the full paragraph.
function shortWhy(v) {
  if (!tables) return "";
  // A triage outcome has no table row — its first sentence IS the finding.
  if (v.kind === "noise") return String(v.text || "").split(/(?<=[.!?])\s/)[0];
  if (!v.known) return "Not in my table — don't guess at it.";
  const row = (v.kind === "leak" ? tables.leaks : tables.lights).find((r) => r.id === v.id);
  const first = row ? String(row.why).split(/(?<=[.!?])\s/)[0] : "";
  return first || (tables.urgency[v.urgency] || {}).line || "";
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function emitCard() {
  if (!svc.glasses) return;
  const c = glanceCard();
  if (c) svc.glasses.send(c);
}

// ---------------------------------------------------------------- noise triage
//
// THE SHARED PATH. These call into modes/guide.js's triage rather than
// reimplementing it — the nodes live in data/automotive.json and are merged
// into the one tree the engine loads. If this file grew its own question loop,
// the handoff's "do not fork the engine" would have been broken quietly, so the
// call is made explicitly and asserted in verification.
let guideMod = null;
async function guideEngine() {
  if (!guideMod) guideMod = (await import("./guide.js")).default;
  return guideMod;
}
let noiseQuestion = "", noiseOptions = [], noiseStop = "";

async function startNoiseTriage() {
  const g = await guideEngine();
  // The engine loads its tree in init(). If Guide has never been opened this
  // session there is nothing to walk — and rather than duplicate the engine's
  // loader here (a fork by another name), we load it through the engine itself
  // by giving it a detached root to initialise into.
  if (!g._packsLoaded || !g._packsLoaded()) {
    try {
      await g.init({ root: document.createElement("div"), services: svc });
    } catch (e) {
      console.warn("automotive: couldn't warm the shared Guide engine —", e && e.message);
    }
  }
  if (!jumpToAutoNoise(g)) {
    return "The car triage questions haven't loaded, and I'd rather say so than start a half-loaded " +
      "triage and give you a worse answer than none. Open Guide once and try again.";
  }
  render();
  return noiseQuestion;
}

// Walk the shared root to the automotive branch using the engine's own answer()
// function, so the traversal is the engine's and not a copy of it.
function jumpToAutoNoise(g) {
  g._triage.start();
  const opts = g._triageOptions ? g._triageOptions() : [];
  const i = opts.findIndex((o) => o.next === "auto-noise");
  if (i === -1) return false;
  g._triage.answer(i);
  syncFromEngine(g);
  return true;
}

function syncFromEngine(g) {
  noiseQuestion = g._triageQ ? g._triageQ() : "";
  noiseOptions = g._triageOptions ? g._triageOptions() : [];
  noiseStop = g._triage.stop() || "";
  if (noiseStop) {
    lastVerdict = { kind: "noise", known: true, headline: "Noise", urgency: null,
                    urgencyLabel: "GET IT HEARD", text: noiseStop };
    emitCard();
  }
}

async function answerNoiseTriage(i) {
  const g = await guideEngine();
  const out = g._triage.answer(i);
  syncFromEngine(g);
  render();
  return noiseStop || out || noiseQuestion;
}

function noteSymptom(v) { store.set("auto.symptom", v); render(); }
function noteWhen(v) { store.set("auto.when", v); render(); }

// ---------------------------------------------------------------- the log
//
// THE EXISTING PERSONAL MEMORY STORE. Not a second store — that mistake was
// nearly made once already, and the whole value of "when did I last change the
// oil" is that the companion can answer it from anywhere, which only works if
// it lives where every other memory lives.
async function addLogEntry(kindRaw, note) {
  const kind = normaliseKind(kindRaw);
  const label = (LOG_KINDS.find((k) => k.id === kind) || { label: "Car job" }).label;
  const ts = Date.now();
  const when = new Date(ts).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  const vehicle = store.get("auto.vehicle", null);
  const body = `Car maintenance: ${label} done on ${when}${vehicle ? ` on my ${vehicle}` : ""}.` +
    (note ? ` ${note}` : "");
  const entry = { id: "log-" + ts, kind, label, ts, note: note || "", vehicle };
  logEntries.unshift(entry);
  store.set("auto.log", logEntries.slice(0, 200));
  render();
  try {
    await svc.knowledge.add(body, {
      title: `${label} — ${when}`, pack: "my-memories",
      meta: { scope: "personal", kind: "fact", subject: `car ${label.toLowerCase()}`, ts, source: "said" },
    });
    entry.inMemory = true;
    store.set("auto.log", logEntries.slice(0, 200));
    render();
    return `Logged: ${label}, ${when}. It's in your memories, so you can ask ` +
      `"when did I last ${ASK_PHRASE[kind] || "do that"}" from anywhere.`;
  } catch (err) {
    entry.memoryError = true;
    store.set("auto.log", logEntries.slice(0, 200));
    render();
    return `Logged locally: ${label}, ${when}. I couldn't reach your bridge to file it in memories, ` +
      `so the companion won't recall it until that's back — ${err && err.message ? err.message : "no detail"}.`;
  }
}

function normaliseKind(raw) {
  const s = String(raw || "").toLowerCase();
  if (/tyre|tire/.test(s)) return "tyres";
  if (/wiper/.test(s)) return "wipers";
  if (/filter/.test(s)) return "filter";
  if (/batter/.test(s)) return "battery";
  if (/oil/.test(s)) return "oil";
  if (/service/.test(s)) return "service";
  return "other";
}

// Answered from the LOCAL log, not from the model, for the same reason the
// action read-backs are generated app-side: a remembered date has to be true.
function recallLog(q) {
  const kind = normaliseKind(q);
  const hit = logEntries.find((e) => e.kind === kind);
  const label = (LOG_KINDS.find((k) => k.id === kind) || { label: "that" }).label;
  if (!hit) {
    return `I don't have a ${label.toLowerCase()} in your car log. If you've done one, say ` +
      `"log the ${kind}" and I'll record it from today.`;
  }
  const when = new Date(hit.ts).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  const days = Math.round((Date.now() - hit.ts) / 86400000);
  return `${label}: ${when} — ${days} day${days === 1 ? "" : "s"} ago.${hit.note ? " " + hit.note : ""}`;
}

function logSummary() {
  if (!logEntries.length) return "Your car log is empty. Say \"log the oil change\" after you do one.";
  return logEntries.slice(0, 5).map((e) =>
    `${e.label}: ${new Date(e.ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`).join(" · ");
}

// ---------------------------------------------------------------- optional colour
//
// The ONLY place this mode talks to a model, and it runs AFTER the verdict is
// already fixed and displayed. The model is told what the answer is and asked
// to explain it; whatever comes back is filtered before it reaches the screen.
// If the bridge is down, the verdict is unaffected — only this paragraph is.
async function explain() {
  if (!lastVerdict || busy) return;
  busy = true; render();
  try {
    const res = await svc.companion.ask(
      `Explain in two short paragraphs, plainly, for someone standing next to their car. ` +
      `THE CONCLUSION IS FIXED AND IS NOT YOURS TO CHANGE: ${lastVerdict.headline}, urgency ` +
      `${lastVerdict.urgencyLabel}. ${lastVerdict.text}\n\n` +
      `Explain why that is the case and what happens if it's ignored. Do not contradict the urgency, ` +
      `do not suggest a repair procedure, and NEVER state or imply that the car is safe to drive.`,
      "", [], { temperature: 0.2, maxTokens: 320,
        systemExtra: "You are elaborating a fixed, table-derived verdict about a vehicle — not forming your own. " +
          "You may never tell anyone their car is safe to drive." });
    const raw = res.ok ? res.text : res.text;
    const filtered = auto.dropDriveClaims(raw);
    if (filtered.dropped.length) {
      console.warn("automotive: dropped a safe-to-drive claim from the model —", filtered.dropped);
    }
    lastVerdict.detail = filtered.text;
    lastVerdict.detailDropped = filtered.dropped.length;
  } catch (e) {
    lastVerdict.detail = "Couldn't reach your local model for the longer explanation — the verdict above " +
      "came from the table and doesn't need it.";
  } finally {
    busy = false; render();
  }
}

// ---------------------------------------------------------------- camera read
//
// /vision can read a colour or a symbol shape. It CANNOT diagnose, and the
// prompt says so — but more importantly the code says so: whatever the model
// describes is fed back into the same table lookup, so the verdict still comes
// from data. A vision model inventing "brake fluid, but it's fine" produces
// exactly one thing here: a table row, or "not in my table".
async function lookAt(kind) {
  if (busy) return;
  busy = true; render();
  try {
    if (!camStream) camStream = await svc.sensors.getCameraStream({ facingMode: "environment" });
    els.cam.srcObject = camStream; els.cam.style.display = "";
    await new Promise((r) => setTimeout(r, 600));
    const b64 = await svc.sensors.grabFrame(els.cam);
    els.cam.style.display = "none";
    const prompt = kind === "leak"
      ? "Describe ONLY what you can literally see of this fluid: its colour in plain words, and where it is " +
        "relative to the car if visible. Do not name the fluid, do not say whether anything is safe, do not " +
        "diagnose. Reply as: COLOUR: <words> | POSITION: <words>."
      : "Describe ONLY the shape and colour of this dashboard warning symbol in plain words — for example " +
        "'red oil can with a drip' or 'amber engine block outline'. Do not say what it means and do not " +
        "diagnose. Reply as: SYMBOL: <words>.";
    const res = await svc.companion.vision(b64, prompt);
    if (!res.ok) {
      lastVerdict = { kind, known: false, headline: "Couldn't look", urgencyLabel: "—", text: res.text };
      return;
    }
    // The model's words become a QUERY into the table, never an answer.
    const described = String(res.text || "").replace(/^(COLOUR|POSITION|SYMBOL):/gim, " ");
    const v = kind === "leak" ? auto.leakVerdict(described) : auto.lightVerdict(described);
    lastVerdict = { kind, described: described.trim(), ...auto.renderVerdict(kind, v) };
    emitCard();
  } catch (e) {
    lastVerdict = { kind, known: false, headline: "Camera unavailable", urgencyLabel: "—",
                    text: "Couldn't get a frame from the camera — describe it to me instead and I'll use the same table." };
  } finally {
    busy = false; render();
  }
}

// ---------------------------------------------------------------- UI
function setView(v) { view = v; render(); }

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const URGENCY_COLOUR = {
  "stop-now": "var(--bad)", "dont-drive": "var(--bad)", today: "var(--warn)",
  "this-week": "var(--warn)", "when-convenient": "var(--dim)",
};

function render() {
  if (!els.wrap) return;
  const w = els.wrap;
  const vehicle = store ? store.get("auto.vehicle", null) : null;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px;">🚗 What's it doing?</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
        A noise you can't place, a light you don't recognise, a puddle you can't identify.
        Leaks and lights are answered from a <b style="color:var(--fg)">built-in table</b>, not from the AI —
        so the verdict is the same every time and can't be talked out of.
      </div>

      <div style="display:flex; gap:6px; flex-wrap:wrap; margin:0 2px 12px;">
        <button class="fbChip ${view === "noise" ? "on" : ""}" data-el="tabNoise">🔊 A noise</button>
        <button class="fbChip ${view === "light" ? "on" : ""}" data-el="tabLight">⚠️ A light</button>
        <button class="fbChip ${view === "leak" ? "on" : ""}" data-el="tabLeak">💧 A leak</button>
        <button class="fbChip ${view === "log" ? "on" : ""}" data-el="tabLog">📒 Log</button>
      </div>

      ${lastRefusal ? `
      <div style="border:1px solid var(--bad); border-radius:14px; padding:12px; margin-bottom:12px; background:rgba(255,80,80,0.07);">
        <div style="font-weight:700; font-size:13px; color:var(--bad); margin-bottom:6px;">NOT A DRIVEWAY JOB</div>
        <div style="font-size:13.5px; line-height:1.55;">${esc(lastRefusal)}</div>
      </div>` : ""}

      ${lastVerdict ? verdictHtml() : ""}
      ${view === "noise" ? noiseHtml() : ""}
      ${view === "leak" ? askHtml("leak") : ""}
      ${view === "light" ? askHtml("light") : ""}
      ${view === "log" ? logHtml() : ""}

      <div style="margin-top:14px; border:1px solid var(--line); border-radius:14px; padding:12px; background:var(--panel);">
        <div style="font-weight:600; font-size:13px; margin-bottom:6px;">What this can't do</div>
        <ul style="margin:0; padding-left:18px; color:var(--dim); font-size:11.5px; line-height:1.65;">
          <li><b style="color:var(--fg)">No fault codes.</b> There's no OBD-II dongle here and I won't guess a code —
              a £20 reader, or most parts shops, will read them for free.</li>
          <li><b style="color:var(--fg)">A photo can't diagnose a fault.</b> It can read a fluid colour or a symbol shape.
              It cannot tell you whether a belt is about to fail.</li>
          <li><b style="color:var(--fg)">I will never tell you a car is safe to drive.</b> Nobody can, from a description or a photo.</li>
          <li><b style="color:var(--fg)">The owner's manual wins.</b> Torque figures and symbols vary by model and mine is a common-symbols list.</li>
          <li><b style="color:var(--fg)">Nothing under a raised car, ever.</b> Brakes, steering, suspension, airbags, seat belts,
              fuel and hybrid/EV high voltage are refused too.</li>
        </ul>
        <div style="margin-top:8px; color:var(--dim); font-size:11px;">
          Car: <b style="color:var(--fg)">${vehicle ? esc(vehicle) : "not set"}</b> — say “my Ford” and I'll remember it.
        </div>
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  wire();
}

function verdictHtml() {
  const v = lastVerdict;
  const colour = URGENCY_COLOUR[v.urgency] || "var(--dim)";
  return `
    <div style="border:1px solid ${colour}; border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
      <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:6px;">
        <span style="font-weight:800; font-size:13px; color:${colour};">${esc(v.urgencyLabel)}</span>
        <span style="font-weight:600; font-size:15px;">${esc(v.headline)}</span>
      </div>
      ${v.described ? `<div style="color:var(--dim); font-size:11px; margin-bottom:6px;">Camera saw: ${esc(v.described)}</div>` : ""}
      <div style="font-size:13.5px; line-height:1.6;">${esc(v.text)}</div>
      <div style="color:var(--dim); font-size:10.5px; margin-top:8px;">
        ${v.known ? "From the built-in table — the AI wasn't asked and can't change this." : "Not in the built-in table."}
      </div>
      ${v.detail ? `<div style="font-size:13px; line-height:1.6; margin-top:10px; padding-top:10px; border-top:1px solid var(--line);">${esc(v.detail)}</div>` : ""}
      ${v.detailDropped ? `<div style="color:var(--warn); font-size:10.5px; margin-top:6px;">Dropped ${v.detailDropped} line(s) where the model tried to clear the car for driving.</div>` : ""}
      <button class="ghostBtn" data-el="explainBtn" style="width:100%; margin-top:10px;">${busy ? "Working…" : "+ Why does that matter?"}</button>
    </div>`;
}

function askHtml(kind) {
  const isLeak = kind === "leak";
  return `
    <div style="border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
      <div style="font-weight:600; font-size:13.5px; margin-bottom:8px;">
        ${isLeak ? "Describe the puddle" : "Describe the symbol"}
      </div>
      <div style="color:var(--dim); font-size:11.5px; line-height:1.5; margin-bottom:8px;">
        ${isLeak
          ? "Colour first, then where it is under the car — that's what separates coolant from power steering, and a real leak from air-conditioning water."
          : "Colour and shape — “red oil can”, “amber engine outline”, “exclamation mark in a horseshoe”."}
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" data-el="askInput" placeholder="${isLeak ? "e.g. bright green, front centre" : "e.g. red oil can with a drip"}"
          style="flex:1; min-width:0;" autocomplete="off">
        <button class="ghostBtn accent" data-el="askBtn">Look it up</button>
      </div>
      <button class="ghostBtn" data-el="camBtn" style="width:100%; margin-top:8px;">
        ${busy ? "Looking…" : isLeak ? "📷 Point the camera at it" : "📷 Point the camera at the dash"}
      </button>
      <div style="color:var(--dim); font-size:10.5px; margin-top:6px;">
        The camera only reports colour and shape. The verdict still comes from the table.
      </div>
    </div>`;
}

function noiseHtml() {
  if (noiseStop) {
    return `
      <div style="border:1px solid var(--warn); border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
        <div style="font-weight:700; font-size:13px; color:var(--warn); margin-bottom:6px;">GET IT HEARD</div>
        <div style="font-size:13.5px; line-height:1.6;">${esc(noiseStop)}</div>
        <button class="ghostBtn" data-el="noiseRestart" style="width:100%; margin-top:10px;">Start again</button>
      </div>`;
  }
  if (!noiseQuestion) {
    return `
      <div style="border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
        <div style="font-weight:600; font-size:13.5px; margin-bottom:6px;">What's it sound like, and when?</div>
        <div style="color:var(--dim); font-size:11.5px; line-height:1.5; margin-bottom:8px;">
          When a noise happens narrows it far better than what it sounds like — braking, turning,
          accelerating and cold-start are four different lists of causes.
        </div>
        <button class="ghostBtn accent" data-el="noiseStart" style="width:100%;">Narrow it down →</button>
      </div>`;
  }
  return `
    <div style="border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
      <div style="font-size:16px; font-weight:600; line-height:1.4; margin-bottom:10px;">${esc(noiseQuestion)}</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${noiseOptions.map((o, i) => `<button class="ghostBtn" data-el="nopt${i}" style="width:100%; text-align:left;">${esc(o.label)}</button>`).join("")}
      </div>
      <div style="color:var(--dim); font-size:10.5px; margin-top:8px;">Hands-free: say “one”, “two”, and so on.</div>
    </div>`;
}

function logHtml() {
  return `
    <div style="border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; background:var(--panel);">
      <div style="font-weight:600; font-size:13.5px; margin-bottom:6px;">📒 Maintenance log</div>
      <div style="color:var(--dim); font-size:11.5px; line-height:1.5; margin-bottom:10px;">
        Entries go into your existing memories — the same place everything else you ask me to remember lives —
        so “when did I last change the oil” works from anywhere, not just in here.
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
        ${LOG_KINDS.filter((k) => k.id !== "other").map((k) =>
          `<button class="fbChip" data-el="log_${k.id}">+ ${k.label}</button>`).join("")}
      </div>
      ${logEntries.length ? `<div style="display:flex; flex-direction:column; gap:6px;">
        ${logEntries.slice(0, 12).map((e) => `
          <div style="display:flex; justify-content:space-between; gap:8px; font-size:12.5px; padding:6px 0; border-top:1px solid var(--line);">
            <span>${esc(e.label)}${e.vehicle ? ` <span style="color:var(--dim)">· ${esc(e.vehicle)}</span>` : ""}</span>
            <span style="color:var(--dim); white-space:nowrap;">
              ${new Date(e.ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
              ${e.inMemory ? "" : e.memoryError ? " ⚠︎" : ""}
            </span>
          </div>`).join("")}
      </div>` : `<div style="color:var(--dim); font-size:12px;">Nothing logged yet.</div>`}
    </div>`;
}

function wire() {
  const on = (el, fn) => { if (els[el]) els[el].addEventListener("click", fn); };
  on("tabNoise", () => setView("noise"));
  on("tabLight", () => setView("light"));
  on("tabLeak", () => setView("leak"));
  on("tabLog", () => setView("log"));
  on("explainBtn", () => explain());
  on("noiseStart", () => startNoiseTriage().then(() => render()));
  on("noiseRestart", () => { noiseStop = ""; noiseQuestion = ""; noiseOptions = []; lastVerdict = null; render(); });
  noiseOptions.forEach((o, i) => on("nopt" + i, () => answerNoiseTriage(i)));
  for (const k of LOG_KINDS) on("log_" + k.id, () => addLogEntry(k.id));
  on("camBtn", () => lookAt(view === "leak" ? "leak" : "light"));
  on("askBtn", () => {
    const t = els.askInput ? els.askInput.value.trim() : "";
    if (!t) return;
    if (view === "leak") answerLeak(t); else answerLight(t);
  });
  if (els.askInput) {
    els.askInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = els.askInput.value.trim();
      if (!t) return;
      if (view === "leak") answerLeak(t); else answerLight(t);
    });
  }
}
