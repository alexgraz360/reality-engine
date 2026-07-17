// Projectile — native physics mode. Track a thrown/rolling object with the
// camera (vendored TF.js COCO-SSD + Kalman smoothing, ported from the
// physics-glasses experiment and hardened) and estimate launch speed, angle,
// peak height, and range from a fixed-g kinematics fit over the smoothed arc.
//
// HONESTY: phone CV is approximate. Estimates need the two-tap length
// calibration (pixels → metres in the throw plane) and are labeled "≈".
// Robustness over range: fits are gated on point count, time span, and R².

const DETECT_W = 480;             // detector input width
const SCORE_MIN = 0.30;
const AUTO_CLASS = "sports ball"; // auto-lock this class when it appears
const AUTO_SCORE = 0.40;
const LOST_S = 0.9;               // coast on prediction, then drop the lock
const REACQ_S = 3.0;              // keep looking for the class after a loss
const TRAIL_S = 2.5;
const G = 9.81;

// Throw segmentation (calibrated units)
const THROW_START_MS = 1.2;       // m/s — motion above this begins a throw
const THROW_END_MS = 0.5;         // m/s — sustained slower than this ends it
const THROW_END_HOLD_S = 0.35;
const THROW_MAX_S = 4;
const FIT_MIN_POINTS = 8;
const FIT_MIN_SPAN_S = 0.25;
const FIT_MIN_R2 = 0.7;           // below this the result is labeled "rough"

let root, svc, store, els = {};
let running = false;
let stream = null;
let model = null;
let modelState = "idle";          // idle | loading | ready | failed
let video, overlay, octx;
let detectCanvas, dctx;
let rafId = 0;
let detectLoopActive = false;
let onResize = null;

let vw = 0, vh = 0;               // video dims (or synthetic dims in tests)
let latest = [];                  // detections in video coords
let target = null;                // { class, kfx, kfy, lastMeas }
let trail = [];
let calib = { ppm: 0, mode: false, pts: [] };
let fpsEma = 0, lastFrameT = 0;

// throw state
let throwState = "idle";          // idle | tracking
let throwPts = [];                // [{x, y, t}] video px, t seconds
let slowSince = 0;
let lastThrow = null;             // { v0, angleDeg, peak, range, r2, rough, at }
let synthNow = 0;                 // synthetic clock for the verification hooks

function setPill(el, cls) { if (el) el.className = "pill" + (cls ? " " + cls : ""); }
function setHint(text) {
  if (!els.hint) return;
  els.hint.textContent = text || "";
  els.hint.classList.toggle("hidden", !text);
}

// ---- 1-D constant-velocity Kalman (proven in physics-glasses; axes independent) ----
class KF1D {
  constructor(p, rPos, sigmaA) {
    this.p = p; this.v = 0;
    this.r2 = rPos * rPos; this.sa2 = sigmaA * sigmaA;
    this.Ppp = rPos * rPos * 4; this.Ppv = 0; this.Pvv = 1e6;
  }
  predict(dt) {
    this.p += this.v * dt;
    const { Ppp, Ppv, Pvv, sa2 } = this;
    this.Ppp = Ppp + 2 * Ppv * dt + Pvv * dt * dt + sa2 * dt * dt * dt * dt / 4;
    this.Ppv = Ppv + Pvv * dt + sa2 * dt * dt * dt / 2;
    this.Pvv = Pvv + sa2 * dt * dt;
  }
  update(z) {
    const S = this.Ppp + this.r2;
    const Kp = this.Ppp / S, Kv = this.Ppv / S;
    const y = z - this.p;
    this.p += Kp * y; this.v += Kv * y;
    const { Ppp, Ppv, Pvv } = this;
    this.Ppp = (1 - Kp) * Ppp;
    this.Ppv = (1 - Kp) * Ppv;
    this.Pvv = Pvv - Kv * Ppv;
  }
}
function makeKF(x, y) {
  const rPos = vw * 0.008;
  const sigmaA = vw * 1.6;
  return { x: new KF1D(x, rPos, sigmaA), y: new KF1D(y, rPos, sigmaA) };
}

// ---------------------------------------------------------------- mode module
export default {
  id: "projectile",
  title: "Projectile · speed & range",
  icon: "⚾",
  family: "Learn",
  permissions: ["camera"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    store = svc.storage.scope("projectile");
    root.innerHTML = `
      <video data-el="video" playsinline muted autoplay
        style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000;"></video>
      <div class="pillRow">
        <div class="pill" data-el="pillCam"><span class="dot"></span>CAM</div>
        <div class="pill" data-el="pillModel"><span class="dot"></span>MODEL</div>
        <div class="pill" data-el="pillTrack"><span class="dot"></span>TRACK</div>
      </div>
      <div style="position:absolute; top:10px; right:12px; z-index:20; display:flex; gap:8px;">
        <button class="ghostBtn accent" data-el="calBtn">Calibrate</button>
        <button class="ghostBtn" data-el="resetBtn">Reset</button>
      </div>
      <div class="hintLine hidden" data-el="hint" style="top:60px;"></div>
      <div class="gatePanel" data-el="calPanel" style="display:none; background:rgba(6,8,15,0.55); z-index:26;">
        <p style="color:var(--text); font-weight:600;">Real length between the two marks?</p>
        <div style="display:flex; align-items:center; gap:10px;">
          <input type="number" data-el="calInput" min="0.01" max="100" step="0.01" value="1.00" inputmode="decimal">
          <span style="color:var(--dim); font-size:13px;">metres</span>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="bigBtn" data-el="calSet" style="padding:10px 28px; font-size:14px;">Set scale</button>
          <button class="ghostBtn" data-el="calCancel">Cancel</button>
        </div>
      </div>
      <div class="readout">
        <div class="statRow">
          <div class="stat"><div class="v big" data-el="statSpeed">—</div><div class="l">launch · m/s</div></div>
          <div class="stat"><div class="v big" data-el="statAngle">—</div><div class="l">angle · °</div></div>
          <div class="stat"><div class="v" data-el="statPeak">—</div><div class="l">peak · m</div></div>
          <div class="stat"><div class="v" data-el="statRange">—</div><div class="l">range · m</div></div>
        </div>
        <div class="statRow" style="margin-top:8px;">
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statLive">—</div><div class="l">live speed</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statClass">—</div><div class="l">target</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statScale">—</div><div class="l">scale</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statFps">—</div><div class="l">fps</div></div>
        </div>
        <div class="noteLine" data-el="note">Camera estimates are approximate.</div>
      </div>
      <div class="gatePanel" data-el="gate">
        <p>Throw or roll a ball across the view — on-device ML (COCO-SSD + Kalman) tracks it and
           a physics fit estimates launch speed, angle, peak height, and range.
           All processing stays on this device.</p>
        <button class="bigBtn" data-el="startBtn">Start camera</button>
        <p class="err" data-el="gateErr"></p>
      </div>`;
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    video = els.video;
    overlay = svc.overlay.createCanvas(root);
    root.insertBefore(overlay, els.hint); // above video, below HUD panels
    octx = overlay.getContext("2d");
    detectCanvas = document.createElement("canvas");
    dctx = detectCanvas.getContext("2d", { willReadFrequently: true });

    els.startBtn.addEventListener("click", onStartClick);
    els.calBtn.addEventListener("click", toggleCalibrate);
    els.resetBtn.addEventListener("click", resetThrow);
    els.calSet.addEventListener("click", commitCalibration);
    els.calCancel.addEventListener("click", () => {
      calib.mode = false; calib.pts = [];
      els.calPanel.style.display = "none";
      els.calBtn.textContent = "Calibrate";
      updateHint();
    });
    overlay.addEventListener("pointerdown", onTap);
    onResize = () => svc.overlay.fit2d(overlay);
    window.addEventListener("resize", onResize);

    loadModel(); // async; the Start button stays instant
  },

  async start() {
    running = true;
    lastFrameT = 0;
    rafId = requestAnimationFrame(render);
    if (stream && !detectLoopActive) detectLoop();
  },

  stop() {
    running = false;
    cancelAnimationFrame(rafId);
  },

  teardown() {
    this.stop();
    if (stream) { svc.sensors.releaseStream(stream); stream = null; }
    if (model && model.dispose) { try { model.dispose(); } catch (e) {} }
    model = null; modelState = "idle";
    if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
    latest = []; target = null; trail = []; throwPts = []; throwState = "idle";
    lastThrow = null; vw = vh = 0;
    els = {}; root = null;
  },

  getContext() {
    if (lastThrow) {
      const t = lastThrow;
      return `Projectile experiment. Last throw: launch speed ≈ ${t.v0.toFixed(1)} m/s, ` +
        `angle ≈ ${Math.round(t.angleDeg)}°, peak height ≈ ${t.peak.toFixed(1)} m, ` +
        `range ≈ ${t.range.toFixed(1)} m (camera estimate, approximate${t.rough ? ", low confidence" : ""}).`;
    }
    if (!stream && vw === 0) return "Opened the projectile experiment; camera not started yet.";
    if (!calib.ppm) return "In the projectile experiment; camera running but not calibrated yet — no throws measured.";
    return "In the projectile experiment, calibrated and waiting for a throw to track.";
  },

  // ---------------- verification hooks (synthetic driving — no camera needed) ----------------
  _state: () => ({
    modelState, running, ppm: calib.ppm, throwState,
    points: throwPts.length,
    targetClass: target ? target.class : null,
    speedPx: target ? Math.hypot(target.kfx.v, target.kfy.v) : 0,
    lastThrow,
  }),
  _synthetic(w, h) { vw = w; vh = h; synthNow = performance.now(); }, // dims + synthetic clock
  _setCalibration(ppm) { calib.ppm = ppm; persistCalibration(); refreshScale(); },
  // Inject a detection with an explicit dt: advances a SYNTHETIC clock (a tight
  // test loop is faster than real time) and runs the same predict/update cycle
  // the render+detector pair performs.
  _injectDetection(cx, cy, dt) {
    synthNow += (dt || 0.033) * 1000;
    const d = { cx, cy, x: cx - 20, y: cy - 20, w: 40, h: 40, class: AUTO_CLASS, score: 0.9, t: synthNow };
    latest = [d];
    if (target && dt > 0) { target.kfx.predict(dt); target.kfy.predict(dt); }
    associate([d], synthNow);
    if (target) throwTick(target.kfx.p, target.kfy.p, dt || 0.033, synthNow);
  },
  _endThrow() { finishThrow(); return lastThrow; },
};

// ---------------------------------------------------------------- model (vendored, no CDN)
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("script failed: " + src));
    document.head.appendChild(s);
  });
}

async function loadModel() {
  modelState = "loading";
  setPill(els.pillModel, "wait");
  try {
    if (!window.tf) await loadScript(new URL("../vendor/tfjs/tf.min.js", import.meta.url).href);
    if (!window.cocoSsd) await loadScript(new URL("../vendor/tfjs/coco-ssd.min.js", import.meta.url).href);
    model = await window.cocoSsd.load({
      base: "lite_mobilenet_v2",
      modelUrl: new URL("../vendor/models/coco-ssd-lite/model.json", import.meta.url).href,
    });
    modelState = "ready";
    setPill(els.pillModel, "ok");
    if (running && stream && !detectLoopActive) detectLoop();
  } catch (err) {
    console.error("COCO-SSD failed to load:", err);
    modelState = "failed";
    setPill(els.pillModel, "err");
    setHint("Object-detection model failed to load — reload and try again.");
  }
}

// ---------------------------------------------------------------- camera (shared service)
async function onStartClick() {
  els.startBtn.disabled = true;
  setPill(els.pillCam, "wait");
  try {
    stream = await svc.sensors.requestCamera({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    vw = video.videoWidth; vh = video.videoHeight;
    setPill(els.pillCam, "ok");
    els.gate.style.display = "none";
    loadCalibration();
    updateHint();
    if (!detectLoopActive) detectLoop();
  } catch (err) {
    console.error("Camera failed:", err);
    setPill(els.pillCam, "err");
    els.gateErr.style.display = "block";
    els.gateErr.textContent = err && err.name === "NotAllowedError"
      ? "Camera permission denied. Allow camera access for this site (iOS: Settings → Safari → Camera), then reload."
      : "Could not open the rear camera (" + (err && err.name || err) + ").";
  } finally {
    els.startBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- detection loop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function detectLoop() {
  if (detectLoopActive) return;
  detectLoopActive = true;
  while (running && modelState === "ready" && stream) {
    if (!video.videoWidth || video.readyState < 2 || document.hidden) { await sleep(150); continue; }
    vw = video.videoWidth; vh = video.videoHeight;
    detectCanvas.width = DETECT_W;
    detectCanvas.height = Math.round(DETECT_W * vh / vw);
    dctx.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);
    let preds = [];
    try {
      preds = await model.detect(detectCanvas, 20, SCORE_MIN);
    } catch (err) {
      console.error("detect() failed:", err);
      await sleep(500);
      continue;
    }
    const now = performance.now();
    const k = vw / detectCanvas.width;
    latest = preds.map((p) => ({
      x: p.bbox[0] * k, y: p.bbox[1] * k, w: p.bbox[2] * k, h: p.bbox[3] * k,
      cx: (p.bbox[0] + p.bbox[2] / 2) * k, cy: (p.bbox[1] + p.bbox[3] / 2) * k,
      class: p.class, score: p.score, t: now,
    }));
    associate(latest, now);
    await sleep(0);
  }
  detectLoopActive = false;
}

// Nearest same-class detection within a gate, or acquire the ball class.
function associate(dets, now) {
  if (target) {
    const gate = Math.max(vw * 0.18, 5 * Math.sqrt(target.kfx.Ppp + target.kfx.r2));
    let best = null, bestD = gate;
    for (const d of dets) {
      if (d.class !== target.class) continue;
      const dist = Math.hypot(d.cx - target.kfx.p, d.cy - target.kfy.p);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) {
      if (now - target.lastMeas > LOST_S * 1000) {
        const kf = makeKF(best.cx, best.cy); // re-acquired: restart the filter
        target.kfx = kf.x; target.kfy = kf.y;
        trail = [];
        finishThrow(); // a gap this long ends any throw in progress
      } else {
        target.kfx.update(best.cx);
        target.kfy.update(best.cy);
      }
      target.lastMeas = now;
    } else if (now - target.lastMeas > REACQ_S * 1000) {
      target = null; trail = [];
      finishThrow();
      updateHint();
    }
    if (target) return;
  }
  let best = null;
  for (const d of dets) if (d.class === AUTO_CLASS && d.score >= AUTO_SCORE && (!best || d.score > best.score)) best = d;
  if (best) acquire(best);
}

function acquire(d) {
  const kf = makeKF(d.cx, d.cy);
  target = { class: d.class, kfx: kf.x, kfy: kf.y, lastMeas: d.t || performance.now() };
  trail = [];
  updateHint();
}

// ---------------------------------------------------------------- throw segmentation + fit
function throwTick(x, y, dt, nowMs) {
  if (!calib.ppm) return; // metres require calibration — honest gating
  const speedMs = Math.hypot(target.kfx.v, target.kfy.v) / calib.ppm;
  if (throwState === "idle") {
    if (speedMs > THROW_START_MS) {
      throwState = "tracking";
      throwPts = [{ x, y, t: nowMs / 1000 }];
      slowSince = 0;
    }
    return;
  }
  throwPts.push({ x, y, t: nowMs / 1000 });
  if (speedMs < THROW_END_MS) {
    if (!slowSince) slowSince = nowMs;
    else if (nowMs - slowSince > THROW_END_HOLD_S * 1000) { finishThrow(); return; }
  } else {
    slowSince = 0;
  }
  if (throwPts.length && (nowMs / 1000 - throwPts[0].t) > THROW_MAX_S) finishThrow();
}

function finishThrow() {
  if (throwState !== "tracking") return;
  throwState = "idle";
  const pts = throwPts;
  throwPts = [];
  slowSince = 0;
  if (!calib.ppm || pts.length < FIT_MIN_POINTS) return;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < FIT_MIN_SPAN_S) return;

  // Metres, y up, origin at the first point.
  const t0 = pts[0].t, x0 = pts[0].x, y0 = pts[0].y;
  const P = pts.map((p) => ({
    t: p.t - t0,
    x: (p.x - x0) / calib.ppm,
    y: -(p.y - y0) / calib.ppm,
  }));

  // vx: least-squares slope of x(t).
  const n = P.length;
  let st = 0, sx = 0, stt = 0, stx = 0;
  for (const p of P) { st += p.t; sx += p.x; stt += p.t * p.t; stx += p.t * p.x; }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-9) return;
  const vx = (n * stx - st * sx) / den;

  // vy0 with g FIXED: z = y + g/2 t² should be linear (z = y0 + vy0 t).
  let sz = 0, stz = 0;
  for (const p of P) { const z = p.y + (G / 2) * p.t * p.t; sz += z; stz += p.t * z; }
  const vy0 = (n * stz - st * sz) / den;
  const b0 = (sz - vy0 * st) / n;

  // R² of the y fit (against the fixed-g model) — the robustness gate.
  let ssRes = 0, ssTot = 0;
  const yMean = P.reduce((a, p) => a + p.y, 0) / n;
  for (const p of P) {
    const yHat = b0 + vy0 * p.t - (G / 2) * p.t * p.t;
    ssRes += (p.y - yHat) ** 2;
    ssTot += (p.y - yMean) ** 2;
  }
  const r2 = ssTot > 1e-9 ? 1 - ssRes / ssTot : 1;

  const v0 = Math.hypot(vx, vy0);
  if (v0 < 0.5) return; // not a throw
  const angleDeg = Math.atan2(vy0, Math.abs(vx)) * 180 / Math.PI;
  const peak = vy0 > 0 ? (vy0 * vy0) / (2 * G) : 0;
  const range = vy0 > 0
    ? Math.abs(vx) * (2 * vy0 / G)                       // back to launch height
    : Math.abs(P[n - 1].x - P[0].x);                     // rolled/desc.: measured span
  lastThrow = {
    v0, angleDeg, peak, range,
    r2: Math.max(0, Math.min(1, r2)),
    rough: r2 < FIT_MIN_R2,
    at: Date.now(),
    path: pts.map((p) => ({ x: p.x, y: p.y })), // video px, for the overlay
  };
  refreshThrowReadout();
}

function resetThrow() {
  lastThrow = null;
  throwPts = [];
  throwState = "idle";
  target = null;
  trail = [];
  refreshThrowReadout();
  updateHint();
}

function refreshThrowReadout() {
  if (!els.statSpeed) return;
  if (lastThrow) {
    els.statSpeed.textContent = lastThrow.v0.toFixed(1);
    els.statAngle.textContent = String(Math.round(lastThrow.angleDeg));
    els.statPeak.textContent = lastThrow.peak.toFixed(1);
    els.statRange.textContent = lastThrow.range.toFixed(1);
    els.note.textContent = lastThrow.rough
      ? "≈ Rough estimate (noisy track) — steadier camera and better light help."
      : "≈ Approximate camera estimates for the last throw, in the calibrated plane.";
  } else {
    els.statSpeed.textContent = "—";
    els.statAngle.textContent = "—";
    els.statPeak.textContent = "—";
    els.statRange.textContent = "—";
    els.note.textContent = calib.ppm
      ? "Throw or roll a ball across the view — estimates appear after the throw."
      : "Camera estimates are approximate. Calibrate a known length first for metres.";
  }
}

// ---------------------------------------------------------------- calibration (persisted)
function toggleCalibrate() {
  calib.mode = !calib.mode;
  calib.pts = [];
  els.calPanel.style.display = "none";
  els.calBtn.textContent = calib.mode ? "Cancel calibration" : "Calibrate";
  updateHint();
}

function commitCalibration() {
  const metres = parseFloat(els.calInput.value);
  if (!(metres > 0) || calib.pts.length !== 2) return;
  const distPx = Math.hypot(calib.pts[0].x - calib.pts[1].x, calib.pts[0].y - calib.pts[1].y);
  if (distPx < 10) { setHint("Marks are too close together — tap two points farther apart."); return; }
  calib.ppm = distPx / metres;
  calib.mode = false; calib.pts = [];
  els.calPanel.style.display = "none";
  els.calBtn.textContent = "Calibrate";
  persistCalibration();
  refreshScale();
  updateHint();
}

function persistCalibration() { store.set("calibration", { ppm: calib.ppm, vw, ts: Date.now() }); }
function loadCalibration() {
  const saved = store.get("calibration");
  if (saved && saved.ppm > 0 && saved.vw > 0 && vw) {
    calib.ppm = saved.ppm * (vw / saved.vw); // rescale if the resolution changed
  }
  refreshScale();
}
function refreshScale() {
  if (!els.statScale) return;
  els.statScale.textContent = calib.ppm ? `${Math.round(calib.ppm)} px/m` : "—";
  refreshThrowReadout();
}

function updateHint() {
  if (calib.mode) setHint(calib.pts.length === 0
    ? "Tap the two ends of a known length in the throw plane (a metre stick, a door…)."
    : "Tap the second end of the known length.");
  else if (stream && !calib.ppm) setHint("Calibrate first: tap Calibrate and mark a known length.");
  else if (!target && stream) setHint(`Waiting for a ${AUTO_CLASS} — or tap any detected object to track it.`);
  else setHint("");
}

// ---------------------------------------------------------------- taps
function onTap(e) {
  if (!vw) return;
  const v = screenToVideo(e.clientX, e.clientY);
  if (!v) return;
  if (calib.mode) {
    calib.pts.push(v);
    if (calib.pts.length === 2) {
      els.calPanel.style.display = "flex";
      els.calInput.focus();
    }
    updateHint();
    return;
  }
  let best = null;
  for (const d of latest) {
    const inside = v.x >= d.x && v.x <= d.x + d.w && v.y >= d.y && v.y <= d.y + d.h;
    const near = Math.hypot(d.cx - v.x, d.cy - v.y) < vw * 0.05;
    if ((inside || near) && (!best || d.w * d.h < best.w * best.h)) best = d;
  }
  if (best) acquire(best);
}

// ---------------------------------------------------------------- coords (object-fit: cover)
function coverTransform() {
  if (!vw || !vh) return null;
  const dw = overlay.clientWidth, dh = overlay.clientHeight;
  const s = Math.max(dw / vw, dh / vh);
  return { s, ox: (dw - vw * s) / 2, oy: (dh - vh * s) / 2 };
}
function videoToScreen(x, y) {
  const t = coverTransform();
  return t ? { x: x * t.s + t.ox, y: y * t.s + t.oy } : null;
}
function screenToVideo(x, y) {
  const t = coverTransform();
  if (!t) return null;
  const r = overlay.getBoundingClientRect();
  const x2 = (x - r.left - t.ox) / t.s, y2 = (y - r.top - t.oy) / t.s;
  if (x2 < 0 || y2 < 0 || x2 > vw || y2 > vh) return null;
  return { x: x2, y: y2 };
}

// ---------------------------------------------------------------- render loop
function render(nowMs) {
  if (!running) return;
  rafId = requestAnimationFrame(render);
  const { g, w, h } = svc.overlay.fit2d(overlay);
  g.clearRect(0, 0, w, h);
  if (!vw) return;

  if (lastFrameT) {
    const inst = 1000 / (nowMs - lastFrameT);
    fpsEma = fpsEma ? fpsEma + 0.08 * (inst - fpsEma) : inst;
  }
  const dt = lastFrameT ? (nowMs - lastFrameT) / 1000 : 0;
  lastFrameT = nowMs;

  const sinceMeas = target ? (nowMs - target.lastMeas) / 1000 : Infinity;
  if (target && dt > 0 && dt < 0.5 && sinceMeas < LOST_S && stream) {
    target.kfx.predict(dt);
    target.kfy.predict(dt);
    trail.push({ x: target.kfx.p, y: target.kfy.p, t: nowMs });
    throwTick(target.kfx.p, target.kfy.p, dt, nowMs);
  }
  while (trail.length && nowMs - trail[0].t > TRAIL_S * 1000) trail.shift();

  drawDetections(g, nowMs);
  drawCalibration(g);
  drawLastThrowPath(g);
  if (target && sinceMeas < LOST_S) drawTarget(g, nowMs, sinceMeas);

  if (target && sinceMeas < LOST_S) setPill(els.pillTrack, "ok");
  else if (target) setPill(els.pillTrack, "wait");
  else setPill(els.pillTrack, stream ? "wait" : "");

  // live speed
  if (target && sinceMeas < LOST_S) {
    const spPx = Math.hypot(target.kfx.v, target.kfy.v);
    els.statLive.textContent = calib.ppm ? (spPx / calib.ppm).toFixed(1) + " m/s" : Math.round(spPx) + " px/s";
    els.statClass.textContent = target.class + (sinceMeas > 0.2 ? " (predicting)" : "");
  } else {
    els.statLive.textContent = "—";
    els.statClass.textContent = target ? target.class + " (lost)" : "—";
  }
  els.statFps.textContent = fpsEma ? String(Math.round(fpsEma)) : "—";
}

function drawDetections(g, nowMs) {
  for (const d of latest) {
    if (nowMs - d.t > 600) continue;
    const a = videoToScreen(d.x, d.y), b = videoToScreen(d.x + d.w, d.y + d.h);
    if (!a || !b) continue;
    const isTarget = target && d.class === target.class &&
      Math.hypot(d.cx - target.kfx.p, d.cy - target.kfy.p) < vw * 0.1;
    g.strokeStyle = isTarget ? "rgba(77,163,255,0.95)" : "rgba(232,238,252,0.35)";
    g.lineWidth = isTarget ? 2.5 : 1.5;
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.fillStyle = isTarget ? "rgba(77,163,255,0.95)" : "rgba(232,238,252,0.5)";
    g.font = "11px " + svc.overlay.cssVar("--mono");
    g.fillText(`${d.class} ${(d.score * 100) | 0}%`, a.x + 3, a.y - 5);
  }
}

function drawCalibration(g) {
  if (!calib.mode && !calib.pts.length) return;
  g.strokeStyle = "#ffb347";
  g.fillStyle = "#ffb347";
  g.lineWidth = 2;
  const pts = calib.pts.map((p) => videoToScreen(p.x, p.y)).filter(Boolean);
  for (const p of pts) {
    g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(p.x, p.y, 2, 0, Math.PI * 2); g.fill();
  }
  if (pts.length === 2) {
    g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(pts[0].x, pts[0].y); g.lineTo(pts[1].x, pts[1].y); g.stroke();
    g.setLineDash([]);
  }
}

// The completed throw's tracked arc, faded gold — stays until Reset/next throw.
function drawLastThrowPath(g) {
  if (!lastThrow || !lastThrow.path || lastThrow.path.length < 2) return;
  g.strokeStyle = "rgba(255, 209, 102, 0.55)";
  g.lineWidth = 2;
  g.setLineDash([7, 6]);
  g.beginPath();
  let started = false;
  for (const p of lastThrow.path) {
    const s = videoToScreen(p.x, p.y);
    if (!s) continue;
    if (!started) { g.moveTo(s.x, s.y); started = true; }
    else g.lineTo(s.x, s.y);
  }
  g.stroke();
  g.setLineDash([]);
}

function drawTarget(g, nowMs, sinceMeas) {
  const t = coverTransform();
  const p = videoToScreen(target.kfx.p, target.kfy.p);
  if (!p || !t) return;
  const predicting = sinceMeas > 0.2;

  for (let i = 1; i < trail.length; i++) {
    const a = videoToScreen(trail[i - 1].x, trail[i - 1].y), b = videoToScreen(trail[i].x, trail[i].y);
    if (!a || !b) continue;
    const age = (nowMs - trail[i].t) / (TRAIL_S * 1000);
    g.strokeStyle = `rgba(77, 163, 255, ${(1 - age) * 0.85})`;
    g.lineWidth = 3.5 * (1 - age) + 1;
    g.lineCap = "round";
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }

  const speed = Math.hypot(target.kfx.v, target.kfy.v);
  if (speed > vw * 0.03) {
    const ex = p.x + target.kfx.v * 0.25 * t.s, ey = p.y + target.kfy.v * 0.25 * t.s;
    const ang = Math.atan2(ey - p.y, ex - p.x);
    g.strokeStyle = "#3ddc84"; g.fillStyle = "#3ddc84";
    g.lineWidth = 3; g.lineCap = "round";
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(ex, ey); g.stroke();
    g.beginPath();
    g.moveTo(ex, ey);
    g.lineTo(ex - 11 * Math.cos(ang - 0.45), ey - 11 * Math.sin(ang - 0.45));
    g.lineTo(ex - 11 * Math.cos(ang + 0.45), ey - 11 * Math.sin(ang + 0.45));
    g.closePath(); g.fill();
  }

  g.strokeStyle = "#ffffff";
  g.lineWidth = 2.5;
  if (predicting) g.setLineDash([5, 4]);
  g.beginPath(); g.arc(p.x, p.y, 14, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2);
  g.fillStyle = "#ffffff"; g.fill();
}
