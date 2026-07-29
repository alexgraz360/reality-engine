// Reality Engine · Chemistry / Matter — what's actually happening here.
//
// THE SCOPE LINE, and it defines the whole mode:
//
//        THIS MODE EXPLAINS. IT NEVER INSTRUCTS.
//
// It describes what is going on inside something you are already looking at or
// already asking about — rust, a rising loaf, a candle, melting ice. It gives no
// procedures for making anything, and anything heading toward explosives, drugs,
// poisons, weapons or hazardous synthesis is refused in one short sentence with
// no partial hints, and then stopped. Safe home demonstrations are deliberately
// out of scope too: "try this at home" belongs in the Guide engine, which has a
// safety-prep layer built for it. An explainer has none.
//
// THE SAFETY-CRITICAL PIECE — household mixing.
// "Can I mix bleach and ammonia?" is a question people genuinely ask, and a
// hallucinated "that's fine" is a hospital visit. So the model NEVER authors
// that answer. mixAnswer() below is pure synchronous lookup against the vendored
// table in data/chemistry-safety.json: no fetch, no companion.ask, no reasoning
// step anywhere on the path. The table contains only reasons NOT to mix, so
// there is no code path that can produce permission, and a pair that isn't
// listed returns "not in my table, so don't mix it" rather than a guess.
//
// Everything else reuses what already exists: the `/vision` snapshot path
// (services.companion.vision) and the SHARED knowledge store (services.knowledge)
// — the vendored pack is ingested into that one RAG store on the bridge like
// every other pack. There is no second retrieval system here.

// The store returns its best matches, not only good ones, so "what's the atomic
// mass of ytterbium" still comes back with a chemistry chunk at ~0.63 and the
// mode would happily "answer from the pack". Measured against the shipped pack,
// genuine matches score 0.73–0.87 and irrelevant questions top out at 0.65, so
// this floor sits in the gap. Enforced app-side on purpose: telling the model
// "say so if the material doesn't cover it" is an instruction it can hallucinate
// straight past — the same lesson as the personal-memory honesty rule.
const MIN_RELEVANCE = 0.70;

let root, svc, els = {};
let table = null;                 // the vendored incompatibility table
let pack = null;                  // the vendored chemistry pack (reference cards)
let camStream = null;
let busy = false;
let last = null;                  // { kind, subject, text, sources[] } — feeds context + glance
let openCard = null;
let mixResultHtml = "";           // the mixing panel's own rendered verdict

// ---------------------------------------------------------------- the gates
// Order matters and is asserted in _gateOrder() below. Read answerFor().

// 1. Someone has already been exposed. This outranks every other branch — it is
//    the one case where the right answer is "stop reading this app".
const EXPOSURE_RE = [
  /\b(i|we|he|she|they|someone|my (child|son|daughter|kid|baby|dog|cat|partner|mum|mom|dad))\s+(just\s+)?(inhaled|breathed in|swallowed|drank|ingested|ate|got splashed)\b/i,
  /\bgot (bleach|ammonia|acid|chemicals?|cleaner|it) (in|on) (my|his|her|their|the) (eyes?|face|skin|mouth)\b/i,
  /\b(chemical burn|poisoned|poisoning|overdosed?)\b/i,
  /\b(feel|feeling|felt) (sick|dizzy|faint|lightheaded|light-headed) after\b/i,
  /\b(can'?t|cannot|trouble) breath(e|ing)\b/i,
  /\bwhat (do|should) i do if i (inhaled|breathed|swallowed|drank|touched)\b/i,
  /\bi think i (inhaled|breathed|swallowed|drank)\b/i,
];

// 2. Topics this mode refuses on sight. No everyday-chemistry explainer needs
//    them, so there is no phrasing that unlocks them — that is the point.
const HARD_TOPICS = [
  { re: /\b(explosive|explosives|bomb|bombs|detonat\w*|blasting cap|gunpowder|black powder|flash powder|thermite|napalm|molotov|pipe bomb|ied|tnt|rdx|hmx|petn|tatp|hmtd|nitroglycerin\w*|picric|anfo|ammonal|shaped charge|pyrotechnic)\b/i },
  { re: /\b(methamphetamine|\bmeth\b|amphetamine|cocaine|crack cocaine|heroin|fentanyl|carfentanil|mdma|ecstasy|\blsd\b|\bdmt\b|psilocybin|\bghb\b|ketamine|hash oil|butane honey oil|\bbho\b|cannabis oil|precursor chemicals?|pseudoephedrine|methylamine)\b/i },
  { re: /\b(nerve agent|sarin|soman|tabun|\bvx\b|mustard gas|sulfur mustard|sulphur mustard|phosgene|chemical weapon|bioweapon|biological weapon|weapons? grade|ricin|abrin|botulinum toxin)\b/i },
  { re: /\b(untraceable poison|undetectable poison|poison (someone|somebody|my|him|her|them)|kill (someone|somebody|him|her|them|my)|slip(ping)? (something|it) into (his|her|their|someone'?s) (drink|food))\b/i },
  { re: /\b(ammunition|gun ?powder|primer compound|firearm|silencer|suppressor|zip gun|napalm)\b/i },
];

// 3. Products that ARE named in our own safety answers (chlorine gas, chloramine)
//    can't be refused on mention — that would refuse the protective question
//    "does mixing bleach and vinegar give off chlorine gas?", which is exactly
//    what this mode should answer. They are refused only when the phrasing is
//    PROCEDURAL: asking how, how much, or in what ratio to produce one.
const PRODUCT_TOPICS = /\b(chlorine gas|chloramine|chloroform|mustard|tear gas|pepper spray|hydrogen sulfide|hydrogen sulphide|hydrogen cyanide|cyanide gas|toxic gas|poison gas|nerve gas|knockout (gas|drug)|chlorine dioxide)\b/i;
const PROCEDURAL_RE = /\b(how (do|can|could|would|might) (i|you|we|one|someone)|how to|how much|how many|what ratio|what proportions?|what concentration|best way to|easiest way to|steps? to|method (for|to)|recipe for|instructions? for|amounts? of|quantit(y|ies) of)\b/i;

// 4. Any request for a procedure to MAKE something. Deliberately anchored to
//    first-person procedural phrasing, because the mode's core job is questions
//    like "what makes iron rust" and "what makes bread rise" — refusing those
//    would break the mode to protect nothing.
const MAKE_INTENT = [
  /\bhow (?:do|can|could|would|should) (?:i|you|we|one)\b[^?]*\b(make|made|produce|create|synthesi[sz]e|brew|distil|distill|extract|purify|concentrate|manufacture|cook up)\b/i,
  /\bhow to\s+(make|produce|create|synthesi[sz]e|brew|distil|distill|extract|purify|concentrate|manufacture)\b/i,
  /\b(recipe|instructions?|procedure|steps|method|formula|process) (for|to) (make|making|produce|producing|creat\w+|synthesi[sz]\w+|extract\w*|distil\w*)\b/i,
  /\b(teach|show|tell|walk) me (how )?to (make|produce|create|synthesi[sz]e|brew|extract|distil|distill)\b/i,
  /\bcan (i|you|we) (make|produce|create|synthesi[sz]e|brew|extract|distil|distill)\b/i,
  /\bwhat (do i|would i|things do i|ingredients do i|chemicals do i) need to (make|produce|create|synthesi[sz]e)\b/i,
];

// 5. Identifying an unknown or suspicious substance so someone can make a SAFETY
//    decision. This is the case people will actually try, and a photo cannot
//    establish any of it — not mould species, not asbestos, not a white powder.
const SAFETY_ID = [
  /\b(is|are|could) (this|that|it|these|those)\b[^?]{0,40}\b(safe|unsafe|toxic|non-?toxic|poisonous|harmful|harmless|dangerous|hazardous|edible|carcinogenic)\b/i,
  /\b(is|are|could) (this|that|it)( be)?\b[^?]{0,30}\b(mould|mold|black mould|black mold|asbestos|lead paint|radon|mildew|dry rot|meth residue)\b/i,
  /\bwhat('?s| is) (this|that)\b[^?]{0,30}\b(powder|substance|liquid|residue|stain|spill|chemical|stuff|crystals?|film|dust)\b/i,
  /\b(identify|tell me what|work out what|figure out what)\b[^?]{0,30}\b(this|that|it)\b[^?]{0,20}\b(is|substance|powder|chemical)\b/i,
  /\b(safe|ok|okay|fine|alright) to (touch|eat|drink|breathe|inhale|handle|use|swallow)\b/i,
  /\bcan (i|we|my \w+) (touch|eat|drink|breathe|inhale|handle) (this|that|it)\b/i,
  /\bwill (this|that|it) (hurt|harm|poison|kill) (me|us|my \w+)\b/i,
];

// A photo cannot establish any of these. If the vision model says one anyway,
// the whole sentence is dropped — same discipline as Guide's repair look-check.
// Verification found the hole this second clause plugs: the first version keyed
// on words like "safe" and "non-toxic", so "You could eat off it" — a safety
// assertion with none of those words in it — sailed straight through. Permission
// to eat, drink, touch or breathe is the claim, however it happens to be phrased.
const SAFE_CLAIM_RE = new RegExp([
  /\b(safe|non-?toxic|nontoxic|harmless|edible|food[- ]safe|drinkable|potable|breathable)\b/,
  /\b(no risk|poses no|won'?t (hurt|harm|poison)|perfectly fine|not (toxic|harmful|dangerous|poisonous))\b/,
  /\b(fine|ok|okay|alright|no problem) to (eat|drink|touch|breathe|handle|use)\b/,
  /\byou (can|could|may|are able to) (safely |happily |certainly )?(eat|drink|touch|breathe|handle|lick|swallow)\b/,
  /\beat off (it|this|that|them)\b/,
  /\bno (harm|danger|hazard) (in|to|from)\b/,
  /\bwon'?t make you (sick|ill)\b/,
].map((r) => r.source).join("|"), "i");

// ---------------------------------------------------------------- refusals
// Every refusal is ONE short sentence. No lecture, no "but here's the general
// principle", no partial hint — a hint is the part that was worth refusing.
const REFUSALS = {
  hazard: "No — that's explosives, drugs, poisons or weapons territory, and I won't help with it in any form.",
  procedural: "No — I won't walk anyone through producing something like that.",
  make: "I explain what's already happening in something, I don't give procedures for making things — for cooking or a repair, Guide mode does step-by-step properly.",
  safetyId: "I can't tell you that. A photo can't identify an unknown substance or establish whether something is safe to touch, eat or breathe — for mould, asbestos, lead or a spill you don't recognise, use a proper test kit or get someone qualified to look at it in person.",
};
function exposureRefusal() {
  return "Stop and get help rather than reading this. If breathing is difficult or anyone is drowsy or unresponsive, " +
    "call your emergency number now. Otherwise contact poison control straight away — in the US that's 1-800-222-1222 — " +
    "and have the product containers with you so you can read out what was in them. Get into fresh air. " +
    "I'm not going to give any medical or first-aid advice here.";
}

// ---------------------------------------------------------------- the table
// Loaded lazily and cached, so the mixing capability answers from the router
// WITHOUT the mode being open — the safety answer shouldn't need a mode switch.
async function ensureTable() {
  if (table) return table;
  const r = await fetch(new URL("../data/chemistry-safety.json", import.meta.url));
  table = await r.json();
  return table;
}
async function ensurePack() {
  if (pack) return pack;
  const r = await fetch(new URL("../knowledge-packs/chemistry.json", import.meta.url));
  pack = await r.json();
  return pack;
}

// Which known substances does this text name?
//
// Every alias hit is collected WITH ITS SPAN, and any hit sitting inside a longer
// one is dropped. That matters across substances, not just within one: "toilet
// bowl cleaner" is an acid, but "toilet" on its own is a urine source, and
// without the span check the pair lookup would land on whichever happened to be
// listed first in the file. Plurals are matched too, because people write "two
// drain cleaners", not "two drain cleaner".
function findSubstances(text) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  const hits = [];
  for (const s of table.substances) {
    for (const alias of s.match) {
      for (const form of [alias.toLowerCase(), alias.toLowerCase() + "s"]) {
        const needle = " " + form + " ";
        let from = 0, i;
        while ((i = t.indexOf(needle, from)) !== -1) {
          hits.push({ id: s.id, label: s.label, via: alias, plural: form !== alias.toLowerCase(),
            start: i, end: i + needle.length });
          from = i + 1;
        }
      }
    }
  }
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));   // longest first
  const kept = [];
  for (const h of hits) if (!kept.some((k) => h.start >= k.start && h.end <= k.end)) kept.push(h);
  kept.sort((a, b) => a.start - b.start);                        // back into sentence order
  const seen = new Set(), out = [];
  for (const h of kept) if (!seen.has(h.id)) { seen.add(h.id); out.push(h); }
  return out;
}

function pairFor(idA, idB) {
  return table.pairs.find((p) => (p.a === idA && p.b === idB) || (p.a === idB && p.b === idA)) || null;
}

// THE DETERMINISTIC ANSWER. Pure, synchronous, table-only. No model, no network,
// no branch that can return permission — every outcome is either a listed hazard
// or "not in my table, so don't mix it".
function mixVerdict(text) {
  const found = findSubstances(text);
  const ids = [...new Set(found.map((f) => f.id))];

  // "can I mix two different drain cleaners" — one substance named, but plainly
  // two products. Only matches where the table declares a self-pair.
  if (ids.length === 1) {
    // The plural is itself the signal ("mix drain cleaners"), as is any word
    // meaning "a second one".
    const selfish = found[0].plural
      || /\b(two|2|another|other|different|second|various|several|more than one)\b/i.test(text);
    const self = table.pairs.find((p) => p.selfPair && p.a === ids[0]);
    if (self && selfish) return { known: true, pair: self, a: found[0], b: found[0], self: true };
  }
  if (ids.length >= 2) {
    const a = found.find((f) => f.id === ids[0]), b = found.find((f) => f.id === ids[1]);
    const pair = pairFor(ids[0], ids[1]);
    if (pair) return { known: true, pair, a, b };
    return { known: false, a, b };
  }
  return { known: false, a: found[0] || null, b: null };
}

// Render the verdict. Also pure — the wording comes from the table plus fixed
// strings in this file, never from a generated sentence.
function mixAnswer(text) {
  const v = mixVerdict(text);
  if (v.known) {
    const p = v.pair;
    const names = v.self ? (p.phrasing || "two of those together") : `${v.a.label} and ${v.b.label}`;
    return {
      verdict: "dont",
      pair: `${p.a}+${p.b}`,
      short: table.verdict,
      text: `${table.verdict} ${cap(names)} give off ${p.produces}. ${p.hazard}` +
        (p.notice ? ` What you'd notice: ${p.notice}` : "") +
        ` ${table.always[0]} ${table.always[1]}`,
    };
  }
  return {
    verdict: "unknown",
    pair: null,
    short: "Not in my table — don't mix it.",
    text: `${table.unknownPair} ${table.always[0]}`,
  };
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Is this a "can I mix …" question at all?
//
// This started out requiring a connector ("and"/"with") as well as a mixing
// verb, and verification caught what that cost: "should I mix two different
// drain cleaners" has no connector, so it fell straight through the table to
// the general companion — a genuinely hazardous question answered by the model,
// which is the exact failure this whole file exists to prevent. The mixing verb
// alone is now enough, because the table's worst case is "don't mix it", and
// that is the right answer to any vague mixing question.
//
// The one carve-out is explanation phrasing: "why does mixing baking soda and
// vinegar fizz" is curiosity, not a request for permission, and deserves the
// explainer. It still gets the table answer if it names a LISTED hazard, since
// there the warning IS the explanation.
const MIX_VERB = /\b(mix|mixing|mixed|combine|combining|combined|pour \w+ (in|into|onto)|add \w+ to)\b/i;
const PERMISSION_RE = /\b(can|could|should|may|ok to|safe to|alright to|fine to|dangerous to|risky to|bad to|is it (safe|ok|okay|alright|fine|dangerous)|what happens if)\b/i;
const EXPLAIN_RE = /\b(why (does|do|is|are|did)|what makes|how does|how do)\b/i;
function isMixingQuestion(text) {
  if (!MIX_VERB.test(text)) return false;
  if (EXPLAIN_RE.test(text) && !PERMISSION_RE.test(text)) return mixVerdict(text).known;
  return true;
}

// ---------------------------------------------------------------- gate runner
// The ONE ordering the whole mode's safety rests on. _gateOrder() exposes it so
// the order itself can be asserted in verification rather than only its effects.
function gateCheck(text) {
  const t = String(text || "");
  if (EXPOSURE_RE.some((re) => re.test(t))) return { gate: "exposure", text: exposureRefusal() };

  // Mixing is checked BEFORE the topic gate on purpose: "does bleach and vinegar
  // make chlorine gas" must reach the protective table answer, not be refused
  // for naming a gas. Procedural phrasing inside a mixing question is still
  // refused first, so "how much bleach do I need to make chlorine gas" doesn't
  // slip through this door.
  if (isMixingQuestion(t)) {
    if (HARD_TOPICS.some((h) => h.re.test(t))) return { gate: "hazard", text: REFUSALS.hazard };
    if (PRODUCT_TOPICS.test(t) && PROCEDURAL_RE.test(t)) return { gate: "procedural", text: REFUSALS.procedural };
    if (MAKE_INTENT.some((re) => re.test(t))) return { gate: "make", text: REFUSALS.make };
    return { gate: "mix", mix: mixAnswer(t) };
  }

  if (HARD_TOPICS.some((h) => h.re.test(t))) return { gate: "hazard", text: REFUSALS.hazard };
  if (PRODUCT_TOPICS.test(t) && PROCEDURAL_RE.test(t)) return { gate: "procedural", text: REFUSALS.procedural };
  if (MAKE_INTENT.some((re) => re.test(t))) return { gate: "make", text: REFUSALS.make };
  if (SAFETY_ID.some((re) => re.test(t))) return { gate: "safetyId", text: REFUSALS.safetyId };
  return null;
}

// ---------------------------------------------------------------- ASK
// Retrieval-grounded, through the EXISTING shared store. If nothing comes back
// above the store's own threshold, we say so rather than letting the model fill
// the gap from memory — same discipline as the personal-memory honesty rule.
async function askChemistry(question) {
  const gate = gateCheck(question);
  if (gate) return gateResult(gate, question);

  const hits = await svc.knowledge.search(question, { context: "everyday chemistry: what is happening and why", topK: 3 });
  const chem = relevant(hits);
  if (!chem.length) {
    return finish({
      kind: "ask", subject: question,
      text: "I don't have anything on that in my chemistry pack, and I'm not going to invent it. " +
        "Try asking it another way, or have a look at the reference cards below for what is in there.",
      sources: [],
    });
  }
  const prompt =
    "You are explaining everyday chemistry to a curious adult. Answer the question using ONLY the reference " +
    "material below. If the material doesn't cover it, say so plainly instead of filling the gap. Two or three " +
    "short paragraphs at most, plain language, no lists. Explain what is happening and why — do NOT give any " +
    "procedure or instructions for making anything, and do not state that anything is safe to touch, eat or breathe.\n\n" +
    "REFERENCE MATERIAL:\n" + svc.knowledge.format(chem) +
    "\n\nQUESTION: " + question;
  const res = await svc.companion.ask(prompt, "", [], { temperature: 0.2, maxTokens: 420 });
  if (!res.ok) return finish({ kind: "ask", subject: question, text: res.text, sources: [] });
  return finish({
    kind: "ask", subject: question, text: dropSafeClaims(res.text).text,
    sources: chem.map((h) => ({ pack: h.packLabel || h.pack, title: h.title })),
  });
}

// Reference chunks good enough to actually answer from. Anything weaker is
// treated as "I don't have this", which is the honest outcome.
function relevant(hits) {
  return (hits || []).filter((h) =>
    (h.pack === "chemistry" || h.source === "pack") && Number(h.score) >= MIN_RELEVANCE);
}

// Drop any sentence asserting something is safe/edible/harmless. Sentence-level
// rather than word-level: surgically rewriting model prose yields mangled
// half-claims, and a half-claim about safety is worse than no sentence.
function dropSafeClaims(s) {
  const sentences = String(s || "").match(/[^.!?]+[.!?]?/g) || [String(s || "")];
  const dropped = [];
  const kept = sentences.filter((sent) => {
    if (SAFE_CLAIM_RE.test(sent)) { dropped.push(sent.trim()); return false; }
    return true;
  });
  if (dropped.length) console.warn("chemistry: dropped a safety assertion:", dropped);
  return { text: kept.join("").replace(/\s+/g, " ").trim(), dropped };
}

// ---------------------------------------------------------------- LOOK
async function enableCamera() {
  if (camStream) return true;
  try {
    camStream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    els.cam.srcObject = camStream;
    els.cam.style.display = "";
    els.shade.style.display = "none";
    await els.cam.play();
    render();
    return true;
  } catch (err) {
    return false;
  }
}

// readyState >= 2 matters: without it the first frames encode as a blank image
// and the vision model confidently describes nothing (the Football watch bug).
function grabFrame() {
  const v = els.cam;
  if (!camStream || !v || v.readyState < 2 || !v.videoWidth) return null;
  const MAX = 768;
  const scale = Math.min(1, MAX / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(v.videoWidth * scale));
  c.height = Math.max(1, Math.round(v.videoHeight * scale));
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  const b64 = c.toDataURL("image/jpeg", 0.7).split(",")[1];
  return b64 && b64.length > 2000 ? b64 : null;   // reject a trivially-empty encode
}

async function look() {
  if (busy) return "Still working on the last one.";
  if (!camStream) {
    const ok = await enableCamera();
    if (!ok) return finish({ kind: "look", subject: "", sources: [],
      text: "I couldn't get the camera — check the permission, then try again." });
    await new Promise((r) => setTimeout(r, 400));   // let the first real frames land
  }
  const b64 = grabFrame();
  if (!b64) return finish({ kind: "look", subject: "", sources: [],
    text: "The camera isn't giving me a usable frame yet — give it a second and try again." });
  return lookWithFrame(b64);
}

// The vision reply is parsed, not trusted as prose: an explicit UNSURE or a low
// confidence stops here and says so, rather than naming a substance anyway.
async function lookWithFrame(b64) {
  busy = true; render();
  try {
    const prompt =
      "Look at this photo and identify the main material, object or process in it. Reply in exactly this format " +
      "and nothing else:\nMATERIAL: <a few words, or the single word UNSURE>\nCONFIDENCE: <high, medium or low>\n" +
      "SEEN: <one sentence describing only what is visibly there>\n" +
      "Use UNSURE if you cannot tell. Do NOT say whether anything is safe, toxic, edible or harmful, and do not " +
      "identify an unknown powder, residue, mould or building material.";
    const res = await svc.companion.vision(b64, prompt);
    if (!res.ok) return finish({ kind: "look", subject: "", text: res.text, sources: [] });

    const raw = res.text || "";
    const material = (raw.match(/MATERIAL:\s*(.+)/i) || [, ""])[1].trim().replace(/[.*]+$/, "");
    const confidence = (raw.match(/CONFIDENCE:\s*(high|medium|low)/i) || [, ""])[1].toLowerCase();
    const seen = dropSafeClaims((raw.match(/SEEN:\s*(.+)/i) || [, ""])[1] || "").text;

    if (!material || /^unsure/i.test(material) || confidence === "low") {
      return finish({
        kind: "look", subject: "", confidence: "low",
        text: "I can't tell what that is from the photo, so I'm not going to guess. Try getting closer, " +
          "filling more of the frame, and using better light — and if what you actually need is to know whether " +
          "something is safe, a photo can never establish that.",
        sources: [],
      });
    }
    // A safety-identification request wearing a photo. Same refusal as the typed one.
    if (SAFETY_ID.some((re) => re.test(material))) {
      return finish({ kind: "look", subject: material, text: REFUSALS.safetyId, sources: [] });
    }

    const hits = await svc.knowledge.search(`${material} — what is happening chemically`, {
      context: "everyday chemistry: what is happening and why", topK: 3,
    });
    const chem = relevant(hits);
    const idLine = `Looks like ${material} — that identification is approximate, from one photo.` +
      (seen ? ` ${cap(seen)}` : "");

    if (!chem.length) {
      return finish({
        kind: "look", subject: material, confidence,
        text: `${idLine}\n\nI don't have anything on ${material} in my chemistry pack, though, so I'll leave the ` +
          "explanation there rather than making one up.",
        sources: [],
      });
    }
    const prompt2 =
      `Someone is looking at ${material}. Using ONLY the reference material below, explain the chemistry of what ` +
      "is happening in it — two short paragraphs, plain language, no lists. If the material doesn't cover it, say " +
      "so plainly. Do not give any procedure for making anything, and do not state that anything is safe to touch, " +
      "eat or breathe.\n\nREFERENCE MATERIAL:\n" + svc.knowledge.format(chem);
    const out = await svc.companion.ask(prompt2, "", [], { temperature: 0.2, maxTokens: 400 });
    return finish({
      kind: "look", subject: material, confidence,
      text: idLine + "\n\n" + (out.ok ? dropSafeClaims(out.text).text : out.text),
      sources: chem.map((h) => ({ pack: h.packLabel || h.pack, title: h.title })),
    });
  } finally {
    busy = false; render();
  }
}

// ---------------------------------------------------------------- results
function finish(result) {
  last = result;
  render();
  return result.text;
}
function gateResult(gate, question) {
  if (gate.gate === "mix") {
    last = { kind: "mix", subject: question, text: gate.mix.text, short: gate.mix.short,
      verdict: gate.mix.verdict, sources: [{ pack: "Vendored safety table", title: "household incompatibilities" }] };
    render();
    return gate.mix.text;
  }
  last = { kind: "refusal", gate: gate.gate, subject: question, text: gate.text, sources: [] };
  render();
  return gate.text;
}

// ---------------------------------------------------------------- mode
export default {
  id: "chemistry",
  title: "Chemistry · what's happening here",
  icon: "🧪",
  family: "Learn",
  permissions: ["camera", "mic"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    root.innerHTML = `
      <video data-el="cam" playsinline muted autoplay
        style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000; display:none;"></video>
      <div data-el="shade" style="position:absolute; inset:0; background:radial-gradient(120% 90% at 50% 0%, #101c1a 0%, var(--bg) 70%);"></div>
      <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:14px 14px 220px;"></div>`;
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    await Promise.all([ensureTable(), ensurePack()]);
    render();
  },

  async start() {},
  stop() { if (camStream) { svc.sensors.releaseStream(camStream); camStream = null; } },
  teardown() { this.stop(); last = null; openCard = null; els = {}; root = null; },

  getContext() {
    if (!last) return "Chemistry mode — explains what's happening in everyday materials and processes. It never gives procedures for making anything.";
    if (last.kind === "mix") {
      return `Chemistry mode — just answered a household mixing question from the vendored safety table: ${last.short} ` +
        "That answer comes from data, not from the model, and must not be contradicted or softened.";
    }
    if (last.kind === "refusal") {
      return "Chemistry mode — just refused a request that's outside its scope (it explains, it never instructs). Do not answer it another way.";
    }
    return `Chemistry mode — ${last.kind === "look" ? "looking at" : "explaining"} ${last.subject || "something"}. ` +
      (last.text || "").slice(0, 400);
  },

  // Text-only HUD card. A mixing verdict takes priority and leads with the
  // refusal, because that's the one you need to read before you pour.
  getGlanceCard() {
    if (!last || !last.text) return null;
    const wrap = (svc && svc.glasses && svc.glasses.wrap) ? svc.glasses.wrap : (t) => [String(t).slice(0, 24)];
    if (last.kind === "mix") {
      return { title: last.verdict === "dont" ? "Don't mix" : "Not in my table",
        lines: wrap(last.short === undefined ? "Don't mix it." : last.short, 24, 4),
        spoken: last.text, holdMs: 15000, priority: "high" };
    }
    if (last.kind === "refusal") {
      return { title: "Out of scope", lines: wrap(last.text, 24, 4), spoken: last.text, holdMs: 9000 };
    }
    return { title: (last.subject || "Chemistry").slice(0, 20),
      lines: wrap(last.text.replace(/\s+/g, " "), 24, 4), spoken: last.text, holdMs: 12000 };
  },

  describeCapabilities() {
    return [
      {
        id: "chem.mix", label: "Chemistry · mixing check", needsMode: false,
        // Answered from the vendored table with NO mode switch and NO model —
        // the safety answer shouldn't cost you a mode change or a round-trip.
        // A catch-all "(mix|combine) X and Y" pattern was the first cut, and the
        // router regression caught what it cost: "mix the flour and the butter
        // until smooth" matched at full confidence and would have answered a
        // cooking instruction with a safety refusal. Routing now needs either
        // permission framing or a named household chemical. The TABLE is still
        // the authority on substances — this short list only decides whether the
        // question is offered to the mixing check at all.
        patterns: [/\bcan (i|we|you) (safely )?(mix|combine|pour)\b/i,
                   /\bshould (i|we) (mix|combine|pour)\b/i,
                   /\bis it (safe|ok|okay|alright|dangerous|bad|risky) to (mix|combine|pour)\b/i,
                   /\bwhat happens if (i|we|you) (mix|combine|pour)\b/i,
                   /\b(safe|dangerous|bad|risky|ok) to (mix|combine)\b/i,
                   /\b(mix|mixing|mixed|combine|combining|combined|pour|pouring)\b[^.?!]{0,40}\b(bleach|ammonia|vinegar|hydrogen peroxide|drain cleaner|drain cleaners|oven cleaner|caustic soda|lye|rubbing alcohol|toilet cleaner|toilet bowl cleaner|descaler|muriatic acid)\b/i],
        examples: ["can I mix bleach and ammonia", "is it safe to mix bleach and vinegar",
                   "what happens if I mix drain cleaner and bleach"],
        run: async (text) => { await ensureTable(); const g = gateCheck(text); return g ? (g.gate === "mix" ? g.mix.text : g.text) : null; },
      },
      {
        id: "chem.look", label: "Chemistry · look", needsMode: true,
        patterns: [/\bwhat'?s (this|that|it) made (of|out of)\b/i,
                   /\bwhat (is|are) (this|that|these) made (of|from)\b/i,
                   /\bwhat'?s happening (to|in|with) (this|that|it)\b/i,
                   /\b(explain|what'?s) the chemistry (of|behind|in) (this|that|it)\b/i],
        // Examples deliberately carry distinctive content words. The first cut
        // led every one with a bare "what's", which the keyword scorer shares
        // with any generic question — "what's the weather like" scored 0.38
        // against them, high enough to cost a model-classifier round-trip it
        // never used to pay for.
        examples: ["what is this rust made of", "what's happening to this metal",
                   "explain the chemistry of this stain"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
      },
      {
        id: "chem.ask", label: "Chemistry · explain", needsMode: true,
        patterns: [/\bwhy (does|do|is|are) .+\b(rust|rusts|dissolve|dissolves|melt|melts|freeze|freezes|boil|boils|burn|burns|burnt|fizz|fizzes|foam|foams|tarnish|curdle|curdles|evaporate|corrode|corrodes|oxidi[sz]e|rise|stick|stain)\b/i,
                   /\bwhy (does|do) .+ (go|goes|turn|turns) (stale|off|sour|brown|green|black|hard|flat|rancid|mouldy|moldy|cloudy)\b/i,
                   /\b(explain|what'?s) the chemistry (of|behind)\b/i,
                   /\bwhat('?s| is) (actually )?happening when\b/i],
        examples: ["why does iron rust", "why does bread go stale", "what's the chemistry behind soap",
                   "why does salt melt ice"],
        run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
      },
    ];
  },

  handleCommand(text) {
    const q = String(text || "").trim();
    if (!q) return null;
    if (/^(look|look at this|what'?s this|what is this|explain this|what'?s this made of|what am i looking at)\??$/i.test(q)) {
      return look();
    }
    const gate = gateCheck(q);
    if (gate) return gateResult(gate, q);
    // Only take questions that are plausibly for this mode; anything else falls
    // through to the normal companion answer, grounded by getContext().
    if (/\b(why|what|how come|chemistry|reaction|react|molecul|atom|acid|alkali|oxidi|dissolve|melt|boil|burn|rust)\b/i.test(q)) {
      return askChemistry(q);
    }
    return null;
  },

  // ---------------- verification hooks ----------------
  _gate: (t) => gateCheck(t),
  _gateOrder: () => ["exposure", "mixing(hazard→procedural→make→table)", "hazard", "procedural", "make", "safetyId", "ask"],
  _mix: (t) => mixAnswer(t),
  _mixVerdict: (t) => mixVerdict(t),
  _substances: (t) => findSubstances(t),
  _table: () => table,
  _pack: () => pack,
  _ask: (t) => askChemistry(t),
  _look: (b64) => lookWithFrame(b64),
  _relevance: () => MIN_RELEVANCE,
  _relevant: (hits) => relevant(hits),
  _dropSafeClaims: (s) => dropSafeClaims(s),
  _last: () => last,
  _ready: () => !!(table && pack),
};

// ---------------------------------------------------------------- rendering
function render() {
  if (!els.wrap || !table) return;
  const w = els.wrap;
  const scroll = w.scrollTop;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px;">🧪 What's happening here?</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
        Point at something and I'll explain the chemistry underneath it — rust, a rising loaf, a candle, melting ice.
        <b style="color:var(--fg)">This mode explains; it doesn't instruct.</b> It gives no procedures for making anything,
        and safe home demos live in Guide, which has the safety layer for them.
      </div>

      <div class="card" style="min-height:0; display:block; margin-bottom:10px;">
        <div class="name" style="margin-bottom:6px;">📷 Look at something</div>
        <div style="color:var(--dim); font-size:12px; line-height:1.45; margin-bottom:8px;">
          One snapshot to your own bridge. The identification is approximate — and if it can't tell, it says so
          instead of naming something.
        </div>
        <button class="fbChip on" data-el="lookBtn" style="width:100%;">${busy ? "Looking…" : (camStream ? "Explain what I'm pointing at" : "Turn on the camera")}</button>
      </div>

      <div class="card" style="min-height:0; display:block; margin-bottom:10px;">
        <div class="name" style="margin-bottom:6px;">💬 Ask about everyday chemistry</div>
        <div style="display:flex; gap:6px;">
          <input data-el="askIn" placeholder="why does salt melt ice?" inputmode="text"
            style="flex:1; min-width:0; background:var(--card2, #0e1524); color:var(--fg); border:1px solid var(--line, #23304a);
                   border-radius:9px; padding:9px 10px; font-size:13.5px;">
          <button class="fbChip" data-el="askBtn">Ask</button>
        </div>
      </div>

      ${mixPanel()}
      ${answerPanel()}
      ${cardsPanel()}

      <div style="color:var(--dim); font-size:11.5px; line-height:1.5; margin:14px 2px 0;">
        Explanations are educational, not a safety determination — product labels and safety data sheets win every time.
        Nothing here identifies an unknown substance, and nothing here will tell you something is safe to touch, eat or
        breathe. If someone has been exposed to something, contact poison control rather than an app.
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  w.scrollTop = scroll;
  wire();
}

function mixPanel() {
  const opts = (sel) => table.substances.map((s) =>
    `<option value="${s.id}"${sel === s.id ? " selected" : ""}>${escapeHtml(s.label)}</option>`).join("") +
    `<option value="__other__">something else…</option>`;
  const r = mixResultHtml;
  return `
    <div class="card" style="min-height:0; display:block; margin-bottom:10px;">
      <div class="name" style="margin-bottom:6px;">⚠️ Can I mix these?</div>
      <div style="color:var(--dim); font-size:12px; line-height:1.45; margin-bottom:8px;">
        Answered from a vendored table of well-known household hazards — <b style="color:var(--fg)">not by the AI</b>.
        The table only lists combinations to avoid, so it will never tell you a mix is fine; anything it doesn't list
        comes back as "don't".
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <select data-el="mixA" style="flex:1; min-width:0; background:var(--card2, #0e1524); color:var(--fg);
          border:1px solid var(--line, #23304a); border-radius:9px; padding:9px 6px; font-size:12.5px;">${opts("bleach")}</select>
        <span style="color:var(--dim); font-size:12px;">+</span>
        <select data-el="mixB" style="flex:1; min-width:0; background:var(--card2, #0e1524); color:var(--fg);
          border:1px solid var(--line, #23304a); border-radius:9px; padding:9px 6px; font-size:12.5px;">${opts("ammonia")}</select>
        <button class="fbChip" data-el="mixBtn">Check</button>
      </div>
      <div data-el="mixOut" style="margin-top:9px; font-size:13px; line-height:1.55; ${r ? "" : "display:none;"}">${r || ""}</div>
    </div>`;
}

function answerPanel() {
  if (!last || !last.text) return "";
  const tone = last.kind === "mix"
    ? "border-color:#7a2530; background:rgba(122,37,48,.16);"
    : last.kind === "refusal" ? "border-color:#5a4a20; background:rgba(90,74,32,.14);" : "";
  const src = (last.sources && last.sources.length)
    ? `<div class="footNote" style="margin-top:8px; font-size:11px; color:var(--dim);">📚 ${
        last.sources.map((s) => escapeHtml(`${s.pack}: ${s.title}`)).join(" · ")}</div>`
    : "";
  const head = last.kind === "mix" ? "⚠️ From the safety table"
    : last.kind === "refusal" ? "Out of scope"
    : last.kind === "look" ? `🔍 ${escapeHtml(last.subject || "Look")}` : "💬 Explanation";
  return `
    <div class="card" style="min-height:0; display:block; margin-bottom:10px; ${tone}">
      <div class="name" style="margin-bottom:6px;">${head}</div>
      <div style="font-size:13.5px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(last.text)}</div>
      ${last.kind === "look" && last.subject ? `<div class="footNote" style="margin-top:8px; font-size:11px; color:var(--dim);">Identification from one photo — approximate.</div>` : ""}
      ${src}
    </div>`;
}

// The reference cards read the vendored pack file directly. That is rendering,
// not retrieval — there is still exactly ONE search path (services.knowledge),
// and reading the file means the cards work with the bridge asleep.
function cardsPanel() {
  if (!pack) return "";
  const groups = {};
  for (const e of pack.entries) (groups[e.topic || "everyday"] = groups[e.topic || "everyday"] || []).push(e);
  const names = { everyday: "Everyday things", oxidation: "Rust, tarnish & oxidation", acids: "Acids & bases",
    states: "States of matter", materials: "Materials" };
  return `
    <div style="margin-top:14px;">
      <div style="font-size:13px; font-weight:600; margin:0 2px 8px;">📚 Reference — ${pack.entries.length} explainers</div>
      ${Object.keys(groups).map((k) => `
        <div style="margin-bottom:10px;">
          <div style="color:var(--dim); font-size:11.5px; margin:0 2px 5px;">${names[k] || k}</div>
          ${groups[k].map((e) => {
            const open = openCard === e.title;
            return `<button class="card" data-card="${escapeHtml(e.title)}"
              style="min-height:0; width:100%; display:block; text-align:left; margin-bottom:6px;">
              <span class="name" style="font-size:13px;">${escapeHtml(e.title)}</span>
              ${open ? `<span class="blurb" style="display:block; margin-top:6px; line-height:1.6;">${escapeHtml(e.text)}</span>` : ""}
            </button>`;
          }).join("")}
        </div>`).join("")}
    </div>`;
}

function wire() {
  if (els.lookBtn) els.lookBtn.onclick = async () => {
    // First tap turns the camera on so you can aim; the second one takes the shot.
    if (!camStream) { const ok = await enableCamera(); if (!ok) els.lookBtn.textContent = "Camera unavailable"; return; }
    await look();
  };
  if (els.askBtn) els.askBtn.onclick = () => runAsk();
  if (els.askIn) els.askIn.onkeydown = (e) => { if (e.key === "Enter") runAsk(); };
  if (els.mixBtn) els.mixBtn.onclick = () => {
    const a = els.mixA.value, b = els.mixB.value;
    const labelOf = (id) => (table.substances.find((s) => s.id === id) || {}).label || "something else";
    // "something else" is a genuinely unknown substance, and the table's answer
    // for that is the same one it gives any unlisted pair: don't.
    const phrase = (a === "__other__" || b === "__other__")
      ? `can I mix ${a === "__other__" ? "an unlisted product" : labelOf(a)} and ${b === "__other__" ? "an unlisted product" : labelOf(b)}`
      : `can I mix ${labelOf(a)} and ${labelOf(b)}`;
    const ans = (a === "__other__" || b === "__other__")
      ? { verdict: "unknown", short: "Not in my table — don't mix it.", text: `${table.unknownPair} ${table.always[0]}` }
      : mixAnswer(phrase);
    mixResultHtml = `<b style="color:${ans.verdict === "dont" ? "var(--bad, #ff6b6b)" : "var(--fg)"};">${escapeHtml(ans.short)}</b> ${escapeHtml(ans.text.replace(ans.short, "").trim())}`;
    last = { kind: "mix", subject: phrase, text: ans.text, short: ans.short, verdict: ans.verdict,
      sources: [{ pack: "Vendored safety table", title: "household incompatibilities" }] };
    render();
    if (svc && svc.speak) svc.speak(ans.text);
  };
  for (const b of els.wrap.querySelectorAll("[data-card]")) {
    b.onclick = () => { openCard = openCard === b.dataset.card ? null : b.dataset.card; render(); };
  }
}

async function runAsk() {
  const q = (els.askIn && els.askIn.value || "").trim();
  if (!q || busy) return;
  busy = true; render();
  try { await askChemistry(q); } finally { busy = false; render(); }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
