// Reality Engine · Sound Lab — what am I hearing.
//
// Live microphone FFT. The dominant frequency, a relative loudness, and the
// nearest musical note with cents off. A room has a hum you can't name; this
// names it.
//
// THE RULE: THE MEASUREMENT OWNS THE ANSWER. An FFT peak is arithmetic. No number
// here comes from a model, nothing is sent anywhere, and the whole mode works
// with the bridge switched off — verified by switching it off, not by reading the
// code. The optional "explain this" button is the ONLY thing that touches the
// bridge, and it disappears cleanly when the bridge is gone.
//
// PRIVACY, STATED ON SCREEN RATHER THAN BURIED: the mic is live the whole time
// this mode is open. Audio is analysed in the browser frame by frame and is
// never recorded, never buffered to disk, and never transmitted. There is no
// MediaRecorder here and no fetch on the audio path.
//
// HONEST LIMITS, ALSO ON SCREEN: a phone mic is not an instrument. It rolls off
// badly below ~50 Hz, it has automatic gain we cannot switch off, and it is not
// calibrated — so loudness is RELATIVE and must never be read as SPL. This is not
// a hearing-safety meter and the mode says so where you can't miss it.

import { noteFromFrequency, sourceBand, A4_DEFAULT } from "../services/labTables.js";

const FFT_SIZE = 8192;          // ~5.4 Hz bins at 44.1 kHz — fine for a tuner
const MIN_HZ = 40, MAX_HZ = 12000;
const SILENCE_DB = -70;         // below this we say "too quiet" rather than guess

let root, svc, store, els = {};
let stream = null, audioCtx = null, analyser = null, raf = 0;
let running = false;
let freqData = null, timeData = null;
let reading = null;             // { hz, note, cents, db, band }
let a4 = A4_DEFAULT;
let targetNote = null;          // tuner target from a slot ("tune to A")
let peakHold = { hz: 0, db: -Infinity };
let explainText = "";           // optional, bridge-backed, never required

// ---------------------------------------------------------------- the maths
// Parabolic interpolation around the peak bin. Without it the readout quantises
// to the bin width (~5.4 Hz), which at A4 is nearly 20 cents — visibly wrong on a
// tuner. With it we get well under a cent of quantisation error.
function refinePeak(mags, i, binHz) {
  const y0 = mags[i - 1], y1 = mags[i], y2 = mags[i + 1];
  if (!(y0 > 0 && y1 > 0 && y2 > 0)) return i * binHz;
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) return i * binHz;
  const delta = 0.5 * (y0 - y2) / denom;      // sub-bin offset, -0.5..+0.5
  return (i + delta) * binHz;
}

// Find the FUNDAMENTAL, not merely the loudest bin.
//
// The first version of this used a textbook Harmonic Product Spectrum, and
// feeding it a known 440 Hz tone reported 7,720 Hz. The reason is worth keeping:
// HPS multiplies mags[i]·mags[2i]·mags[3i]·mags[4i], and a PURE tone has nothing
// at its harmonics, so the product at the true peak is (signal × noise × noise ×
// noise) — vanishingly small — while somewhere up in the noise floor four
// comparable tiny numbers multiply to something larger. It picked noise. Rich
// tones worked, pure ones failed catastrophically, which is exactly the sort of
// bug that survives a casual hum test and then embarrasses you against a tuning
// fork.
//
// So: start from the raw peak, which is always right for a pure tone, then look
// DOWNWARD for a subharmonic that would explain it. A voice whose second harmonic
// is loudest has real energy at f/2 with the series above it; noise does not.
function fundamental(mags, binHz) {
  const n = mags.length;
  const loBin = Math.max(1, Math.floor(MIN_HZ / binHz));
  const hiBin = Math.min(n - 2, Math.floor(MAX_HZ / binHz));

  let peak = loBin, peakV = -Infinity;
  for (let i = loBin; i <= hiBin; i++) if (mags[i] > peakV) { peakV = mags[i]; peak = i; }

  // Is the raw peak actually the k-th harmonic of something lower? Check the
  // largest divisor first so a true fundamental two octaves down still wins.
  const near = (bin) => {           // strongest magnitude within ±2 bins
    let m = 0;
    for (let d = -2; d <= 2; d++) { const j = bin + d; if (j >= loBin && j <= hiBin && mags[j] > m) m = mags[j]; }
    return m;
  };
  for (const k of [4, 3, 2]) {
    const cand = Math.round(peak / k);
    if (cand < loBin) continue;
    // The candidate needs real energy of its own...
    if (near(cand) < peakV * 0.08) continue;
    // ...and its harmonic series should actually be present, which is what
    // distinguishes a genuine fundamental from an unrelated low-frequency bump.
    let present = 0;
    for (let h = 2; h <= k; h++) if (near(cand * h) > peakV * 0.05) present++;
    if (present >= k - 1) { peak = cand; break; }
  }
  return refinePeak(mags, peak, binHz);
}

function analyse() {
  if (!running || !analyser) return;
  analyser.getFloatFrequencyData(freqData);   // dB, -Infinity..0
  analyser.getFloatTimeDomainData(timeData);

  // RMS -> relative dB. RELATIVE: no calibration exists for a phone mic, and the
  // browser applies its own gain, so this tracks change well and absolute level
  // not at all.
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
  const rms = Math.sqrt(sum / timeData.length);
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  const binHz = audioCtx.sampleRate / FFT_SIZE;
  // Linear magnitudes for HPS — multiplying dB values would be meaningless.
  const mags = new Float32Array(freqData.length);
  for (let i = 0; i < freqData.length; i++) mags[i] = Math.pow(10, freqData[i] / 20);

  if (db < SILENCE_DB) {
    reading = { hz: null, db, quiet: true };
  } else {
    const hz = fundamental(mags, binHz);
    const note = noteFromFrequency(hz, a4);
    reading = { hz, db, note, band: sourceBand(hz), quiet: false };
    if (db > peakHold.db) peakHold = { hz, db };
  }
  render();
  raf = requestAnimationFrame(analyse);
}

// ---------------------------------------------------------------- mic
async function start() {
  if (running) return "Already listening.";
  try {
    stream = await svc.sensors.requestMic({ audio: {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    }, video: false });
  } catch (err) {
    setNote("Microphone unavailable — check the permission, then tap again. Nothing else in this mode needs it.");
    return "I couldn't open the microphone.";
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.5;
  // NOTE: the analyser is a dead end on purpose — it is never connected to the
  // destination and there is no MediaRecorder. Audio is read, measured, discarded.
  src.connect(analyser);
  freqData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(analyser.fftSize);
  running = true;
  peakHold = { hz: 0, db: -Infinity };
  analyse();
  return "Listening. Nothing is recorded.";
}
function stop() {
  running = false;
  cancelAnimationFrame(raf); raf = 0;
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  if (stream) { svc.sensors.releaseStream(stream); stream = null; }
  analyser = null;
  render();
}

let noteMsg = "";
function setNote(t) { noteMsg = t; render(); }

// ---------------------------------------------------------------- mode
export default {
  id: "soundlab",
  title: "Sound Lab · what am I hearing",
  icon: "🔊",
  family: "Learn",
  permissions: ["mic"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("soundlab");
    a4 = Number(store.get("a4")) || A4_DEFAULT;
    renderShell();
  },
  async start() {},
  stop() { stop(); },
  teardown() { stop(); els = {}; root = null; reading = null; explainText = ""; },

  getContext() {
    if (!reading) return "Sound Lab — microphone off; nothing measured yet.";
    if (reading.quiet) return "Sound Lab — listening, but the room is below the noise floor right now.";
    const n = reading.note;
    return `Sound Lab — hearing ${Math.round(reading.hz)} Hz, nearest note ${n.label} ` +
      `${n.cents >= 0 ? "+" : ""}${n.cents} cents, relative level ${reading.db.toFixed(0)} dB` +
      (reading.band ? `. Usually ${reading.band.label}.` : ".") +
      " Relative level only — a phone mic is not calibrated and this is not an SPL meter.";
  },

  // The number leads. "440 Hz · A4 +3¢", never "Sound Lab is measuring".
  getGlanceCard() {
    if (!reading || reading.quiet) return null;
    const n = reading.note;
    const wrap = (svc.glasses && svc.glasses.wrap) || ((t) => [String(t).slice(0, 24)]);
    return {
      title: `${Math.round(reading.hz)} Hz`,
      lines: [
        `${n.label} ${n.cents >= 0 ? "+" : ""}${n.cents}¢`,
        ...(reading.band ? wrap(reading.band.label, 24, 2) : []),
        `${reading.db.toFixed(0)} dB rel`,
      ].slice(0, 4),
      spoken: `${Math.round(reading.hz)} hertz, ${n.label} ${n.cents >= 0 ? "plus" : "minus"} ${Math.abs(n.cents)} cents.`,
      holdMs: 6000,
    };
  },

  // "Tune to A" must not open a form.
  describeSlots() {
    return [{
      id: "targetNote", label: "the note to tune to", required: false,
      sources: ["utterance", "context"],
      parse: (t) => {
        const m = String(t || "").match(/\btune (?:to|it to)\s+([A-G])(\s*(?:sharp|#|flat|b))?\s*(\d)?/i);
        if (!m) return null;
        let name = m[1].toUpperCase();
        if (m[2]) name += /sharp|#/i.test(m[2]) ? "#" : "b";
        return name + (m[3] || "4");
      },
      fromContext: () => targetNote,
      current: () => null,
      apply: (v) => { targetNote = v; render(); },
      say: (v) => `tuning to ${v}`,
    }];
  },

  describeCapabilities() {
    return [{
      id: "sound.listen", label: "Sound Lab", needsMode: true, fillsSlots: true,
      patterns: [/\bwhat note is (this|that)\b/i, /\bwhat (frequency|pitch) is (this|that)\b/i,
                 /\bhow loud is (it|this)\b/i, /\bwhat am i hearing\b/i,
                 /\b(open|start) (the )?(sound lab|tuner)\b/i, /\btune (to|my)\b/i],
      examples: ["what note is this", "how loud is it", "what am I hearing", "tune to A"],
      run: (text, ctx) => (ctx.callActiveCommand ? ctx.callActiveCommand(text) : null),
    }];
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?]/g, "").trim();
    if (/\b(what note|what frequency|what pitch|how loud|what am i hearing)\b/.test(q)) {
      if (!running) return start().then(() => "Listening — give it a second and ask again. Nothing is recorded.");
      if (!reading || reading.quiet) return "Too quiet to read anything right now.";
      const n = reading.note;
      return `${Math.round(reading.hz)} hertz — ${n.label}, ${Math.abs(n.cents)} cents ${n.cents >= 0 ? "sharp" : "flat"}. ` +
        (reading.band ? `That band is usually ${reading.band.label}. ` : "") +
        `Level ${reading.db.toFixed(0)} dB relative — not an SPL reading.`;
    }
    if (/\b(open|start) (the )?(sound lab|tuner)\b|\bstart listening\b/.test(q)) return start();
    if (/\bstop listening\b|\bstop\b$/.test(q)) { stop(); return "Microphone off."; }
    return null;
  },

  // ---- verification hooks ----
  // The analysis is pure: give it a buffer, get a reading. That is what lets a
  // known 440 Hz tone be pushed through the REAL code path without a microphone.
  _analyseBuffer: (samples, sampleRate) => analyseBuffer(samples, sampleRate),
  _reading: () => reading,
  _running: () => running,
  _setA4: (v) => { a4 = v; },
};

// Offline analysis over a supplied buffer, using the same maths the live path
// uses. This exists so a synthesized tone of known frequency can be measured and
// the error reported honestly.
export function analyseBuffer(samples, sampleRate) {
  const n = FFT_SIZE;
  const buf = new Float32Array(n);
  buf.set(samples.subarray(0, Math.min(n, samples.length)));
  // Hann window — without it, spectral leakage smears the peak and the parabolic
  // interpolation has nothing clean to fit.
  for (let i = 0; i < n; i++) buf[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  const mags = dftMagnitudes(buf);
  const binHz = sampleRate / n;
  const hz = fundamental(mags, binHz);
  return { hz, note: noteFromFrequency(hz, a4), band: sourceBand(hz) };
}

// A real FFT (radix-2, iterative). Our own code, no dependency — and the browser's
// AnalyserNode can't be fed a synthetic buffer, which is exactly what the known-
// tone verification needs.
function dftMagnitudes(input) {
  const n = input.length;
  const re = Float64Array.from(input), im = new Float64Array(n);
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / (n / 2);
  return out;
}

// ---------------------------------------------------------------- rendering
function renderShell() {
  root.innerHTML = `
    <div data-el="wrap" style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      padding:14px 14px 220px; background:radial-gradient(120% 90% at 50% 0%, #101a26 0%, var(--bg) 70%);"></div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  render();
}

function render() {
  if (!els.wrap) return;
  const r = reading;
  const scroll = els.wrap.scrollTop;
  const n = r && !r.quiet ? r.note : null;
  const cents = n ? n.cents : 0;
  // Needle: ±50 cents maps across the width.
  const pct = Math.max(0, Math.min(100, 50 + cents));

  els.wrap.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <h2 style="font-size:20px; margin:2px 2px 4px;">🔊 What am I hearing?</h2>
      <div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
        Live frequency, nearest note, and a relative level. All measured on this phone —
        <b style="color:var(--fg)">audio is never recorded and never leaves the device.</b>
      </div>

      <div style="border:1px solid var(--line); border-radius:16px; background:var(--panel-solid); padding:16px; text-align:center;">
        <div style="font-family:var(--mono); font-size:38px; font-weight:700; line-height:1;">
          ${r && !r.quiet ? Math.round(r.hz) + " <span style='font-size:18px;color:var(--dim)'>Hz</span>" : "—"}
        </div>
        <div style="font-size:22px; font-weight:700; margin-top:6px; color:${Math.abs(cents) <= 5 ? "#46c882" : "var(--fg)"};">
          ${n ? `${n.label} <span style="font-family:var(--mono); font-size:15px;">${cents >= 0 ? "+" : ""}${cents}¢</span>` : (running ? "listening…" : "mic off")}
        </div>
        ${n ? `
        <div style="position:relative; height:26px; margin:12px 6px 4px; border-radius:6px;
                    background:linear-gradient(90deg,#3a2530,#1c2430 45%,#16311f 50%,#1c2430 55%,#3a2530);">
          <div style="position:absolute; left:50%; top:-3px; bottom:-3px; width:2px; background:rgba(255,255,255,0.35);"></div>
          <div style="position:absolute; left:${pct}%; top:-5px; bottom:-5px; width:3px; border-radius:2px;
                      background:${Math.abs(cents) <= 5 ? "#46c882" : "#e6b446"}; transform:translateX(-1.5px);"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-family:var(--mono); font-size:9.5px; color:var(--dim); margin:0 6px;">
          <span>-50¢</span><span>in tune</span><span>+50¢</span>
        </div>` : ""}
        <div style="font-family:var(--mono); font-size:11.5px; color:var(--dim); margin-top:10px;">
          ${r ? `${r.db === -Infinity ? "—" : r.db.toFixed(0)} dB relative` : "—"}
          ${targetNote ? ` · target ${targetNote}` : ""} · A4 = ${a4} Hz
        </div>
        ${r && !r.quiet && r.band ? `<div style="font-size:12px; color:var(--dim); margin-top:8px; line-height:1.45;">
          <b style="color:var(--fg)">${r.band.label}</b> — ${r.band.note}</div>` : ""}
      </div>

      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="bigBtn" data-el="micBtn" style="flex:1; padding:13px;">
          ${running ? "⏹ Stop listening" : "🎤 Start listening"}</button>
        <button class="ghostBtn" data-el="explainBtn">Explain this</button>
      </div>
      <div class="saveNote" data-el="note">${noteMsg}</div>
      ${explainText ? `<div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid);
        padding:12px; margin-top:10px; font-size:13px; line-height:1.6;">${escapeHtml(explainText)}</div>` : ""}

      <div style="border:1px solid var(--line); border-radius:14px; background:rgba(255,255,255,0.02);
                  padding:12px; margin-top:12px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:6px;">What this can and can't tell you</div>
        <div style="color:var(--dim); font-size:11.5px; line-height:1.6;">
          <b style="color:var(--fg)">The level is relative, not SPL.</b> A phone mic is uncalibrated and the browser
          applies its own gain, so this tracks whether a sound got louder — it cannot tell you how loud it is in the
          real world. <b style="color:var(--fg)">Never use it for hearing-safety decisions</b>; that needs a real
          sound level meter.<br><br>
          Phone mics also roll off hard below about 50 Hz, so deep bass reads far quieter than it is. Frequency is the
          trustworthy part: the bins are ~${audioCtx ? (audioCtx.sampleRate / FFT_SIZE).toFixed(1) : "5.4"} Hz wide and
          interpolated, so pitch is good to well under a cent — it's the loudness you should distrust.
        </div>
      </div>
      <div style="color:var(--dim); font-size:11px; line-height:1.5; margin:12px 2px 0;">
        The microphone is live while this mode is open. Audio is analysed frame by frame in the browser and
        immediately discarded — there is no recording, no buffer written to disk, and nothing sent anywhere.
        Every number here is arithmetic on this device and works with the bridge switched off.
      </div>
    </div>`;
  for (const el of els.wrap.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.wrap.scrollTop = scroll;
  if (els.micBtn) els.micBtn.onclick = () => (running ? (stop(), setNote("")) : start().then(setNote));
  if (els.explainBtn) els.explainBtn.onclick = explain;
}

// THE ONLY BRIDGE CALL IN THIS FILE, and it is optional by construction: it
// explains a number that already exists and never produces one. If the bridge is
// down this says so and the mode carries on measuring.
async function explain() {
  if (!reading || reading.quiet) { setNote("Measure something first, then I can explain it."); return; }
  const n = reading.note;
  explainText = "Asking…"; render();
  try {
    const res = await svc.companion.ask(
      `In at most 40 words, explain plainly what a reading of ${Math.round(reading.hz)} Hz means musically ` +
      `and what usually makes a sound at that pitch. The nearest note is ${n.label}. Do not invent numbers.`,
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
