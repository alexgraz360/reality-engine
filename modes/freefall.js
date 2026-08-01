// Reality Engine · Free Fall — measure g, badly, and understand why.
//
// Toss the phone straight up (or drop it onto something soft) and it detects the
// weightless interval: while in free fall the accelerometer reads ~0 g, because
// the phone and its internal proof mass are falling together. Time that interval
// and g falls out of the kinematics.
//
// THE HONESTY THAT MAKES THIS WORTH SHIPPING: this measurement is BAD, and the
// reasons it is bad are the actual lesson. Sample rate quantises the interval;
// the release and the catch are smeared; air resistance is real. A mode that
// measures g poorly and explains the error sources teaches more than one that
// quietly nudges the answer to 9.81.
//
// THERE IS NO CORRECTION TOWARD 9.81 ANYWHERE IN THIS FILE. 9.81 appears only as
// a number to COMPARE against and to show the error from. Nothing is scaled,
// clamped, blended or rejected for disagreeing with it. Verify by reading
// estimateG() — it divides measured numbers and returns the result.
//
// Reports the SPREAD across repeated drops, not one flattering number, because a
// single lucky run is exactly how you'd fool yourself here.

const FREEFALL_G = 0.25;      // |a| below this (in g) counts as weightless
const MIN_FALL_MS = 120;      // shorter than this is a bump, not a fall
const MAX_FALL_MS = 2000;
const G_REFERENCE = 9.80665;  // for COMPARISON ONLY — never applied to a result

let root, svc, store, els = {};
let listening = false, offMotion = null;
let inFall = false, fallStart = 0;
let drops = [];               // { ms, g, at } — every attempt, nothing discarded
let noteMsg = "", explainText = "";
let sampleHz = 0, sampleCount = 0, sampleT0 = 0;

// ---------------------------------------------------------------- the maths
// A toss that leaves the hand and returns takes T weightless, split evenly up and
// down, so the rise time is T/2 and g = 2h/(T/2)^2 with h = g(T/2)^2/2 — which
// collapses to the standard result that for a free-fall interval T of a thrown
// object, the peak height is g*T^2/8. Solving for g from the measured T alone
// requires knowing the height, so instead we use the DROP form: for a straight
// drop through height h, T = sqrt(2h/g), hence g = 2h/T^2.
//
// PURE ARITHMETIC. No reference value enters this function.
function estimateG(heightM, fallSeconds) {
  if (!(heightM > 0) || !(fallSeconds > 0)) return null;
  return (2 * heightM) / (fallSeconds * fallSeconds);
}

function stats(values) {
  if (!values.length) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return { n, mean, sd, min: sorted[0], max: sorted[n - 1],
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 };
}

let dropHeight = 1.0;         // metres, a slot — most people drop from chest height

// ---------------------------------------------------------------- motion
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  sampleCount++;
  if (!sampleT0) sampleT0 = performance.now();
  else if (sampleCount % 20 === 0) sampleHz = Math.round(sampleCount / ((performance.now() - sampleT0) / 1000));

  // Magnitude in g. At rest this is ~1; in free fall it collapses toward 0.
  const mag = Math.hypot(a.x, a.y, a.z) / 9.80665;
  const now = performance.now();

  if (!inFall && mag < FREEFALL_G) { inFall = true; fallStart = now; }
  else if (inFall && mag > FREEFALL_G * 3) {
    const ms = now - fallStart;
    inFall = false;
    if (ms >= MIN_FALL_MS && ms <= MAX_FALL_MS) {
      const g = estimateG(dropHeight, ms / 1000);
      // EVERY attempt is kept, including the embarrassing ones. Discarding runs
      // that disagree with the textbook is precisely the fudge this mode exists
      // to avoid.
      drops.push({ ms: Math.round(ms), g, at: Date.now() });
      noteMsg = "";
    } else if (ms < MIN_FALL_MS) {
      noteMsg = `Caught a ${Math.round(ms)} ms blip — too short to be a fall. Drop it from higher, or onto something soft.`;
    }
    render();
  }
}

async function startListening() {
  if (listening) return "Already listening for drops.";
  try { await svc.sensors.requestMotion(); }
  catch (err) {
    noteMsg = "Motion permission denied. On iOS this must come from a tap — that's the browser's rule, not ours.";
    render(); return "I need motion permission for this.";
  }
  offMotion = svc.sensors.onMotion(onMotion);
  listening = true; sampleCount = 0; sampleT0 = 0;
  render();
  return `Ready. Drop the phone from about ${dropHeight} m onto something soft, or toss it straight up and catch it.`;
}
function stopListening() {
  if (offMotion) { offMotion(); offMotion = null; }
  listening = false; inFall = false;
  render();
}

// ---------------------------------------------------------------- mode
export default {
  id: "freefall",
  title: "Free Fall · measure g",
  icon: "🍎",
  family: "Learn",
  permissions: ["motion"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("freefall");
    dropHeight = Number(store.get("height")) || 1.0;
    drops = store.get("drops") || [];
    renderShell();
  },
  async start() {},
  stop() { stopListening(); },
  teardown() { stopListening(); store && store.set("drops", drops.slice(-20)); els = {}; root = null; },

  getContext() {
    const s = stats(drops.map((d) => d.g).filter((x) => x > 0));
    if (!s) return `Free Fall — no drops recorded yet. Drop height set to ${dropHeight} m.`;
    return `Free Fall — ${s.n} drop${s.n === 1 ? "" : "s"} from ${dropHeight} m. ` +
      `g measured ${s.mean.toFixed(2)} m/s² (spread ${s.min.toFixed(2)}–${s.max.toFixed(2)}, sd ${s.sd.toFixed(2)}). ` +
      `Textbook is ${G_REFERENCE} — the gap is the point, and it comes from sample rate, release timing and air resistance. ` +
      `Accelerometer is sampling at about ${sampleHz || "?"} Hz.`;
  },

  // The number leads.
  getGlanceCard() {
    const s = stats(drops.map((d) => d.g).filter((x) => x > 0));
    if (!s) return null;
    const errPct = ((s.mean - G_REFERENCE) / G_REFERENCE) * 100;
    return {
      title: `g ≈ ${s.mean.toFixed(2)}`,
      lines: [
        `m/s² · ${s.n} drop${s.n === 1 ? "" : "s"}`,
        `spread ${s.min.toFixed(1)}–${s.max.toFixed(1)}`,
        `${errPct >= 0 ? "+" : ""}${errPct.toFixed(0)}% vs 9.81`,
      ],
      spoken: `g measured ${s.mean.toFixed(2)} metres per second squared across ${s.n} drops, ` +
        `${Math.abs(errPct).toFixed(0)} percent ${errPct >= 0 ? "above" : "below"} the textbook value.`,
      holdMs: 9000,
    };
  },

  describeSlots() {
    return [{
      id: "height", label: "the drop height", required: false,
      sources: ["utterance", "context"],
      parse: (t) => {
        const s = String(t || "").toLowerCase();
        let m = s.match(/\b(\d+(?:\.\d+)?)\s*(m|metre|meter|metres|meters)\b/);
        if (m) return Math.max(0.1, Math.min(20, parseFloat(m[1])));
        m = s.match(/\b(\d+(?:\.\d+)?)\s*(cm|centimetre|centimeter)/);
        if (m) return Math.max(0.1, Math.min(20, parseFloat(m[1]) / 100));
        m = s.match(/\b(\d+(?:\.\d+)?)\s*(ft|foot|feet)\b/);
        if (m) return Math.max(0.1, Math.min(20, parseFloat(m[1]) * 0.3048));
        return null;
      },
      fromContext: () => dropHeight,
      current: () => null,
      default: 1.0,
      apply: (v) => { dropHeight = v; store && store.set("height", v);
        // Height changed, so previous g values were computed from a different
        // height and are no longer comparable. Recompute rather than mix them.
        drops = drops.map((d) => ({ ...d, g: estimateG(dropHeight, d.ms / 1000) }));
        render(); },
      say: (v) => `dropping from ${v} m`,
    }];
  },

  describeCapabilities() {
    return [{
      id: "freefall.measure", label: "Free Fall", needsMode: true, fillsSlots: true,
      // NOT a bare "measure gravity" — Pendulum has owned that phrasing since it
      // shipped, and verification caught this stealing it. Both modes genuinely
      // measure g; Free Fall claims the DROP language, Pendulum keeps the swing.
      patterns: [/\b(open|start) (the )?free ?fall\b/i,
                 /\bdrop test\b/i, /\bmeasure (gravity|g) by dropping\b/i,
                 /\bhow fast (do|does) things fall\b/i,
                 /\bdrop (the phone|it) from\b/i],
      examples: ["start free fall", "drop test from 2 metres", "how fast do things fall"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?]/g, "").trim();
    if (/\bmeasure (gravity|g)\b|\b(open|start) (the )?free ?fall\b|\bdrop test\b/.test(q)) {
      if (!listening) return startListening();
      return `Listening. Drop from ${dropHeight} m. ${drops.length} drop${drops.length === 1 ? "" : "s"} so far.`;
    }
    if (/\b(reset|clear)( the)? (drops|results)\b/.test(q)) { drops = []; render(); return "Cleared."; }
    if (/\bwhat did i get\b|\bwhat'?s the result\b/.test(q)) {
      const s = stats(drops.map((d) => d.g).filter((x) => x > 0));
      if (!s) return "No drops recorded yet.";
      return `g came out at ${s.mean.toFixed(2)} m/s² across ${s.n} drops, ranging ${s.min.toFixed(2)} to ${s.max.toFixed(2)}. ` +
        `Textbook is ${G_REFERENCE}. The gap is sample rate, release timing and air resistance — not a bad phone.`;
    }
    return null;
  },

  // ---- verification hooks ----
  _estimateG: (h, t) => estimateG(h, t),        // pure; no reference value inside
  _drops: () => drops.slice(),
  _stats: () => stats(drops.map((d) => d.g).filter((x) => x > 0)),
  _pushDrop: (ms) => { drops.push({ ms, g: estimateG(dropHeight, ms / 1000), at: Date.now() }); render(); },
  _setHeight: (h) => { dropHeight = h; },
  _reset: () => { drops = []; render(); },
};

// ---------------------------------------------------------------- rendering
function renderShell() {
  root.innerHTML = `
    <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      padding:14px 14px 220px; background:radial-gradient(120% 90% at 50% 0%, #141a26 0%, var(--bg) 70%);"></div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  render();
}

function render() {
  if (!els.wrap) return;
  const scroll = els.wrap.scrollTop;
  const gs = drops.map((d) => d.g).filter((x) => x > 0);
  const s = stats(gs);
  const errPct = s ? ((s.mean - G_REFERENCE) / G_REFERENCE) * 100 : 0;

  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px;">🍎 Measure g</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
        Drop the phone (onto something soft!) or toss it straight up. While it's falling the accelerometer reads
        near zero — that weightless interval is what gets timed.
      </div>

      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px; text-align:center;">
        <div style="font-family:var(--mono); font-size:40px; font-weight:700; line-height:1;">
          ${s ? s.mean.toFixed(2) : "—"} <span style="font-size:16px; color:var(--dim);">m/s²</span>
        </div>
        <div style="font-size:13px; color:var(--dim); margin-top:6px;">
          ${s ? `mean of ${s.n} drop${s.n === 1 ? "" : "s"} from ${dropHeight} m` : `no drops yet · height ${dropHeight} m`}
        </div>
        ${s ? `
        <div style="font-family:var(--mono); font-size:12px; margin-top:12px; line-height:1.8; color:var(--dim);">
          spread &nbsp;<b style="color:var(--fg)">${s.min.toFixed(2)} – ${s.max.toFixed(2)}</b> m/s²<br>
          std dev &nbsp;<b style="color:var(--fg)">±${s.sd.toFixed(2)}</b> &nbsp;·&nbsp; median ${s.median.toFixed(2)}<br>
          vs textbook ${G_REFERENCE} &nbsp;<b style="color:${Math.abs(errPct) < 10 ? "#e6b446" : "#ff8a8a"}">
          ${errPct >= 0 ? "+" : ""}${errPct.toFixed(1)}%</b>
        </div>` : ""}
        <div style="font-family:var(--mono); font-size:10.5px; color:var(--dim); margin-top:10px;">
          accelerometer ~${sampleHz || "?"} Hz ${listening ? "· listening" : "· idle"}
        </div>
      </div>

      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="bigBtn" data-el="goBtn" style="flex:1; padding:13px;">
          ${listening ? "⏹ Stop" : "▶ Enable motion &amp; listen"}</button>
        ${drops.length ? `<button class="ghostBtn" data-el="clearBtn">Clear</button>` : ""}
        ${s ? `<button class="ghostBtn" data-el="explainBtn">Explain</button>` : ""}
      </div>
      <div class="saveNote" data-el="note">${noteMsg}</div>
      ${explainText ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
        padding:12px; margin-top:10px; font-size:13px; line-height:1.6;">${escapeHtml(explainText)}</div>` : ""}

      ${drops.length ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
        padding:12px; margin-top:12px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:8px;">Every drop, including the bad ones</div>
        <div style="font-family:var(--mono); font-size:11.5px; line-height:1.9; color:var(--dim);">
          ${drops.slice(-10).map((d, i) => `#${drops.length - Math.min(10, drops.length) + i + 1} &nbsp; ` +
            `${String(d.ms).padStart(4)} ms &nbsp;→&nbsp; <b style="color:var(--fg)">${d.g.toFixed(2)}</b> m/s²`).join("<br>")}
        </div>
        <div style="color:var(--dim); font-size:11px; margin-top:8px; line-height:1.45;">
          Nothing is discarded for disagreeing with the textbook. The scatter is the result.
        </div>
      </div>` : ""}

      <div style="border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,0.02);
                  padding:12px; margin-top:12px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:6px;">Why your answer is wrong (and that's the lesson)</div>
        <div style="color:var(--dim); font-size:11.5px; line-height:1.6;">
          <b style="color:var(--fg)">Sample rate.</b> The accelerometer reports at roughly
          ${sampleHz || "60–100"} Hz, so the fall is timed in steps of about
          ${sampleHz ? (1000 / sampleHz).toFixed(0) : "10–17"} ms. On a half-second drop that alone is a few percent.<br><br>
          <b style="color:var(--fg)">The release and the catch are smeared.</b> Your hand doesn't let go instantly and
          the catch decelerates over several milliseconds, so the "weightless" window has soft edges. This usually makes
          the fall look longer, which makes g look smaller.<br><br>
          <b style="color:var(--fg)">Air resistance.</b> Small over a metre, not zero — and it always reduces the
          apparent g.<br><br>
          <b style="color:var(--fg)">And the height is your estimate</b>, not a measurement. g scales linearly with the
          height you typed in: guess 1.2 m when it was 1.0 and every result is 20% high.<br><br>
          <b style="color:var(--fg)">Nothing here is corrected toward 9.81.</b> The number above is
          2h/t² with your height and the measured time, and nothing else. A physics app that quietly nudges its answer
          to the textbook teaches you nothing.
        </div>
      </div>
      <div style="color:var(--dim); font-size:11px; line-height:1.5; margin:12px 2px 0;">
        On iOS, motion access must be granted from a tap — that's a browser rule and no design can remove it.
        Everything else here is arithmetic on this device and works with the bridge switched off.
      </div>
    </div>`;
  for (const el of els.wrap.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.wrap.scrollTop = scroll;
  if (els.goBtn) els.goBtn.onclick = () => (listening ? stopListening() : startListening().then((m) => { noteMsg = m; render(); }));
  if (els.clearBtn) els.clearBtn.onclick = () => { drops = []; render(); };
  if (els.explainBtn) els.explainBtn.onclick = explain;
}

async function explain() {
  const s = stats(drops.map((d) => d.g).filter((x) => x > 0));
  if (!s) return;
  explainText = "Asking…"; render();
  try {
    const res = await svc.companion.ask(
      `Someone measured g as ${s.mean.toFixed(2)} m/s² by dropping a phone from ${dropHeight} m, ` +
      `with a spread of ${s.min.toFixed(2)} to ${s.max.toFixed(2)}. In at most 45 words, explain plainly ` +
      `which error source most likely dominates. Do not invent numbers and do not claim the true value was measured.`,
      "", [], { maxTokens: 120, temperature: 0.3 });
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
