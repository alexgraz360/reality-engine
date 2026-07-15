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
    id: "astronomy", title: "Astronomy", family: "Astronomy", icon: "🔭",
    permissions: ["camera", "motion", "orientation", "geolocation"],
    blurb: "Point at the sky — planets, stars, time travel, free flight. Opens the live app.",
    url: "https://alexgraz360.github.io/astronomy-glasses/phase1/", external: true,
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
  sensors.releaseAll(); // safety net: no stream/listener survives a mode
  window.__mode = undefined;
  modeRoot.innerHTML = "";
  modeView.classList.remove("open");
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
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.classList.remove("open"); });
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

// Companion (the ✦ button in the mode bar): text-first Q&A grounded in the active
// mode's getContext(). Voice input (Web Speech) is a planned fast-follow.
function activeContext() {
  try { return active ? (active.mod.getContext() || "") : ""; } catch (e) { console.error(e); return ""; }
}

document.getElementById("companionBtn").addEventListener("click", () => {
  document.getElementById("companionContext").textContent =
    activeContext() || "(this mode reports nothing right now)";
  document.getElementById("companionReply").textContent = companion.isConfigured()
    ? "Ask away — answers come from your own machine."
    : "Not configured yet — add your bridge's endpoint + token in Settings (on the home screen).";
  document.getElementById("companionReplyMeta").textContent = "";
  openSheet("companionSheet");
});

let asking = false;
async function askCompanion() {
  if (asking) return;
  const input = document.getElementById("companionQuestion");
  const question = input.value.trim();
  if (!question) return;
  const reply = document.getElementById("companionReply");
  const meta = document.getElementById("companionReplyMeta");
  const context = activeContext(); // re-read at ask time — freshest reading
  document.getElementById("companionContext").textContent = context || "(this mode reports nothing right now)";
  asking = true;
  document.getElementById("companionAskBtn").disabled = true;
  reply.textContent = "Thinking… (your local model is generating; the first answer can take ~10 s)";
  meta.textContent = "";
  try {
    const res = await companion.ask(question, context);
    reply.textContent = res.text;
    meta.textContent = res.ok && res.stats
      ? `local model · ${res.stats.tokensPerSec ?? "?"} tok/s · ${res.stats.seconds ?? "?"} s`
      : "";
    if (res.ok) input.value = "";
  } finally {
    asking = false;
    document.getElementById("companionAskBtn").disabled = false;
  }
}
document.getElementById("companionAskBtn").addEventListener("click", askCompanion);
document.getElementById("companionQuestion").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); askCompanion(); }
});
