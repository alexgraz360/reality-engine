// Reality Engine — the SHELL. Home screen, mode registry, lifecycle, settings, about.
//
// Modes are plug-ins (see MODES.md). The shell only knows the mode interface:
//   { id, title, icon, family, permissions[], init(ctx), start(), stop(), teardown(), getContext() }
// One mode is active at a time; opening loads it on demand, going Home tears it down
// fully (plus a sensors.releaseAll() safety net). `visibilitychange` pauses/resumes.

import sensors from "./services/sensors.js";
import overlay from "./services/overlay.js";
import storage from "./services/storage.js";
import companion from "./services/companion.js";
import localActions from "./services/actions.js";
import knowledge from "./services/knowledge.js";
import glasses from "./services/glasses.js";
import router from "./services/router.js";

// ---------------------------------------------------------------- mode registry
// USABLE modes only — every entry here renders an "Open" card under its family.
// `load` dynamically imports the module (nothing loads until the card is tapped).
// Things that don't exist yet live in ROADMAP below, never here, so the grid
// never shows a card you can't actually open.
const REGISTRY = [
  {
    id: "astronomy", title: "Astronomy", family: "Learn", icon: "🔭",
    permissions: ["camera", "motion", "orientation", "geolocation"],
    blurb: "Point at the sky — planets, stars, time travel, events. The ✦ companion knows what you're looking at.",
    load: () => import("./modes/astronomy.js"),
  },
  {
    id: "guide", title: "Guide · cook with me", family: "Learn", icon: "🍳",
    permissions: ["camera", "mic"],
    blurb: "Hands-free step-by-step coach — cooking first. Spoken steps, timers, and a look-check on your pan.",
    load: () => import("./modes/guide.js"),
  },
  {
    id: "football", title: "Football · read the game", family: "Learn", icon: "🏈",
    permissions: ["mic", "camera"],
    blurb: "Be the smartest person in the room — set the down and what you see, get a speakable pre-snap read. General tendencies, no live feed.",
    load: () => import("./modes/football.js"),
  },
  {
    id: "baseball", title: "Baseball · read the pitch", family: "Learn", icon: "⚾",
    permissions: ["mic", "camera"],
    blurb: "Pitcher, batter, count — get the likely pitch and location plus the live hit/walk/strikeout odds for this exact spot. Historical tendencies, not a prediction.",
    load: () => import("./modes/baseball.js"),
  },
  {
    id: "translate", title: "Translate · read & talk", family: "Live", icon: "🌐",
    permissions: ["mic", "camera"],
    blurb: "Point at a sign or menu and hear it in your language, or hold a two-way spoken conversation. Machine translation on the local model — best on common languages.",
    load: () => import("./modes/translate.js"),
  },
  {
    id: "repair", title: "Guide · fix & assemble", family: "Build", icon: "🔧",
    permissions: ["camera", "mic"],
    blurb: "Unclog a sink, fix a dripping tap, mend a puncture, build the flat-pack — hands-free, safety prep first, and it ends by proving the fix actually worked. Gas and mains wiring are refused, not attempted.",
    load: () => import("./modes/repair.js"),
  },
  {
    id: "transcribe", title: "Transcribe · record & recall", family: "Live", icon: "🎙",
    permissions: ["mic"],
    blurb: "Record a meeting or class, get a transcript and summary on your own bridge, then ask about it later — it lands in your memories. Never ambient; you tap to start.",
    load: () => import("./modes/transcribe.js"),
  },
  {
    id: "pendulum", title: "Pendulum · period & g", family: "Learn", icon: "🪀",
    permissions: ["motion"],
    blurb: "Swing the phone on a string — measures period T from the gyroscope and computes g in real units.",
    load: () => import("./modes/pendulum.js"),
  },
  {
    id: "projectile", title: "Projectile · speed & range", family: "Learn", icon: "⚾",
    permissions: ["camera"],
    blurb: "Throw a ball — on-device ML tracks it and physics fits launch speed, angle, peak, and range.",
    load: () => import("./modes/projectile.js"),
  },
];

// Families from VISION.md — the ONE grouping vocabulary the home screen uses.
const FAMILIES = [
  { key: "Learn", desc: "Understand a subject" },
  { key: "Build", desc: "Make or fix something" },
  { key: "Live", desc: "Navigate daily life" },
];

// Not built yet. Rendered dimmed and NON-interactive at the bottom so the plan
// stays visible without pretending to be usable. The four physics entries were
// inventoried from the old physics-glasses hub (stubbed there, never finished)
// so retiring that card doesn't lose them — also tracked in MODES_CHECKLIST.md.
const ROADMAP = [
  { family: "Learn", title: "🔊 Sound Lab", note: "Mic FFT — frequency, loudness, musical note" },
  { family: "Learn", title: "🍎 Free fall · measure g", note: "From the old physics hub (unfinished)" },
  { family: "Learn", title: "🌀 Spring oscillation", note: "From the old physics hub (unfinished)" },
  { family: "Learn", title: "📢 Speed of sound", note: "Clap-echo timing — old physics hub (unfinished)" },
  { family: "Learn", title: "🏃 Body motion", note: "Pose tracking — old physics hub (unfinished)" },
  { family: "Learn", title: "🌈 Light & Colour Lab", note: "Camera colour naming and brightness" },
  { family: "Learn", title: "🏀 Form coach", note: "Pose + spoken cues for your shot" },
  { family: "Build", title: "🔧 Guide: Repair & Assembly", note: "Same Guide engine, new step packs" },
  { family: "Build", title: "🚗 Automotive", note: "Diagnose, guide the fix, log the history" },
  { family: "Live", title: "🧭 Navigator", note: "AR pins, arrow and distance" },
  { family: "Live", title: "🎭 Emotion", note: "Expression cues only — ethics pass required first" },
];

// ---------------------------------------------------------------- shell state
const home = document.getElementById("home");
const modeView = document.getElementById("modeView");
const modeRoot = document.getElementById("modeRoot");
const modeTitle = document.getElementById("modeTitle");
const modeTag = document.getElementById("modeTag");

let active = null; // { mod, entry }

const services = {
  sensors, overlay, storage, companion,
  actions: localActions, // notes/reminders layer (Guide timers reuse it)
  glasses,               // adapter — modes may send() a GlanceCard directly
  knowledge,             // the shared memory/RAG store (Transcribe files sessions here)
  // Speak through the shell's normal voice path (Piper/system, session-guarded).
  speak(text) {
    const willSpeak = speakReply(String(text || ""), () => setStatus("idle"));
    if (willSpeak) setStatus("speaking");
    return willSpeak;
  },
  // Language-aware voice surface for Translate (additive; companion path
  // untouched). speakInLanguage routes English→Piper, foreign→a matching system
  // voice, and refuses to speak a language with no voice rather than mangle it.
  // A mode building its own recognizer must stopDictation() the shell's single
  // instance first so the two never run at once (mic/TTS never overlap).
  voice: {
    speak: (text, lang, onDone) => speakInLanguage(text, lang, onDone),
    stopSpeak: () => stopSpeaking(),
    systemVoiceForLang: (lang) => systemVoiceForLang(lang),
    hasVoiceForLang: (lang) => !!systemVoiceForLang(lang),
    stopShellDictation: () => stopDictation(true),
    isShellListening: () => listening,
    Recognition: () => (window.SpeechRecognition || window.webkitSpeechRecognition) || null,
  },
};

// ---- Glance cards (glasses adapter, additive) --------------------------------
// The app pushes companion/action cards at their events; modes are PULLED via
// getGlanceCard(). While the preview is open we poll the active mode lightly so
// a read that changed through the mode's own panel is reflected — the adapter's
// rate cap keeps that from flashing. No mode internals are touched.
let lastPolledGlance = "";
function pullActiveGlance() {
  if (!active || !active.mod || typeof active.mod.getGlanceCard !== "function") return;
  let card;
  try { card = active.mod.getGlanceCard(); } catch (e) { console.error("getGlanceCard failed:", e); return; }
  if (!card) return;
  const sig = JSON.stringify([card.title, card.lines]);
  if (sig === lastPolledGlance) return;   // unchanged — don't re-send
  lastPolledGlance = sig;
  glasses.send(card);
}
// ---- Glasses preview (the develop-before-hardware harness) -------------------
// A subscriber renders each dispatched card into the circular lens exactly as
// the Halo would, honouring the same clamped card the BLE transport will get.
const glassesPreviewEl = document.getElementById("glassesPreview");
const glassesTitleEl = document.getElementById("glassesTitle");
const glassesLinesEl = document.getElementById("glassesLines");
const glassesEmptyEl = document.getElementById("glassesEmpty");
let glancePollTimer = 0;

glasses.subscribe((card) => {
  if (!card) {
    glassesTitleEl.textContent = "";
    glassesLinesEl.innerHTML = "";
    glassesEmptyEl.style.display = "block";
    glassesPreviewEl.classList.remove("alert");
    return;
  }
  glassesEmptyEl.style.display = "none";
  glassesTitleEl.textContent = card.title || "";
  glassesLinesEl.innerHTML = "";
  for (const line of card.lines) {
    const d = document.createElement("div");
    d.textContent = line;          // textContent — never HTML; cards are pure text
    glassesLinesEl.appendChild(d);
  }
  glassesPreviewEl.classList.toggle("alert", card.priority === "alert");
});

function setGlassesPreview(on) {
  glassesPreviewEl.style.display = on ? "flex" : "none";
  clearInterval(glancePollTimer);
  if (on) {
    pullActiveGlance();  // show the active mode's current card immediately
    // Poll the active mode lightly so a read changed via its own panel shows up;
    // the adapter's rate cap means this can never flash.
    glancePollTimer = setInterval(pullActiveGlance, 800);
  }
}
const glassesPreviewToggle = document.getElementById("glassesPreviewToggle");
glassesPreviewToggle.addEventListener("change", () => setGlassesPreview(glassesPreviewToggle.checked));
document.getElementById("glassesPreviewClose").addEventListener("click", () => {
  glassesPreviewToggle.checked = false; setGlassesPreview(false);
});

// A short spoken companion/vision answer, condensed into a glance card. The
// headline is the mode (or "Companion"); the body is the first sentence(s).
function glanceFromAnswer(text, kind) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  // Wrap the answer across the lens so it reads as a short paragraph rather than
  // hard-truncated sentence fragments; the FULL answer is always in `spoken`.
  glasses.send({
    title: kind === "look" ? "👁 Look" : "Companion",
    lines: glasses.wrap(clean, glasses.LIMITS.LINE_MAX, glasses.LIMITS.MAX_LINES),
    spoken: clean,
    holdMs: 8000,
  });
}

// ---------------------------------------------------------------- home screen
// Companion first, then one section per family (usable modes only), then the
// dimmed roadmap, then the legacy link in the footer.
const sectionsEl = document.getElementById("sections");
for (const fam of FAMILIES) {
  const entries = REGISTRY.filter((e) => e.family === fam.key);
  const head = document.createElement("div");
  head.className = "sectionHead";
  head.innerHTML = `<span class="sectionTitle">${fam.key}</span><span class="sectionDesc">${fam.desc}</span>`;
  sectionsEl.appendChild(head);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "sectionEmpty";
    empty.textContent = "Nothing here yet — see the roadmap below.";
    sectionsEl.appendChild(empty);
    continue;
  }
  const grid = document.createElement("div");
  grid.className = "modeGrid";
  for (const entry of entries) {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `
      <span class="tag ${entry.family.toLowerCase()}">${entry.family.toUpperCase()}</span>
      <span class="icon">${entry.icon}</span>
      <span class="name">${entry.title}</span>
      <span class="blurb">${entry.blurb}</span>
      <span class="footNote"><span class="statusPill open">OPEN</span>Launch →</span>`;
    card.addEventListener("click", () => openMode(entry));
    grid.appendChild(card);
  }
  sectionsEl.appendChild(grid);
}

// Roadmap — grouped by family, dimmed, pointer-events:none (never tappable).
const roadmapGroups = document.getElementById("roadmapGroups");
for (const fam of FAMILIES) {
  const items = ROADMAP.filter((r) => r.family === fam.key);
  if (!items.length) continue;
  const group = document.createElement("div");
  group.className = "roadmapGroup";
  const title = document.createElement("div");
  title.className = "roadmapGroupTitle";
  title.textContent = fam.key.toUpperCase();
  group.appendChild(title);
  const grid = document.createElement("div");
  grid.className = "roadmapGrid";
  for (const item of items) {
    const cell = document.createElement("div"); // div, not button — nothing to tap
    cell.className = "roadmapCard";
    cell.innerHTML = `<div class="rmName">${item.title}</div><div class="rmNote">${item.note}</div>`;
    grid.appendChild(cell);
  }
  group.appendChild(grid);
  roadmapGroups.appendChild(group);
}

// The companion strip opens ✦ (never collapses it — tapping "Companion" should
// always show the companion). Same path the FAB uses, no logic duplicated.
document.getElementById("companionStrip").addEventListener("click", () => {
  primeTTS();
  if (cardState !== "open") openCard(cardState === "closed");
});

// ---------------------------------------------------------------- lifecycle
async function openMode(entry) {
  if (entry.external) {
    window.open(entry.url, "_blank", "noopener"); // live legacy app, untouched
    return;
  }
  if (active) return; // one mode active at a time
  modeTitle.textContent = entry.title;
  modeTag.textContent = entry.family.toUpperCase();
  modeTag.className = "tag " + entry.family.toLowerCase();
  modeRoot.innerHTML = "";
  home.style.display = "none";
  modeView.classList.add("open");
  document.body.classList.add("modeOpen"); // FAB rides above mode bottom panels
  try {
    const mod = (await entry.load()).default;
    active = { mod, entry };
    lastPolledGlance = ""; // new mode: let its first card through the poll dedupe
    await mod.init({ root: modeRoot, services });
    await mod.start();
    if (location.hash.includes("debug")) window.__mode = mod; // verification hook
  } catch (err) {
    console.error(`Mode "${entry.id}" failed:`, err);
    modeRoot.innerHTML = `<div class="gatePanel"><p style="color:var(--bad)">This mode failed to load
      (${err && err.message || err}). Go back and try again.</p></div>`;
  }
}

function closeMode() {
  if (active) {
    try { active.mod.stop(); } catch (e) { console.error(e); }
    try { active.mod.teardown(); } catch (e) { console.error(e); }
    active = null;
    lastPolledGlance = "";
  }
  stopSpeaking();
  stopDictation(true);
  sensors.releaseAll(); // safety net: no stream/listener survives a mode
  window.__mode = undefined;
  modeRoot.innerHTML = "";
  modeView.classList.remove("open");
  document.body.classList.remove("modeOpen");
  home.style.display = "";
}

document.getElementById("backBtn").addEventListener("click", closeMode);

// Pause the active mode when the tab/app is hidden (battery + thermals).
document.addEventListener("visibilitychange", () => {
  if (!active) return;
  try {
    if (document.hidden) active.mod.stop();
    else active.mod.start();
  } catch (e) { console.error(e); }
});

// ---------------------------------------------------------------- sheets
function openSheet(id) { document.getElementById(id).classList.add("open"); }
function closeSheet(id) { document.getElementById(id).classList.remove("open"); }
for (const btn of document.querySelectorAll("[data-close]")) {
  btn.addEventListener("click", () => closeSheet(btn.dataset.close));
}
for (const wrap of document.querySelectorAll(".sheetWrap")) {
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(wrap.id); });
}

// Settings
document.getElementById("settingsBtn").addEventListener("click", () => {
  const perms = new Map(); // permission → [mode titles]
  for (const entry of REGISTRY) {
    for (const p of entry.permissions || []) {
      if (!perms.has(p)) perms.set(p, []);
      perms.get(p).push(entry.title.split("·")[0].trim());
    }
  }
  document.getElementById("permSummary").innerHTML = [...perms.entries()]
    .map(([p, modes]) => `<div class="kvRow"><span class="k">${p}</span><span class="v">${modes.join(", ")}</span></div>`)
    .join("");
  refreshCompanionStatus();
  const cfg = companion.getConfig();
  document.getElementById("companionEndpoint").value = cfg.endpoint;
  document.getElementById("companionToken").value = cfg.token;
  document.getElementById("companionSaveNote").textContent = "";
  document.getElementById("storageCount").textContent = String(storage.keys().length);
  openSheet("settingsSheet");
});

function refreshCompanionStatus() {
  document.getElementById("companionStatus").textContent =
    companion.isConfigured() ? "configured (local bridge)" : "not configured";
}

document.getElementById("companionSaveBtn").addEventListener("click", () => {
  companion.setConfig(
    document.getElementById("companionEndpoint").value,
    document.getElementById("companionToken").value);
  voicesFetched = false; // new bridge → re-fetch its voice list on next open
  refreshCompanionStatus();
  document.getElementById("companionSaveNote").textContent =
    companion.isConfigured() ? "Saved on this device." : "Cleared — both fields are needed.";
});

document.getElementById("companionForgetBtn").addEventListener("click", () => {
  companion.setConfig("", "");
  document.getElementById("companionEndpoint").value = "";
  document.getElementById("companionToken").value = "";
  refreshCompanionStatus();
  document.getElementById("companionSaveNote").textContent = "Forgotten on this device.";
});

document.getElementById("companionTestBtn").addEventListener("click", async () => {
  const note = document.getElementById("companionSaveNote");
  companion.setConfig(
    document.getElementById("companionEndpoint").value,
    document.getElementById("companionToken").value);
  refreshCompanionStatus();
  if (!companion.isConfigured()) { note.textContent = "Enter endpoint + token first."; return; }
  note.textContent = "Testing… (a local model can take ~10 s)";
  const res = await companion.ask("Reply with a 5-word hello.", "");
  note.textContent = res.ok ? "Connected — the companion answered." : res.text;
});

document.getElementById("clearStorageBtn").addEventListener("click", () => {
  if (confirm("Clear all Reality Engine data stored on this device (settings, calibrations, per-mode state)?")) {
    storage.clearAll();
    document.getElementById("storageCount").textContent = "0";
  }
});

// About
document.getElementById("aboutBtn").addEventListener("click", () => openSheet("aboutSheet"));

// Companion (the global floating ✦): a NON-MODAL card — the app underneath
// stays fully usable (scroll, taps, the astronomy iframe) while the companion
// is open, thinking, or speaking. Grounded via the active mode's getContext().
function activeContext() {
  try { return active ? (active.mod.getContext() || "") : ""; } catch (e) { console.error(e); return ""; }
}

const card = document.getElementById("companionCard");
const fabStatusEl = document.getElementById("fabStatus");
let cardState = "closed";  // "closed" | "open" | "collapsed"
let unreadReply = false;   // an answer landed while collapsed
let uiStatus = "idle";     // "idle" | "thinking" | "speaking" | "listening"
let convo = [];            // rolling transcript: [{ role, content, meta? }]
const HISTORY_SENT = 8;    // messages sent with each ask (~4 exchanges)
const HISTORY_KEPT = 12;   // messages retained in the UI/memory

function statusLabel() {
  return uiStatus === "thinking" ? "thinking…"
    : uiStatus === "looking" ? "looking…"
    : uiStatus === "speaking" ? "speaking…"
    : uiStatus === "listening" ? "listening…" : "";
}

function setStatus(s) {
  uiStatus = s;
  document.getElementById("ccStatus").textContent = statusLabel();
  refreshFabStatus();
}

function refreshFabStatus() {
  // The tiny pill next to the collapsed ✦: activity while collapsed, plus a
  // "new reply" badge when an answer arrived unseen.
  const show = cardState === "collapsed" && (unreadReply || uiStatus !== "idle");
  fabStatusEl.style.display = show ? "block" : "none";
  if (!show) return;
  fabStatusEl.classList.toggle("newreply", unreadReply);
  document.getElementById("fabStatusText").textContent = unreadReply ? "new reply" : statusLabel();
}

function renderTranscript(thinking) {
  const t = document.getElementById("ccTranscript");
  t.innerHTML = "";
  if (!convo.length && !thinking) {
    const hint = document.createElement("div");
    hint.className = "ccHint";
    hint.textContent = companion.isConfigured()
      ? "Ask anything — astronomy, physics, the world. When a mode is open, the companion knows what you're doing."
      : "Not configured yet — scan the bridge QR (show-qr.ps1), or add endpoint + token in Settings.";
    t.appendChild(hint);
    return;
  }
  convo.forEach((m) => {
    const d = document.createElement("div");
    d.className = "ccMsg " + (m.role === "user" ? "user" : "ai");
    d.textContent = m.content;
    if (m.meta) {
      const meta = document.createElement("div");
      meta.className = "ccMeta";
      meta.textContent = m.meta;
      d.appendChild(meta);
    }
    t.appendChild(d);
  });
  if (thinking) {
    const d = document.createElement("div");
    d.className = "ccMsg sys";
    d.textContent = "thinking… (local model, ~10 s)";
    t.appendChild(d);
  }
  t.scrollTop = t.scrollHeight;
}

function transcriptNote(text) { // transient system line (errors etc.) — not part of history
  const t = document.getElementById("ccTranscript");
  const d = document.createElement("div");
  d.className = "ccMsg sys";
  d.textContent = text;
  t.appendChild(d);
  t.scrollTop = t.scrollHeight;
}

function openCard(withAutoListen) {
  card.style.display = "flex";
  cardState = "open";
  unreadReply = false;
  refreshVoicePicker(); // populate Piper voices (async, once per config)
  refreshFabStatus();
  renderTranscript(uiStatus === "thinking");
  document.getElementById("ccStatus").textContent = statusLabel();
  if (withAutoListen && autoListenToggle.checked) {
    if (SR && !micDenied) startListening(); // guard inside prevents double-start
    else document.getElementById("companionQuestion").focus();
  }
}

function collapseCard() {
  card.style.display = "none";
  cardState = "collapsed"; // conversation loop, TTS, and pending asks keep running
  refreshFabStatus();
}

function closeCard() {
  card.style.display = "none";
  cardState = "closed";
  unreadReply = false;
  hideActionConfirm(); // closing the card abandons any pending action (never auto-commits)
  disarmLoop();
  stopSpeaking();
  stopDictation(true);
  setStatus("idle");
}

document.getElementById("companionFab").addEventListener("click", () => {
  primeTTS(); // unlock speech inside this gesture (once per session)
  if (cardState === "open") collapseCard();
  else openCard(cardState === "closed"); // expand from collapsed = no re-listen
});
document.getElementById("ccCollapseBtn").addEventListener("click", collapseCard);
document.getElementById("ccCloseBtn").addEventListener("click", closeCard);
document.getElementById("ccNewBtn").addEventListener("click", () => {
  convo = [];
  stopSpeaking();
  disarmLoop();
  renderTranscript(false);
});

// ---- voice out (speechSynthesis) — opt-in via a persisted toggle ----
// iOS Safari needs real care here: audio must be primed inside a user gesture
// (once), getVoices() is empty until `voiceschanged`, cancel() needs a beat
// before the next speak(), long utterances get truncated, and the whole channel
// is muted by the hardware silent switch (hence the hint in the sheet — that
// one can't be fixed in code).
const speakToggle = document.getElementById("companionSpeakToggle");
const ttsSupported = "speechSynthesis" in window;
let ttsUnlocked = false;
let ttsVoices = [];
let ttsPreferred = null;
let pendingSpeak = null;  // answer that arrived before voices loaded — queued, not dropped
let speakSession = 0;     // bumped on every stop; stale queued speaks abort themselves
let lastChunkCount = 0;   // verification hook

speakToggle.checked = ttsSupported && Boolean(storage.get("companion.speak", false));
if (!ttsSupported) speakToggle.disabled = true;
speakToggle.addEventListener("change", () => {
  storage.set("companion.speak", speakToggle.checked);
  if (speakToggle.checked) primeTTS(); // the change itself is a user gesture
  else stopSpeaking();
});

// ---- voice picker: local Piper voices (via the bridge /tts) + system fallback ----
const voiceSel = document.getElementById("companionVoiceSel");
const rateSel = document.getElementById("companionRateSel");
let piperVoices = [];
let voicesFetched = false;   // reset when the bridge config changes
let piperNoteShown = false;  // quiet one-time "Piper unavailable" note
let audioUnlocked = false;
const piperAudio = new Audio(); // ONE element: unlocked once on a gesture, reused per chunk

// Apply the persisted choice immediately (before the picker is populated), so
// an ask that happens before the card ever opens still uses the saved voice.
const savedVoiceId = String(storage.get("companion.voiceId", "system"));
if (savedVoiceId !== "system") {
  const placeholder = document.createElement("option");
  placeholder.value = savedVoiceId;
  placeholder.textContent = savedVoiceId; // replaced with the proper label on first fetch
  voiceSel.appendChild(placeholder);
}
voiceSel.value = savedVoiceId;
rateSel.value = String(storage.get("companion.rate", "1"));
voiceSel.addEventListener("change", () => storage.set("companion.voiceId", voiceSel.value));
rateSel.addEventListener("change", () => storage.set("companion.rate", rateSel.value));
function currentRate() { return parseFloat(storage.get("companion.rate", "1")) || 1; }

async function refreshVoicePicker() {
  if (voicesFetched || !companion.isConfigured()) return;
  voicesFetched = true;
  piperVoices = await companion.getVoices(); // [] on any failure
  const saved = String(storage.get("companion.voiceId", "system"));
  voiceSel.innerHTML = "";
  const sys = document.createElement("option");
  sys.value = "system";
  sys.textContent = "System voice";
  voiceSel.appendChild(sys);
  piperVoices.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.label;
    voiceSel.appendChild(o);
  });
  voiceSel.value = (saved === "system" || piperVoices.some((v) => v.id === saved)) ? saved : "system";
}

// iOS allows programmatic .play() only on an element that was activated inside
// a user gesture — same rule as speechSynthesis. Prime it once with silence.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    piperAudio.muted = true;
    piperAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
    const p = piperAudio.play();
    if (p && p.catch) p.catch(() => {});
    setTimeout(() => { try { piperAudio.pause(); piperAudio.muted = false; } catch (e) {} }, 60);
  } catch (e) { /* unlock must never break the flow */ }
}

// Piper playback: synthesize the same sentence-chunks via the bridge and play
// them in order through the unlocked element. Chunks are fetched eagerly (the
// proxy serializes synthesis) so playback stays gapless. ANY failure — fetch,
// decode, blocked play() — falls back to speechSynthesis for the REMAINDER of
// the answer: never dead air. onDone fires after the final audio ends, which
// is what drives the conversation-mode relisten.
function speakNowPiper(text, onDone) {
  const session = ++speakSession;
  if (ttsSupported) { try { speechSynthesis.cancel(); } catch (e) {} }
  const voiceId = voiceSel.value;
  const rate = currentRate();
  const chunks = chunkText(text);
  lastChunkCount = chunks.length;
  const blobs = new Array(chunks.length); // undefined = fetching, null = failed
  let idx = 0;
  const fallback = () => {
    if (session !== speakSession) return;
    if (!piperNoteShown) {
      piperNoteShown = true;
      voiceNote.textContent = "Piper voice unavailable — using the system voice.";
    }
    if (!ttsSupported) { if (onDone) onDone(); return; } // no system voice either: end cleanly
    speakNow(chunks.slice(idx).join(" "), onDone); // bumps the session itself
  };
  const playNext = () => {
    if (session !== speakSession) return;
    if (idx >= chunks.length) { if (onDone) onDone(); return; }
    const b = blobs[idx];
    if (b === undefined) { setTimeout(playNext, 120); return; } // still synthesizing
    if (b === null) { fallback(); return; }
    const url = URL.createObjectURL(b);
    piperAudio.onended = () => { URL.revokeObjectURL(url); idx++; playNext(); };
    piperAudio.onerror = () => { URL.revokeObjectURL(url); fallback(); };
    piperAudio.src = url;
    const p = piperAudio.play();
    if (p && p.catch) p.catch(() => fallback());
  };
  chunks.forEach((c, i) => {
    companion.tts(c, voiceId, rate)
      .then((blob) => { blobs[i] = blob; if (i === 0) playNext(); })
      .catch(() => { blobs[i] = null; if (i === 0) playNext(); });
  });
}

function loadVoices() {
  if (!ttsSupported) return;
  ttsVoices = speechSynthesis.getVoices();
  const lang = navigator.language || "en-US";
  ttsPreferred =
    ttsVoices.find((v) => v.lang === lang && v.localService) ||
    ttsVoices.find((v) => v.lang === lang) ||
    ttsVoices.find((v) => v.lang && v.lang.indexOf("en") === 0 && v.default) ||
    ttsVoices.find((v) => v.lang && v.lang.indexOf("en") === 0) || null;
  if (ttsVoices.length && pendingSpeak) {
    const queued = pendingSpeak;
    pendingSpeak = null;
    speakNow(queued.text, queued.onDone);
  }
}
loadVoices();
if (ttsSupported) speechSynthesis.addEventListener("voiceschanged", loadVoices);

// One-time unlock inside the session's first companion gesture (sheet open,
// mic tap, Ask, or toggling speak on). Near-silent so it's inaudible.
function primeTTS() {
  unlockAudio(); // HTMLAudio unlock for the Piper path (its own once-flag)
  if (!ttsSupported || ttsUnlocked) return;
  ttsUnlocked = true;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0.01;
    speechSynthesis.speak(u);
  } catch (e) { /* priming must never break the flow */ }
}

// iOS truncates long utterances — split into sentences, merge to ~200-char chunks.
function chunkText(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > 200) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function speakNow(text, onDone) {
  const session = ++speakSession;
  speechSynthesis.cancel();
  // Give cancel() a beat to fully clear (iOS stalls if speak() follows at once).
  setTimeout(() => {
    if (session !== speakSession || !speakToggle.checked) return; // stopped meanwhile
    if (speechSynthesis.paused) { try { speechSynthesis.resume(); } catch (e) {} }
    const chunks = chunkText(text);
    lastChunkCount = chunks.length;
    let finished = 0;
    const chunkDone = () => {
      // onDone fires once, after the FINAL chunk, and only if this speak
      // wasn't superseded (a stop bumps speakSession, silencing the callback).
      if (++finished === chunks.length && session === speakSession && onDone) onDone();
    };
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = navigator.language || "en-US";
      u.rate = currentRate();
      if (ttsPreferred) u.voice = ttsPreferred;
      u.onstart = () => console.debug(`tts chunk ${i + 1}/${chunks.length} start`);
      u.onend = () => { console.debug(`tts chunk ${i + 1}/${chunks.length} end`); chunkDone(); };
      u.onerror = (e) => { console.warn("tts error:", e.error); chunkDone(); }; // never hang the loop
      speechSynthesis.speak(u); // enqueued; the engine plays them in order
    });
    if (speechSynthesis.paused) { try { speechSynthesis.resume(); } catch (e) {} }
  }, 80);
}

function speakReply(text, onDone) {
  if (!speakToggle.checked || !text) return false;
  // A selected Piper voice routes through the bridge; anything else (or an
  // unconfigured bridge) uses the system speechSynthesis path below.
  if (voiceSel.value !== "system" && companion.isConfigured()) {
    speakNowPiper(text, onDone);
    return true;
  }
  if (!ttsSupported) return false;
  if (!ttsVoices.length) {
    // Voices not loaded yet: queue for voiceschanged, with a fallback timer so
    // engines that can speak without listing voices still get the answer.
    const queued = { text, onDone };
    pendingSpeak = queued;
    setTimeout(() => {
      if (pendingSpeak === queued) { pendingSpeak = null; speakNow(text, onDone); }
    }, 1500);
    return true;
  }
  speakNow(text, onDone);
  return true;
}

// Language-aware speech for Translate: English stays on Piper (our natural
// voice); a FOREIGN target uses the system speechSynthesis voice whose language
// matches, because speaking Spanish with an English voice is unintelligible. If
// no system voice exists for that language we DON'T speak it — the caller shows
// the text instead of mangling it. Returns { spoken, reason?, voice? }.
function systemVoiceForLang(langCode) {
  if (!ttsSupported) return null;
  const voices = speechSynthesis.getVoices();
  const base = String(langCode || "").slice(0, 2).toLowerCase();
  if (!base) return null;
  return voices.find((v) => v.lang && v.lang.toLowerCase() === langCode.toLowerCase() && v.localService)
    || voices.find((v) => v.lang && v.lang.toLowerCase() === langCode.toLowerCase())
    || voices.find((v) => v.lang && v.lang.toLowerCase().slice(0, 2) === base && v.localService)
    || voices.find((v) => v.lang && v.lang.toLowerCase().slice(0, 2) === base)
    || null;
}
function speakInLanguage(text, langCode, onDone) {
  const t = String(text || "").trim();
  if (!t) return { spoken: false, reason: "empty" };
  const base = String(langCode || "").slice(0, 2).toLowerCase();
  // English → our Piper/system path exactly as the companion uses it.
  if (base === "en") { const ok = speakReply(t, onDone); return { spoken: ok, reason: ok ? null : "muted", engine: "piper/system" }; }
  if (!speakToggle.checked) return { spoken: false, reason: "muted" };
  const voice = systemVoiceForLang(langCode);
  if (!voice) return { spoken: false, reason: "no-voice" };   // don't mispronounce
  const session = ++speakSession;
  try { speechSynthesis.cancel(); } catch (e) {}
  setTimeout(() => {
    if (session !== speakSession) return;
    const chunks = chunkText(t);
    let finished = 0;
    chunks.forEach((c) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = voice.lang;          // critical: tag the utterance's language
      u.voice = voice;
      u.rate = currentRate();
      u.onend = () => { if (++finished === chunks.length && session === speakSession && onDone) onDone(); };
      u.onerror = () => { if (++finished === chunks.length && session === speakSession && onDone) onDone(); };
      speechSynthesis.speak(u);
    });
    if (speechSynthesis.paused) { try { speechSynthesis.resume(); } catch (e) {} }
  }, 60);
  return { spoken: true, reason: null, engine: "system", voice: { name: voice.name, lang: voice.lang } };
}

function stopSpeaking() {
  pendingSpeak = null;
  speakSession++; // aborts any queued/delayed speakNow AND stale Piper pipelines
  try {
    piperAudio.pause();
    piperAudio.onended = null;
    piperAudio.onerror = null;
    piperAudio.removeAttribute("src");
  } catch (e) { /* flushing must never throw */ }
  if (ttsSupported) speechSynthesis.cancel();
}

// ---- voice in (SpeechRecognition; webkitSpeechRecognition on iOS/Safari) ----
// ONE recognition instance for the whole app. iOS fires benign events constantly
// (self-aborts, silence, focus loss) and double-starting a recognizer causes instant
// "aborted" errors — a single lazily-created instance plus an explicit `listening`
// flag prevents both, and benign errors never surface as banners. If iOS dictation
// stays flaky in practice, the noted future path is local Whisper speech-to-text on
// the bridge (not built).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = document.getElementById("companionMicBtn");
const voiceNote = document.getElementById("companionVoiceNote");
let recognition = null;       // the single instance, created on first use
let listening = false;        // guards start(): double-start = instant "aborted"
let finalTranscript = "";
let discardDictation = false; // abort path (close/mode exit): never auto-send

if (!SR) {
  micBtn.classList.add("unsupported"); // typing still works everywhere
  voiceNote.textContent = "Voice input isn't supported in this browser — type your question instead.";
}

// Conversation-mode loop state: "armed" means the current/next listen was
// started by the hands-free loop (not a manual tap), so its outcome decides
// whether the loop continues.
let micDenied = false;    // set on not-allowed; auto-listen + loop stay out of the way
let convoArmed = false;
let noSpeechRuns = 0;     // consecutive silent loop turns; 2 ends the loop quietly

function disarmLoop() { convoArmed = false; noSpeechRuns = 0; }

// Handler wiring is separate from construction so the verification harness can
// inject a stub recognizer and still exercise the REAL handler logic.
function wireRecognition(rec) {
  const input = document.getElementById("companionQuestion");
  rec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) (r.isFinal ? (finalTranscript += r[0].transcript) : (interim += r[0].transcript));
    // WAKE MODE: the pre-trigger stream never reaches the input box, the
    // transcript, storage, or any action — it is inspected for the phrase and
    // then discarded. Only what follows the trigger is ever used.
    if (wakeMode) { handleWakeAudio(finalTranscript + interim); return; }
    input.value = (finalTranscript + interim).trim();
  };
  rec.onerror = (e) => {
    finalTranscript = "";
    switch (e.error) {
      case "aborted":       // benign: self-abort / we cancelled — silent
        break;
      case "no-speech":     // benign; in the hands-free loop, count it
        if (convoArmed) noSpeechRuns++;
        else voiceNote.textContent = "Didn't catch that — tap the mic and try again, or type.";
        break;
      case "not-allowed":
      case "service-not-allowed":
        micDenied = true;   // don't keep auto-starting a mic that can't open
        disarmLoop();
        input.value = "";
        voiceNote.textContent = "Microphone access was denied — allow the mic for this site (iOS: Settings → Safari → Microphone), or just type.";
        break;
      case "audio-capture":
        disarmLoop();
        input.value = "";
        voiceNote.textContent = "No microphone was found on this device — type your question instead.";
        break;
      case "network":
        disarmLoop();
        input.value = "";
        voiceNote.textContent = "The speech service is unreachable right now — type your question instead.";
        break;
      default:              // anything exotic: stay quiet, typing always works
        break;
    }
  };
  rec.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    if (uiStatus === "listening") setStatus("idle");
    // In wake mode the cycle simply restarts (or stops on inactivity); nothing
    // heard before a trigger is ever sent anywhere.
    if (wakeMode) { finalTranscript = ""; discardDictation = false; onWakeCycleEnd(); return; }
    const send = !discardDictation && finalTranscript && input.value.trim();
    discardDictation = false;
    finalTranscript = "";
    if (send) {
      noSpeechRuns = 0;   // the loop heard something — reset the silence counter
      askCompanion();     // speak → auto-send (loop stays armed via maybeRelisten)
    } else if (convoArmed) {
      if (noSpeechRuns >= 2) {
        disarmLoop();     // two silent turns: end quietly, no error banner
        voiceNote.textContent = "Conversation paused — tap the mic or just type to continue.";
      } else {
        startListening(); // one more chance to catch the user's turn
      }
    }
  };
}

function getRecognition() {
  if (recognition) return recognition;
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;   // live transcript into the box
  rec.continuous = false;      // one utterance per listen
  rec.maxAlternatives = 1;
  wireRecognition(rec);
  recognition = rec;
  return rec;
}

// stop(discard=false) finalizes (may auto-send); stop(discard=true) throws the
// in-progress dictation away (card close, mode exit, new question) and always
// ends the hands-free loop cycle.
function stopDictation(discard = false) {
  if (discard) disarmLoop();
  if (!listening || !recognition) return;
  discardDictation = discard;
  try { discard ? recognition.abort() : recognition.stop(); } catch (e) { /* already stopped */ }
}

let recStartCount = 0; // verification hook: how many times rec.start() actually ran

// ---------------------------------------------------------------- wake word
// FOREGROUND ONLY, OFF BY DEFAULT. This runs the SAME single recognizer in a
// different loop — there is no second instance, and the `listening` guard,
// benign aborted/no-speech handling, and mic/TTS never-overlap rule all still
// apply. Nothing heard before the trigger phrase is stored or acted on.
//
// SEAM: detectWake() is the whole detection surface. A proper offline
// wake-word engine can replace this one function later without touching the
// router or the loop. The naive continuous-listen here may prove flaky on iOS
// (see our `aborted` history) — that's the documented upgrade path.
const WAKE_DEFAULT_PHRASE = "hey engine";   // distinctive: two words, uncommon pair
const WAKE_IDLE_MS = 5 * 60 * 1000;         // auto-stop after 5 min with no trigger
let wakeMode = false;                        // is the recognizer in wake-listen?
let wakeEnabled = false;                     // the persisted toggle
let wakePhrase = WAKE_DEFAULT_PHRASE;
let wakeLastTriggerAt = 0;
let wakeArmedText = "";                      // transient; cleared every cycle

// The detection seam. Returns { triggered, rest } and NOTHING else — no storage,
// no side effects, no retention.
function detectWake(transcript, phrase) {
  const t = String(transcript || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const p = String(phrase || "").toLowerCase().trim();
  if (!p) return { triggered: false, rest: "" };
  const i = t.indexOf(p);
  if (i < 0) return { triggered: false, rest: "" };
  return { triggered: true, rest: t.slice(i + p.length).trim() };
}

function handleWakeAudio(transcript) {
  const { triggered, rest } = detectWake(transcript, wakePhrase);
  if (!triggered) { wakeArmedText = ""; return; }   // discarded — never stored
  wakeLastTriggerAt = Date.now();
  wakeArmedText = rest;
  setWakeIndicator(true, rest ? `heard: ${rest}` : "listening for your request…");
  // Let the utterance finish so we capture the whole request, then hand off.
  if (rest && rest.split(/\s+/).length >= 2) {
    stopDictation(true);                 // ends this cycle; onend routes it
  }
}

function onWakeCycleEnd() {
  const pending = wakeArmedText;
  wakeArmedText = "";
  if (pending) {
    // Everything after the trigger goes to the ROUTER via the normal ask path,
    // identical to the tap path — same gates, same fallthrough.
    setWakeIndicator(wakeEnabled, "routing…");
    const input = document.getElementById("companionQuestion");
    input.value = pending;
    askCompanion();
    // resume watching once the request has been handled
    setTimeout(() => { if (wakeEnabled) startWakeListen(); }, 1200);
    return;
  }
  if (!wakeEnabled) { setWakeIndicator(false); return; }
  if (Date.now() - wakeLastTriggerAt > WAKE_IDLE_MS) {
    stopWake("Wake word paused after 5 quiet minutes — tap 👂 to resume.");
    return;
  }
  setTimeout(() => { if (wakeEnabled && !listening) startWakeListen(); }, 400);
}

function startWakeListen() {
  if (!SR || !wakeEnabled || listening || micDenied) return;
  if (asking || looking) { setTimeout(startWakeListen, 1500); return; }  // never over a request
  wakeMode = true;
  stopSpeaking();                     // mic and speaker never run together
  const rec = getRecognition();       // the SAME single instance
  listening = true;
  finalTranscript = "";
  discardDictation = false;
  setWakeIndicator(true, `listening for “${wakePhrase}”`);
  try { rec.start(); recStartCount++; }
  catch (err) { listening = false; setTimeout(() => { if (wakeEnabled) startWakeListen(); }, 800); }
}

function startWake() {
  if (!SR) { transcriptNote("Voice input isn't supported in this browser."); return; }
  wakeEnabled = true;
  storage.set("wake.enabled", true);
  wakeLastTriggerAt = Date.now();
  startWakeListen();
  syncWakeUI();
}
function stopWake(note) {
  wakeEnabled = false;
  wakeMode = false;
  wakeArmedText = "";
  storage.set("wake.enabled", false);
  stopDictation(true);
  setWakeIndicator(false);
  syncWakeUI();
  if (note) transcriptNote(note);
}

// An always-visible indicator whenever the mic is live — the user must never
// have to wonder whether it's listening.
function setWakeIndicator(on, detail) {
  const el = document.getElementById("wakeIndicator");
  if (!el) return;
  el.style.display = on ? "flex" : "none";
  const d = document.getElementById("wakeIndicatorText");
  if (d) d.textContent = detail || "mic on";
}
function syncWakeUI() {
  const t = document.getElementById("wakeToggle");
  if (t) t.checked = wakeEnabled;
  const p = document.getElementById("wakePhraseInput");
  if (p && p.value !== wakePhrase) p.value = wakePhrase;
}

function startListening() {
  if (!SR || listening) return; // the guard: auto-start + manual tap can never double-start
  wakeMode = false;             // a manual tap is always a normal dictation
  stopSpeaking(); // mic and speaker never run together
  const input = document.getElementById("companionQuestion");
  const rec = getRecognition();
  listening = true;
  finalTranscript = "";
  discardDictation = false;
  micBtn.classList.add("listening");
  setStatus("listening");
  voiceNote.textContent = "Listening… speak your question (tap again to stop).";
  input.value = "";
  try { rec.start(); recStartCount++; } catch (err) {
    // start() throws if the engine is somehow mid-shutdown — reset quietly
    listening = false;
    micBtn.classList.remove("listening");
    setStatus("idle");
    voiceNote.textContent = "";
  }
}

micBtn.addEventListener("click", () => {
  if (!SR) return;
  primeTTS(); // any companion gesture may be the session's first
  if (listening) {
    // Stop-tap: finalize (sends if something was said) AND end the loop cycle.
    disarmLoop();
    stopDictation(false);
    return;
  }
  disarmLoop(); // a manual listen is not a loop turn
  startListening();
});

// ---- hands-free "Conversation mode": after an answer is fully SPOKEN, listen
// for the next turn. Requires Speak-answers on; never overlaps mic and TTS
// (this runs only from the final chunk's onend, and startListening cancels any
// residual speech). The `listening` guard makes double-starts impossible.
const convoToggle = document.getElementById("companionConvoToggle");
convoToggle.checked = Boolean(storage.get("companion.convoMode", false));
if (!SR) convoToggle.disabled = true;
convoToggle.addEventListener("change", () => {
  storage.set("companion.convoMode", convoToggle.checked);
  if (!convoToggle.checked) {
    const wasLoopListen = convoArmed && listening;
    disarmLoop();
    if (wasLoopListen) stopDictation(true); // stop the loop immediately
  }
});

function maybeRelisten() {
  if (!convoToggle.checked || !speakToggle.checked) return;
  if (cardState === "closed") return; // collapsed keeps looping; closed stops
  if (!SR || micDenied || listening || asking || looking) return;
  convoArmed = true;
  startListening();
}

// ---- "Open and listen" (one-tap talk): persisted, default ON ----
const autoListenToggle = document.getElementById("companionAutoListen");
autoListenToggle.checked = Boolean(storage.get("companion.autoListen", true));
if (!SR) autoListenToggle.disabled = true;
autoListenToggle.addEventListener("change", () => {
  storage.set("companion.autoListen", autoListenToggle.checked);
});

// Verification hook (same spirit as the modes' _state()).
window.RE_knowledge = knowledge;
window.RE_voiceDebug = {
  primed: () => ttsUnlocked,
  listening: () => listening,
  startCount: () => recStartCount,
  pendingSpeak: () => pendingSpeak !== null,
  lastChunkCount: () => lastChunkCount,
  chunk: chunkText,
  startListening: startListening,
  // convo/card state
  cardState: () => cardState,
  status: () => uiStatus,
  convoLen: () => convo.length,
  armed: () => convoArmed,
  noSpeechRuns: () => noSpeechRuns,
  maybeRelisten: maybeRelisten,
  // Inject a stub recognizer wired with the REAL handlers, so tests can drive
  // onerror/onend without a live microphone.
  _setRecognitionForTest: (fake) => { recognition = fake; wireRecognition(fake); return fake; },
  _recognition: () => recognition,
  // Piper path introspection
  piperAudio: () => piperAudio,
  audioUnlocked: () => audioUnlocked,
  piperVoices: () => piperVoices,
  selectedVoice: () => voiceSel.value,
  speakReply: speakReply,
  // vision
  visionAsk: (b64, q) => visionAsk(b64, q),
  looking: () => looking,
  frameToJpegBase64: frameToJpegBase64,
  // actions (P0): inject a model reply without the bridge, inspect the gate
  _injectReply: (question, text) => handleAssistantReply(question, { ok: true, text, stats: null }),
  // full-result injection, so the memory-honesty guard can be tested with a
  // deliberately hallucinated reply and an empty retrieval set
  _injectReplyWithRes: (question, res) => handleAssistantReply(question, res),
  extractAction: extractAction,
  pendingAction: () => pendingAction,
  localActions: localActions,
  checkReminders: checkReminders,
  // memory verification hooks
  requestActionConfirm: (a) => requestActionConfirm(a),
  confirmYes: () => document.getElementById("ccConfirmYes").click(),
  confirmNo: () => document.getElementById("ccConfirmNo").click(),
  memories: () => knowledge.personal(),
  renderMemories: () => renderMemoriesSheet(),
  lastRecall: () => lastRecall,
  lookAndRemember: (b64) => lookAndRemember(b64),
  knowledge: knowledge,
  // voice router verification hooks
  router: router,
  routerCtx: () => routerCtx(),
  loadModeCapabilities: () => loadModeCapabilities(),
  askText: (t) => { document.getElementById("companionQuestion").value = t; return askCompanion(); },
  // wake-word verification hooks — drive the REAL handlers without a live mic
  wake: {
    detect: (t, p) => detectWake(t, p || wakePhrase),
    feed: (t) => handleWakeAudio(t),
    cycleEnd: () => onWakeCycleEnd(),
    setMode: (v) => { wakeMode = !!v; },
    state: () => ({ wakeMode, wakeEnabled, wakePhrase, armed: wakeArmedText, listening }),
    recognizerInstance: () => recognition,
    recStarts: () => recStartCount,
  },
};

// ---------------------------------------------------------------- voice router
// The shell registers the GLOBAL capabilities (memory, notes, reminders, look,
// open-a-mode) through exactly the same interface modes use. The router itself
// knows about none of them.
//
// Anything side-effectful builds its action locally and hands it to the SAME
// confirmation gate as before — the router changes how a request arrives, never
// whether it's confirmed.

// "remember the passport is in the desk drawer" → the fact, minus the command.
function stripLead(text, re) { return String(text).replace(re, "").trim().replace(/^that\s+/i, ""); }
// The thing a memory is ABOUT: the words before the first relational word, so
// "the passport is in the desk drawer" → "passport", not "passport is in".
function subjectOf(fact) {
  const head = String(fact).replace(/^(the|my|a|an)\s+/i, "")
    .split(/\s+(?:is|are|was|were|goes|lives|sits|in|on|under|at|with|works)\b/i)[0];
  return head.trim().replace(/[.,]$/, "").split(/\s+/).slice(0, 4).join(" ").slice(0, 60);
}
// A capability that opened a confirmation gate has fully handled the request —
// the gate is the response. Returning this (rather than null) stops the router
// falling through to the companion and firing a needless model call.
const GATED = { text: "" };

// Deterministic time parsing for the common reminder phrasings. Anything more
// exotic returns null and the capability declines, so the request falls through
// to today's companion path unchanged.
function parseWhen(text) {
  const t = String(text).toLowerCase();
  let m = t.match(/\bin\s+(\d{1,3})\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const ms = /hour|hr/.test(m[2]) ? n * 3600000 : n * 60000;
    return new Date(Date.now() + ms);
  }
  m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    const d = new Date();
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (!m[3] && h <= 7) h += 12;          // "at 6" in the evening, sensibly
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

function registerGlobalCapabilities() {
  router.register({
    id: "memory.remember", label: "Remember it", sideEffect: true,
    patterns: [/^\s*(remember|keep in mind|don'?t forget)\b/i, /\bmake a memory\b/i],
    examples: ["remember the passport is in the desk drawer", "remember my oven runs hot"],
    run: (text) => {
      const fact = stripLead(text, /^\s*(remember|keep in mind|don'?t forget)\s*/i);
      if (!fact) return null;              // decline → normal companion answer
      const kind = /\bthis is\b|\bworks (with|at)\b|\bshe |\bhe /i.test(fact) ? "person"
        : /\bin the\b|\bon the\b|\bunder\b|\bdrawer|shelf|cupboard/i.test(fact) ? "thing" : "fact";
      requestActionConfirm({ action: "remember", text: fact, subject: subjectOf(fact), kind });
      return GATED;                         // the gate IS the response
    },
  });

  router.register({
    id: "memory.forget", label: "Forget it", sideEffect: true,
    patterns: [/^\s*(forget|delete the memory|remove the memory)\b/i],
    examples: ["forget the backpack", "forget what I said about the landlord"],
    run: (text) => {
      const ref = stripLead(text, /^\s*(forget|delete the memory( about)?|remove the memory( about)?)\s*/i)
        .replace(/^(about|what i said about)\s+/i, "");
      if (!ref) return null;
      requestActionConfirm({ action: "forget", ref });
      return GATED;
    },
  });

  // Recall deliberately DECLINES: the normal companion path already retrieves
  // memories globally with the when/where and hallucination guards. Routing it
  // anywhere else would duplicate that logic and risk regressing it. Registered
  // so the decision is visible in the log rather than silently unmatched.
  router.register({
    id: "memory.recall", label: "Recall a memory",
    patterns: [/\bwhere (did|do) i (put|leave)\b/i, /\bwhere('?s| is| are) my\b/i,
               /\bwhat did i say about\b/i, /^\s*who is\b/i,
               // recorded sessions land in the same store, so meeting recall
               // routes here too and is answered by the normal path
               /\bwhat (did|was) (we|it|they) ?(decide|agree|discuss|say|conclude)/i,
               /\bwhat (was|were) (decided|agreed|discussed)\b/i,
               /\b(in|from|at) (the|that|our|my) (meeting|call|session|standup|review)\b/i],
    examples: ["where did I put my passport", "who is Maya", "what did we decide about the budget"],
    run: () => null,   // → today's answer path, unchanged
  });

  router.register({
    id: "actions.reminder", label: "Set a reminder", sideEffect: true,
    // "remind me" anywhere, so "can you remind me to call mum" routes too — and
    // so a phrase containing BOTH remember and remind is caught as ambiguous
    // rather than silently resolved to whichever pattern happened to be first.
    patterns: [/\bremind me\b/i, /\bset a reminder\b/i],
    examples: ["remind me in 10 minutes to check the oven", "remind me at 6pm to call"],
    run: (text) => {
      const when = parseWhen(text);
      if (!when) return null;              // exotic phrasing → companion parses it
      let what = String(text)
        .replace(/^\s*remind me\s*/i, "").replace(/\bset a reminder\s*/i, "")
        .replace(/\bin\s+\d{1,3}\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i, "")
        .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i, "")
        .replace(/^\s*(to|that)\s+/i, "").trim();
      if (!what) return null;
      requestActionConfirm({ action: "add_reminder", text: what, when: when.toISOString(), dueMs: when.getTime() });
      return GATED;
    },
  });

  router.register({
    id: "actions.note", label: "Make a note", sideEffect: true,
    patterns: [/^\s*(make|add|take|write) a note\b/i, /^\s*note (that|to)\b/i],
    examples: ["make a note to buy milk", "note that the bin goes out Tuesday"],
    run: (text) => {
      const note = stripLead(text, /^\s*((make|add|take|write) a note|note)\s*(that|to)?\s*/i);
      if (!note) return null;
      requestActionConfirm({ action: "add_note", note });
      return GATED;
    },
  });

  // Runs IN PLACE — looking at something shouldn't yank you out of your mode.
  router.register({
    id: "vision.look", label: "Look at this",
    patterns: [/^\s*(what is|what'?s) (this|that)\b/i, /\blook at (this|that)\b/i,
               /\bwhat am i (looking at|holding)\b/i],
    examples: ["what is this", "look at this", "what am I looking at"],
    run: () => { lookBtn.click(); return GATED; },  // the vision flow speaks for itself
  });

  // "open astronomy" / "switch to football" — patterns built from the REGISTRY,
  // so a new mode is routable the moment it's registered, with no router edit.
  const modeWords = REGISTRY.map((e) => e.id).join("|");
  router.register({
    id: "shell.openMode", label: "Open a mode",
    patterns: [new RegExp(`\\b(open|switch to|go to|launch|start)\\s+(the\\s+)?(${modeWords})\\b`, "i")],
    examples: REGISTRY.slice(0, 3).map((e) => `open ${e.id}`),
    run: async (text) => {
      const m = String(text).match(new RegExp(`\\b(?:open|switch to|go to|launch|start)\\s+(?:the\\s+)?(${modeWords})\\b`, "i"));
      if (!m) return null;
      const entry = REGISTRY.find((e) => e.id === m[1].toLowerCase());
      if (!entry) return null;
      if (active && active.entry && active.entry.id === entry.id) return `Already in ${entry.title}.`;
      await openMode(entry);
      return `Opened ${entry.title}.`;
    },
  });
}

registerGlobalCapabilities();

// Mode capabilities are discovered from describeCapabilities() by importing each
// registered mode ONCE, lazily, on first use. Modes have no import-time side
// effects, and a failing import is skipped rather than breaking routing.
let modeCapsLoaded = false;
async function loadModeCapabilities() {
  if (modeCapsLoaded) return;
  modeCapsLoaded = true;
  await Promise.all(REGISTRY.map(async (entry) => {
    try {
      const mod = (await entry.load()).default;
      if (typeof mod.describeCapabilities !== "function") return;
      for (const cap of mod.describeCapabilities() || []) {
        router.register({ ...cap, modeId: cap.modeId || entry.id, label: cap.label || entry.title });
      }
    } catch (err) {
      console.warn(`router: couldn't read capabilities for "${entry.id}" —`, err && err.message);
    }
  }));
}

// The context the router needs — it owns none of this itself.
function routerCtx() {
  return {
    activeModeId: active && active.entry ? active.entry.id : null,
    ask: (p, c, h, o) => companion.ask(p, c, h, o),
    // A switch must be visible even with the companion card closed — otherwise
    // the app silently changing modes under you is confusing.
    announce: (msg) => { showToast(msg); transcriptNote(msg); },
    switchTo: async (modeId) => {
      const entry = REGISTRY.find((e) => e.id === modeId);
      if (!entry) throw new Error(`no such mode: ${modeId}`);
      await openMode(entry);
    },
    // Lets a mode capability reuse its own handleCommand once it's active,
    // instead of duplicating that parsing in the capability.
    callActiveCommand: (text) => {
      if (active && active.mod && typeof active.mod.handleCommand === "function") {
        try { return active.mod.handleCommand(text); } catch (e) { return null; }
      }
      return null;
    },
  };
}

// ---- ask flow (typed or dictated), multi-turn ----
let asking = false;
async function askCompanion() {
  if (asking || looking) return;
  const input = document.getElementById("companionQuestion");
  const question = input.value.trim();
  if (!question) return;
  stopDictation(true); // question text is already captured — discard the dictation
  stopSpeaking();      // a new question interrupts the previous answer
  primeTTS();          // in case this Ask is the session's first companion gesture
  if (pendingAction) { hideActionConfirm(); transcriptNote("Previous action cancelled."); }

  // Active-mode command hook: a mode may handle the input itself ("next",
  // "start the timer", "how does this look?") — instant, local, no model
  // round-trip. Returning null/undefined falls through to the companion.
  if (active && active.mod && typeof active.mod.handleCommand === "function") {
    let handled = null;
    try { handled = active.mod.handleCommand(question); } catch (e) { console.error("mode command failed:", e); }
    if (handled) {
      asking = true;
      document.getElementById("companionAskBtn").disabled = true;
      input.value = "";
      const isAsync = typeof handled.then === "function";
      setStatus(isAsync ? "looking" : "thinking");
      if (isAsync) renderTranscript(true);
      try {
        const text = String((await handled) || "Done.");
        handleAssistantReply(question, { ok: true, text, stats: null }, { fromMode: true });
        pullActiveGlance(); // a mode command may have changed its glance state
      } catch (err) {
        console.error("mode command failed:", err);
        renderTranscript(false);
        transcriptNote("That didn't work: " + (err && err.message || err));
        setStatus("idle");
      } finally {
        asking = false;
        document.getElementById("companionAskBtn").disabled = false;
        refreshFabStatus();
      }
      return;
    }
  }

  // Voice intent router: reach the right capability from ANYWHERE, switching
  // modes when needed. Runs AFTER the active mode's handleCommand (so "next" in
  // Guide still wins) and BEFORE the companion — anything it doesn't claim
  // falls through to exactly today's answer. That's the regression bar.
  try {
    await loadModeCapabilities();
    const routed = await router.route(question, routerCtx());
    if (routed.handled) {
      input.value = "";
      if (routed.text) {
        // A clarifying question is a question, not an answer — never spoken as
        // if the action happened, and never stored as a completed turn.
        handleAssistantReply(question, { ok: true, text: routed.text, stats: null }, { fromMode: true });
        glasses.send({ title: routed.clarify ? "?" : "Done", lines: glasses.wrap(routed.text), spoken: routed.text, holdMs: 6000 });
      }
      pullActiveGlance();
      refreshFabStatus();
      return;
    }
  } catch (err) {
    console.error("router failed — falling through to the companion:", err);
  }

  const context = activeContext(); // re-read at ask time — freshest reading
  asking = true;
  document.getElementById("companionAskBtn").disabled = true;
  setStatus("thinking");
  renderTranscript(true);
  voiceNote.textContent = SR ? "" : voiceNote.textContent;
  input.value = ""; // box is free for the next question while this one thinks
  try {
    // Multi-turn memory: recent turns ride along so follow-ups resolve
    // ("what about the one next to it?"). Capped to respect the proxy limits.
    const history = convo.slice(-HISTORY_SENT).map((m) => ({ role: m.role, content: m.content }));
    // An active mode may football-prime (etc.) fall-through answers by exposing
    // getSystemContext() — additive; modes without it are unaffected.
    let systemExtra = "";
    try { systemExtra = (active && active.mod && active.mod.getSystemContext && active.mod.getSystemContext()) || ""; }
    catch (e) { console.error("getSystemContext failed:", e); }
    const res = await companion.ask(question, context, history, { systemExtra });
    if (res.ok) {
      handleAssistantReply(question, res);
    } else {
      renderTranscript(false);
      transcriptNote(res.text); // error line — shown, never stored as history
      input.value = question;   // hand the question back for retry
      disarmLoop();
      setStatus("idle");
    }
  } finally {
    asking = false;
    document.getElementById("companionAskBtn").disabled = false;
    refreshFabStatus();
  }
}
document.getElementById("companionAskBtn").addEventListener("click", askCompanion);
document.getElementById("companionQuestion").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); askCompanion(); }
});

// ---- personal memory helpers -------------------------------------------------
// A COARSE place tag, and ONLY if location permission was already granted by
// something else — saving a memory must never trigger a location prompt. Rounded
// to ~1km so the store never holds a precise position. Best-effort and silent.
let lastCoarsePlace = null;
let lastRecall = null;   // last recalled memory (feeds the glance card + tests)
function refreshCoarsePlace() {
  if (!navigator.geolocation || !navigator.permissions) return;
  navigator.permissions.query({ name: "geolocation" }).then((p) => {
    if (p.state !== "granted") return;   // never prompt for this
    navigator.geolocation.getCurrentPosition(
      (pos) => { lastCoarsePlace = `${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`; },
      () => {}, { enableHighAccuracy: false, timeout: 4000, maximumAge: 600000 });
  }).catch(() => {});
}
refreshCoarsePlace();
function coarsePlaceTag() { return lastCoarsePlace; }

// HONESTY: memories are embedded and stored on the user's OWN bridge (their
// machine) — private and third-party-free, but not phone-only like notes. This
// string is shown wherever memories are saved or listed.
const MEMORY_STORAGE_NOTE =
  "Memories are stored on your own bridge (your machine) — never sent to anyone else. " +
  "Unlike notes, they don't live only on this phone.";

// ---------------------------------------------------------------- Actions P0
// LOCAL notes & reminders with a MANDATORY confirmation gate. The model may
// propose an action via a fenced JSON block; the app validates it and nothing
// is written or deleted until the user taps Confirm. Anything absent/invalid
// is treated as plain conversation — an action is never fabricated. list_*
// read-backs are generated by the APP from storage (the model doesn't know
// the data), so they're always true. No network on any action path.
const ACTION_TYPES = { add_note: 1, list_notes: 1, delete_note: 1, add_reminder: 1, list_reminders: 1, delete_reminder: 1, remember: 1, forget: 1 };
const MEMORY_KINDS = { thing: 1, person: 1, fact: 1, place: 1, session: 1 };
let pendingAction = null;

function validateAction(o) {
  if (!o || typeof o !== "object" || !ACTION_TYPES[o.action]) return null;
  const ok = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 500;
  switch (o.action) {
    case "add_note":
      return ok(o.note) ? { action: "add_note", note: o.note.trim() } : null;
    case "remember":
      return ok(o.text) ? { action: "remember", text: o.text.trim(),
        topic: typeof o.topic === "string" ? o.topic.trim().slice(0, 60) : "",
        // Personal-memory metadata: what kind of thing, and what it's about.
        kind: MEMORY_KINDS[o.kind] ? o.kind : "fact",
        subject: typeof o.subject === "string" && o.subject.trim()
          ? o.subject.trim().slice(0, 80)
          : (typeof o.topic === "string" && o.topic.trim() ? o.topic.trim().slice(0, 80) : "") } : null;
    case "forget":
      return ok(String(o.match ?? o.id ?? "")) ? { action: "forget", ref: String(o.match ?? o.id).trim() } : null;
    case "add_reminder": {
      if (!ok(o.text) || !ok(o.when)) return null;
      const dueMs = Date.parse(o.when.trim());
      return isFinite(dueMs) ? { action: "add_reminder", text: o.text.trim(), when: o.when.trim(), dueMs } : null;
    }
    case "delete_note":
    case "delete_reminder": {
      const ref = o.match !== undefined ? o.match : o.id;
      return ok(String(ref ?? "")) ? { action: o.action, ref: String(ref).trim() } : null;
    }
    case "list_notes":
    case "list_reminders":
      return { action: o.action };
  }
  return null;
}

function extractAction(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  let raw = fenced ? fenced[1] : null;
  let whole = fenced ? fenced[0] : null;
  if (!raw) {
    const bare = text.match(/\{[^{}]*"action"\s*:\s*"[a-z_]+"[^{}]*\}/i);
    if (bare) { raw = bare[0]; whole = bare[0]; }
  }
  if (!raw) return { action: null, text };
  const stripped = text.replace(whole, " ").replace(/\s{3,}/g, " ").trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch (e) { /* malformed → plain conversation */ }
  return { action: obj ? validateAction(obj) : null, text: stripped };
}

function fmtWhen(ms) {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function formatNotesReadback() {
  const notes = localActions.listNotes();
  if (!notes.length) return "You have no notes.";
  return `You have ${notes.length} note${notes.length > 1 ? "s" : ""}: ` +
    notes.map((n, i) => `${i + 1}) ${n.text}`).join("; ") + ".";
}
function formatRemindersReadback() {
  const rems = localActions.listReminders();
  if (!rems.length) return "You have no reminders.";
  return `You have ${rems.length} reminder${rems.length > 1 ? "s" : ""}: ` +
    rems.map((r, i) => `${i + 1}) ${r.text} — ${fmtWhen(r.dueMs)}${r.fired ? " (already fired)" : ""}`).join("; ") + ".";
}

// Success path for every model reply (real asks and test injections alike).
function handleAssistantReply(question, res, opts) {
  const parsed = extractAction(res.text);
  let assistantText = parsed.text || res.text;
  let emittedMemoryCard = false;   // a recall card takes precedence on the HUD
  // MEMORY HONESTY (enforced here, not merely asked for in the prompt): if the
  // user asked about their own things/people/past and NOTHING personal was
  // retrieved, the model has nothing to answer from — so we replace whatever it
  // invented. A prompt instruction can be hallucinated past; this cannot.
  if (res.askedPersonal && !parsed.action && (!res.personalFound || !res.personalFound.length)) {
    assistantText = "I don't have anything stored about that. Tell me and I'll remember it — " +
      "say “remember …” and I'll save it to your memories.";
  }
  // Recall: state WHEN (and where) it was saved, from the record itself rather
  // than trusting the model to repeat it.
  if (res.personalFound && res.personalFound.length && !parsed.action) {
    const m = res.personalFound[0];
    const when = knowledge.whenLabel(m.ts);
    if (!new RegExp(when.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(assistantText)) {
      assistantText += `\n\n(You saved that ${when}${m.placeTag ? `, at ${m.placeTag}` : ""}` +
        `${m.savedVia === "looked" ? ", by looking at it" : ""}.)`;
    }
    lastRecall = { subject: m.subject, text: m.text, when, placeTag: m.placeTag };
    emittedMemoryCard = true;   // this card wins over the generic answer card
    glasses.send({
      title: String(m.subject || "Memory").slice(0, 20),
      lines: glasses.wrap(m.text, 24, 3).concat([`saved ${when}`]).slice(0, 4),
      spoken: assistantText, holdMs: 9000,
    });
  }
  if (parsed.action) {
    if (parsed.action.action === "list_notes") assistantText = formatNotesReadback();
    else if (parsed.action.action === "list_reminders") assistantText = formatRemindersReadback();
    else if (!parsed.text) assistantText = confirmQuestion(parsed.action) || res.text;
  }
  // Name the knowledge-library entries that fed this answer — the user should
  // always be able to see where a fact came from rather than trusting a voice.
  const statLine = res.stats ? `local model · ${res.stats.tokensPerSec ?? "?"} tok/s · ${res.stats.seconds ?? "?"} s` : "";
  const srcLine = (res.sources && res.sources.length)
    ? "📚 " + res.sources.map((s) => `${s.pack}: ${s.title}`).join(" · ")
    : "";
  convo.push(
    { role: "user", content: question },
    { role: "assistant", content: assistantText,
      meta: [srcLine, statLine].filter(Boolean).join("\n") });
  if (convo.length > HISTORY_KEPT) convo = convo.slice(-HISTORY_KEPT);
  renderTranscript(false);
  if (cardState === "collapsed") unreadReply = true;
  if (parsed.action && parsed.action.action !== "list_notes" && parsed.action.action !== "list_reminders") {
    requestActionConfirm(parsed.action);
  }
  // Glasses: the companion answer, condensed. Skipped for mode-command results
  // (the mode emits its own richer card via pullActiveGlance) and for pending
  // actions (the confirm handler emits the save card).
  if (!parsed.action && !(opts && opts.fromMode) && !emittedMemoryCard) glanceFromAnswer(assistantText, "ask");
  const willSpeak = speakReply(assistantText, () => {
    setStatus("idle");
    maybeRelisten(); // hands-free loop: answer finished SPEAKING → listen
  });
  setStatus(willSpeak ? "speaking" : "idle");
}

function confirmQuestion(a) {
  switch (a.action) {
    case "add_note": return `Save note: “${a.note}”?`;
    case "remember": return `Remember this${a.subject ? ` about ${a.subject}` : ""} — it's stored on your own bridge and comes back in future answers:\n“${a.text}”`;
    case "forget": return a.target ? `Forget this memory?\n“${a.target.text}”\n(saved ${knowledge.whenLabel(a.target.ts)})` : "";
    case "add_reminder": return `Set a reminder for ${fmtWhen(a.dueMs)}: “${a.text}”?`;
    case "delete_note": return a.target ? `Delete note: “${a.target.text}”?` : "";
    case "delete_reminder": return a.target ? `Delete reminder: “${a.target.text}” (${fmtWhen(a.target.dueMs)})?` : "";
  }
  return "";
}

async function requestActionConfirm(a) {
  // A forget must resolve to ONE concrete stored memory before the gate, so the
  // user confirms exactly what disappears — never a fuzzy "something like that".
  if (a.action === "forget") {
    const all = await knowledge.personal();
    if (!all.length) { transcriptNote("You have no saved memories to forget."); return; }
    const needle = a.ref.toLowerCase();
    const hits = all.filter((m) =>
      (m.subject || "").toLowerCase().includes(needle) || (m.text || "").toLowerCase().includes(needle));
    if (!hits.length) { transcriptNote(`No memory matching “${a.ref}”. Open Memories to see what's stored.`); return; }
    if (hits.length > 1) {
      transcriptNote(`${hits.length} memories match “${a.ref}” — open Memories and delete the right one.`);
      renderMemoriesSheet();
      return;
    }
    a.target = hits[0];
  }
  // Deletes resolve to a concrete record BEFORE the gate — a miss never gates.
  if (a.action === "delete_note") {
    a.target = localActions.findNote(a.ref);
    if (!a.target) { transcriptNote(`No note matching “${a.ref}”.`); return; }
  }
  if (a.action === "delete_reminder") {
    a.target = localActions.findReminder(a.ref);
    if (!a.target) { transcriptNote(`No reminder matching “${a.ref}”.`); return; }
  }
  pendingAction = a;
  document.getElementById("ccConfirmText").textContent = confirmQuestion(a);
  document.getElementById("ccConfirm").style.display = "block";
}

function hideActionConfirm() {
  pendingAction = null;
  document.getElementById("ccConfirm").style.display = "none";
}

document.getElementById("ccConfirmYes").addEventListener("click", async () => {
  const a = pendingAction;
  hideActionConfirm();
  if (!a) return;
  let line;
  try {
    if (a.action === "add_note") { localActions.addNote(a.note); line = `✓ Saved note: “${a.note}”.`; }
    else if (a.action === "add_reminder") { localActions.addReminder(a.text, a.when); line = `✓ Reminder set for ${fmtWhen(a.dueMs)}: “${a.text}”. It fires while the app is open.`; }
    else if (a.action === "delete_note") { localActions.deleteNote(a.target.id); line = `✓ Deleted note: “${a.target.text}”.`; }
    else if (a.action === "delete_reminder") { localActions.deleteReminder(a.target.id); line = `✓ Deleted reminder: “${a.target.text}”.`; }
    else if (a.action === "remember") {
      // Goes to the knowledge library on the bridge (embedded for recall),
      // not to the local notes list — this is memory, not a to-do. Tagged
      // scope:'personal' so it can be listed, preferred on recall, and deleted
      // separately from the seeded reference packs.
      transcriptNote("Saving to your memories…");
      const meta = {
        scope: "personal", kind: a.kind || "fact",
        subject: a.subject || a.topic || a.text.slice(0, 40),
        ts: Date.now(), source: a.source === "looked" ? "looked" : "said",
      };
      const place = coarsePlaceTag();     // only if location is ALREADY available
      if (place) meta.placeTag = place;
      await knowledge.add(a.text, { title: meta.subject, pack: "my-memories", meta });
      line = `✓ Saved${meta.placeTag ? ` (at ${meta.placeTag})` : ""}. I'll recall it when you ask.`;
      glasses.send({ title: "Saved ✓", lines: glasses.wrap(meta.subject), spoken: line, holdMs: 5000 });
      renderMemoriesSheet();
    }
    else if (a.action === "forget") {
      await knowledge.remove(a.target.id);
      line = `✓ Forgotten: “${a.target.subject || a.target.text}”. It won't come back in answers.`;
      renderMemoriesSheet();
    }
  } catch (err) {
    line = "Couldn't do that: " + (err && err.message || err);
  }
  transcriptNote(line);
  renderNotesSheet();
  // Glasses: a short save/confirmation card (the ✓ line without the quotes noise).
  if (a) glasses.send({ title: "Saved ✓", lines: [line.replace(/^✓\s*/, "").replace(/[""]/g, "").slice(0, 90)], spoken: line, holdMs: 5000 });
  const willSpeak = speakReply(line, () => { setStatus("idle"); maybeRelisten(); });
  if (willSpeak) setStatus("speaking");
});
document.getElementById("ccConfirmNo").addEventListener("click", () => {
  hideActionConfirm();
  transcriptNote("Cancelled — nothing was changed.");
});

// ---- reminders fire while the app is OPEN (honesty: background needs native/glasses) ----
function checkReminders() {
  for (const r of localActions.dueReminders()) {
    localActions.markFired(r.id);
    const line = `⏰ Reminder: ${r.text}`;
    // Glasses: a due reminder is the canonical ALERT card — it preempts the
    // rate cap / min-hold so it can't be starved by chatty normal cards.
    glasses.send({ title: "⏰ Reminder", lines: [r.text], spoken: line, priority: "alert", holdMs: 10000 });
    showToast(line);
    if (cardState !== "closed") transcriptNote(line);
    if (cardState === "collapsed") { unreadReply = true; refreshFabStatus(); }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification("Reality Engine", { body: r.text }); } catch (e) {}
    }
    if (speakToggle.checked) {
      const willSpeak = speakReply(line, () => setStatus("idle"));
      if (willSpeak) setStatus("speaking");
    }
    renderNotesSheet();
  }
}
setInterval(checkReminders, 10_000);

// ---- manual Notes & Reminders panel ----
function renderNotesSheet() {
  const notesList = document.getElementById("notesList");
  const remindersList = document.getElementById("remindersList");
  if (!notesList) return;
  const notes = localActions.listNotes();
  const rems = localActions.listReminders();

  notesList.innerHTML = "";
  if (!notes.length) notesList.innerHTML = '<div class="nrEmpty">No notes yet — try “make a note to…” in the ✦ companion.</div>';
  notes.forEach((n) => notesList.appendChild(nrRow(
    n.text, new Date(n.at).toLocaleDateString(), "",
    () => { if (confirm(`Delete note: “${n.text}”?`)) { localActions.deleteNote(n.id); renderNotesSheet(); } })));

  remindersList.innerHTML = "";
  if (!rems.length) remindersList.innerHTML = '<div class="nrEmpty">No reminders yet — try “remind me at … to …”.</div>';
  rems.forEach((r) => notesRowReminder(remindersList, r));

  const permBtn = document.getElementById("notifPermBtn");
  permBtn.style.display =
    (typeof Notification !== "undefined" && Notification.permission === "default") ? "" : "none";
}
function nrRow(text, meta, metaClass, onDelete) {
  const row = document.createElement("div");
  row.className = "nrRow";
  const main = document.createElement("div");
  main.className = "nrMain";
  main.textContent = text;
  const m = document.createElement("div");
  m.className = "nrMeta" + (metaClass ? " " + metaClass : "");
  m.textContent = meta;
  main.appendChild(m);
  const del = document.createElement("button");
  del.className = "nrDel";
  del.textContent = "Delete";
  del.addEventListener("click", onDelete);
  row.appendChild(main);
  row.appendChild(del);
  return row;
}
function notesRowReminder(container, r) {
  const overdue = !r.fired && r.dueMs <= Date.now();
  container.appendChild(nrRow(
    r.text,
    fmtWhen(r.dueMs) + (r.fired ? " · fired" : overdue ? " · due" : ""),
    r.fired ? "fired" : overdue ? "due" : "",
    () => { if (confirm(`Delete reminder: “${r.text}”?`)) { localActions.deleteReminder(r.id); renderNotesSheet(); } }));
}
document.getElementById("notesBtn").addEventListener("click", () => {
  renderNotesSheet();
  openSheet("notesSheet");
});

// ---- Memories panel: the user's OWN entries only, newest first --------------
const KIND_ICON = { thing: "📦", person: "👤", place: "📍", fact: "💡", session: "🎙" };
let memoriesCache = [];
async function renderMemoriesSheet() {
  const list = document.getElementById("memoriesList");
  if (!list) return;
  if (!companion.isConfigured()) {
    list.innerHTML = '<div class="nrEmpty">Connect your bridge in Settings — memories are stored and embedded there.</div>';
    return;
  }
  list.innerHTML = '<div class="nrEmpty">Loading…</div>';
  memoriesCache = await knowledge.personal();
  list.innerHTML = "";
  if (!memoriesCache.length) {
    list.innerHTML = '<div class="nrEmpty">Nothing saved yet — say “remember I put my passport in the desk drawer”, or use 👁 Look and remember.</div>';
    return;
  }
  for (const m of memoriesCache) {
    const meta = `${KIND_ICON[m.kind] || "💡"} ${m.subject} · saved ${knowledge.whenLabel(m.ts)}` +
      `${m.placeTag ? ` · ${m.placeTag}` : ""}${m.savedVia === "looked" ? " · by looking" : ""}`;
    const row = nrRow(m.text, meta, "", async () => {
      // Deleting from the panel confirms too — a memory never vanishes silently.
      if (!confirm(`Forget this memory?\n\n“${m.text}”\n\nSaved ${knowledge.whenLabel(m.ts)}.`)) return;
      try { await knowledge.remove(m.id); transcriptNote(`✓ Forgotten: “${m.subject}”.`); }
      catch (err) { transcriptNote("Couldn't delete that — is the bridge reachable?"); }
      renderMemoriesSheet();
    });
    // Edit re-embeds on the bridge so retrieval matches the NEW wording.
    const edit = document.createElement("button");
    edit.className = "nrDel";
    edit.textContent = "Edit";
    edit.style.marginRight = "6px";
    edit.addEventListener("click", async () => {
      const next = prompt("Edit this memory:", m.text);
      if (next === null || !next.trim() || next.trim() === m.text) return;
      try { await knowledge.update(m.id, { text: next.trim() }); transcriptNote("✓ Memory updated."); }
      catch (err) { transcriptNote("Couldn't update that — is the bridge reachable?"); }
      renderMemoriesSheet();
    });
    row.insertBefore(edit, row.lastChild);
    list.appendChild(row);
  }
}
document.getElementById("memoriesBtn").addEventListener("click", () => {
  renderMemoriesSheet();
  openSheet("memoriesSheet");
});

// ---- Look and remember: ONE deliberate snapshot, proposed then confirmed ----
// Reuses the existing /vision path. Never continuous, never ambient: one frame
// per tap, and nothing is stored until the user confirms the editable proposal.
let lookRemembering = false;
async function lookAndRemember(imageBase64) {
  if (lookRemembering) return;
  lookRemembering = true;
  setStatus("looking");
  transcriptNote("👁 looking, to remember this… (one snapshot — nothing is saved until you confirm)");
  try {
    const res = await companion.vision(imageBase64,
      "Describe the main object and exactly where it is, in one short phrase suitable for remembering " +
      "later (e.g. \"black backpack on the shelf by the door\"). Describe objects and places only. " +
      "Do NOT describe or identify any person. Answer with the phrase only.");
    if (!res.ok) { transcriptNote(res.text); setStatus("idle"); return; }
    const caption = String(res.text || "").replace(/\s+/g, " ").trim();
    if (!caption) { transcriptNote("Couldn't make out anything to remember — try again."); setStatus("idle"); return; }
    // Editable proposal → the SAME confirmation gate as every other write.
    const edited = prompt("Save this memory? You can edit it first:", caption);
    if (edited === null || !edited.trim()) { transcriptNote("Nothing saved."); setStatus("idle"); return; }
    const text = edited.trim();
    requestActionConfirm({
      action: "remember", text,
      subject: text.split(/[,.]/)[0].slice(0, 60), kind: "thing", source: "looked",
    });
  } finally {
    lookRemembering = false;
    setStatus("idle");
    refreshFabStatus();
  }
}
document.getElementById("notifPermBtn").addEventListener("click", () => {
  // requested only on this explicit gesture, per platform rules
  Notification.requestPermission().then(() => renderNotesSheet());
});

// ---- "look": ONE camera frame → the local vision model on the bridge ----
// On-demand only, user-initiated, never a stream. The downscaled frame is sent
// ONLY to the configured bridge (companion.vision → <endpoint>/vision).
const lookBtn = document.getElementById("companionLookBtn");
const lookInput = document.getElementById("companionLookInput");
let looking = false;

function findLiveVideo() {
  // A native mode's own <video>, or — same-origin embeds like astronomy — one
  // inside its iframe. Cross-origin iframes throw → photo picker instead.
  const direct = document.querySelector("#modeRoot video");
  if (direct && direct.readyState >= 2 && direct.videoWidth > 0) return direct;
  const iframe = document.querySelector("#modeRoot iframe");
  if (iframe) {
    try {
      const v = iframe.contentDocument && iframe.contentDocument.querySelector("video");
      if (v && v.readyState >= 2 && v.videoWidth > 0) return v;
    } catch (e) { /* cross-origin */ }
  }
  return null;
}

function frameToJpegBase64(source, w, h) {
  const MAX = 768; // longest side — plenty for a small vision model, kind to CPU
  const scale = Math.min(1, MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

async function visionAsk(imageBase64, question) {
  if (looking || asking) return;
  looking = true;
  stopDictation(true);
  stopSpeaking();
  primeTTS();
  const context = activeContext();
  const prompt = (context ? `Context: ${context}\n` : "") + (question || "What is this? Answer briefly.");
  setStatus("looking");
  renderTranscript(false);
  transcriptNote("👁 looking… (local vision model — the image goes only to your bridge; this can take a while)");
  document.getElementById("companionQuestion").value = "";
  try {
    const res = await companion.vision(imageBase64, prompt);
    if (res.ok) {
      convo.push(
        { role: "user", content: "[Looking through the camera] " + (question || "What is this?") },
        { role: "assistant", content: res.text,
          meta: res.stats ? `local vision · ${res.stats.seconds ?? "?"} s` : "" });
      if (convo.length > HISTORY_KEPT) convo = convo.slice(-HISTORY_KEPT);
      renderTranscript(false);
      if (cardState === "collapsed") unreadReply = true;
      glanceFromAnswer(res.text, "look");   // glasses: the vision answer, condensed
      const willSpeak = speakReply(res.text, () => {
        setStatus("idle");
        maybeRelisten(); // vision answers join the hands-free loop too
      });
      setStatus(willSpeak ? "speaking" : "idle");
    } else {
      renderTranscript(false);
      transcriptNote(res.text);
      setStatus("idle");
    }
  } finally {
    looking = false;
    refreshFabStatus();
  }
}

lookBtn.addEventListener("click", () => {
  primeTTS();
  if (looking || asking) return;
  const question = document.getElementById("companionQuestion").value.trim();
  const video = findLiveVideo();
  if (video) {
    visionAsk(frameToJpegBase64(video, video.videoWidth, video.videoHeight), question);
  } else {
    lookInput.dataset.q = question;
    lookInput.value = ""; // allow re-taking the same photo
    lookInput.click();    // iOS opens the camera and returns ONE photo
  }
});

lookInput.addEventListener("change", () => {
  const file = lookInput.files && lookInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const b64 = frameToJpegBase64(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(url);
    visionAsk(b64, lookInput.dataset.q || "");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    transcriptNote("Couldn't read that photo — try again.");
  };
  img.src = url;
});

// Look & remember: one deliberate snapshot through the SAME vision path.
const rememberInput = document.getElementById("companionRememberInput");
document.getElementById("lookRememberBtn").addEventListener("click", () => {
  primeTTS();
  if (looking || asking || lookRemembering) return;
  const video = findLiveVideo();
  if (video) { lookAndRemember(frameToJpegBase64(video, video.videoWidth, video.videoHeight)); return; }
  rememberInput.value = "";
  rememberInput.click();
});
rememberInput.addEventListener("change", () => {
  const file = rememberInput.files && rememberInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { const b64 = frameToJpegBase64(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); lookAndRemember(b64); };
  img.onerror = () => { URL.revokeObjectURL(url); transcriptNote("Couldn't read that photo — try again."); };
  img.src = url;
});
document.getElementById("openMemoriesBtn").addEventListener("click", () => {
  renderMemoriesSheet();
  openSheet("memoriesSheet");
});

// ---- wake word wiring (persisted; OFF by default) ----
wakePhrase = String(storage.get("wake.phrase", WAKE_DEFAULT_PHRASE) || WAKE_DEFAULT_PHRASE).toLowerCase();
// NOTE: deliberately NOT auto-started from storage. Enabling a live microphone
// is a decision the user makes each session, with a gesture — not something a
// page load does to them.
document.getElementById("wakeToggle").addEventListener("change", (e) => {
  primeTTS();
  if (e.target.checked) startWake(); else stopWake("Wake word off.");
});
document.getElementById("wakePhraseInput").addEventListener("change", (e) => {
  const p = String(e.target.value || "").trim().toLowerCase();
  wakePhrase = p || WAKE_DEFAULT_PHRASE;
  storage.set("wake.phrase", wakePhrase);
  e.target.value = wakePhrase;
  if (wakePhrase.split(/\s+/).length < 2 || wakePhrase.length < 6) {
    transcriptNote(`“${wakePhrase}” is short — common or single words false-trigger a lot. Two distinctive words work best.`);
  }
  if (wakeEnabled) { stopDictation(true); }   // pick up the new phrase next cycle
});
document.getElementById("wakeStopBtn").addEventListener("click", () => stopWake("Wake word off."));
syncWakeUI();

// ---------------------------------------------------------------- config deep-link
let toastTimer = 0;
function showToast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

// #c=<base64url(JSON {"e":endpoint,"t":token})> — generated on the bridge machine
// (show-qr.ps1) and delivered by QR scan, so the phone never types a token. Saved
// through the same path Settings uses (setConfig scrubs whitespace/invisibles); the
// hash is stripped immediately so the secret never lingers in the URL bar or history.
(function importConfigFromHash() {
  const m = (location.hash || "").match(/[#&]c=([A-Za-z0-9_-]+=*)/);
  if (!m) return;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const cfg = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    if (!cfg || typeof cfg.e !== "string" || typeof cfg.t !== "string") throw new Error("bad payload");
    companion.setConfig(cfg.e, cfg.t);
    showToast(companion.isConfigured()
      ? "✓ Companion configured — ask away"
      : "Companion config link was incomplete");
  } catch (err) {
    console.error("companion config import failed:", err);
    showToast("Couldn't read the companion config link");
  } finally {
    history.replaceState(null, "", location.pathname + location.search);
  }
})();
