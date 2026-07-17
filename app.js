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

// ---------------------------------------------------------------- mode registry
// Native modes: `load` dynamically imports the module (nothing loads until opened).
// External entries: `url` opens the live legacy app in a new tab (gradual migration —
// embedding via iframe would break iOS sensor/camera permission prompts, so we link).
const REGISTRY = [
  {
    id: "pendulum", title: "Pendulum · period & g", family: "Physics", icon: "🪀",
    permissions: ["motion"],
    blurb: "Swing the phone on a string — measures period T from the gyroscope and computes g. The first fully native mode.",
    load: () => import("./modes/pendulum.js"),
  },
  {
    id: "astronomy", title: "Astronomy", family: "Learn", icon: "🔭",
    permissions: ["camera", "motion", "orientation", "geolocation"],
    blurb: "Point at the sky — planets, stars, time travel, events. Native mode: the ✦ companion knows what you're looking at.",
    load: () => import("./modes/astronomy.js"),
  },
  {
    id: "physics", title: "Physics experiments", family: "Physics", icon: "⚗️",
    permissions: ["camera", "motion"],
    blurb: "The full experiments hub — object speed via ML tracking, and more. Opens the live app.",
    url: "https://alexgraz360.github.io/physics-glasses/phase1/", external: true,
  },
  { id: "companion", title: "AI Companion", family: "Assistant", icon: "✦",
    permissions: ["mic", "camera"],
    blurb: "Talk to the engine — it sees what you see, knows the active mode, and answers by voice.", soon: true },
  { id: "coach", title: "Basketball Coach", family: "Coaching", icon: "🏀",
    permissions: ["camera"],
    blurb: "Pose tracking on your shot — release angle, arc, and spoken form cues.", soon: true },
  { id: "emotion", title: "Emotion", family: "Perception", icon: "🎭",
    permissions: ["camera"],
    blurb: "Honest expression & engagement cues (research + ethics pass pending — no lie detection).", soon: true },
  { id: "translate", title: "Translation", family: "Perception", icon: "🌐",
    permissions: ["mic", "camera"],
    blurb: "Live speech and sign translation in the HUD.", soon: true },
  { id: "navigate", title: "Navigation", family: "Perception", icon: "🧭",
    permissions: ["geolocation", "camera", "orientation"],
    blurb: "AR pins and glanceable walking directions.", soon: true },
];

// ---------------------------------------------------------------- shell state
const home = document.getElementById("home");
const modeView = document.getElementById("modeView");
const modeRoot = document.getElementById("modeRoot");
const modeTitle = document.getElementById("modeTitle");
const modeTag = document.getElementById("modeTag");

let active = null; // { mod, entry }

const services = { sensors, overlay, storage, companion };

// ---------------------------------------------------------------- home cards
const cardsEl = document.getElementById("cards");
for (const entry of REGISTRY) {
  const card = document.createElement("button");
  card.className = "card" + (entry.soon ? " soon" : "") + (entry.external ? " ext" : "");
  const foot = entry.soon ? "COMING SOON"
    : entry.external ? "EXTERNAL · MIGRATING ↗"
    : "Open →";
  card.innerHTML = `
    <span class="tag ${entry.family.toLowerCase()}">${entry.family.toUpperCase()}</span>
    <span class="icon">${entry.icon}</span>
    <span class="name">${entry.title}</span>
    <span class="blurb">${entry.blurb}</span>
    <span class="footNote">${foot}</span>`;
  if (!entry.soon) card.addEventListener("click", () => openMode(entry));
  cardsEl.appendChild(card);
}

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
  if (!ttsSupported || !speakToggle.checked || !text) return false;
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

function stopSpeaking() {
  pendingSpeak = null;
  speakSession++; // aborts any queued/delayed speakNow
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

function startListening() {
  if (!SR || listening) return; // the guard: auto-start + manual tap can never double-start
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
  if (!SR || micDenied || listening || asking) return;
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
};

// ---- ask flow (typed or dictated), multi-turn ----
let asking = false;
async function askCompanion() {
  if (asking) return;
  const input = document.getElementById("companionQuestion");
  const question = input.value.trim();
  if (!question) return;
  stopDictation(true); // question text is already captured — discard the dictation
  stopSpeaking();      // a new question interrupts the previous answer
  primeTTS();          // in case this Ask is the session's first companion gesture
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
    const res = await companion.ask(question, context, history);
    if (res.ok) {
      convo.push(
        { role: "user", content: question },
        { role: "assistant", content: res.text,
          meta: res.stats ? `local model · ${res.stats.tokensPerSec ?? "?"} tok/s · ${res.stats.seconds ?? "?"} s` : "" });
      if (convo.length > HISTORY_KEPT) convo = convo.slice(-HISTORY_KEPT);
      renderTranscript(false);
      if (cardState === "collapsed") unreadReply = true;
      const willSpeak = speakReply(res.text, () => {
        setStatus("idle");
        maybeRelisten(); // hands-free loop: answer finished SPEAKING → listen
      });
      setStatus(willSpeak ? "speaking" : "idle");
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
