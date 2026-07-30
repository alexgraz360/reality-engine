// Reality Engine · Form Coach — watch my shot, tell me ONE thing.
//
// The Coaching pipeline from VISION.md, end to end: Demonstrate → Observe →
// Correct → Repeat → FADE. It also completes the old physics hub's stubbed
// "body motion" experiment, because joint angles and release timing fall out of
// the same keypoints.
//
// WHAT MAKES THIS USEFUL RATHER THAN ANNOYING is the restraint:
//   • ONE cue per rep — the largest deviation, in plain language. Never a list.
//     A list of five faults is how people quit.
//   • A cue that comes good is RETIRED out loud, and the next priority takes
//     over. That's the "fade" — the coach talks less as you get better.
//   • If the keypoints aren't confident enough, it says the view is unusable
//     rather than coaching on garbage.
//
// HARD LINE: pain, injury and rehab are refused outright — no guidance, just a
// plain pointer to a qualified professional. That is a stop, not a disclaimer.
//
// Pose runs on the ALREADY-VENDORED TF.js (the one COCO-SSD/Projectile uses)
// with MoveNet Lightning vendored locally. No CDN, and no network at all for
// pose — frames never leave the phone.

import { manualPanelHTML, wireManualPanel, voiceFirstHint } from "../services/manualPanel.js";

const MIN_KP_SCORE = 0.35;       // a keypoint below this is not trusted
const NEEDED_PARTS = ["left_shoulder", "right_shoulder", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle"];
const SETUP_FRAMES_OK = 8;        // consecutive good frames before we allow coaching
const FADE_STREAK = 3;            // reps in range before a cue is retired
const MAX_REP_FRAMES = 120;

let root, svc, store, els = {};
let movements = [], movement = null;
let detector = null, modelLoading = false, modelError = "";
let camStream = null, rafId = 0, running = false;
let frames = [];                  // current rep window
let setupStreak = 0, setupOk = false, lastSetupProblem = "";
let repCount = 0, lastCue = null, lastMeasures = null, lastPraise = "";
let progress = {};                // cueId -> { state, streak, seen }
let activeCueId = null;
let fps = 0, fpsSamples = [];
let refusedMedical = false;

// ---------------------------------------------------------------- pain gate
// Checked BEFORE anything else on any text that reaches this mode.
const PAIN_RE = /\b(pain|painful|hurts?|hurting|sore|soreness|injur(y|ed|ies)|rehab|rehabilitation|physio|physiotherapy|torn|sprain(ed)?|strain(ed)?|tendon|tendinitis|tendonitis|acl|mcl|meniscus|rotator cuff|impingement|herniat|slipped disc|surgery|post[- ]?op|recovering from)\b/i;
function medicalRefusal() {
  refusedMedical = true;
  render();
  return "That's outside what this should be used for — I'm not able to help with pain, an injury, or " +
    "recovery, and I won't guess at it. Please see a physio, doctor or another qualified professional " +
    "who can actually examine you. I can help with form again once you're cleared.";
}

// ---------------------------------------------------------------- geometry
// All 2D and therefore PROJECTED — camera placement changes these numbers, which
// is why the setup gate matters more than the model does.
function kp(pose, name) {
  const k = pose.keypoints.find((x) => x.name === name);
  return k && k.score >= MIN_KP_SCORE ? k : null;
}
function angleAt(a, b, c) {      // angle at b, degrees
  if (!a || !b || !c) return null;
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return null;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180) / Math.PI;
}
function dist(a, b) { return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null; }

// Which side faces the camera — whichever shoulder/hip pair is more confident.
function sideOf(pose) {
  const l = (kp(pose, "left_shoulder") ? 1 : 0) + (kp(pose, "left_hip") ? 1 : 0);
  const r = (kp(pose, "right_shoulder") ? 1 : 0) + (kp(pose, "right_hip") ? 1 : 0);
  return r > l ? "right" : "left";
}

// ---------------------------------------------------------------- setup gate
function setupCheck(pose) {
  if (!pose || !pose.keypoints) return { ok: false, problem: "No one detected yet — step into frame." };
  const missing = NEEDED_PARTS.filter((n) => !kp(pose, n));
  if (missing.length > 3) {
    return { ok: false, problem: "I can't see enough of you — step back so your whole body is in frame, and check the light." };
  }
  if (missing.length) {
    const pretty = missing[0].replace("_", " ");
    return { ok: false, problem: `I'm losing your ${pretty} — adjust the framing or the lighting so your whole body is visible.` };
  }
  const sh = kp(pose, "left_shoulder") || kp(pose, "right_shoulder");
  const an = kp(pose, "left_ankle") || kp(pose, "right_ankle");
  const span = dist(sh, an);
  if (span != null && span < 0.35) {
    return { ok: false, problem: "You're a bit far away — come closer or zoom in so you fill more of the frame." };
  }
  return { ok: true, problem: "" };
}

// ---------------------------------------------------------------- measurements
// Computes every measurement the definitions can reference. Returns null for any
// it couldn't establish confidently, and the check is then skipped rather than
// guessed at.
function measureRep(seq, mv) {
  if (!seq.length) return null;
  const side = sideOf(seq[Math.floor(seq.length / 2)]);
  const S = (p, n) => kp(p, `${side}_${n}`);
  const out = {};

  if (mv.id === "basketball-shot") {
    // Set point = lowest wrist; release = highest wrist.
    let setF = null, relF = null, setY = -Infinity, relY = Infinity;
    for (const p of seq) {
      const w = S(p, "wrist");
      if (!w) continue;
      if (w.y > setY) { setY = w.y; setF = p; }
      if (w.y < relY) { relY = w.y; relF = p; }
    }
    if (setF) {
      const sh = S(setF, "shoulder"), el = S(setF, "elbow"), wr = S(setF, "wrist");
      out.elbowAngleAtSet = angleAt(sh, el, wr);
      // NOTE: true elbow flare (elbow swinging out to the side) is a FRONT-view
      // fault and is simply not observable side-on, so it is not measured here
      // rather than being approximated into something misleading.
    }
    if (relF) {
      out.releaseElbowAngle = angleAt(S(relF, "shoulder"), S(relF, "elbow"), S(relF, "wrist"));
      const sh = S(relF, "shoulder"), wr = S(relF, "wrist"), ea = S(relF, "ear") || S(relF, "eye");
      const headSpan = dist(sh, ea) || 0.1;
      out.releaseHeight = sh && wr ? (sh.y - wr.y) / headSpan : null;
    }
    // How long the wrist stays above the shoulder after the release frame.
    const relIdx = seq.indexOf(relF);
    let held = 0;
    for (let i = relIdx + 1; i < seq.length; i++) {
      const w = S(seq[i], "wrist"), s = S(seq[i], "shoulder");
      if (w && s && w.y < s.y) held++; else break;
    }
    const dt = seq.length > 1 ? (seq[seq.length - 1].t - seq[0].t) / (seq.length - 1) : 33;
    out.followThroughHold = (held * dt) / 1000;
  }

  if (mv.id === "bodyweight-squat") {
    let depthF = null, lowest = -Infinity;
    for (const p of seq) {
      const h = S(p, "hip");
      if (h && h.y > lowest) { lowest = h.y; depthF = p; }
    }
    if (depthF) {
      const sh = S(depthF, "shoulder"), hip = S(depthF, "hip"), kn = S(depthF, "knee"), an = S(depthF, "ankle");
      out.kneeAngleAtDepth = angleAt(hip, kn, an);
      out.hipAngleAtDepth = angleAt(sh, hip, kn);
      if (sh && hip) {
        // Torso lean from vertical.
        out.torsoLeanAtDepth = Math.abs((Math.atan2(Math.abs(sh.x - hip.x), Math.abs(sh.y - hip.y)) * 180) / Math.PI);
      }
      if (kn && an) {
        const shin = dist(kn, an) || 0.1;
        // Side-on this is FORWARD travel of the knee past the ankle, not lateral
        // knee cave — that needs a front view and is deliberately not claimed.
        out.kneeTravelAtDepth = Math.abs(kn.x - an.x) / shin;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- one cue
// Evaluate every check, then emit EXACTLY ONE — the worst deviation among the
// checks we haven't already retired, in priority order as the tiebreak.
function evaluate(measures, mv) {
  const results = [];
  for (const c of mv.checks) {
    const v = measures ? measures[c.measure] : null;
    if (v == null || !isFinite(v)) { results.push({ check: c, value: null, ok: null, severity: 0 }); continue; }
    const t = c.target || {};
    let over = 0;
    if (t.min != null && v < t.min) over = (t.min - v) / Math.abs(t.min || 1);
    if (t.max != null && v > t.max) over = Math.max(over, (v - t.max) / Math.abs(t.max || 1));
    results.push({ check: c, value: v, ok: over === 0, severity: over });
  }
  return results;
}

function cueTextFor(res) {
  const c = res.check, t = c.target || {};
  if (t.min != null && res.value < t.min && c.cueLow) return c.cueLow;
  if (t.max != null && res.value > t.max && c.cueHigh) return c.cueHigh;
  return c.cue || c.cueLow || c.cueHigh || "Something's off on that rep.";
}

function progressFor(id) {
  if (!progress[id]) progress[id] = { state: "working", streak: 0, seen: 0 };
  return progress[id];
}
function persist() { store.set("progress", progress); }

// The heart of it: one cue, plus the fade.
function coachRep(measures, mv) {
  repCount++;
  lastMeasures = measures;
  const results = evaluate(measures, mv);
  const spoken = [];

  // FADE — a cue we were working on that's now in range for FADE_STREAK reps is
  // retired out loud, and we move on. This is the whole point of the mode.
  if (activeCueId) {
    const cur = results.find((r) => r.check.id === activeCueId);
    if (cur && cur.ok) {
      const p = progressFor(activeCueId);
      p.streak++;
      p.state = p.streak >= FADE_STREAK ? "good" : "improving";
      if (p.state === "good") {
        spoken.push(cur.check.good || "That's looking good now.");
        activeCueId = null;
      }
      persist();
    } else if (cur && cur.ok === false) {
      const p = progressFor(activeCueId);
      p.streak = 0; p.state = "working";
      persist();
    }
  }

  // Pick the next thing to say: worst deviation among checks not already retired.
  // Read-only state lookup here — filtering must not CREATE progress entries for
  // checks that were never actually coached.
  const stateOf = (id) => (progress[id] || {}).state || "working";
  const candidates = results
    .filter((r) => r.ok === false && stateOf(r.check.id) !== "good")
    .sort((a, b) => (b.severity - a.severity) || (a.check.priority - b.check.priority));

  if (candidates.length) {
    const pick = candidates[0];
    activeCueId = pick.check.id;
    const p = progressFor(activeCueId);
    p.seen++; p.streak = 0;
    if (p.state === "good") p.state = "working";
    persist();
    lastCue = { id: pick.check.id, text: cueTextFor(pick), value: pick.value, measure: pick.check.measure };
    lastPraise = "";
    // Exactly one cue. If we also retired something this rep, that acknowledgement
    // comes first — it's not a second criticism, it's the fade.
    spoken.push(lastCue.text);
  } else {
    // Nothing out of range: praise, never a manufactured criticism.
    lastCue = null;
    const anyMeasured = results.some((r) => r.value != null);
    lastPraise = anyMeasured
      ? (spoken.length ? "" : "That one looked good — same again.")
      : "I couldn't measure that rep clearly enough to give you anything.";
    if (lastPraise) spoken.push(lastPraise);
  }
  render();
  return spoken.join(" ");
}

// ---------------------------------------------------------------- rep detection
// A rep is a clear excursion of the tracked signal (wrist up for a shot, hip
// down for a squat) followed by a return.
let repState = "idle", extremum = null, baseline = null;
function feedFrame(pose, t) {
  const gate = setupCheck(pose);
  if (!gate.ok) {
    setupStreak = 0; setupOk = false; lastSetupProblem = gate.problem;
    frames = []; repState = "idle";
    return null;
  }
  setupStreak++;
  if (setupStreak >= SETUP_FRAMES_OK) { setupOk = true; lastSetupProblem = ""; }
  if (!setupOk || !movement) return null;

  const side = sideOf(pose);
  const sig = movement.repDetect.signal === "wristY"
    ? (kp(pose, `${side}_wrist`) || {}).y
    : (kp(pose, `${side}_hip`) || {}).y;
  if (sig == null) return null;

  frames.push({ ...pose, t });
  if (frames.length > MAX_REP_FRAMES) frames.shift();

  const down = movement.repDetect.direction === "down";
  if (baseline == null) { baseline = sig; extremum = sig; return null; }
  // travel is positive when the signal moves the way a rep should
  const travel = down ? sig - baseline : baseline - sig;
  if (repState === "idle") {
    if (travel > movement.repDetect.minTravel) { repState = "moving"; extremum = sig; frames = frames.slice(-30); }
    else baseline = baseline * 0.9 + sig * 0.1;   // drift with a still stance
  } else if (repState === "moving") {
    extremum = down ? Math.max(extremum, sig) : Math.min(extremum, sig);
    const back = down ? extremum - sig : sig - extremum;
    // returned most of the way = rep complete
    if (back > movement.repDetect.minTravel * 0.6) {
      repState = "idle";
      baseline = sig;
      const seq = frames.slice();
      frames = [];
      return seq;
    }
  }
  return null;
}

// ---------------------------------------------------------------- pose engine
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("script failed: " + src));
    document.head.appendChild(s);
  });
}
async function ensureDetector() {
  if (detector || modelLoading) return detector;
  modelLoading = true;
  try {
    // The SAME vendored runtime Projectile uses — loaded, not forked.
    if (!window.tf) await loadScript(new URL("../vendor/tfjs/tf.min.js", import.meta.url).href);
    if (!window.poseDetection) await loadScript(new URL("../vendor/tfjs/pose-detection.min.js", import.meta.url).href);
    detector = await window.poseDetection.createDetector(
      window.poseDetection.SupportedModels.MoveNet,
      {
        modelType: window.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        // Vendored locally — no CDN, no network for pose.
        modelUrl: new URL("../vendor/models/movenet-lightning/model.json", import.meta.url).href,
      }
    );
  } catch (err) {
    modelError = "Couldn't start the pose model on this device — " + (err && err.message || err);
    console.error("formcoach: detector failed", err);
  } finally {
    modelLoading = false;
    render();
  }
  return detector;
}

async function startCamera() {
  if (running) return;
  if (refusedMedical) return;
  try {
    camStream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (err) { modelError = "Camera unavailable — Form Coach needs it."; render(); return; }
  els.cam.srcObject = camStream;
  els.cam.style.display = "";
  try { await els.cam.play(); } catch (e) {}
  await ensureDetector();
  if (!detector) return;
  running = true;
  baseline = null; repState = "idle"; setupStreak = 0; setupOk = false;
  loop();
  render();
}
function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId); rafId = 0;
  if (camStream) { svc.sensors.releaseStream(camStream); camStream = null; }
  if (els.cam) { els.cam.srcObject = null; els.cam.style.display = "none"; }
  render();
}

async function loop() {
  if (!running || !detector) return;
  const t0 = performance.now();
  try {
    const poses = await detector.estimatePoses(els.cam, { maxPoses: 1, flipHorizontal: false });
    if (poses && poses[0]) {
      // Normalise to 0..1 so thresholds don't depend on resolution.
      const w = els.cam.videoWidth || 1, h = els.cam.videoHeight || 1;
      const pose = { keypoints: poses[0].keypoints.map((k) => ({ name: k.name, x: k.x / w, y: k.y / h, score: k.score })) };
      const rep = feedFrame(pose, performance.now());
      if (rep) {
        const line = coachRep(measureRep(rep, movement), movement);
        if (line) svc.speak(line);
      }
      drawOverlay(pose);
    }
  } catch (err) { console.warn("formcoach: pose frame failed", err); }
  const dt = performance.now() - t0;
  fpsSamples.push(1000 / Math.max(1, dt));
  if (fpsSamples.length > 30) fpsSamples.shift();
  fps = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  rafId = requestAnimationFrame(loop);
}

const SKELETON = [["shoulder", "elbow"], ["elbow", "wrist"], ["shoulder", "hip"], ["hip", "knee"], ["knee", "ankle"]];
function drawOverlay(pose) {
  const c = els.overlay;
  if (!c) return;
  const ctx = c.getContext("2d");
  c.width = c.clientWidth; c.height = c.clientHeight;
  ctx.clearRect(0, 0, c.width, c.height);
  const side = sideOf(pose);
  ctx.strokeStyle = setupOk ? "rgba(120,255,180,0.9)" : "rgba(255,180,90,0.9)";
  ctx.lineWidth = 3;
  for (const [a, b] of SKELETON) {
    const p1 = kp(pose, `${side}_${a}`), p2 = kp(pose, `${side}_${b}`);
    if (!p1 || !p2) continue;
    ctx.beginPath(); ctx.moveTo(p1.x * c.width, p1.y * c.height);
    ctx.lineTo(p2.x * c.width, p2.y * c.height); ctx.stroke();
  }
  ctx.fillStyle = ctx.strokeStyle;
  for (const k of pose.keypoints) {
    if (k.score < MIN_KP_SCORE) continue;
    ctx.beginPath(); ctx.arc(k.x * c.width, k.y * c.height, 4, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!els.panel) return;
  const p = els.panel;
  if (refusedMedical) {
    p.innerHTML = `
      <div style="border:1px solid var(--bad); border-radius:14px; background:rgba(255,90,90,0.08); padding:14px;">
        <div style="font-weight:700; font-size:14px; color:var(--bad);">Not the right tool for this</div>
        <div style="font-size:13px; line-height:1.55; margin-top:6px;">
          I can't help with pain, an injury, or recovery, and I'm not going to guess. Please see a physio,
          doctor or another qualified professional who can actually examine you.</div>
        <button class="ghostBtn" data-el="resetBtn" style="margin-top:10px;">I'm asking about form, not injury</button>
      </div>`;
    els.resetBtn = p.querySelector("[data-el=resetBtn]");
    els.resetBtn.addEventListener("click", () => { refusedMedical = false; render(); });
    return;
  }
  const cueBlock = lastCue
    ? `<div style="font-size:19px; font-weight:600; line-height:1.4;">${escapeHtml(lastCue.text)}</div>`
    : lastPraise
      ? `<div style="font-size:19px; font-weight:600; line-height:1.4; color:var(--good);">${escapeHtml(lastPraise)}</div>`
      : `<div style="color:var(--dim); font-size:13px;">${running ? (setupOk ? "Watching — take a rep." : "") : "Camera off."}</div>`;
  p.innerHTML = `
    ${!setupOk && running ? `<div style="border:1px solid var(--warn); border-radius:12px; background:rgba(255,209,102,0.07);
        padding:11px 13px; margin-bottom:10px;">
        <div style="font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--warn);">SETUP CHECK</div>
        <div style="font-size:13px; line-height:1.5; margin-top:5px;">${escapeHtml(lastSetupProblem || "Checking I can see all of you…")}</div>
        <div style="font-size:11px; color:var(--dim); margin-top:6px;">${escapeHtml(movement ? movement.setup : "")} Prop the phone somewhere stable.</div>
      </div>` : ""}
    ${modelError ? `<div style="color:var(--bad); font-size:12.5px; margin-bottom:8px;">${escapeHtml(modelError)}</div>` : ""}
    <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:14px; min-height:74px;">
      <div style="font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--accent); margin-bottom:7px;">
        ${movement ? movement.title.toUpperCase() : ""} · REP ${repCount}</div>
      ${cueBlock}
    </div>
    ${lastMeasures ? `
    <div style="border:1px solid var(--line); border-radius:12px; background:var(--panel); padding:11px 12px; margin-top:9px;">
      <div style="font-family:var(--mono); font-size:10px; color:var(--dim); letter-spacing:0.06em;">MEASUREMENTS · APPROXIMATE 2D PROJECTIONS</div>
      <div style="font-family:var(--mono); font-size:11.5px; line-height:1.7; margin-top:5px;">
        ${Object.entries(lastMeasures).filter(([, v]) => v != null && isFinite(v))
          .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: <strong>${/angle|lean/i.test(k) ? Math.round(v) + "°" : v.toFixed(2)}</strong>`)
          .join("<br>")}
        <br>reps: <strong>${repCount}</strong>${fps ? ` · pose ${fps.toFixed(0)} fps` : ""}
      </div>
    </div>` : ""}
    <div style="margin-top:10px;">
      <div style="font-weight:700; font-size:12.5px; margin:0 2px 6px;">Progress</div>
      ${(movement ? movement.checks : []).map((c) => {
        const st = (progress[c.id] || {}).state || "working";
        const dot = st === "good" ? "●" : st === "improving" ? "◐" : "○";
        const col = st === "good" ? "var(--good)" : st === "improving" ? "var(--warn)" : "var(--dim)";
        const label = st === "good" ? "looks good" : st === "improving" ? "improving" : "working on it";
        return `<div style="display:flex; gap:8px; align-items:center; font-size:12px; padding:3px 2px;">
          <span style="color:${col}; font-size:14px;">${dot}</span>
          <span style="flex:1;">${escapeHtml(c.cue || c.cueLow || c.id).slice(0, 46)}</span>
          <span style="color:${col}; font-family:var(--mono); font-size:10.5px;">${label}</span></div>`;
      }).join("")}
    </div>`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderShell() {
  root.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 10px;">
          <span style="font-size:22px;">🏀</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Form Coach</div>
            <div style="font-size:11px; color:var(--dim);">One thing at a time — and it stops mentioning it once you've got it.</div>
          </div>
        </div>
        ${voiceFirstHint(["coach my shot", "watch my squat"])}
        ${manualPanelHTML({ key: "move", label: "Set manually",
          inner: `<div data-el="movePicker" style="display:flex; gap:8px;"></div>` })}
        <div style="position:relative; border-radius:14px; overflow:hidden; background:#000;">
          <video data-el="cam" playsinline muted autoplay
            style="display:none; width:100%; height:38vh; max-height:380px; object-fit:cover;"></video>
          <canvas data-el="overlay" style="position:absolute; inset:0; width:100%; height:100%; pointer-events:none;"></canvas>
        </div>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <button class="ghostBtn accent" data-el="camBtn" style="flex:1; padding:11px;">▶ Start watching</button>
        </div>
        <div data-el="panel" style="margin-top:10px;"></div>
        <div style="font-size:10px; color:var(--dim); margin-top:14px; line-height:1.55;">
          <strong>Honest limits.</strong> This is a <strong>single camera with no depth</strong>, so every angle
          is a <em>2D projection</em> — moving the phone changes the numbers, which is why the setup check
          matters more than the model does. The cues are <strong>widely-taught fundamentals</strong>, not
          personalised coaching: good form varies by body, sport and coach, and this is no substitute for one.
          If the keypoints aren't confident it will say the view isn't usable rather than coach on bad data.
          It works <strong>only while this screen is open</strong> and running the camera plus pose model
          <strong>uses battery</strong>. All pose processing is on-device — no frames leave your phone.
          <strong>Not for pain, injury or rehab.</strong>
        </div>
      </div>
    </div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.camBtn.addEventListener("click", () => (running ? stopCamera() : startCamera()));
  wireManualPanel(els, { key: "move" });
  renderPicker();
  render();
}
function renderPicker() {
  els.movePicker.innerHTML = "";
  for (const mv of movements) {
    const b = document.createElement("button");
    b.className = "fbChip" + (movement && movement.id === mv.id ? " on" : "");
    b.textContent = `${mv.icon} ${mv.title}`;
    b.addEventListener("click", () => { movement = mv; repCount = 0; lastCue = null; lastPraise = ""; lastMeasures = null; activeCueId = null; renderPicker(); render(); });
    els.movePicker.appendChild(b);
  }
}

// ---------------------------------------------------------------- mode API
export default {
  id: "formcoach",
  title: "Form Coach · one cue at a time",
  icon: "🏀",
  family: "Learn",
  permissions: ["camera", "mic"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("formcoach");
    progress = store.get("progress") || {};
    try {
      const r = await fetch(new URL("../data/movements.json", import.meta.url));
      movements = (await r.json()).movements || [];
    } catch (e) { console.error("movements failed to load:", e); movements = []; }
    movement = movements[0] || null;
    renderShell();
  },
  async start() {},
  stop() { stopCamera(); },
  teardown() { stopCamera(); els = {}; root = null; },

  getContext() {
    if (refusedMedical) return "Form Coach — declined to advise on an injury; suggested a professional.";
    if (!movement) return "Form Coach — no movement selected.";
    const cue = lastCue ? ` Current cue: ${lastCue.text}` : (lastPraise ? ` Last rep: ${lastPraise}` : "");
    return `Form Coach — ${movement.title}, ${repCount} rep${repCount === 1 ? "" : "s"} this session.${cue}` +
      (running ? (setupOk ? " Watching." : ` Setup: ${lastSetupProblem}`) : " Camera off.");
  },

  handleCommand(text) {
    const raw = String(text || "");
    if (PAIN_RE.test(raw)) return medicalRefusal();          // hard stop, first
    const q = raw.toLowerCase().replace(/[.,!?']/g, "").trim();
    for (const mv of movements) {
      if (new RegExp(`\\b(coach|watch|check|film)\\b.*\\b${mv.verb}\\b`).test(q) ||
          new RegExp(`\\b${mv.id.replace("-", " ")}\\b`).test(q)) {
        movement = mv; repCount = 0; activeCueId = null; lastCue = null; lastPraise = "";
        renderPicker(); render(); startCamera();
        return `Watching your ${mv.verb}. ${mv.setup}`;
      }
    }
    if (/^(start watching|start)$/.test(q)) { startCamera(); return "Watching."; }
    if (/^(stop watching|stop)$/.test(q)) { stopCamera(); return "Stopped."; }
    if (/how many reps|rep count/.test(q)) return `${repCount} rep${repCount === 1 ? "" : "s"} so far.`;
    return null;
  },

  // ---------------------------------------------------------------- slots
  // "Coach my shot" already says basketball. The only thing this mode needs is
  // the movement, and the movement is almost always in the sentence — so this
  // should essentially never ask.
  //
  // NOTE the pain gate is NOT a slot and must never become one: it is a refusal,
  // not a value to collect, and it still runs first in handleCommand.
  describeSlots() {
    const matchMovement = (t) => {
      const s = " " + String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
      for (const mv of movements) {
        // Each movement's own verb and title, plus the words people actually use.
        const words = [mv.verb, mv.title, mv.id.replace(/-/g, " ")].filter(Boolean).map((x) => x.toLowerCase());
        if (mv.id === "basketball-shot") words.push("shot", "shooting", "jumper", "jump shot", "free throw", "basketball");
        if (mv.id === "bodyweight-squat") words.push("squat", "squats", "squatting", "air squat");
        for (const w of words) if (s.includes(" " + w + " ")) return mv.id;
      }
      return null;
    };
    return [{
      id: "movement", label: "the movement", required: true,
      sources: ["utterance", "context"],
      ask: "Shot or squat?",
      parse: matchMovement,
      // Last one coached, so "watch my form" alone continues where you left off.
      fromContext: () => (movement ? movement.id : (store && store.get("lastMovement")) || null),
      current: () => null,
      apply: (id) => {
        const mv = movements.find((m) => m.id === id);
        if (!mv) return;
        movement = mv; repCount = 0; activeCueId = null; lastCue = null; lastPraise = "";
        if (store) store.set("lastMovement", id);
        renderPicker(); render();
      },
      say: (id) => {
        const mv = movements.find((m) => m.id === id);
        return mv ? `your ${mv.verb}` : "that movement";
      },
    }];
  },

  describeCapabilities() {
    return [{
      id: "form.coach", label: "Form Coach", needsMode: true, fillsSlots: true,
      patterns: [/\b(coach|watch|check|film) my (shot|shooting|squat|form)\b/i,
                 /\bhow('?s| is) my (shot|squat|form)\b/i],
      examples: ["coach my shot", "watch my squat", "check my form"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  // Text-only, within the contract limits: the one cue plus the rep count.
  getGlanceCard() {
    if (refusedMedical) return { title: "Not for injury", lines: ["see a professional"], spoken: "", holdMs: 6000 };
    if (!movement) return null;
    const wrap = svc.glasses && svc.glasses.wrap;
    const body = lastCue ? lastCue.text : (lastPraise || (running ? "watching…" : "camera off"));
    const lines = (wrap ? wrap(body, 24, 3) : [String(body).slice(0, 24)]).concat([`rep ${repCount}`]).slice(0, 4);
    return { title: movement.title.slice(0, 20), lines, spoken: lastCue ? lastCue.text : lastPraise, holdMs: 7000 };
  },

  // verification hooks (#debug)
  _state: () => ({ movement: movement && movement.id, repCount, activeCueId, lastCue, lastPraise,
    progress: JSON.parse(JSON.stringify(progress)), setupOk, refusedMedical, running }),
  _movements: () => movements.map((m) => ({ id: m.id, checks: m.checks.map((c) => c.id) })),
  _setMovement: (id) => { movement = movements.find((m) => m.id === id) || movement; repCount = 0; activeCueId = null; lastCue = null; lastPraise = ""; render(); return !!movement; },
  _measure: (seq) => measureRep(seq, movement),
  _coach: (seq) => coachRep(measureRep(seq, movement), movement),
  _coachMeasures: (m) => coachRep(m, movement),
  _setupCheck: (pose) => setupCheck(pose),
  _feed: (pose, t) => feedFrame(pose, t),
  _reset: () => { progress = {}; repCount = 0; activeCueId = null; lastCue = null; lastPraise = ""; refusedMedical = false; persist(); render(); },
  _glance: () => (movement ? { ...module_glance() } : null),
  _pain: (t) => (PAIN_RE.test(t) ? medicalRefusal() : null),
};
function module_glance() {
  const wrap = svc.glasses && svc.glasses.wrap;
  const body = lastCue ? lastCue.text : (lastPraise || (running ? "watching…" : "camera off"));
  const lines = (wrap ? wrap(body, 24, 3) : [String(body).slice(0, 24)]).concat([`rep ${repCount}`]).slice(0, 4);
  return { title: movement.title.slice(0, 20), lines, spoken: lastCue ? lastCue.text : lastPraise, holdMs: 7000 };
}
