// Pendulum — the REFERENCE native mode, proving the Reality Engine mode API end-to-end.
// Ported from physics-glasses phase 1. Swing the phone on a string: the gyroscope
// rotation rate oscillates at the pendulum frequency. Autocorrelation on the dominant
// axis gives the period T; with the user's length L, g = 4π²L/T². Method inspired by
// phyphox's pendulum experiment (GPLv3 — method referenced only, no code reused).
//
// Uses the shared services: sensors (permission-gated DeviceMotion), overlay (canvas),
// storage (remembers L). Implements getContext() for the future AI companion.

const G_REF = 9.81; // m/s², for the theoretical-period comparison

const BUFFER_S = 15;        // raw sample retention
const WINDOW_S = 8;         // analysis window
const RESAMPLE_HZ = 50;     // uniform grid for autocorrelation
const MIN_LAG_S = 0.25, MAX_LAG_S = 4; // period search range (0.25–4 s ≈ L of 1.5 cm–4 m)
const GYRO_RMS_MIN = 8;     // deg/s — below this we call it "not swinging"
const ACCEL_RMS_MIN = 0.35; // m/s² — fallback threshold
const AC_PEAK_MIN = 0.35;   // normalized autocorrelation quality gate
const HISTORY_N = 6;        // period estimates kept for the lock check
const LOCK_SPREAD = 0.08;   // (max-min)/median must be under this to lock

let root, svc, store, els = {};
let offMotion = null;   // unsubscribe from the sensors service
let enabled = false;    // permission granted at least once
let running = false;
let analysisTimer = 0;
let rafId = 0;
let samples = [];      // {t (s), r: [rx,ry,rz] deg/s | null, a: [ax,ay,az] m/s² | null}
let periodHistory = [];
let state = {          // exposed via _state() for verification
  source: null,        // "gyro" | "accel"
  axis: 0,
  rms: 0,
  swinging: false,
  locked: false,
  T: null,             // measured period, s
  g: null,             // computed gravity, m/s²
};

function setPill(el, cls) { el.className = "pill" + (cls ? " " + cls : ""); }

// ---------------------------------------------------------------- mode module
export default {
  id: "pendulum",
  title: "Pendulum · period & g",
  icon: "🪀",
  family: "Physics",
  permissions: ["motion"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    store = svc.storage.scope("pendulum");
    root.innerHTML = `
      <div class="pillRow">
        <div class="pill" data-el="pillMotion"><span class="dot"></span>MOTION</div>
        <div class="pill" data-el="pillSwing"><span class="dot"></span>SWING</div>
      </div>
      <div class="hintLine hidden" data-el="hint" style="top:64px;"></div>
      <div class="readout">
        <div class="statRow">
          <div class="stat"><div class="v big" data-el="statT">—</div><div class="l">period T · s</div></div>
          <div class="stat"><div class="v big" data-el="statG">—</div><div class="l">g · m/s²</div></div>
          <div class="stat"><div class="v" data-el="statDelta">—</div><div class="l">Δ vs theory</div></div>
        </div>
        <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-top:10px;">
          <label style="font-size:12px; color:var(--dim);">length L</label>
          <input type="number" data-el="lenInput" min="0.05" max="30" step="0.01" inputmode="decimal">
          <span style="font-size:12px; color:var(--dim);">m</span>
          <span style="font-size:12px; color:var(--dim); margin-left:8px;"
            >theory T = <span data-el="statTTheory" style="font-family:var(--mono); color:var(--text);">—</span> s</span>
        </div>
        <div class="noteLine" data-el="note">Real units: seconds and m/s², measured from the motion sensor.</div>
      </div>
      <div class="gatePanel" data-el="gate">
        <p>Tie the phone to a string (or tape it to a pendulum) and let it swing.
           The gyroscope measures the oscillation — no camera needed.</p>
        <button class="bigBtn" data-el="enableBtn">Enable motion</button>
        <p class="err" data-el="gateErr"></p>
      </div>`;
    // Graph canvas under the HUD, via the overlay service.
    els.graph = svc.overlay.createCanvas(root);
    root.insertBefore(els.graph, root.firstChild);
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;

    const savedL = parseFloat(store.get("L"));
    els.lenInput.value = (savedL > 0 ? savedL : 1.0).toFixed(2);
    els.lenInput.addEventListener("input", () => {
      const L = parseFloat(els.lenInput.value);
      if (L > 0) store.set("L", L);
      updateReadout();
    });
    updateReadout(); // show theory T for the saved length immediately

    els.enableBtn.addEventListener("click", async () => {
      els.enableBtn.disabled = true;
      try {
        await svc.sensors.requestMotion(); // iOS gesture-gated, handled by the service
        enabled = true;
        els.gate.style.display = "none";
        beginListening();
      } catch (err) {
        els.gateErr.style.display = "block";
        els.gateErr.textContent = "Motion access denied. Allow Motion & Orientation access for this site in Settings → Safari, then reload.";
      }
      els.enableBtn.disabled = false;
    });
  },

  async start() {
    running = true;
    if (enabled && !offMotion) beginListening(); // re-attach after a stop()
    rafId = requestAnimationFrame(drawGraph);
    if (!analysisTimer) analysisTimer = setInterval(analyze, 500);
  },

  stop() {
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(analysisTimer);
    analysisTimer = 0;
    if (offMotion) { offMotion(); offMotion = null; }
  },

  teardown() {
    this.stop();
    enabled = false;
    samples = [];
    periodHistory = [];
    state = { source: null, axis: 0, rms: 0, swinging: false, locked: false, T: null, g: null };
    els = {};
    root = null;
  },

  // What the future AI companion reads — a short natural-language description of
  // what the user is doing/seeing right now.
  getContext() {
    if (!enabled) return "Opened the pendulum experiment; motion access is not enabled yet.";
    if (!state.swinging) return "In the pendulum experiment, waiting for the phone to swing on a string.";
    if (!state.T) return "Measuring a pendulum's period from the phone's motion sensor.";
    const L = parseFloat(els.lenInput && els.lenInput.value);
    let s = `Measuring a pendulum: period T ≈ ${state.T.toFixed(2)} s`;
    if (state.g) s += `, computed g ≈ ${state.g.toFixed(2)} m/s² with length ${L.toFixed(2)} m`;
    s += state.locked ? " (reading locked)." : " (still settling).";
    return s;
  },

  _state: () => ({ ...state, samples: samples.length }), // verification hook
};

// ---------------------------------------------------------------- sensor plumbing
function beginListening() {
  if (offMotion) offMotion();
  offMotion = svc.sensors.onMotion(onMotion);
  setPill(els.pillMotion, "wait");
  setTimeout(() => {
    if (offMotion && samples.length === 0 && els.pillMotion) {
      setPill(els.pillMotion, "err");
      setHint("No motion data arriving — this mode needs a phone with motion sensors.");
    }
  }, 3000);
}

function onMotion(e) {
  const t = performance.now() / 1000;
  const r = e.rotationRate && e.rotationRate.beta !== null
    ? [e.rotationRate.alpha || 0, e.rotationRate.beta || 0, e.rotationRate.gamma || 0] : null;
  const a = e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null
    ? [e.accelerationIncludingGravity.x, e.accelerationIncludingGravity.y, e.accelerationIncludingGravity.z] : null;
  if (!r && !a) return;
  samples.push({ t, r, a });
  const cutoff = t - BUFFER_S;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  if (samples.length === 1) setPill(els.pillMotion, "ok");
}

function setHint(text) {
  els.hint.textContent = text || "";
  els.hint.classList.toggle("hidden", !text);
}

// ---------------------------------------------------------------- analysis
// Dominant-axis pick → uniform resample → normalized autocorrelation → refined peak.
function analyze() {
  if (!samples.length || samples[samples.length - 1].t - samples[0].t < 4) return;

  const useGyro = samples[samples.length - 1].r !== null;
  const get = useGyro ? (s) => s.r : (s) => s.a;
  const rmsMin = useGyro ? GYRO_RMS_MIN : ACCEL_RMS_MIN;
  state.source = useGyro ? "gyro" : "accel";

  const t1 = samples[samples.length - 1].t;
  const win = samples.filter((s) => s.t >= t1 - WINDOW_S && get(s));
  if (win.length < 40) return;

  // Dominant axis = greatest variance.
  const means = [0, 0, 0], vars = [0, 0, 0];
  for (const s of win) for (let i = 0; i < 3; i++) means[i] += get(s)[i];
  for (let i = 0; i < 3; i++) means[i] /= win.length;
  for (const s of win) for (let i = 0; i < 3; i++) vars[i] += (get(s)[i] - means[i]) ** 2;
  const axis = vars.indexOf(Math.max(...vars));
  state.axis = axis;
  state.rms = Math.sqrt(vars[axis] / win.length);

  if (state.rms < rmsMin) { // not swinging
    state.swinging = false;
    state.locked = false;
    periodHistory = [];
    setPill(els.pillSwing, "wait");
    setHint("Waiting for a swing — set the pendulum moving gently.");
    updateReadout();
    return;
  }
  state.swinging = true;
  setHint("");

  // Uniform resample (linear interpolation) of the mean-removed dominant axis.
  const n = Math.floor(WINDOW_S * RESAMPLE_HZ);
  const dt = 1 / RESAMPLE_HZ;
  const x = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t1 - WINDOW_S + i * dt;
    while (j < win.length - 2 && win[j + 1].t < t) j++;
    const a = win[j], b = win[Math.min(j + 1, win.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    x[i] = (get(a)[axis] + f * (get(b)[axis] - get(a)[axis])) - means[axis];
  }

  // Normalized autocorrelation over the period search range.
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (e0 === 0) return;
  const kMin = Math.round(MIN_LAG_S * RESAMPLE_HZ);
  const kMax = Math.min(Math.round(MAX_LAG_S * RESAMPLE_HZ), n - 10);
  const ac = new Float64Array(kMax + 1);
  for (let k = kMin; k <= kMax; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += x[i] * x[i + k];
    ac[k] = s / e0 * (n / (n - k)); // bias-correct shorter overlap
  }
  let kBest = -1, vBest = AC_PEAK_MIN;
  for (let k = kMin + 1; k < kMax; k++) {
    if (ac[k] > vBest && ac[k] >= ac[k - 1] && ac[k] >= ac[k + 1]) { vBest = ac[k]; kBest = k; }
  }
  if (kBest < 0) { setPill(els.pillSwing, "wait"); updateReadout(); return; }

  // Subharmonic guard (octave-error correction): the bias-corrected autocorrelation can
  // favor the 2T peak on a very clean signal. If half the chosen lag is also a strong
  // local peak, the true period is there.
  const kHalf = Math.round(kBest / 2);
  if (kHalf >= kMin + 1 && kHalf + 1 <= kMax) {
    let kh = kHalf, vh = -Infinity;
    for (let k = Math.max(kMin + 1, kHalf - 2); k <= Math.min(kMax - 1, kHalf + 2); k++) {
      if (ac[k] > vh) { vh = ac[k]; kh = k; }
    }
    if (vh >= 0.85 * vBest && ac[kh] >= ac[kh - 1] && ac[kh] >= ac[kh + 1]) { kBest = kh; vBest = vh; }
  }

  // Parabolic sub-sample refinement.
  const y0 = ac[kBest - 1], y1 = ac[kBest], y2 = ac[kBest + 1];
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const T = (kBest + Math.max(-0.5, Math.min(0.5, offset))) * dt;

  periodHistory.push(T);
  if (periodHistory.length > HISTORY_N) periodHistory.shift();
  const sorted = [...periodHistory].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = (sorted[sorted.length - 1] - sorted[0]) / median;
  state.locked = periodHistory.length >= 3 && spread < LOCK_SPREAD;
  state.T = state.locked ? median : T;
  setPill(els.pillSwing, state.locked ? "ok" : "wait");
  updateReadout();
}

function updateReadout() {
  const L = parseFloat(els.lenInput.value);
  const validL = L > 0;
  els.statTTheory.textContent = validL ? (2 * Math.PI * Math.sqrt(L / G_REF)).toFixed(2) : "—";

  if (!state.swinging || !state.T) {
    els.statT.textContent = "—";
    els.statG.textContent = "—";
    els.statDelta.textContent = "—";
    state.g = null;
    els.note.textContent = state.swinging
      ? "Measuring the period…"
      : "Real units: seconds and m/s², measured from the motion sensor.";
    return;
  }
  els.statT.textContent = state.T.toFixed(2);
  els.statT.style.color = state.locked ? "var(--good)" : "var(--warn)";
  if (validL) {
    state.g = 4 * Math.PI * Math.PI * L / (state.T * state.T);
    els.statG.textContent = state.g.toFixed(2);
    const tTheory = 2 * Math.PI * Math.sqrt(L / G_REF);
    const d = (state.T - tTheory) / tTheory * 100;
    els.statDelta.textContent = (d >= 0 ? "+" : "") + d.toFixed(1) + "%";
  } else {
    state.g = null;
    els.statG.textContent = "—";
    els.statDelta.textContent = "—";
  }
  els.note.textContent = state.locked
    ? `Period locked (${state.source}). g from g = 4π²L/T² — enter L accurately (pivot to centre of mass).`
    : "Measuring the period… keep the swing steady.";
}

// ---------------------------------------------------------------- live graph
function drawGraph() {
  if (!running) return;
  rafId = requestAnimationFrame(drawGraph);
  const c = els.graph;
  if (!c) return;
  const { g, w, h } = svc.overlay.fit2d(c);
  g.clearRect(0, 0, w, h);

  const useGyro = samples.length && samples[samples.length - 1].r !== null;
  const get = useGyro ? (s) => s.r : (s) => s.a;
  const span = 8; // seconds shown
  const tNow = performance.now() / 1000;
  const view = samples.filter((s) => s.t >= tNow - span && get(s));

  // Grid.
  g.strokeStyle = "rgba(120,160,255,0.10)";
  g.lineWidth = 1;
  const mid = h * 0.44;
  for (let i = 0; i <= span; i++) {
    const gx = w - (i / span) * w;
    g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, h); g.stroke();
  }
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();

  if (view.length < 2) {
    g.fillStyle = "rgba(136,153,187,0.8)";
    g.font = "12px -apple-system, sans-serif";
    g.textAlign = "center";
    g.fillText(enabled ? "waiting for motion data…" : "enable motion to see the live signal", w / 2, mid - 8);
    return;
  }

  const axis = state.axis;
  let peak = useGyro ? 30 : 1; // minimum scale so noise doesn't fill the graph
  for (const s of view) peak = Math.max(peak, Math.abs(get(s)[axis]));
  g.strokeStyle = svc.overlay.cssVar("--sensor") || "#b48cff";
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < view.length; i++) {
    const s = view[i];
    const gx = w - ((tNow - s.t) / span) * w;
    const gy = mid - (get(s)[axis] / peak) * (h * 0.34);
    i === 0 ? g.moveTo(gx, gy) : g.lineTo(gx, gy);
  }
  g.stroke();

  g.fillStyle = "rgba(136,153,187,0.9)";
  g.font = "11px " + svc.overlay.cssVar("--mono");
  g.textAlign = "left";
  g.fillText(
    (useGyro ? "gyro rotation rate · °/s" : "accelerometer · m/s²") +
    ` · axis ${"xyz"[axis]} · ±${peak.toFixed(0)}`, 12, 18);
}
