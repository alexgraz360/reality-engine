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

const SAFETY_RE = /(chicken|poultry|meat|beef|pork|turkey|lamb|sausage|burger|egg|fish|salmon|shrimp|prawn|seafood)/i;
const MAX_AI_STEPS = 20;

let root, svc, els = {};
let recipes = [];                 // vendored built-ins
let recipe = null;                // active recipe
let aiDrafted = false;
let idx = 0;
let phase = "pick";               // "pick" | "steps" | "finish"
let camStream = null;
let timerRec = null;              // { id, dueMs, label } — lives in the reminders layer
let tickId = 0;
let drafting = false;

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
    try {
      const r = await fetch(new URL("../data/recipes.json", import.meta.url));
      recipes = (await r.json()).recipes || [];
    } catch (e) {
      console.error("recipes failed to load:", e);
      recipes = [];
    }
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
    els = {}; root = null;
  },

  getContext() {
    if (phase === "pick") return "Guide Mode — choosing a recipe to cook.";
    if (phase === "finish") return `Guide Mode — just finished cooking “${recipe.title}”.`;
    const s = recipe.steps[idx];
    let out = `Guide Mode — cooking “${recipe.title}”${aiDrafted ? " (AI-drafted recipe)" : ""}. ` +
      `Step ${idx + 1} of ${recipe.steps.length}: ${s.text}`;
    if (s.donenessCue) out += ` (cue: ${s.donenessCue})`;
    const left = timerLeftMs();
    if (left !== null) out += ` Timer running: ${fmtLeft(left)} left.`;
    return /[.!?]$/.test(out) ? out : out + ".";
  },

  // Voice/typed commands from the shell's companion input. Return a string (or
  // a Promise of one) to handle locally — spoken via the normal speak path —
  // or null to let the question fall through to the model (with getContext).
  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?']/g, "").trim();
    const m = q.match(/guide me through (.+)/);
    if (m) return draftRecipe(m[1].trim());
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
  _state: () => ({ phase, idx, total: recipe ? recipe.steps.length : 0, recipe: recipe ? recipe.title : null,
    aiDrafted, timer: timerRec, camOn: !!camStream }),
  _load: (id) => { const r = recipes.find((x) => x.id === id); if (r) selectRecipe(r, false); return !!r; },
  _lookWithFrame: (b64) => visionCheckWithFrame(b64),
};

// ---------------------------------------------------------------- picker
function renderPicker() {
  phase = "pick";
  els.cam.style.display = "none";
  els.shade.style.display = "";
  const w = els.wrap;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:8px 2px 4px;">🍳 What are we making?</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 14px;">
        Pick a recipe, then cook hands-free: open ✦ and just say
        “next”, “repeat”, “start the timer”, or “how does this look?”.
      </div>
      <div data-el="recipeCards" style="display:flex; flex-direction:column; gap:10px;"></div>
      <div style="margin-top:16px; border:1px solid var(--line); border-radius:14px; padding:12px; background:var(--panel);">
        <div style="font-weight:600; font-size:13.5px; margin-bottom:8px;">Or ask for any dish</div>
        <div style="display:flex; gap:8px;">
          <input type="text" data-el="dishInput" placeholder="e.g. chicken fried rice"
            style="flex:1; min-width:0;" autocomplete="off">
          <button class="ghostBtn accent" data-el="draftBtn">Draft it</button>
        </div>
        <div style="color:var(--dim); font-size:11px; margin-top:7px;">
          Drafted by your local model — steps are labeled AI-drafted; double-check quantities and temps.</div>
        <div data-el="draftNote" style="color:var(--warn); font-size:11.5px; margin-top:6px;"></div>
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  recipes.forEach((r) => {
    const card = document.createElement("button");
    card.className = "card";
    card.style.cssText = "min-height:0; width:100%;";
    card.innerHTML = `<span class="name">${r.title}</span>
      <span class="blurb">${r.steps.length} steps · serves ${r.servings} · ${r.ingredients.length} ingredients</span>
      <span class="footNote" style="color:var(--accent); font-family:inherit; font-size:11.5px; font-weight:600;">Start →</span>`;
    card.addEventListener("click", () => selectRecipe(r, false));
    els.recipeCards.appendChild(card);
  });
  els.draftBtn.addEventListener("click", async () => {
    const dish = els.dishInput.value.trim();
    if (!dish || drafting) return;
    els.draftNote.textContent = "Drafting with your local model… (~20 s)";
    const msg = await draftRecipe(dish);
    if (phase === "pick" && els.draftNote) els.draftNote.textContent = msg; // failure path stays on picker
  });
}

// ---------------------------------------------------------------- step engine
function selectRecipe(r, ai) {
  recipe = r;
  aiDrafted = ai;
  idx = 0;
  phase = "steps";
  timerRec = null;
  renderStep();
  svc.speak(`Let's make ${r.title}. ${stepLine()}`);
}

function stepLine() {
  const s = recipe.steps[idx];
  return `Step ${idx + 1} of ${recipe.steps.length}: ${s.text}`;
}

function nextStep() {
  if (idx >= recipe.steps.length - 1) return finish();
  idx++;
  renderStep();
  return stepLine() + (recipe.steps[idx].tip ? ` Tip: ${recipe.steps[idx].tip}` : "");
}

function backStep() {
  if (idx === 0) return "Already at the first step. " + stepLine();
  idx--;
  renderStep();
  return stepLine();
}

function sayStep() {
  const s = recipe.steps[idx];
  return stepLine() + (s.tip ? ` Tip: ${s.tip}` : "");
}

function finish() {
  phase = "finish";
  renderFinish();
  return `That's it — ${recipe.title} is done. Nice work: you made it yourself, step by step. ` +
    `Say "guide me through" another dish whenever you're ready.`;
}

function renderStep() {
  const s = recipe.steps[idx];
  const w = els.wrap;
  w.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div style="display:flex; align-items:center; gap:8px; margin:4px 2px 10px;">
        <button class="ghostBtn" data-el="exitBtn">‹ Recipes</button>
        <div style="flex:1; text-align:center; font-weight:700; font-size:14px;">${recipe.title}</div>
        <span class="tag learn" style="position:static;">${aiDrafted ? "AI-DRAFTED" : "RECIPE"}</span>
      </div>
      ${aiDrafted ? '<div style="color:var(--warn); font-size:11px; text-align:center; margin-bottom:8px;">AI-drafted — double-check quantities and temperatures.</div>' : ""}
      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px 16px 14px;">
        <div style="font-family:var(--mono); font-size:11px; color:var(--accent); letter-spacing:0.08em; margin-bottom:8px;">
          STEP ${idx + 1} OF ${recipe.steps.length}</div>
        <div style="font-size:18px; line-height:1.45; font-weight:600;">${s.text}</div>
        ${s.tip ? `<div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin-top:8px;">💡 ${s.tip}</div>` : ""}
        ${s.donenessCue ? `<div style="color:var(--gold); font-size:12px; margin-top:8px;">👁 Look for: ${s.donenessCue}</div>` : ""}
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
  uiTick();
}

function renderFinish() {
  stopTimerDisplay();
  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:40px auto 0; text-align:center;">
      <div style="font-size:52px;">🎉</div>
      <h2 style="font-size:22px; margin:10px 0 6px;">${recipe.title} — done!</h2>
      <div style="color:var(--dim); font-size:13.5px; line-height:1.6; max-width:380px; margin:0 auto;">
        Nice work — you made it yourself, one step at a time. Next time you'll need
        this guide a little less. That's the point.</div>
      <button class="bigBtn" data-el="againBtn" style="margin-top:20px;">Cook something else</button>
    </div>`;
  els.wrap.querySelector("[data-el=againBtn]").addEventListener("click", renderPicker);
}

// ---------------------------------------------------------------- timers (reminders layer)
function startTimer(seconds) {
  const s = recipe.steps[idx];
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
  const s = recipe.steps[idx];
  const cue = s.donenessCue || "";
  const prompt =
    `The user is cooking ${recipe.title}. Current step: ${s.text}` +
    (cue ? ` They should be looking for: ${cue}.` : "") +
    " From this photo, does it look on track or does it need more time? Answer in one or two short, friendly sentences.";
  const res = await svc.companion.vision(b64, prompt);
  if (!res.ok) return res.text; // graceful: bridge/vision down message
  let feedback = res.text;
  // Deterministic safety rule — never left to the model: photos don't prove doneness.
  if (SAFETY_RE.test(s.text + " " + cue + " " + recipe.title)) {
    feedback += " Remember, a photo is only a rough visual check — confirm meat, poultry, or eggs with a food thermometer before eating (chicken: 74 °C / 165 °F).";
  }
  return feedback;
}

// ---------------------------------------------------------------- AI-drafted recipes
async function draftRecipe(dish) {
  if (drafting) return "Still drafting the previous recipe — one moment.";
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
