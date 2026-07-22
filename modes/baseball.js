// Reality Engine · Baseball — read the pitch.
//
// The football pattern applied to the diamond: a deterministic instant read with
// NO model on the hot path, a persistent live feed of the current count's
// outcome odds, a strike-zone card showing where the pitcher works, an anchored
// ＋Detail that explains (never re-decides) the call, and a Watch loop that OCRs
// the broadcast graphic and re-reads on every new count or batter.
//
// HONESTY: every number is a historical frequency from public Statcast data.
// It never claims to know the next pitch — only what usually happens here.

import baseballData from "../services/baseballData.js";

let root, svc, store, els = {};
let sit = null;
let dataReady = false;
let lastInstant = null;        // { line, numbers, ... }
let watching = false, watchStream = null, watchTimer = 0, wakeLock = null;
let watchBusy = false, watchPulse = false, watchSaw = "", watchNote = "", watchRead = "";
let lastPitchKey = "";         // batter|balls-strikes — debounce for the Watch loop
let manualOpen = false;
let playersAutoSet = "";
let skipNextTick = false, lastTapAt = 0;
const TAP_MIN_GAP_MS = 1500;
const WATCH_MS = 6000;         // 10 ticks/min, inside the /scoreboard budget

function freshSituation() {
  return {
    pitcherId: "", batterId: "",
    balls: 0, strikes: 0,
    outs: 0, bases: "empty",          // empty | 1 | 2 | 3 | 12 | 13 | 23 | loaded
    inning: 1, half: "top",
    scoreFor: 0, scoreAgainst: 0,     // batting team's perspective
  };
}
const BASE_LABELS = {
  empty: "bases empty", 1: "runner on first", 2: "runner on second", 3: "runner on third",
  12: "first and second", 13: "first and third", 23: "second and third", loaded: "bases loaded",
};

function persist() { store.set("situation", sit); }
function countObj() { return { balls: sit.balls, strikes: sit.strikes }; }
function prediction() {
  if (!dataReady) return null;
  return baseballData.getPrediction(sit.pitcherId, sit.batterId, countObj(), {
    outs: sit.outs, bases: sit.bases, inning: sit.inning, half: sit.half,
  });
}
function names() {
  const p = sit.pitcherId && baseballData.getPitcher(sit.pitcherId);
  const b = sit.batterId && baseballData.getBatter(sit.batterId);
  return { pitcher: p ? p.name : null, batter: b ? b.name : null };
}

// ---------------------------------------------------------------- context
function buildContext() {
  const n = names();
  const bits = [
    n.pitcher && n.batter ? `${n.pitcher} pitching to ${n.batter}` : (n.batter ? `${n.batter} batting` : null),
    `${sit.balls}-${sit.strikes} count`,
    `${sit.outs} out${sit.outs === 1 ? "" : "s"}`,
    BASE_LABELS[sit.bases],
    `${sit.half} ${ordinal(sit.inning)}`,
    sit.scoreFor === sit.scoreAgainst ? "tied"
      : `batting team ${sit.scoreFor > sit.scoreAgainst ? "up" : "down"} ${Math.abs(sit.scoreFor - sit.scoreAgainst)}`,
  ].filter(Boolean);
  return `Baseball mode. ${bits.join(", ")}.`;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------------------------------------------------------- instant read
// Deterministic. No /chat. This is what gets spoken on every new pitch.
function instantRead() {
  const pred = prediction();
  const r = pred ? baseballData.instantRead(pred, names()) : null;
  if (r && r.line) { lastInstant = r; return r.line; }
  const line = dataReady
    ? "Pick the pitcher and batter to get the matchup numbers."
    : "Baseball data didn't load — the situation panel still works.";
  lastInstant = { line, numbers: [] };
  return line;
}

// ---------------------------------------------------------------- ＋Detail
// Same one-voice contract as football: the model explains the deterministic
// call, is fed its exact numbers, runs near-greedy, and any sentence that
// contradicts the data's pitch call is dropped.
async function moreDetail() {
  const line = instantRead();
  const pred = prediction();
  const brief = pred ? baseballData.formatBriefForPrompt(pred, names()) : "";
  const pitchName = pred && pred.pitch ? pred.pitch.name : null;
  const prompt =
    "You are a baseball analyst. The call below is FIXED — it comes from real pitch-level data " +
    "and it is the conclusion. In AT MOST 45 words, EXPLAIN it and add nuance: why this pitch in " +
    "this count, what the batter tends to do with it, and one thing to watch. Do NOT make a " +
    "different call." +
    (pitchName ? ` The data says the likely pitch is the ${pitchName} — agree with that and do not ` +
      `name a different pitch as the likely one.` : "") +
    " Plain speakable text, no lists. These are historical tendencies — never say you know what is " +
    "coming next.\n\nTHE CALL: " + line +
    (lastInstant && lastInstant.numbers.length ? "\nBUILT FROM: " + lastInstant.numbers.join(" · ") : "") +
    (brief ? "\n" + brief : "");
  try {
    const res = await svc.companion.ask(prompt, buildContext(), [], {
      systemExtra: "You are elaborating a fixed, data-derived conclusion — not forming your own. " +
        "Same call, deeper why.",
      maxTokens: 120, temperature: 0.05, stable: true,
    });
    if (!res.ok || !res.text) return { line, detail: "", note: res.text || "Couldn't get more detail right now." };
    return { line, detail: enforcePitchCall(res.text, pitchName) };
  } catch (e) {
    return { line, detail: "", note: "Couldn't get more detail right now." };
  }
}

// Guardrail: drop any sentence that names a DIFFERENT pitch as the likely one.
const PITCH_WORDS = ["fastball", "four-seam", "sinker", "cutter", "slider", "sweeper",
  "curveball", "curve", "knuckle curve", "changeup", "splitter", "slurve"];
function enforcePitchCall(text, pitchName) {
  if (!pitchName) return text.trim();
  const called = pitchName.toLowerCase();
  const kept = (text.match(/[^.!?]+[.!?]?/g) || [text]).filter((s) => {
    const low = s.toLowerCase();
    // only police sentences that actually make a prediction
    if (!/\b(likely|expect|should|will|look for|probably|going to|leans?)\b/.test(low)) return true;
    const namesOther = PITCH_WORDS.some((w) => low.includes(w) && !called.includes(w) && !w.includes(called));
    const namesCalled = low.includes(called) || called.split(/[\s-]/).some((w) => w.length > 3 && low.includes(w));
    const bad = namesOther && !namesCalled;
    if (bad) console.warn(`baseball: dropped detail sentence contradicting the ${pitchName} call:`, s.trim());
    return !bad;
  });
  return kept.join("").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- live capture
// Same readiness gate as football: a <video> reports dimensions as soon as
// METADATA lands, before any frame decodes, so require a decoded frame and a
// non-trivial encode before anything is sent.
const MIN_FRAME_B64 = 4000;
function captureLiveFrame(video) {
  if (!video) return { ok: false, reason: "no_video" };
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return { ok: false, reason: "not_ready", detail: `readyState=${video.readyState} ${video.videoWidth}x${video.videoHeight}` };
  }
  let b64;
  try { b64 = frameToJpegBase64(video, video.videoWidth, video.videoHeight); }
  catch (err) { return { ok: false, reason: "draw_failed", detail: String(err && err.message || err) }; }
  if (!b64 || b64.length < MIN_FRAME_B64) return { ok: false, reason: "empty_frame", detail: `${b64 ? b64.length : 0} chars` };
  return { ok: true, b64 };
}
function frameToJpegBase64(source, w, h) {
  const MAX = 1024;                       // small graphic text needs the pixels
  const scale = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

// ---------------------------------------------------------------- Watch loop
async function toggleWatch() {
  if (watching) { stopWatch("Watch off."); return; }
  try {
    watchStream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (err) {
    setWatchNote("Camera unavailable — Watch needs the camera. Manual entry still works.");
    return;
  }
  watching = true; lastPitchKey = "";
  els.watchVideo.srcObject = watchStream;
  els.watchVideo.style.display = "block";
  try { await els.watchVideo.play(); } catch (e) {}
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
  setWatchNote("Watching — point at the score graphic. I'll call each new count.");
  watchTimer = setInterval(watchTick, WATCH_MS);
  watchTick();
  renderWatchUI();
}

function stopWatch(note) {
  watching = false;
  clearInterval(watchTimer); watchTimer = 0;
  if (watchStream) { svc.sensors.releaseStream(watchStream); watchStream = null; }
  if (els.watchVideo) { els.watchVideo.srcObject = null; els.watchVideo.style.display = "none"; }
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  watchPulse = false; watchSaw = ""; watchRead = "";
  setWatchNote(note || ""); renderWatchUI();
}

async function watchTick() {
  if (!watching || watchBusy) return;
  if (skipNextTick) { skipNextTick = false; setWatchNote("Easing off after a rate limit — resuming."); return; }
  watchBusy = true; watchPulse = true; renderWatchUI();
  try {
    const shot = captureLiveFrame(els.watchVideo);
    if (!shot.ok) {
      console.warn("baseball: live capture not usable —", shot.reason, shot.detail || "");
      setWatchNote(shot.reason === "not_ready"
        ? "Camera warming up — trying again in a moment."
        : "Couldn't grab a clear camera frame — hold steady and re-aim.");
      return;
    }
    const res = await svc.companion.scoreboard(shot.b64, { fast: true, sport: "baseball" });
    if (!watching) return;
    if (!res.ok) {
      console.warn("baseball: scoreboard failed —", res.reason, res.error || res.text);
      setWatchNote({
        rate_limited: "Scanning too fast — easing off for a moment.",
        offline: "Bridge unreachable — is the host machine awake? Manual entry still works.",
        timeout: "That scan took too long — trying again shortly.",
        bad_image: "Couldn't grab a clear camera frame — hold steady and re-aim.",
        unauthorized: "The bridge rejected the token — check Settings → Companion.",
        unavailable: "The scoreboard reader isn't running on the bridge right now.",
      }[res.reason] || res.text || "Scan failed — trying again shortly.");
      if (res.reason === "rate_limited") skipNextTick = true;
      return;
    }
    watchSaw = summariseOcr(res.rawText);
    const p = { ...(res.parsed || {}) };
    // App-side safety net: pull a count from anywhere in the raw text.
    if (!Number.isInteger(p.balls) || !Number.isInteger(p.strikes)) {
      const c = countAnywhere(res.rawText);
      if (c) { p.balls = c.balls; p.strikes = c.strikes; }
    }
    if (!Number.isInteger(p.balls) || !Number.isInteger(p.strikes)) {
      setWatchNote("Watching — no clear count on screen yet. Fill more of the frame with the graphic.");
      return;
    }
    const filled = applyGraphic(p, res.rawText);
    const key = `${sit.batterId}|${p.balls}-${p.strikes}`;
    const label = `${p.balls}-${p.strikes}`;
    if (key === lastPitchKey) { watchRead = label; setWatchNote(`Watching — still ${label}.`); return; }
    lastPitchKey = key;
    watchRead = label;
    renderPanel();
    const line = instantRead();     // deterministic — no model per pitch
    showReadCard(line);
    renderFeed();
    svc.speak(line);
    setWatchNote(`New count — ${label}${filled.includes("batter") ? ", new batter" : ""}. Spoken.`);
  } finally {
    watchBusy = false; watchPulse = false; renderWatchUI();
  }
}

function summariseOcr(raw) {
  if (!raw) return "(nothing legible)";
  return raw.split("|").map((t) => t.trim()).filter(Boolean).slice(0, 8).join(" · ").slice(0, 120);
}
// "1-2", "1 - 2", or "B:1 S:2" anywhere in the OCR text.
function countAnywhere(raw) {
  if (!raw) return null;
  const t = " " + String(raw).replace(/\|/g, " ").replace(/\s+/g, " ") + " ";
  let m = t.match(/\bB\s*:?\s*([0-3])\D{0,4}S\s*:?\s*([0-2])\b/i);
  if (!m) m = t.match(/\b([0-3])\s*-\s*([0-2])\b/);
  return m ? { balls: parseInt(m[1], 10), strikes: parseInt(m[2], 10) } : null;
}

// Apply the OCR'd graphic to the situation; auto-select players by name.
function applyGraphic(p, rawText) {
  const filled = [];
  if (Number.isInteger(p.balls)) { sit.balls = Math.min(3, p.balls); filled.push("balls"); }
  if (Number.isInteger(p.strikes)) { sit.strikes = Math.min(2, p.strikes); filled.push("strikes"); }
  if (Number.isInteger(p.outs)) { sit.outs = Math.min(2, p.outs); filled.push("outs"); }
  if (Number.isInteger(p.inning)) { sit.inning = p.inning; filled.push("inning"); }
  if (p.half === "top" || p.half === "bottom") { sit.half = p.half; filled.push("half"); }
  const bat = matchPlayer(p.batter || rawText, baseballData.batters());
  if (bat && bat.id !== sit.batterId) { sit.batterId = bat.id; playersAutoSet = "batter"; filled.push("batter"); }
  const pit = matchPlayer(p.pitcher, baseballData.pitchers());
  if (pit && pit.id !== sit.pitcherId) { sit.pitcherId = pit.id; filled.push("pitcher"); }
  if (filled.length) persist();
  return filled;
}

// Match an OCR'd name against the roster. Broadcast graphics usually show the
// SURNAME in caps, so match on surname and only accept an unambiguous hit —
// a wrong player would silently poison every number.
function matchPlayer(text, roster) {
  if (!text || !roster || !roster.length) return null;
  const words = String(text).toUpperCase().match(/[A-Z]{3,}/g) || [];
  if (!words.length) return null;
  for (const w of words) {
    const hits = roster.filter((r) => {
      const last = r.name.split(" ").slice(-1)[0].toUpperCase();
      return last === w;
    });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// ---------------------------------------------------------------- rendering
function setWatchNote(t) { watchNote = t; renderWatchUI(); }
function renderWatchUI() {
  if (els.watchBtn) {
    els.watchBtn.textContent = watching ? "⏹ Stop watching" : "👁 Watch";
    els.watchBtn.classList.toggle("accent", !watching);
  }
  if (els.watchNote) els.watchNote.textContent = watchNote;
  if (els.watchHud) els.watchHud.style.display = watching ? "block" : "none";
  if (els.aimHint) els.aimHint.style.display = watching ? "block" : "none";
  if (els.watchPulse) els.watchPulse.textContent = watchPulse ? "◉ scanning…" : (watching ? "○ idle" : "");
  if (els.watchSaw) els.watchSaw.textContent = watchSaw ? `saw: ${watchSaw}` : (watching ? "saw: —" : "");
  if (els.watchReadLine) els.watchReadLine.textContent = watchRead ? `count: ${watchRead}` : "";
  if (els.autoNote) {
    els.autoNote.textContent = playersAutoSet
      ? "Batter auto-set from the graphic — change it above if that's wrong."
      : "";
  }
}

// The persistent live feed: this count's outcome odds, always visible.
function renderFeed() {
  const host = els.feed;
  if (!host) return;
  const pred = prediction();
  const o = pred && pred.outcome;
  if (!o) {
    host.innerHTML = `<div style="font-size:11px; color:var(--dim); padding:8px 2px;">
      Pick a batter to see this count's odds.</div>`;
    return;
  }
  const cell = (label, v, colour) => `
    <div style="flex:1; text-align:center; padding:6px 2px;">
      <div style="font-family:var(--mono); font-size:19px; font-weight:700; color:${colour};">${Math.round(v * 100)}%</div>
      <div style="font-size:9.5px; letter-spacing:0.06em; color:var(--dim); text-transform:uppercase;">${label}</div>
    </div>`;
  host.innerHTML = `
    <div style="border:1px solid var(--line); border-radius:12px; background:var(--panel-solid); margin-top:8px;">
      <div style="display:flex; align-items:center; gap:6px; padding:6px 10px 0; font-family:var(--mono); font-size:10px; color:var(--dim);">
        <span style="color:var(--gold);">${sit.balls}-${sit.strikes}</span>
        <span>${o.basis === "league" ? "league baseline (thin sample)" : "this batter"}</span>
        <span style="flex:1"></span><span>n=${o.n}</span>
      </div>
      <div style="display:flex;">
        ${cell("hit", o.hit, "var(--good)")}
        ${cell("walk", o.walk, "var(--accent)")}
        ${cell("strikeout", o.k, "var(--warn)")}
        ${cell("other out", o.out, "var(--dim)")}
      </div>
    </div>`;
}

// Mini strike zone: 3x3 shaded by where this pitcher works in this count.
function renderZone() {
  const host = els.zone;
  if (!host) return;
  const pred = prediction();
  const g = pred && pred.locationGrid;
  if (!g) { host.innerHTML = ""; return; }
  const max = Math.max(...Object.values(g));
  const rows = ["up", "mid", "low"], cols = ["in", "mid", "away"];
  const cells = rows.map((r) => cols.map((c) => {
    const v = g[`${r}-${c}`] || 0;
    const a = max ? (v / max) * 0.85 : 0;
    return `<div style="aspect-ratio:1; border:1px solid rgba(255,255,255,0.13);
      background:rgba(255,209,102,${a.toFixed(3)}); display:flex; align-items:center; justify-content:center;
      font-family:var(--mono); font-size:9.5px; color:${a > 0.4 ? "#1a1205" : "var(--dim)"};">${v ? Math.round(v * 100) : ""}</div>`;
  }).join("")).join("");
  const top = pred.location;
  host.innerHTML = `
    <div style="display:flex; gap:10px; align-items:center; margin-top:8px;">
      <div style="width:104px; display:grid; grid-template-columns:repeat(3,1fr); border-radius:6px; overflow:hidden;">${cells}</div>
      <div style="flex:1; font-size:11px; line-height:1.5; color:var(--dim);">
        <div style="color:var(--text); font-weight:600;">${top ? top.phrase : "location"}</div>
        Where ${names().pitcher || "he"} works in ${sit.balls}-${sit.strikes} counts.
        Grid is catcher's view: columns inside → away, rows up → low.
        ${(pred.fallbacks || []).includes("location") ? "<br><em>League pattern — thin sample for him.</em>" : ""}
      </div>
    </div>`;
}

function showReadCard(read, detail) {
  if (!els.readCard) return;
  els.readCard.style.cssText =
    "display:block; border:1px solid rgba(77,163,255,0.45); border-radius:14px;" +
    "background:rgba(77,163,255,0.09); padding:13px 15px; margin-top:10px;" +
    "font-size:16px; line-height:1.5; font-weight:600; white-space:pre-wrap;";
  els.readCard.textContent = read;
  if (detail) {
    const d = document.createElement("div");
    d.style.cssText = "margin-top:8px; padding-top:8px; border-top:1px solid rgba(77,163,255,0.25);" +
      "font-size:13.5px; font-weight:400; color:var(--text); line-height:1.55;";
    d.textContent = detail;
    els.readCard.appendChild(d);
  }
}

function playerSelect(which, value, label, list) {
  const opts = [`<option value="">${label}</option>`].concat(
    list.map((p) => `<option value="${p.id}"${String(p.id) === String(value) ? " selected" : ""}>${p.name}</option>`)
  ).join("");
  return `<select data-player="${which}" style="max-width:46%;">${opts}</select>`;
}

function renderPanel() {
  const w = root;
  const P = dataReady ? baseballData.pitchers() : [];
  const B = dataReady ? baseballData.batters() : [];
  const meta = dataReady ? baseballData.meta() : null;
  w.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 6px;">
          <span style="font-size:22px;">⚾</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Read the pitch</div>
            <div style="font-size:11px; color:var(--dim);">Historical tendencies from public pitch data — not a prediction.</div>
          </div>
        </div>

        <div class="fbRow" style="margin:6px 0 2px;"><span class="fbSeg">
          ${playerSelect("pitcher", sit.pitcherId, "Pitcher", P)}
          <span style="color:var(--dim); font-size:12px;">vs</span>
          ${playerSelect("batter", sit.batterId, "Batter", B)}
        </span></div>
        <div data-el="autoNote" style="font-size:10.5px; color:var(--gold); margin:0 2px 8px; line-height:1.4;"></div>

        <div style="display:flex; gap:8px;">
          <button class="ghostBtn accent" data-el="watchBtn" style="flex:1; padding:11px;">👁 Watch</button>
          <button class="ghostBtn accent" data-el="scanBtn" style="flex:1; padding:11px;">📷 Scan</button>
        </div>
        <input type="file" data-el="scanInput" accept="image/*" capture="environment" style="display:none;">
        <video data-el="watchVideo" playsinline muted autoplay
          style="display:none; width:100%; border-radius:14px; margin-top:10px; background:#000;
                 height:38vh; max-height:380px; object-fit:cover; cursor:pointer;"></video>
        <div data-el="watchHud" style="display:none; margin-top:6px;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span data-el="watchPulse" style="font-family:var(--mono); font-size:11px; color:var(--warn);"></span>
            <span data-el="watchReadLine" style="font-family:var(--mono); font-size:12px; font-weight:700; color:var(--good);"></span>
            <span style="flex:1"></span>
            <span style="font-size:10px; color:var(--dim);">checking every ~6s · tap to scan now</span>
          </div>
          <div data-el="watchSaw" style="font-family:var(--mono); font-size:10.5px; color:var(--dim);
               margin-top:4px; overflow-wrap:anywhere; line-height:1.4;"></div>
        </div>

        <div data-el="readCard" style="display:none;"></div>
        <div data-el="feed"></div>
        <div data-el="zone"></div>

        <div data-el="watchNote" style="font-size:11px; color:var(--warn); margin-top:6px; line-height:1.45;"></div>
        <div data-el="aimHint" style="display:none; font-size:10.5px; color:var(--dim); margin-top:4px; line-height:1.45;">
          Aim so the count graphic fills more of the frame and hold steady — small on-screen text is hard from across a room.</div>
        <div style="font-size:10px; color:var(--dim); margin-top:4px; line-height:1.4;">
          Watch reads the broadcast graphic from the camera while this screen is open — it uses battery and
          only works in the foreground. Always-on is a glasses feature later.</div>
        <div data-el="scanNote" style="font-size:11px; color:var(--dim); margin-top:6px; line-height:1.45;"></div>

        <div class="fbRow" style="margin-top:10px;"><span class="fbLbl">Count</span><span class="fbSeg">
          ${[0,1,2,3].map((b) => `<button class="fbChip ${sit.balls===b?"on":""}" data-balls="${b}">${b}</button>`).join("")}
          <span style="color:var(--dim); font-size:12px; margin:0 2px;">–</span>
          ${[0,1,2].map((s) => `<button class="fbChip ${sit.strikes===s?"on":""}" data-strikes="${s}">${s}</button>`).join("")}
        </span></div>

        <div style="display:flex; gap:8px; margin-top:12px;">
          <button class="bigBtn" data-el="readBtn" style="flex:1; padding:13px;">📣 Read it</button>
          <button class="ghostBtn" data-el="detailBtn">＋ Detail</button>
        </div>

        <button class="ghostBtn" data-el="manualBtn" style="width:100%; margin-top:12px; text-align:left;">
          ${manualOpen ? "▾" : "▸"} Set manually</button>
        <div data-el="manualWrap" style="display:${manualOpen ? "block" : "none"};
             border:1px solid var(--line); border-radius:14px; background:var(--panel-solid); padding:12px; margin-top:8px;">
          <div class="fbRow"><span class="fbLbl">Outs</span><span class="fbSeg">
            ${[0,1,2].map((o) => `<button class="fbChip ${sit.outs===o?"on":""}" data-outs="${o}">${o}</button>`).join("")}
          </span></div>
          <div class="fbRow"><span class="fbLbl">Runners</span><span class="fbSeg fbWrap">
            ${Object.keys(BASE_LABELS).map((k) => `<button class="fbChip ${String(sit.bases)===k?"on":""}" data-bases="${k}">${k === "empty" ? "—" : k === "loaded" ? "loaded" : k}</button>`).join("")}
          </span></div>
          <div class="fbRow"><span class="fbLbl">Inning</span><span class="fbSeg">
            <button class="fbChip" data-inn="-1">–</button>
            <span class="fbVal" data-el="innVal">${sit.half === "top" ? "▲" : "▼"} ${sit.inning}</span>
            <button class="fbChip" data-inn="1">+</button>
            <button class="fbChip" data-el="halfBtn">${sit.half === "top" ? "Top" : "Bottom"}</button>
          </span></div>
          <div class="fbRow"><span class="fbLbl">Score</span><span class="fbSeg">
            <button class="fbChip" data-score="-1">–</button>
            <span class="fbVal" data-el="scoreVal">${scoreLabel()}</span>
            <button class="fbChip" data-score="1">+</button>
          </span></div>
          <button class="ghostBtn" data-el="resetBtn" style="margin-top:10px;">Reset situation</button>
        </div>

        <div data-el="statCard"></div>
        <div style="font-size:10px; color:var(--dim); margin-top:10px; line-height:1.45;">
          ${meta ? `Public Statcast data (${(meta.range || []).join(" → ")}), ${(meta.pitches || 0).toLocaleString()} pitches.
           Season-to-date frequencies, not a prediction.` : ""}
        </div>
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.panel = w;
  wirePanel();
  renderFeed(); renderZone(); renderStatCard(); renderWatchUI();
  if (lastInstant && lastInstant.line) showReadCard(lastInstant.line);
  if (watching && watchStream && els.watchVideo) {
    els.watchVideo.srcObject = watchStream;
    els.watchVideo.style.display = "block";
    const p = els.watchVideo.play(); if (p && p.catch) p.catch(() => {});
  }
}

function scoreLabel() {
  const d = sit.scoreFor - sit.scoreAgainst;
  return d === 0 ? "tied" : d > 0 ? `up ${d}` : `down ${-d}`;
}

function renderStatCard() {
  const host = els.statCard;
  if (!host) return;
  const pred = prediction();
  if (!pred) { host.innerHTML = ""; return; }
  const lines = baseballData.cardLines(pred);
  const n = names();
  host.innerHTML = `
    <div style="border:1px solid rgba(255,209,102,0.35); border-radius:12px; background:rgba(255,209,102,0.05); padding:10px 12px; margin-top:10px;">
      <div style="font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--gold); margin-bottom:6px;">
        ${(n.pitcher || "PITCHER").toUpperCase()} · ${sit.balls}-${sit.strikes}</div>
      ${lines.map((l) => `<div style="font-size:12px; line-height:1.55;">${l}</div>`).join("")}
      ${(pred.fallbacks || []).length ? `<div style="font-size:10px; color:var(--dim); margin-top:6px;">
        League baseline used for: ${pred.fallbacks.join(", ")} (thin sample).</div>` : ""}
    </div>`;
}

function refresh() {
  persist();
  renderFeed(); renderZone(); renderStatCard();
}

function wirePanel() {
  root.querySelectorAll("[data-player]").forEach((sel) => {
    sel.addEventListener("change", () => {
      sit[sel.dataset.player + "Id"] = sel.value;
      playersAutoSet = "";
      refresh(); renderWatchUI();
    });
  });
  root.querySelectorAll("[data-balls]").forEach((b) => b.addEventListener("click", () => {
    sit.balls = +b.dataset.balls; renderPanel(); refresh();
  }));
  root.querySelectorAll("[data-strikes]").forEach((b) => b.addEventListener("click", () => {
    sit.strikes = +b.dataset.strikes; renderPanel(); refresh();
  }));
  root.querySelectorAll("[data-outs]").forEach((b) => b.addEventListener("click", () => {
    sit.outs = +b.dataset.outs; renderPanel(); refresh();
  }));
  root.querySelectorAll("[data-bases]").forEach((b) => b.addEventListener("click", () => {
    sit.bases = b.dataset.bases; renderPanel(); refresh();
  }));
  root.querySelectorAll("[data-inn]").forEach((b) => b.addEventListener("click", () => {
    sit.inning = Math.max(1, Math.min(20, sit.inning + (+b.dataset.inn))); renderPanel(); refresh();
  }));
  root.querySelectorAll("[data-score]").forEach((b) => b.addEventListener("click", () => {
    sit.scoreFor = Math.max(0, sit.scoreFor + (+b.dataset.score)); renderPanel(); refresh();
  }));
  els.halfBtn.addEventListener("click", () => { sit.half = sit.half === "top" ? "bottom" : "top"; renderPanel(); refresh(); });
  els.resetBtn.addEventListener("click", () => { sit = freshSituation(); lastInstant = null; renderPanel(); refresh(); });
  els.manualBtn.addEventListener("click", () => {
    manualOpen = !manualOpen;
    els.manualWrap.style.display = manualOpen ? "block" : "none";
    els.manualBtn.textContent = `${manualOpen ? "▾" : "▸"} Set manually`;
  });
  els.readBtn.addEventListener("click", () => {
    const line = instantRead();
    showReadCard(line); renderFeed(); renderZone(); svc.speak(line);
  });
  els.detailBtn.addEventListener("click", async () => {
    els.detailBtn.disabled = true; els.detailBtn.textContent = "Thinking…";
    const r = await moreDetail();
    els.detailBtn.disabled = false; els.detailBtn.textContent = "＋ Detail";
    showReadCard(r.line, r.detail || r.note);
    svc.speak(r.detail ? `${r.line} ${r.detail}` : r.line);
  });
  els.watchBtn.addEventListener("click", toggleWatch);
  els.watchVideo.addEventListener("click", () => {
    if (!watching) return;
    const now = Date.now();
    if (now - lastTapAt < TAP_MIN_GAP_MS) { setWatchNote("Easy — one scan at a time."); return; }
    lastTapAt = now; setWatchNote("Scanning now…"); watchTick();
  });
  els.scanBtn.addEventListener("click", () => { els.scanInput.value = ""; els.scanInput.click(); });
  els.scanInput.addEventListener("change", () => {
    const f = els.scanInput.files && els.scanInput.files[0];
    if (f) scanFromFile(f);
  });
}

async function scanFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    const b64 = frameToJpegBase64(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(url);
    els.scanNote.textContent = "Reading the graphic…";
    const res = await svc.companion.scoreboard(b64, { sport: "baseball" });
    if (!res.ok) { els.scanNote.textContent = res.text + " You can still set everything by hand."; return; }
    const p = { ...(res.parsed || {}) };
    if (!Number.isInteger(p.balls) || !Number.isInteger(p.strikes)) {
      const c = countAnywhere(res.rawText);
      if (c) { p.balls = c.balls; p.strikes = c.strikes; }
    }
    const filled = applyGraphic(p, res.rawText);
    renderPanel();
    els.scanNote.textContent = filled.length
      ? `Auto-filled ${filled.join(", ")} — check and fix any misread.`
      : "Couldn't read the graphic — set it by hand, or try closer.";
    if (filled.length) { const line = instantRead(); showReadCard(line); renderFeed(); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); els.scanNote.textContent = "Couldn't read that photo — try again."; };
  img.src = url;
}

// ---------------------------------------------------------------- mode API
export default {
  id: "baseball",
  title: "Baseball · read the pitch",
  icon: "⚾",
  family: "Learn",
  permissions: ["mic", "camera"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    store = svc.storage.scope("baseball");
    sit = Object.assign(freshSituation(), store.get("situation") || {});
    dataReady = await baseballData.ready();
    renderPanel();
  },
  async start() {},
  stop() { if (watching) stopWatch("Watch paused — tap Watch to resume."); },
  teardown() {
    if (watching) stopWatch("");
    els = {}; root = null; sit = null; lastInstant = null;
  },

  getContext() { return buildContext(); },

  // Shell offers every ✦ input here first.
  handleCommand(text) {
    const t = String(text || "").toLowerCase().trim();
    const c = t.match(/\b([0-3])\s*(?:-|and|to)\s*([0-2])\b/);
    if (c && /count|balls?|strikes?|^\s*[0-3]/.test(t)) {
      sit.balls = +c[1]; sit.strikes = +c[2]; renderPanel(); refresh();
      const line = instantRead(); showReadCard(line); return line;
    }
    if (/\bread it\b|\bwhat('| i)?s (he|the) (throwing|pitch)/.test(t)) {
      const line = instantRead(); showReadCard(line); renderFeed(); return line;
    }
    if (/\bfull count\b/.test(t)) {
      sit.balls = 3; sit.strikes = 2; renderPanel(); refresh();
      const line = instantRead(); showReadCard(line); return line;
    }
    return null;
  },

  getSystemContext() {
    const pred = prediction();
    if (!pred) return "";
    return "Real pitch-level data for this matchup (public Statcast, historical frequencies — never a " +
      "claim about the next pitch):\n" + baseballData.formatBriefForPrompt(pred, names());
  },

  // debug hooks (#debug)
  _state: () => ({ situation: sit, dataReady, watching }),
  _set: (patch) => { Object.assign(sit, patch || {}); renderPanel(); refresh(); },
  _instantRead: () => instantRead(),
  _prediction: () => prediction(),
  _moreDetail: () => moreDetail(),
  _enforcePitchCall: (t, p) => enforcePitchCall(t, p),
  _applyGraphic: (p, raw) => applyGraphic(p, raw),
  _matchPlayer: (t, list) => matchPlayer(t, list || baseballData.batters()),
  _countAnywhere: (t) => countAnywhere(t),
  _forceWatch: (on) => { watching = on; if (!on) { clearInterval(watchTimer); watchTimer = 0; } lastPitchKey = ""; },
  _watchTick: () => watchTick(),
  _lastInstant: () => lastInstant,
};
