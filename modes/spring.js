// Reality Engine · Spring Oscillation — find the spring constant.
//
// Hang the phone on a spring, set it bouncing, and the accelerometer sees a clean
// sinusoid. Count the period T and the spring constant falls out of
// k = 4π²m / T², where m is the hanging mass. Then the relationship worth seeing:
// T depends on √(m/k), so FOUR times the mass only doubles the period — and the
// amplitude doesn't enter at all, which surprises most people.
//
// THE RULE: the measurement owns the answer. Period detection is zero-crossing
// counting on the accelerometer trace — arithmetic, on this device, no model, and
// it works with the bridge switched off. The optional explanation is the only
// thing that touches the bridge and it degrades to a sentence when it's gone.
//
// HONEST LIMITS: the mass is whatever you typed in, and k scales linearly with it,
// so a bad mass estimate is a bad k by exactly the same factor. Damping means the
// measured period is fractionally longer than the ideal one. And this assumes a
// simple mass-on-spring — a real spring has its own mass, which this ignores.

const MIN_PERIOD_MS = 80;      // faster than this is noise, not a spring
const MAX_PERIOD_MS = 5000;
const SETTLE_SAMPLES = 12;     // ignore the first few while the hand lets go

let root, svc, store, els = {};
let listening = false, offMotion = null;
let trace = [];                // { t, a } recent samples for the graph
let crossings = [];            // upward zero-crossing timestamps
let periods = [];              // ms between consecutive crossings
let massKg = 0.2;              // a phone is ~0.2 kg; a slot
let sampleHz = 0, sampleCount = 0, sampleT0 = 0;
let baseline = null;           // running mean, so we detect oscillation not gravity
let noteMsg = "", explainText = "";

// ---------------------------------------------------------------- the maths
// k = 4*pi^2*m / T^2. Pure arithmetic, nothing referenced or corrected.
function springConstant(mass, periodSeconds) {
  if (!(mass > 0) || !(periodSeconds > 0)) return null;
  return (4 * Math.PI * Math.PI * mass) / (periodSeconds * periodSeconds);
}
function stats(v) {
  if (!v.length) return null;
  const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const st = v.slice().sort((a, b) => a - b);
  return { n, mean, sd, min: st[0], max: st[n - 1] };
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.z == null) return;
  sampleCount++;
  if (!sampleT0) sampleT0 = performance.now();
  else if (sampleCount % 20 === 0) sampleHz = Math.round(sampleCount / ((performance.now() - sampleT0) / 1000));
  if (sampleCount < SETTLE_SAMPLES) return;

  const now = performance.now();
  const mag = Math.hypot(a.x, a.y, a.z);
  // Track the slow mean so we measure the oscillation about it rather than the
  // constant 9.8 of gravity sitting underneath.
  baseline = baseline === null ? mag : baseline * 0.98 + mag * 0.02;
  const dev = mag - baseline;

  trace.push({ t: now, a: dev });
  if (trace.length > 240) trace.shift();

  // Upward zero-crossings, with a small deadband so noise near zero doesn't
  // manufacture crossings and halve the apparent period.
  const prev = trace[trace.length - 2];
  if (prev && prev.a <= -0.15 && dev > 0.15) {
    if (crossings.length) {
      const p = now - crossings[crossings.length - 1];
      if (p >= MIN_PERIOD_MS && p <= MAX_PERIOD_MS) periods.push(p);
      if (periods.length > 40) periods.shift();
    }
    crossings.push(now);
    if (crossings.length > 41) crossings.shift();
    render();
  }
}

async function startListening() {
  if (listening) return "Already measuring.";
  try { await svc.sensors.requestMotion(); }
  catch (err) {
    noteMsg = "Motion permission denied. On iOS it must come from a tap — a browser rule, not ours.";
    render(); return "I need motion permission for this.";
  }
  offMotion = svc.sensors.onMotion(onMotion);
  listening = true; sampleCount = 0; sampleT0 = 0; baseline = null;
  trace = []; crossings = []; periods = [];
  render();
  return `Measuring. Hang the phone on the spring and set it bouncing gently — ${massKg} kg assumed.`;
}
function stopListening() {
  if (offMotion) { offMotion(); offMotion = null; }
  listening = false;
  render();
}

export default {
  id: "spring",
  title: "Spring · period & stiffness",
  icon: "🌀",
  family: "Learn",
  permissions: ["motion"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("spring");
    massKg = Number(store.get("mass")) || 0.2;
    renderShell();
  },
  async start() {},
  stop() { stopListening(); },
  teardown() { stopListening(); els = {}; root = null; explainText = ""; },

  getContext() {
    const s = stats(periods);
    if (!s) return `Spring — nothing measured yet. Mass set to ${massKg} kg.`;
    const T = s.mean / 1000, k = springConstant(massKg, T);
    return `Spring — period ${T.toFixed(3)} s over ${s.n} cycles (spread ${(s.min / 1000).toFixed(3)}–${(s.max / 1000).toFixed(3)} s), ` +
      `mass ${massKg} kg, so the spring constant is about ${k.toFixed(1)} N/m. ` +
      `k scales directly with the mass you entered, so a wrong mass is a wrong k by the same factor.`;
  },

  getGlanceCard() {
    const s = stats(periods);
    if (!s) return null;
    const T = s.mean / 1000, k = springConstant(massKg, T);
    return {
      title: `k ≈ ${k.toFixed(1)} N/m`,
      lines: [`T = ${T.toFixed(3)} s`, `${s.n} cycles · ${massKg} kg`, `±${(s.sd / 1000).toFixed(3)} s spread`],
      spoken: `Period ${T.toFixed(2)} seconds, so the spring constant is about ${k.toFixed(0)} newtons per metre.`,
      holdMs: 9000,
    };
  },

  describeSlots() {
    return [{
      id: "mass", label: "the hanging mass", required: false,
      sources: ["utterance", "context"],
      parse: (t) => {
        const s = String(t || "").toLowerCase();
        let m = s.match(/\b(\d+(?:\.\d+)?)\s*(kg|kilo|kilos|kilograms?)\b/);
        if (m) return Math.max(0.01, Math.min(50, parseFloat(m[1])));
        m = s.match(/\b(\d+(?:\.\d+)?)\s*(g|grams?)\b/);
        if (m) return Math.max(0.01, Math.min(50, parseFloat(m[1]) / 1000));
        return null;
      },
      fromContext: () => massKg,
      current: () => null,
      default: 0.2,
      apply: (v) => { massKg = v; store && store.set("mass", v); render(); },
      say: (v) => `${v} kg on the spring`,
    }];
  },

  describeCapabilities() {
    return [{
      id: "spring.measure", label: "Spring", needsMode: true, fillsSlots: true,
      patterns: [/\b(measure|find) (the )?spring( constant| stiffness)?\b/i,
                 /\b(open|start) (the )?spring\b/i, /\bhow stiff is (this|the) spring\b/i],
      examples: ["measure the spring constant", "how stiff is this spring", "start spring with 500 grams"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?]/g, "").trim();
    if (/\b(measure|find) (the )?spring|\b(open|start) (the )?spring\b|\bhow stiff\b/.test(q)) {
      if (!listening) return startListening();
      const s = stats(periods);
      if (!s) return "Measuring — set it bouncing and give me a few cycles.";
      const T = s.mean / 1000;
      return `Period ${T.toFixed(3)} seconds over ${s.n} cycles, so k is about ${springConstant(massKg, T).toFixed(1)} newtons per metre at ${massKg} kg.`;
    }
    if (/\b(reset|clear)\b/.test(q)) { trace = []; crossings = []; periods = []; render(); return "Cleared."; }
    return null;
  },

  // ---- verification hooks ----
  _springConstant: (m, T) => springConstant(m, T),
  _periods: () => periods.slice(),
  _pushPeriod: (ms) => { periods.push(ms); render(); },
  _setMass: (m) => { massKg = m; },
};

function renderShell() {
  root.innerHTML = `
    <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      padding:14px 14px 220px; background:radial-gradient(120% 90% at 50% 0%, #16202a 0%, var(--bg) 70%);"></div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  render();
}

function render() {
  if (!els.wrap) return;
  const scroll = els.wrap.scrollTop;
  const s = stats(periods);
  const T = s ? s.mean / 1000 : null;
  const k = T ? springConstant(massKg, T) : null;
  // Sparkline of the recent trace, so you can see it really is a sinusoid.
  const pts = trace.slice(-120);
  const maxA = Math.max(0.5, ...pts.map((p) => Math.abs(p.a)));
  const path = pts.map((p, i) => `${(i / Math.max(1, pts.length - 1)) * 100},${50 - (p.a / maxA) * 45}`).join(" ");

  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px;">🌀 Spring: period &amp; stiffness</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
        Hang the phone on a spring and set it bouncing. The accelerometer sees the oscillation directly.
      </div>

      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px; text-align:center;">
        <div style="font-family:var(--mono); font-size:38px; font-weight:700; line-height:1;">
          ${k ? k.toFixed(1) : "—"} <span style="font-size:15px; color:var(--dim);">N/m</span>
        </div>
        <div style="font-size:13px; color:var(--dim); margin-top:6px;">
          ${T ? `T = ${T.toFixed(3)} s over ${s.n} cycles · ${massKg} kg` : `no cycles yet · ${massKg} kg assumed`}
        </div>
        ${s ? `<div style="font-family:var(--mono); font-size:11.5px; color:var(--dim); margin-top:8px;">
          spread ${(s.min / 1000).toFixed(3)}–${(s.max / 1000).toFixed(3)} s · sd ±${(s.sd / 1000).toFixed(3)} s</div>` : ""}
        ${pts.length > 4 ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none"
            style="width:100%; height:70px; margin-top:12px; background:rgba(255,255,255,0.03); border-radius:8px;">
            <polyline points="${path}" fill="none" stroke="#8affc0" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
          </svg>` : ""}
        <div style="font-family:var(--mono); font-size:10.5px; color:var(--dim); margin-top:8px;">
          accelerometer ~${sampleHz || "?"} Hz ${listening ? "· measuring" : "· idle"}
        </div>
      </div>

      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="bigBtn" data-el="goBtn" style="flex:1; padding:13px;">
          ${listening ? "⏹ Stop" : "▶ Enable motion &amp; measure"}</button>
        ${periods.length ? `<button class="ghostBtn" data-el="clearBtn">Clear</button>` : ""}
        ${k ? `<button class="ghostBtn" data-el="explainBtn">Explain</button>` : ""}
      </div>
      <div class="saveNote" data-el="note">${noteMsg}</div>
      ${explainText ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
        padding:12px; margin-top:10px; font-size:13px; line-height:1.6;">${escapeHtml(explainText)}</div>` : ""}

      <div style="border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,0.02);
                  padding:12px; margin-top:12px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:6px;">The surprising part</div>
        <div style="color:var(--dim); font-size:11.5px; line-height:1.6;">
          <b style="color:var(--fg)">The amplitude doesn't matter.</b> Pull it down twice as far and the period is
          identical — that's what makes a spring (and a pendulum) usable as a clock.<br><br>
          <b style="color:var(--fg)">Mass only helps by its square root.</b> T = 2π√(m/k), so to double the period you
          need <i>four times</i> the mass, not twice.<br><br>
          <b style="color:var(--fg)">What limits this reading:</b> k scales directly with the mass you entered, so a
          20% error in the mass is a 20% error in k — and it's an estimate, not a measurement. Damping makes the
          measured period slightly long. The spring's own mass is ignored here, which matters for a heavy spring and a
          light load.
        </div>
      </div>
      <div style="color:var(--dim); font-size:11px; line-height:1.5; margin:12px 2px 0;">
        iOS requires a tap to grant motion access — a browser rule. Everything here is arithmetic on this device and
        works with the bridge switched off.
      </div>
    </div>`;
  for (const el of els.wrap.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.wrap.scrollTop = scroll;
  if (els.goBtn) els.goBtn.onclick = () => (listening ? stopListening() : startListening().then((m) => { noteMsg = m; render(); }));
  if (els.clearBtn) els.clearBtn.onclick = () => { trace = []; crossings = []; periods = []; render(); };
  if (els.explainBtn) els.explainBtn.onclick = explain;
}

async function explain() {
  const s = stats(periods);
  if (!s) return;
  const T = s.mean / 1000, k = springConstant(massKg, T);
  explainText = "Asking…"; render();
  try {
    const res = await svc.companion.ask(
      `A spring with ${massKg} kg hanging on it oscillates with a period of ${T.toFixed(3)} s, giving ` +
      `k ≈ ${k.toFixed(1)} N/m. In at most 40 words, say plainly whether that is a stiff or soft spring ` +
      `and what it compares to. Do not invent numbers.`,
      "", [], { maxTokens: 110, temperature: 0.3 });
    explainText = res.ok ? res.text : "The explanation needs the bridge, which isn't reachable — the measurement above is unaffected.";
  } catch (e) {
    explainText = "The explanation needs the bridge, which isn't reachable — the measurement above is unaffected.";
  }
  render();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
