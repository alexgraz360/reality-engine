// Guide — hands-free apprenticeship mode (P0: cooking). The Coaching pipeline
// (Demonstrate → Observe → Correct → Repeat → Fade) built by COMPOSING existing
// services: one glanceable step at a time (spoken via services.speak), voice
// commands via the shell's handleCommand hook (the companion mic/loop — no new
// recognizer), step timers via services.actions (the existing reminders layer),
// and "how does this look?" via services.companion.vision seeded with the
// current step's doneness cue.
//
// FOOD-SAFETY HONESTY: for meat/poultry/egg/fish doneness the vision feedback
// ALWAYS defers to a thermometer — appended deterministically app-side, never
// left to the model. A photo can't declare food safe.

// SECOND DOMAIN (repair/assembly) — the same engine, richer packs. A pack now
// declares a `domain`, and repair packs add tools/parts/safety and a REQUIRED
// verify step. Cooking packs are unchanged and need none of it.
//
// REPAIR SAFETY, and it is not decoration:
//   • safety[] is shown BEFORE step 1 and must be acknowledged to continue.
//   • A "stop and call a professional" control is available on every step.
//   • A HARD HAZARD GATE refuses gas, mains wiring, structural, roof/ladder and
//     similar — for built-in scope AND for AI drafting. It produces no steps at
//     all, because a half-drafted procedure is worse than a refusal.

const SAFETY_RE = /(chicken|poultry|meat|beef|pork|turkey|lamb|sausage|burger|egg|fish|salmon|shrimp|prawn|seafood)/i;
// A photo cannot establish any of these. If the vision model claims one anyway,
// the sentence is dropped — see visionCheckWithFrame.
const SAFE_CLAIM_RE = /\b(safe|secure(ly)?|watertight|airtight|sealed|leak[- ]free|properly tightened|correctly (fitted|installed|tightened)|good to (go|use)|ready to use|no leaks?)\b/i;
const MAX_AI_STEPS = 20;

// The refuse list. Deliberately broad: a false refusal costs someone a DIY job,
// a false accept can cost them a house or a life.
const HAZARD_RULES = [
  { re: /\b(gas|propane|butane|lpg|boiler|furnace|water heater|pilot light|gas (line|pipe|valve|meter|hob|cooker|oven|fire))\b/i,
    why: "anything on a gas appliance or gas line" },
  { re: /\b(mains|wiring|rewire|rewiring|outlet|socket|breaker|fuse ?box|consumer unit|circuit|electrical panel|junction box|live wire|earth wire|240v|120v|light fitting|ceiling rose)\b/i,
    why: "household mains wiring" },
  { re: /\b(load[- ]bearing|structural|joist|rafter|lintel|foundation|supporting wall|remove a wall|knock through)\b/i,
    why: "structural work" },
  { re: /\b(roof|chimney|gutter|ladder|scaffold|working at height|second storey|second story)\b/i,
    why: "roof, gutter or ladder work" },
  { re: /\b(asbestos|lead paint|mould remediation|sewage|septic)\b/i,
    why: "hazardous material" },
  { re: /\b(brake|airbag|steering|suspension|fuel (line|tank|pump))\b/i,
    why: "safety-critical vehicle work" },
];
function hazardCheck(text) {
  const t = String(text || "");
  for (const r of HAZARD_RULES) if (r.re.test(t)) return r.why;
  return null;
}
function refusalFor(why) {
  return `That one's for a professional — it involves ${why}, where a mistake can injure ` +
    `someone or cause serious damage, and I can't verify your setup from here. I'm not going to ` +
    `draft steps for it. A qualified tradesperson is the right call.`;
}

let root, svc, els = {};
let recipes = [];                 // vendored packs (cooking + repair)
let triageTree = [], triageStops = {};
let recipe = null;                // active pack
let aiDrafted = false;
let idx = 0;
let phase = "pick";               // "pick" | "safety" | "steps" | "finish" | "triage"
let camStream = null;
let timerRec = null;              // { id, dueMs, label } — lives in the reminders layer
let tickId = 0;
let drafting = false;
let pickerDomain = "cooking";     // which list the picker shows
let safetyAcked = false;
let triageNode = null;
let triageStopMsg = "";

// A pack's steps plus its verify step, which is just the final step with a flag —
// so next/back/repeat/timers/glance cards all work on it with no special cases.
function stepsOf(p) {
  if (!p) return [];
  if (p._steps) return p._steps;
  const list = (p.steps || []).slice();
  if (p.verify) list.push({ ...p.verify, isVerify: true });
  p._steps = list;
  return list;
}
function isRepair(p) { return !!p && p.domain === "repair"; }
// `checkCue` is the generic name; `donenessCue` is what the cooking packs use
// and keeps working untouched.
function cueOf(s) { return (s && (s.checkCue || s.donenessCue)) || ""; }

export default {
  id: "guide",
  title: "Guide · cook with me",
  icon: "🍳",
  family: "Learn",
  permissions: ["camera", "mic"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    root.innerHTML = `
      <video data-el="cam" playsinline muted autoplay
        style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000; display:none;"></video>
      <div data-el="shade" style="position:absolute; inset:0; background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%);"></div>
      <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
        padding: 14px 14px 220px;"></div>`;
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    // Both pack sets load into ONE list — same engine, two domains. Cooking
    // packs carry no `domain` field, so they're tagged here rather than edited.
    recipes = [];
    try {
      const r = await fetch(new URL("../data/recipes.json", import.meta.url));
      const cooking = (await r.json()).recipes || [];
      recipes.push(...cooking.map((p) => ({ ...p, domain: p.domain || "cooking" })));
    } catch (e) { console.error("recipes failed to load:", e); }
    try {
      const r2 = await fetch(new URL("../data/repairs.json", import.meta.url));
      const rep = await r2.json();
      recipes.push(...(rep.packs || []).map((p) => ({ ...p, domain: p.domain || "repair" })));
      triageTree = rep.triage || [];
      triageStops = rep.triageStops || {};
    } catch (e) { console.error("repairs failed to load:", e); }
    renderPicker();
  },

  async start() {
    if (!tickId) tickId = setInterval(uiTick, 1000);
  },

  stop() {
    clearInterval(tickId);
    tickId = 0;
  },

  teardown() {
    this.stop();
    if (camStream) { svc.sensors.releaseStream(camStream); camStream = null; }
    recipe = null; idx = 0; phase = "pick"; timerRec = null; aiDrafted = false;
    safetyAcked = false; triageNode = null; triageStopMsg = "";
    els = {}; root = null;
  },

  // Lets the Build-family entry open straight into the repair picker. Same
  // module, same engine — just which list you land on.
  _setDomain(d) { pickerDomain = d === "repair" ? "repair" : "cooking"; },

  // Voice intent router: what Guide answers from anywhere. Static data.
  // Voice intent router — the COOKING half. The repair entry (modes/repair.js)
  // declares the fix/triage half against its own mode id, so "guide me through
  // making pasta" and "guide me through fixing the sink" land in the right
  // picker rather than fighting over one capability id.
  describeCapabilities() {
    return [{
      id: "guide.cook", label: "Guide", needsMode: true, fillsSlots: true,
      patterns: [/\bguide me through (?!fixing|repairing|replacing|unclogging|unblocking|assembling|installing|fitting|mending)/i,
                 /\bguide me to make\b/i,
                 /\b(walk|talk) me through (making|cooking)\b/i,
                 /\bhelp me (cook|make)\b/i],
      examples: ["guide me through making pasta", "walk me through cooking chicken", "help me cook rice"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  // ---------------------------------------------------------------- slots
  // "Guide me through fixing the sink" already names the job — the picker was
  // never needed for that sentence, it was just the only way in.
  //
  // The pack slot is REQUIRED but declares no `ask`, because Guide already has
  // something better than a question: the voice TRIAGE, which narrows by asking
  // about symptoms rather than making you know the pack's name. So an unresolved
  // pack falls to triage (below) instead of "which recipe?".
  //
  // THE HAZARD GATE IS NOT A SLOT and must not become one. It runs inside
  // draftRecipe/draftRepair before any model call, and a slot resolving a pack
  // name can never reach a gas or mains job because those aren't in the packs.
  describeSlots() {
    // Match on the DISTINCTIVE nouns in a pack's title, not the whole title.
    // "Guide me through fixing the sink" shares exactly one word with "Unclog a
    // slow sink", and an earlier version that demanded two silently fell through
    // to AI-drafting a procedure when a vendored, verified pack was sitting right
    // there. Verbs like "fix" are stripped because every pack is a fix.
    const STOPW = new Set(["fix", "fixing", "a", "an", "the", "or", "and", "slow", "how", "to",
      "guide", "me", "through", "with", "my", "your", "help", "walk", "talk", "make", "making",
      "cook", "cooking", "assemble", "unclog", "repair", "mend", "pan", "soft", "crispy"]);
    const matchPack = (t) => {
      const s = " " + String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
      let best = null, bestScore = 0;
      for (const p of recipes) {
        const words = [
          ...String(p.title).toLowerCase().split(/[^a-z0-9]+/),
          ...(p.keywords || []).map((x) => String(x).toLowerCase()),
        ].filter((w) => w.length >= 3 && !STOPW.has(w));
        // Score by how much of the pack's identity the sentence actually names:
        // longer, rarer words count for more than short common ones.
        let score = 0;
        for (const w of new Set(words)) if (s.includes(" " + w + " ")) score += w.length;
        if (score > bestScore) { best = p.id; bestScore = score; }
      }
      return bestScore >= 3 ? best : null;
    };
    return [{
      id: "pack", label: "to know what you're working on", required: true,
      sources: ["utterance", "context"],
      parse: matchPack,
      fromContext: () => (recipe ? recipe.id : null),
      current: () => (recipe ? recipe.id : null),
      apply: (id) => { const r = recipes.find((x) => x.id === id); if (r) selectRecipe(r, false); },
      say: (id) => { const r = recipes.find((x) => x.id === id); return r ? r.title : "that one"; },
    }];
  },

  getContext() {
    if (phase === "pick") return `Guide Mode — choosing a ${pickerDomain === "repair" ? "repair or assembly job" : "recipe to cook"}.`;
    if (phase === "triage") return "Guide Mode — working out what's wrong before starting a repair.";
    if (!recipe) return "Guide Mode.";
    const rep = isRepair(recipe);
    if (phase === "finish") return `Guide Mode — just finished ${rep ? "the repair" : "cooking"} “${recipe.title}”.`;
    if (phase === "safety") return `Guide Mode — about to start “${recipe.title}”, reading the safety prep first.`;
    const list = stepsOf(recipe);
    const s = list[idx];
    let out = `Guide Mode — ${rep ? "fixing" : "cooking"} “${recipe.title}”${aiDrafted ? " (AI-drafted, unverified)" : ""}. ` +
      (s.isVerify ? "Final check" : `Step ${idx + 1} of ${list.length}`) + `: ${s.text}`;
    if (cueOf(s)) out += ` (cue: ${cueOf(s)})`;
    const left = timerLeftMs();
    if (left !== null) out += ` Timer running: ${fmtLeft(left)} left.`;
    return /[.!?]$/.test(out) ? out : out + ".";
  },

  // Glasses hook (additive): the current step is already the right shape for a
  // HUD — one instruction, a cue, a timer. null while picking/finished.
  getGlanceCard() {
    if (phase !== "steps" || !recipe) return null;
    const list = stepsOf(recipe);
    const s = list[idx];
    const left = timerLeftMs();
    // A running timer is the single most glanceable thing, so it takes line 1;
    // the step text wraps across the remaining lines rather than being truncated
    // to one. The full step is always in `spoken`.
    const lines = [];
    if (left !== null) lines.push(`⏱ ${fmtLeft(left)} left`);
    for (const w of wrapText(s.text, 24, 4 - lines.length)) lines.push(w);
    return {
      title: s.isVerify ? "Final check" : `Step ${idx + 1}/${list.length}`,
      lines,
      spoken: cueOf(s) ? `${s.text} Cue: ${cueOf(s)}.` : s.text,
      holdMs: 9000,
    };
  },

  // Voice/typed commands from the shell's companion input. Return a string (or
  // a Promise of one) to handle locally — spoken via the normal speak path —
  // or null to let the question fall through to the model (with getContext).
  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?']/g, "").trim();
    const m = q.match(/(?:guide me through|walk me through|help me) (?:fixing |repairing |making |cooking )?(.+)/);
    if (m) return draftRecipe(m[1].trim());
    if (/\b(stop|call) (and call )?(a )?professional\b|\bcall someone\b|\bthis is beyond me\b/.test(q)) {
      return callProfessional();
    }
    if (phase === "safety") {
      // Deliberate acknowledgement only. "next" is a NAVIGATION command people
      // say out of habit hands-free — accepting it here would let someone skip
      // the safety prep without ever reading it, which is the whole point of
      // the gate.
      if (/^(ready|im ready|ive read it|read it|i have read it|understood|got it|start|yes)$/.test(q)) return ackSafety();
      if (/^(next|continue|go|skip)$/.test(q)) {
        return `Not yet — read the safety prep first, then say “ready”. ${(recipe.safety || [])[0] || ""}`;
      }
      if (/^(tools|what tools)/.test(q)) return `Tools: ${(recipe.tools || []).join(", ") || "none listed"}.`;
      if (/^(parts|what parts)/.test(q)) return `Parts: ${(recipe.parts || []).join(", ") || "none listed"}.`;
      return `Read the safety prep first, then say “ready”. ${(recipe.safety || [])[0] || ""}`;
    }
    if (phase === "triage") {
      const nm = q.match(/^(?:option )?(one|two|three|four|five|1|2|3|4|5)$/);
      if (nm) {
        const map = { one: 0, two: 1, three: 2, four: 3, five: 4 };
        const i = nm[1] in map ? map[nm[1]] : parseInt(nm[1], 10) - 1;
        return answerTriage(i) || null;
      }
      return null;
    }
    if (/^(whats wrong|what's wrong|triage|help me diagnose)$/.test(q)) return startTriage();
    if (phase === "pick") return null;

    if (/^(next|whats next|what next|done|continue|okay next|ok next|go on|forward)$/.test(q) || q === "next step") {
      return nextStep();
    }
    if (/^(back|go back|previous|previous step)$/.test(q)) return backStep();
    if (/(^repeat$|say that again|^again$|repeat the step|repeat that)/.test(q)) return sayStep();
    const tm = q.match(/start (?:a |the )?(?:(\d+)\s*(second|minute)s? )?timer/);
    if (tm) {
      const secs = tm[1] ? parseInt(tm[1], 10) * (tm[2] === "minute" ? 60 : 1) : null;
      return startTimer(secs);
    }
    if (/(how does (this|it) look|hows (this|it) look(ing)?|check this|does (this|it) look right|look at this)/.test(q)) {
      return lookCheck();
    }
    const im = q.match(/how (?:much|many) (.+)/);
    if (im) {
      const hit = (recipe.ingredients || []).find((i) => i.toLowerCase().includes(im[1].trim()));
      if (hit) return `The recipe uses ${hit}.`;
      return null; // not in the list — let the model answer with getContext grounding
    }
    if (/^(finish|im done|were done|finish cooking)$/.test(q)) return finish();
    return null; // anything else: normal companion conversation
  },

  // ---------------- verification hooks ----------------
  _state: () => ({ phase, idx, total: stepsOf(recipe).length, recipe: recipe ? recipe.title : null,
    aiDrafted, timer: timerRec, camOn: !!camStream }),
  _load: (id) => { const r = recipes.find((x) => x.id === id); if (r) selectRecipe(r, false); return !!r; },
  _lookWithFrame: (b64) => visionCheckWithFrame(b64),
  _packs: () => recipes.map((r) => ({ id: r.id, title: r.title, domain: r.domain,
    steps: stepsOf(r).length, tools: (r.tools || []).length, safety: (r.safety || []).length, verify: !!r.verify })),
  _hazard: (t) => hazardCheck(t),
  _draft: (t) => draftRecipe(t),
  _ack: () => ackSafety(),
  _safetyAcked: () => safetyAcked,
  _triage: { start: () => startTriage(), answer: (i) => answerTriage(i),
    node: () => (triageNode ? triageNode.id : null), stop: () => triageStopMsg },
  _pro: () => callProfessional(),
  _setPickerDomain: (d) => { pickerDomain = d; renderPicker(); },
};

// ---------------------------------------------------------------- picker
function renderPicker() {
  phase = "pick";
  triageNode = null; triageStopMsg = "";
  els.cam.style.display = "none";
  els.shade.style.display = "";
  const repairMode = pickerDomain === "repair";
  const list = recipes.filter((r) => (r.domain === "repair") === repairMode);
  const w = els.wrap;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div style="display:flex; gap:6px; margin:6px 2px 10px;">
        <button class="fbChip ${repairMode ? "" : "on"}" data-el="tabCook">🍳 Cook</button>
        <button class="fbChip ${repairMode ? "on" : ""}" data-el="tabFix">🔧 Fix &amp; build</button>
      </div>
      <h2 style="font-size:20px; margin:2px 2px 4px;">${repairMode ? "🔧 What are we fixing?" : "🍳 What are we making?"}</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 14px;">
        ${repairMode
          ? "Say what's broken — <b style=\"color:var(--fg)\">“guide me through fixing the sink”</b> — and it starts there. Not sure? Say <b style=\"color:var(--fg)\">“what's wrong”</b> and it'll narrow it down by asking. Safety prep comes first either way."
          : "Say what you're making — <b style=\"color:var(--fg)\">“guide me through making pasta”</b> — and it starts there. Then work hands-free: “next”, “repeat”, “start the timer”, “how does this look?”."}
      </div>
      ${repairMode ? `
      <button class="card" data-el="triageBtn" style="min-height:0; width:100%; margin-bottom:10px;">
        <span class="name">🩺 Not sure what's wrong?</span>
        <span class="blurb">Answer a couple of quick questions and I'll point you at the right job — or tell you it needs a professional.</span>
        <span class="footNote" style="color:var(--accent); font-family:inherit; font-size:11.5px; font-weight:600;">Start triage →</span>
      </button>` : ""}
      <div data-el="recipeCards" style="display:flex; flex-direction:column; gap:10px;"></div>
      <div style="margin-top:16px; border:1px solid var(--line); border-radius:14px; padding:12px; background:var(--panel);">
        <div style="font-weight:600; font-size:13.5px; margin-bottom:8px;">${repairMode ? "Or describe the job" : "Or ask for any dish"}</div>
        <div style="display:flex; gap:8px;">
          <input type="text" data-el="dishInput" placeholder="${repairMode ? "e.g. replace a shower head" : "e.g. chicken fried rice"}"
            style="flex:1; min-width:0;" autocomplete="off">
          <button class="ghostBtn accent" data-el="draftBtn">Draft it</button>
        </div>
        <div style="color:var(--dim); font-size:11px; margin-top:7px;">
          ${repairMode
            ? "Drafted by your local model and <strong>not verified by anyone</strong> — check the tools, parts and any shut-off step yourself before you start. Gas, mains wiring, structural, roof and ladder jobs are refused outright."
            : "Drafted by your local model — steps are labeled AI-drafted; double-check quantities and temps."}</div>
        <div data-el="draftNote" style="color:var(--warn); font-size:11.5px; margin-top:6px;"></div>
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  list.forEach((r) => {
    const card = document.createElement("button");
    card.className = "card";
    card.style.cssText = "min-height:0; width:100%;";
    const blurb = isRepair(r)
      ? `${stepsOf(r).length} steps · ${r.difficulty} · ${r.timeEstimate} · ${(r.tools || []).length} tools`
      : `${r.steps.length} steps · serves ${r.servings} · ${r.ingredients.length} ingredients`;
    card.innerHTML = `<span class="name">${r.title}</span>
      <span class="blurb">${blurb}</span>
      <span class="footNote" style="color:var(--accent); font-family:inherit; font-size:11.5px; font-weight:600;">Start →</span>`;
    card.addEventListener("click", () => selectRecipe(r, false));
    els.recipeCards.appendChild(card);
  });
  els.tabCook.addEventListener("click", () => { pickerDomain = "cooking"; renderPicker(); });
  els.tabFix.addEventListener("click", () => { pickerDomain = "repair"; renderPicker(); });
  if (els.triageBtn) els.triageBtn.addEventListener("click", () => startTriage());
  els.draftBtn.addEventListener("click", async () => {
    const dish = els.dishInput.value.trim();
    if (!dish || drafting) return;
    els.draftNote.textContent = "Drafting with your local model… (~20 s)";
    const msg = await draftRecipe(dish);
    if (phase === "pick" && els.draftNote) els.draftNote.textContent = msg; // failure path stays on picker
  });
}

// ---------------------------------------------------------------- triage
// A symptom, not a procedure — ask a few short questions and route. When it
// can't narrow confidently it SAYS SO and offers a professional; it never
// guesses a repair.
function startTriage() {
  phase = "triage";
  triageStopMsg = "";
  triageNode = triageTree.find((n) => n.id === "root") || null;
  renderTriage();
  return triageNode ? triageNode.q : "Triage isn't available.";
}
function answerTriage(i) {
  if (!triageNode) return null;
  const opt = triageNode.options[i];
  if (!opt) return null;
  if (opt.pack) {
    const p = recipes.find((r) => r.id === opt.pack);
    if (p) { selectRecipe(p, false); return null; }
  }
  if (opt.stop) {
    triageStopMsg = triageStops[opt.stop] || "I can't narrow this down confidently.";
    triageNode = null;
    renderTriage();
    return triageStopMsg;
  }
  if (opt.next) {
    triageNode = triageTree.find((n) => n.id === opt.next) || null;
    renderTriage();
    return triageNode ? triageNode.q : null;
  }
  return null;
}
function renderTriage() {
  const w = els.wrap;
  if (triageStopMsg) {
    w.innerHTML = `
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:4px 2px 10px;">
          <button class="ghostBtn" data-el="exitBtn">‹ Back</button>
          <div style="flex:1; text-align:center; font-weight:700; font-size:14px;">Triage</div>
        </div>
        <div style="border:1px solid var(--warn); border-radius:16px; background:var(--panel-solid); padding:16px;">
          <div style="font-weight:700; font-size:15px; margin-bottom:8px;">I can't safely narrow this one down</div>
          <div style="font-size:13.5px; line-height:1.55;">${triageStopMsg}</div>
          <div style="font-size:12px; color:var(--dim); line-height:1.5; margin-top:10px;">
            I'd rather tell you that than talk you into the wrong repair.</div>
        </div>
        <button class="ghostBtn" data-el="restartBtn" style="width:100%; margin-top:12px;">Start over</button>
      </div>`;
    for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    els.exitBtn.addEventListener("click", renderPicker);
    els.restartBtn.addEventListener("click", () => { svc.speak(startTriage()); });
    return;
  }
  if (!triageNode) { renderPicker(); return; }
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div style="display:flex; align-items:center; gap:8px; margin:4px 2px 10px;">
        <button class="ghostBtn" data-el="exitBtn">‹ Back</button>
        <div style="flex:1; text-align:center; font-weight:700; font-size:14px;">Triage</div>
      </div>
      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px;">
        <div style="font-size:18px; line-height:1.4; font-weight:600;">${triageNode.q}</div>
      </div>
      <div data-el="opts" style="display:flex; flex-direction:column; gap:8px; margin-top:12px;"></div>
      <div style="color:var(--dim); font-size:11px; text-align:center; margin-top:10px;">
        Hands-free: say the number, or “one”, “two”…</div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.exitBtn.addEventListener("click", renderPicker);
  triageNode.options.forEach((o, i) => {
    const b = document.createElement("button");
    b.className = "ghostBtn";
    b.style.cssText = "width:100%; text-align:left; padding:12px;";
    b.textContent = `${i + 1}. ${o.label}`;
    b.addEventListener("click", () => { const r = answerTriage(i); if (r) svc.speak(r); });
    els.opts.appendChild(b);
  });
}

// ---------------------------------------------------------------- step engine
function selectRecipe(r, ai) {
  recipe = r;
  aiDrafted = ai;
  idx = 0;
  timerRec = null;
  safetyAcked = false;
  // A repair pack with safety prep NEVER goes straight to step 1 — the prep is
  // shown first and must be acknowledged.
  if (isRepair(r) && (r.safety || []).length) {
    phase = "safety";
    renderSafety();
    svc.speak(`Before we start ${r.title}, here's the safety prep. ${r.safety[0]}`);
    return;
  }
  phase = "steps";
  renderStep();
  svc.speak(`${isRepair(r) ? "Let's fix" : "Let's make"} ${r.title}. ${stepLine()}`);
}

function ackSafety() {
  if (phase !== "safety") return null;
  safetyAcked = true;
  phase = "steps";
  idx = 0;
  renderStep();
  return `Right — ${stepLine()}`;
}

function renderSafety() {
  const r = recipe;
  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div style="display:flex; align-items:center; gap:8px; margin:4px 2px 10px;">
        <button class="ghostBtn" data-el="exitBtn">‹ Back</button>
        <div style="flex:1; text-align:center; font-weight:700; font-size:14px;">${r.title}</div>
      </div>
      ${aiDrafted ? `<div style="border:1px solid var(--bad); border-radius:12px; background:rgba(255,90,90,0.08);
        padding:11px 13px; margin-bottom:10px;">
        <div style="font-weight:700; font-size:13px; color:var(--bad);">⚠︎ AI-DRAFTED — NOT VERIFIED BY ANYONE</div>
        <div style="font-size:12px; line-height:1.5; margin-top:5px;">Your local model wrote these steps. Check the
        tools, the parts, and especially any shut-off step against the real thing before you start. If a step
        doesn't match what's in front of you, trust the object, not the text.</div></div>` : ""}
      <div style="border:1px solid var(--warn); border-radius:16px; background:var(--panel-solid); padding:16px;">
        <div style="font-family:var(--mono); font-size:11px; color:var(--warn); letter-spacing:0.08em; margin-bottom:10px;">
          SAFETY PREP — BEFORE YOU START</div>
        <ol style="margin:0 0 0 18px; padding:0; font-size:14px; line-height:1.6;">
          ${(r.safety || []).map((s) => `<li style="margin-bottom:8px;">${s}</li>`).join("")}
        </ol>
      </div>
      ${(r.tools || []).length || (r.parts || []).length ? `
      <div style="border:1px solid var(--line); border-radius:14px; background:var(--panel); padding:12px; margin-top:10px;">
        ${(r.tools || []).length ? `<div style="font-size:12.5px; line-height:1.6;"><strong>Tools:</strong> ${r.tools.join(", ")}</div>` : ""}
        ${(r.parts || []).length ? `<div style="font-size:12.5px; line-height:1.6; margin-top:6px;"><strong>Parts:</strong> ${r.parts.join(", ")}</div>` : ""}
      </div>` : ""}
      <button class="bigBtn" data-el="ackBtn" style="width:100%; margin-top:14px; padding:14px;">
        I've read this — start step 1</button>
      <button class="ghostBtn" data-el="proBtn" style="width:100%; margin-top:8px;">This looks beyond me — call a professional</button>
      <div style="color:var(--dim); font-size:11px; text-align:center; margin-top:10px;">
        Hands-free: say “ready” or “I've read it” to start.</div>
    </div>`;
  for (const el of els.wrap.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.exitBtn.addEventListener("click", renderPicker);
  els.ackBtn.addEventListener("click", () => svc.speak(ackSafety()));
  els.proBtn.addEventListener("click", () => svc.speak(callProfessional()));
}

// Always available, on every step. Never buried.
function callProfessional() {
  phase = "finish";
  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:40px auto 0; text-align:center;">
      <div style="font-size:46px;">🧰</div>
      <h2 style="font-size:20px; margin:10px 0 6px;">Good call</h2>
      <div style="color:var(--dim); font-size:13.5px; line-height:1.6; max-width:400px; margin:0 auto;">
        Stopping when something looks beyond the job is the right instinct, not a failure —
        it's usually cheaper than the repair after a repair. Nothing here is urgent enough
        to risk it.</div>
      <button class="bigBtn" data-el="againBtn" style="margin-top:20px;">Back to the list</button>
    </div>`;
  els.wrap.querySelector("[data-el=againBtn]").addEventListener("click", renderPicker);
  return "Stopping here. Calling someone in is the right instinct — it's usually cheaper than fixing a repair twice.";
}

function stepLine() {
  const list = stepsOf(recipe);
  const s = list[idx];
  return (s.isVerify ? "Final check" : `Step ${idx + 1} of ${list.length}`) + `: ${s.text}`;
}

function nextStep() {
  const list = stepsOf(recipe);
  if (idx >= list.length - 1) return finish();
  idx++;
  renderStep();
  return stepLine() + (list[idx].tip ? ` Tip: ${list[idx].tip}` : "");
}

function backStep() {
  if (idx === 0) return "Already at the first step. " + stepLine();
  idx--;
  renderStep();
  return stepLine();
}

function sayStep() {
  const s = stepsOf(recipe)[idx];
  return stepLine() + (s.tip ? ` Tip: ${s.tip}` : "");
}

function finish() {
  phase = "finish";
  renderFinish();
  if (isRepair(recipe)) {
    return `That's it — ${recipe.title} done, and you checked it works rather than hoping. ` +
      `Next time you'll need this guide a lot less.`;
  }
  return `That's it — ${recipe.title} is done. Nice work: you made it yourself, step by step. ` +
    `Say "guide me through" another dish whenever you're ready.`;
}

function renderStep() {
  const list = stepsOf(recipe);
  const s = list[idx];
  const cue = cueOf(s);
  const w = els.wrap;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div style="display:flex; align-items:center; gap:8px; margin:4px 2px 10px;">
        <button class="ghostBtn" data-el="exitBtn">‹ Recipes</button>
        <div style="flex:1; text-align:center; font-weight:700; font-size:14px;">${recipe.title}</div>
        <span class="tag learn" style="position:static;">${aiDrafted ? "AI-DRAFTED" : (isRepair(recipe) ? "REPAIR" : "RECIPE")}</span>
      </div>
      ${aiDrafted ? `<div style="color:var(--bad); font-size:11px; text-align:center; margin-bottom:8px; font-weight:600;">${isRepair(recipe) ? "AI-drafted and unverified — check tools, parts and shut-offs against the real thing." : "AI-drafted — double-check quantities and temperatures."}</div>` : ""}
      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px 16px 14px;">
        <div style="font-family:var(--mono); font-size:11px; color:${s.isVerify ? "var(--good)" : "var(--accent)"}; letter-spacing:0.08em; margin-bottom:8px;">
          ${s.isVerify ? "FINAL CHECK — PROVE IT WORKED" : `STEP ${idx + 1} OF ${list.length}`}</div>
        <div style="font-size:18px; line-height:1.45; font-weight:600;">${s.text}</div>
        ${s.tip ? `<div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin-top:8px;">💡 ${s.tip}</div>` : ""}
        ${cue ? `<div style="color:var(--gold); font-size:12px; margin-top:8px;">👁 Look for: ${cue}</div>` : ""}
        <div data-el="timerLine" style="font-family:var(--mono); font-size:13px; color:var(--warn); margin-top:10px; display:none;"></div>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="ghostBtn" data-el="backBtn2">◀ Back</button>
        <button class="ghostBtn" data-el="repeatBtn">Repeat</button>
        ${s.timerSeconds ? '<button class="ghostBtn accent" data-el="timerBtn">⏱ Timer</button>' : ""}
        <button class="ghostBtn" data-el="lookBtn">📷 Look</button>
        <button class="ghostBtn accent" data-el="nextBtn" style="flex:1;">Next ▶</button>
      </div>
      <div data-el="camRow" style="margin-top:10px; text-align:center;">
        ${camStream ? "" : '<button class="ghostBtn" data-el="camBtn">📷 Enable look checks (camera)</button>'}
      </div>
      ${isRepair(recipe) ? `<button class="ghostBtn" data-el="proBtn" style="width:100%; margin-top:10px; color:var(--warn);">
        ✋ Stop and call a professional</button>` : ""}
      <div style="color:var(--dim); font-size:11px; text-align:center; margin-top:10px;">
        Hands-free: open ✦ and say “next”, “repeat”, “start the timer”, “how does this look?”.</div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.exitBtn.addEventListener("click", () => { stopTimerDisplay(); renderPicker(); });
  els.backBtn2.addEventListener("click", () => svc.speak(backStep()));
  els.repeatBtn.addEventListener("click", () => svc.speak(sayStep()));
  els.nextBtn.addEventListener("click", () => svc.speak(nextStep()));
  els.lookBtn.addEventListener("click", async () => svc.speak(await lookCheck()));
  if (els.timerBtn) els.timerBtn.addEventListener("click", () => svc.speak(startTimer()));
  if (els.camBtn) els.camBtn.addEventListener("click", enableCamera);
  if (els.proBtn) els.proBtn.addEventListener("click", () => svc.speak(callProfessional()));
  uiTick();
}

function renderFinish() {
  stopTimerDisplay();
  const rep = isRepair(recipe);
  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:40px auto 0; text-align:center;">
      <div style="font-size:52px;">${rep ? "🔧" : "🎉"}</div>
      <h2 style="font-size:22px; margin:10px 0 6px;">${recipe.title} — done!</h2>
      <div style="color:var(--dim); font-size:13.5px; line-height:1.6; max-width:400px; margin:0 auto;">
        ${rep
          ? "You fixed it yourself and then checked it actually works, which is the part most guides skip. Next time you'll need this a lot less — that's the point."
          : "Nice work — you made it yourself, one step at a time. Next time you'll need this guide a little less. That's the point."}</div>
      ${rep ? `<div style="color:var(--warn); font-size:12px; line-height:1.5; max-width:400px; margin:12px auto 0;">
        If anything starts dripping, sticking or coming loose over the next day or two, go back and re-check
        the joint — or call someone in.</div>` : ""}
      <button class="bigBtn" data-el="againBtn" style="margin-top:20px;">${rep ? "Back to the list" : "Cook something else"}</button>
    </div>`;
  els.wrap.querySelector("[data-el=againBtn]").addEventListener("click", renderPicker);
}

// ---------------------------------------------------------------- timers (reminders layer)
function startTimer(seconds) {
  const s = stepsOf(recipe)[idx];
  const secs = seconds || s.timerSeconds;
  if (!secs) return "This step doesn't have a timer — say 'start a 5 minute timer' to set one.";
  const label = `${recipe.title} — step ${idx + 1}: ${s.text.slice(0, 60)}`;
  try {
    const rec = svc.actions.addReminder(label, new Date(Date.now() + secs * 1000));
    timerRec = { id: rec.id, dueMs: rec.dueMs, label };
    uiTick();
    const mins = Math.floor(secs / 60), rem = secs % 60;
    return `Timer set for ${mins ? mins + (mins === 1 ? " minute" : " minutes") : ""}${mins && rem ? " " : ""}${rem ? rem + " seconds" : ""}. I'll call out when it's done.`;
  } catch (err) {
    return "Couldn't set the timer: " + err.message;
  }
}

function timerLeftMs() {
  if (!timerRec) return null;
  const left = timerRec.dueMs - Date.now();
  return left > 0 ? left : null;
}
function fmtLeft(ms) {
  const t = Math.round(ms / 1000);
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}
function stopTimerDisplay() { timerRec = null; }

// Greedy word-wrap into at most `maxLines` lines of `width` chars, for the
// glasses HUD. The last line is ellipsised if the text doesn't fit — but the
// full step is always spoken, so nothing is actually lost.
function wrapText(text, width, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= width) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length <= width ? w : w.slice(0, width - 1) + "…";
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  // If we ran out of room mid-text, mark the final line as truncated.
  const consumed = lines.join(" ").replace(/…$/, "").split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length) {
    const last = lines[lines.length - 1];
    if (!last.endsWith("…")) lines[lines.length - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + "…";
  }
  return lines;
}

function uiTick() {
  if (!els.timerLine || phase !== "steps") return;
  const left = timerLeftMs();
  if (left !== null) {
    els.timerLine.style.display = "";
    els.timerLine.textContent = `⏱ ${fmtLeft(left)} left — I'll speak up when it's done.`;
  } else if (timerRec) {
    els.timerLine.style.display = "";
    els.timerLine.textContent = "⏱ Timer done!";
  } else {
    els.timerLine.style.display = "none";
  }
}

// ---------------------------------------------------------------- look checks (vision)
async function enableCamera() {
  try {
    camStream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.cam.srcObject = camStream;
    els.cam.style.display = "";
    els.shade.style.display = "none";
    await els.cam.play();
    if (els.camRow) els.camRow.innerHTML = "";
  } catch (err) {
    if (els.camRow) els.camRow.innerHTML =
      '<span style="color:var(--bad); font-size:12px;">Camera unavailable — look checks off. You can still cook by voice.</span>';
  }
}

function grabFrame() {
  const v = els.cam;
  if (!camStream || !v.videoWidth) return null;
  const MAX = 768;
  const scale = Math.min(1, MAX / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(v.videoWidth * scale));
  c.height = Math.max(1, Math.round(v.videoHeight * scale));
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7).split(",")[1];
}

async function lookCheck() {
  if (phase !== "steps") return "Pick a recipe first, then I can look at your cooking.";
  const b64 = grabFrame();
  if (!b64) return "The camera isn't on — tap “Enable look checks” on the step card first.";
  return visionCheckWithFrame(b64);
}

async function visionCheckWithFrame(b64) {
  const s = stepsOf(recipe)[idx];
  const cue = cueOf(s);
  const rep = isRepair(recipe);
  const prompt = rep
    ? `The user is doing this repair: ${recipe.title}. Current step: ${s.text}` +
      (cue ? ` They should be looking for: ${cue}.` : "") +
      " From this photo, does it visually look like that step is done, or not yet?" +
      " Describe only what you can actually see. Do NOT comment on whether anything is safe," +
      " sealed, tight, or correctly torqued — you cannot tell that from a photo." +
      " Answer in one or two short sentences."
    : `The user is cooking ${recipe.title}. Current step: ${s.text}` +
      (cue ? ` They should be looking for: ${cue}.` : "") +
      " From this photo, does it look on track or does it need more time? Answer in one or two short, friendly sentences.";
  const res = await svc.companion.vision(b64, prompt);
  if (!res.ok) return res.text; // graceful: bridge/vision down message
  let feedback = res.text;
  // Deterministic honesty rules — appended app-side, never left to the model.
  if (rep) {
    // The model is told not to judge safety, but if it does anyway we DROP the
    // whole sentence rather than editing it: surgically rewriting model prose
    // yields mangled half-claims. Sentence-level, like the football guardrail.
    const kept = (feedback.match(/[^.!?]+[.!?]?/g) || [feedback]).filter((sent) => {
      const bad = SAFE_CLAIM_RE.test(sent);
      if (bad) console.warn("guide: dropped a vision sentence asserting safety:", sent.trim());
      return !bad;
    });
    feedback = kept.join("").replace(/\s+/g, " ").trim();
    if (!feedback) feedback = "I can see the work, but I can't tell from a photo whether it's right.";
    feedback += " That's a rough visual check only — a photo can't confirm a seal, a torque, " +
      "an electrical or gas condition, or anything inside the pipe or wall. Check those yourself.";
  } else if (SAFETY_RE.test(s.text + " " + cue + " " + recipe.title)) {
    feedback += " Remember, a photo is only a rough visual check — confirm meat, poultry, or eggs with a food thermometer before eating (chicken: 74 °C / 165 °F).";
  }
  return feedback;
}

// ---------------------------------------------------------------- AI-drafted recipes
// Decide which domain a free-text request is, so a repair gets the repair
// treatment (hazard gate, safety prep, verify step) rather than a recipe.
const REPAIR_HINT = /\b(fix|repair|replace|unclog|unblock|install|assemble|mount|tighten|leak|leaking|drip|dripping|broken|stuck|jammed|puncture|flat tyre|flat tire|squeak|rattle|sink|tap|faucet|toilet|drain|bike|shelf|door|handle|hinge|screw|bolt)\b/i;

async function draftRecipe(dish) {
  if (drafting) return "Still drafting — one moment.";

  // THE HARD GATE, first, before any model call. A refusal must produce no
  // steps at all — a half-drafted gas or wiring procedure is worse than none.
  const hazard = hazardCheck(dish);
  if (hazard) {
    const msg = refusalFor(hazard);
    if (phase === "pick" && els.draftNote) els.draftNote.textContent = msg;
    return msg;
  }

  if (REPAIR_HINT.test(dish)) return draftRepair(dish);

  drafting = true;
  try {
    const prompt =
      `Create a simple recipe for "${dish}" as JSON in a fenced code block, using exactly this schema: ` +
      `{"title":"...","servings":2,"ingredients":["quantity + item", ...],"steps":[{"text":"one short imperative step (max 140 chars)","tip":"optional short tip","donenessCue":"optional visual cue","timerSeconds":300}, ...]}. ` +
      `Use 6 to 12 steps, only include timerSeconds where real waiting happens, and reply with the JSON block only.`;
    const res = await svc.companion.ask(prompt, "", []);
    if (!res.ok) return "Couldn't reach your local model to draft that — " + res.text;
    const parsed = parseRecipeJson(res.text);
    if (!parsed) return `I couldn't get a clean recipe for “${dish}” from the local model — try again, or pick a built-in recipe.`;
    selectRecipe(parsed, true);
    return `Drafted “${parsed.title}” — ${parsed.steps.length} steps, AI-drafted so double-check quantities. ${stepLine()}`;
  } finally {
    drafting = false;
  }
}

// AI-drafted REPAIRS are gated harder than recipes: the hazard gate has already
// run above, the model is told to refuse hazardous work itself, and whatever
// comes back is labelled prominently as unverified and still goes through the
// safety-prep acknowledgement before step 1.
async function draftRepair(job) {
  drafting = true;
  try {
    const prompt =
      `Write a safe DIY procedure for "${job}" as JSON in a fenced code block, using exactly this schema: ` +
      `{"title":"...","difficulty":"easy|medium","timeEstimate":"20-40 min","tools":["..."],"parts":["..."],` +
      `"safety":["prep step done BEFORE starting, e.g. turn the water off at the isolation valve"],` +
      `"steps":[{"text":"one short imperative step (max 160 chars)","tip":"optional","checkCue":"optional visible cue","timerSeconds":300}],` +
      `"verify":{"text":"a final check that proves the repair actually worked","checkCue":"what success looks like"}}. ` +
      `Use 5 to 14 steps. safety[] must include any shut-off (water, power at the plug) needed. ` +
      `verify is REQUIRED. If this job involves gas, household mains wiring, structural work, roofs or ladders, ` +
      `reply with exactly {"refuse":"reason"} instead and no steps. Reply with the JSON block only.`;
    const res = await svc.companion.ask(prompt, "", []);
    if (!res.ok) return "Couldn't reach your local model to draft that — " + res.text;

    // If the model itself flagged it as out of scope, respect that.
    if (/"refuse"\s*:/.test(res.text)) {
      const msg = refusalFor("work the model flagged as beyond safe DIY");
      if (phase === "pick" && els.draftNote) els.draftNote.textContent = msg;
      return msg;
    }
    const parsed = parseRepairJson(res.text);
    // Parse failure → back to the picker, exactly like cooking.
    if (!parsed) {
      return `I couldn't get a clean, complete procedure for “${job}” from the local model — ` +
        `pick one of the built-in jobs instead, or try describing it differently.`;
    }
    // Belt and braces: gate the DRAFTED CONTENT too, not just the request.
    const hz = hazardCheck(parsed.title + " " + parsed.steps.map((s) => s.text).join(" ") + " " + (parsed.safety || []).join(" "));
    if (hz) {
      const msg = refusalFor(hz) + " (The drafted steps strayed into that territory, so I've discarded them.)";
      if (phase === "pick" && els.draftNote) els.draftNote.textContent = msg;
      return msg;
    }
    selectRecipe(parsed, true);
    return `Drafted “${parsed.title}” — ${parsed.steps.length} steps. This is AI-drafted and unverified, ` +
      `so check the tools, parts and shut-off steps against what's actually in front of you. Safety prep first.`;
  } finally {
    drafting = false;
  }
}

function parseRepairJson(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  const raw = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return null; }
  if (!o || typeof o.title !== "string" || !Array.isArray(o.steps)) return null;
  const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const list = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 12).map((x) => x.trim().slice(0, n)) : []);
  const steps = o.steps
    .filter((s) => s && typeof s.text === "string" && s.text.trim())
    .slice(0, MAX_AI_STEPS)
    .map((s) => ({
      text: String(s.text).trim().slice(0, 220),
      tip: str(s.tip, 200),
      checkCue: str(s.checkCue, 160),
      timerSeconds: Number.isFinite(s.timerSeconds) && s.timerSeconds > 0 && s.timerSeconds <= 6 * 3600 ? Math.round(s.timerSeconds) : undefined,
    }));
  // A repair without a verify step is not acceptable — that's the whole point.
  const verifyText = o.verify && str(o.verify.text, 220);
  if (steps.length < 3 || !verifyText) return null;
  return {
    id: "ai-" + Date.now().toString(36),
    title: String(o.title).slice(0, 80),
    domain: "repair",
    difficulty: str(o.difficulty, 20) || "unknown",
    timeEstimate: str(o.timeEstimate, 30) || "unknown",
    tools: list(o.tools, 80),
    parts: list(o.parts, 80),
    // Always prepend our own line so a drafted job can never start without the
    // user being told the steps are unverified.
    safety: ["These steps were drafted by a local AI model and have not been checked by anyone — read them through and sanity-check the tools, parts and any shut-off before you start."]
      .concat(list(o.safety, 220)),
    steps,
    verify: { text: verifyText, tip: str(o.verify.tip, 200), checkCue: str(o.verify.checkCue, 160) },
  };
}

function parseRecipeJson(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  const raw = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return null; }
  if (!o || typeof o.title !== "string" || !Array.isArray(o.steps)) return null;
  const steps = o.steps
    .filter((s) => s && typeof s.text === "string" && s.text.trim())
    .slice(0, MAX_AI_STEPS)
    .map((s) => ({
      text: String(s.text).trim().slice(0, 200),
      tip: typeof s.tip === "string" && s.tip.trim() ? String(s.tip).trim().slice(0, 200) : undefined,
      donenessCue: typeof s.donenessCue === "string" && s.donenessCue.trim() ? String(s.donenessCue).trim().slice(0, 160) : undefined,
      timerSeconds: Number.isFinite(s.timerSeconds) && s.timerSeconds > 0 && s.timerSeconds <= 6 * 3600 ? Math.round(s.timerSeconds) : undefined,
    }));
  if (steps.length < 3) return null;
  return {
    id: "ai-" + Date.now().toString(36),
    title: String(o.title).slice(0, 80),
    servings: Number.isFinite(o.servings) ? o.servings : 2,
    ingredients: Array.isArray(o.ingredients) ? o.ingredients.filter((i) => typeof i === "string").slice(0, 30).map((i) => i.slice(0, 120)) : [],
    steps,
  };
}
