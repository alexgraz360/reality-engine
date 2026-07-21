// Football — analyst companion mode. You set the live situation (down, distance,
// field zone, quarter, score, what you see); the mode grounds every companion
// answer in it and, on "read it", hands back a short speakable three-part read.
//
// COMPOSES existing services — no fork: quick commands ride the handleCommand
// seam (like Guide), the read + fall-through answers go through the normal
// companion ask/voice path, and the analyst framing is applied via the additive
// getSystemContext() hook the shell passes to companion.ask.
//
// HONESTY: this is a knowledge + reasoning tool. It cannot see the broadcast —
// it reasons only from the situation you give it, and everything is framed as
// general tendencies, never guaranteed play calls. Baked into both the prompt
// and the on-screen note.

import footballData from "../services/footballData.js";

let root, svc, store, els = {};
let ref = null;
let sit = null;
let dataReady = false;        // vendored tendency data loaded
let scanning = false;         // scoreboard OCR in flight
let justFilled = new Set();   // fields the last scan filled (for highlighting)
let scanNote = "";            // status/honesty line under the scan button

const ZONES = [
  { id: "backed-up", label: "Backed up" },
  { id: "own-territory", label: "Own side" },
  { id: "midfield", label: "Midfield" },
  { id: "plus-territory", label: "Plus terr." },
  { id: "red-zone", label: "Red zone" },
  { id: "goal-line", label: "Goal line" },
];

function freshSituation() {
  return {
    down: 1, distance: 10, zone: "own-territory",
    quarter: 1, margin: 0,            // offense point differential (+ ahead, − behind)
    twoMinute: false,
    see: "",                          // free "what you see" text
    offense: "", defense: "",         // team codes (nflverse); optional
    clock: "",                        // game clock from a scan, e.g. "2:11"
  };
}

// Situation the data providers understand.
function dataSituation() { return { down: sit.down, distance: sit.distance, zone: sit.zone }; }
function tendencies() {
  if (!dataReady || !sit.offense) return null;
  return footballData.getTendencies(sit.offense, dataSituation());
}
function defenseTendencies() {
  if (!dataReady || !sit.defense) return null;
  return footballData.getDefenseTendencies(sit.defense, dataSituation());
}

export default {
  id: "football",
  title: "Football · read the game",
  icon: "🏈",
  family: "Learn",
  permissions: ["mic", "camera"],

  async init(ctx) {
    root = ctx.root;
    svc = ctx.services;
    store = svc.storage.scope("football");
    sit = Object.assign(freshSituation(), store.get("situation") || {}); // merge so new fields exist
    try {
      const r = await fetch(new URL("../data/football-reference.json", import.meta.url));
      ref = await r.json();
    } catch (e) { console.error("football reference failed to load:", e); ref = null; }
    dataReady = await footballData.ready(); // vendored nflverse tendencies (offline)
    renderPanel();
  },

  async start() {},
  stop() {},
  teardown() { els = {}; root = null; ref = null; sit = null; },

  // Situation string that grounds every companion answer.
  getContext() { return buildContext(); },

  // Analyst framing + a few situation-relevant reference lines. The shell passes
  // this to companion.ask as systemExtra, so BOTH "read it" and any fall-through
  // football question are primed — without touching the shared prompt.
  getSystemContext() { return buildSystemContext(); },

  // Quick commands (intercepted before the model). Return a string / Promise<string>
  // to handle locally; return null to fall through to the football-primed answer.
  handleCommand(text) {
    const q = String(text || "").toLowerCase().replace(/[.,!?]/g, "").trim();

    if (/^(reset|clear|new (drive|situation))$/.test(q)) {
      sit = freshSituation(); persist(); renderPanel();
      return "Situation reset to first and ten, own territory.";
    }

    // The read (check before the question guard — "what should I watch" is a read).
    if (/(read it|read this|what should i watch|what'?s the read|whats the read|give me (a|the) read|break it down)/.test(q)) {
      return generateRead();
    }

    // Explicit reference lookup: "explain cover two", "what is a bunch formation".
    const ex = q.match(/^(?:explain|what'?s|whats|what is|what are|tell me about|define) (?:a |an |the )?(.+)/);
    if (ex) { const hit = lookupReference(ex[1].trim()); if (hit) return hit; }

    // Question guard: anything phrased as a question is a conversation for the
    // model, NOT a situation-setter — so "why run play-action on second and
    // short" falls through instead of setting 2nd-and-short. (Read/explain were
    // already handled above.)
    if (/^(why|how|when|where|who|which|should|would|could|is|are|do|does|did|will|can|whats|what)\b/.test(q) || /\?$/.test(text || "")) {
      return null;
    }

    // Situation setters (imperative shortcuts only, now that questions are gone).
    const dd = parseDownDistance(q);
    if (dd) { Object.assign(sit, dd); persist(); renderPanel(); return `Set: ${describeSituation()}.`; }

    const zone = ZONES.find((z) => q.includes(z.label.toLowerCase()) || q.includes(z.id.replace(/-/g, " ")));
    if (zone && /(red zone|goal line|midfield|backed up|own side|own territory|plus)/.test(q)) {
      sit.zone = zone.id; persist(); renderPanel(); return `Ball placed: ${zone.label}.`;
    }

    if (/(two.?minute|2.?minute)/.test(q)) {
      sit.twoMinute = true; persist(); renderPanel(); return "Two-minute drill on. Expect tempo, sideline routes, and clock management.";
    }

    // "what you see" capture: "I see ...", "they're in ...", "it's ..."
    const seeMatch = q.match(/^(?:i see|they'?re in|it'?s|offense is in|they have|showing) (.+)/);
    if (seeMatch) {
      sit.see = seeMatch[1]; persist(); renderPanel();
      return `Got it — you're seeing ${sit.see}. Say "read it" for the pre-snap read.`;
    }

    return null; // fall through → football-primed companion answer with getContext()
  },

  // ---- verification hooks ----
  _state: () => ({ situation: { ...sit }, dataReady }),
  _tendencies: () => tendencies(),
  _defenseTendencies: () => defenseTendencies(),
  _systemContext: () => buildSystemContext(),
  _scan: (b64) => runScan(b64),                 // drive a scan without the camera
  _applyScoreboard: (p) => applyScoreboard(p),  // field-mapping check
  _justFilled: () => [...justFilled],
  _set: (partial) => { Object.assign(sit, partial); persist(); if (els.panel) renderPanel(); },
  _read: () => generateRead(),
  _reference: () => ref,
};

// ---------------------------------------------------------------- scoreboard scan
// One frame → the bridge's OCR + parse → auto-fill. Everything stays editable;
// fields the bridge couldn't read are left alone rather than guessed.
function frameToJpegBase64(source, w, h) {
  const MAX = 1024; // a bit larger than /vision: small text needs the pixels
  const scale = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function startScan() {
  if (scanning) return;
  els.scanInput.value = ""; // allow re-picking the same shot
  els.scanInput.click();    // iOS opens the camera and returns ONE photo
}

async function scanFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    const b64 = frameToJpegBase64(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(url);
    await runScan(b64);
  };
  img.onerror = () => { URL.revokeObjectURL(url); setScanNote("Couldn't read that photo — try again."); };
  img.src = url;
}

async function runScan(b64) {
  scanning = true;
  setScanNote("Reading the scoreboard… (a few seconds)");
  renderScanUI();
  try {
    const res = await svc.companion.scoreboard(b64);
    if (!res.ok) { setScanNote(res.text + " You can still set everything by hand."); return; }
    const filled = applyScoreboard(res.parsed);
    if (!filled.length) {
      setScanNote("Couldn't read a scoreboard in that shot — set the situation by hand, or try again closer.");
    } else {
      setScanNote(`Auto-filled ${filled.join(", ")} from the scoreboard — check and fix any misread.`);
      justFilled = new Set(filled);
      setTimeout(() => { justFilled = new Set(); if (els.panel) renderPanel(); }, 6000);
    }
    renderPanel();
  } finally {
    scanning = false;
    renderScanUI();
  }
}

// Map the parsed bug onto the situation. Returns the list of fields actually set.
function applyScoreboard(p) {
  const filled = [];
  if (Number.isInteger(p.down) && p.down >= 1 && p.down <= 4) { sit.down = p.down; filled.push("down"); }
  if (Number.isInteger(p.distance) && p.distance >= 0) { sit.distance = p.distance; filled.push("distance"); }
  if (Number.isInteger(p.quarter)) { sit.quarter = Math.min(4, p.quarter); filled.push("quarter"); }
  if (typeof p.clock === "string" && p.clock) {
    sit.clock = p.clock;
    filled.push("clock");
    // Two-minute drill is a real tendency switch — infer it, still user-editable.
    const [m] = p.clock.split(":").map(Number);
    sit.twoMinute = (p.quarter === 2 || p.quarter === 4) && m < 2;
  }
  // Possession picks the offense when it matches a team we have data for.
  const teams = dataReady ? footballData.getTeams() : [];
  if (p.possession && teams.includes(p.possession)) { sit.offense = p.possession; filled.push("offense"); }
  // Scores → margin from the offense's point of view (needs to know who has it).
  const pairs = [[p.homeTeam, p.homeScore], [p.awayTeam, p.awayScore]].filter(([t, s]) => t && Number.isInteger(s));
  if (pairs.length === 2 && sit.offense) {
    const mine = pairs.find(([t]) => t === sit.offense);
    const theirs = pairs.find(([t]) => t !== sit.offense);
    if (mine && theirs) { sit.margin = mine[1] - theirs[1]; filled.push("score"); }
    if (theirs && teams.includes(theirs[0]) && !sit.defense) { sit.defense = theirs[0]; filled.push("defense"); }
  }
  // "PHI 35" → a field zone, but only if we know whose side that is.
  if (typeof p.yardLine === "string" && sit.offense) {
    const m = p.yardLine.match(/^([A-Z]{2,3})\s*(\d{1,2})$/);
    if (m) {
      const yardsToOpp = m[1] === sit.offense ? 100 - parseInt(m[2], 10) : parseInt(m[2], 10);
      sit.zone = yardsToOpp <= 5 ? "goal-line" : yardsToOpp <= 20 ? "red-zone"
        : yardsToOpp <= 40 ? "plus-territory" : yardsToOpp <= 59 ? "midfield"
        : yardsToOpp <= 89 ? "own-territory" : "backed-up";
      filled.push("field");
    }
  }
  if (filled.length) persist();
  return filled;
}

function setScanNote(t) { scanNote = t; renderScanUI(); }
function renderScanUI() {
  if (els.scanBtn) {
    els.scanBtn.disabled = scanning;
    els.scanBtn.textContent = scanning ? "Reading…" : "📷 Scan scoreboard";
  }
  if (els.scanNote) els.scanNote.textContent = scanNote;
}

// ---------------------------------------------------------------- context builders
function buildContext() {
  if (!sit) return "Football mode.";
  const z = ZONES.find((x) => x.id === sit.zone);
  const parts = [
    `${ordinal(sit.down)} and ${sit.distance === 0 ? "goal" : sit.distance}`,
    z ? `ball in ${z.label.toLowerCase()}` : null,
    `Q${sit.quarter}`,
    sit.margin === 0 ? "score even" : `offense ${sit.margin > 0 ? "up" : "down"} ${Math.abs(sit.margin)}`,
    sit.clock ? `${sit.clock} on the clock` : null,
    sit.twoMinute ? "two-minute drill" : null,
  ].filter(Boolean);
  let s = `Football mode. Situation: ${parts.join(", ")}.`;
  if (sit.offense) s += ` Offense on the field: ${sit.offense}${sit.defense ? ` vs ${sit.defense} defense` : ""}.`;
  if (sit.see && sit.see.trim()) s += ` User sees: ${sit.see.trim()}.`;
  return s;
}

function buildSystemContext() {
  let s =
    "You are a sharp, plain-spoken football analyst helping the user sound smart while watching a game. " +
    "Be concise and speakable — a couple of short sentences unless asked for more. Explain formations, " +
    "personnel, coverages, blitzes, route concepts, and down-and-distance tendencies in clear language. " +
    "CRITICAL HONESTY: you CANNOT see the broadcast; you reason only from the situation the user gives you. " +
    "Frame everything as general tendencies and what to watch for — never as a guaranteed play call or insider info. " +
    "No team-specific or proprietary claims.";
  // When we have real team numbers they carry the read, so trim the generic
  // reference lines — a leaner prompt also generates noticeably faster on CPU.
  const haveTeamData = !!(tendencies() || defenseTendencies());
  const lines = relevantReference().slice(0, haveTeamData ? 2 : 5);
  if (lines.length) s += "\n\nRelevant reference for this situation:\n" + lines.join("\n");
  // Real per-team tendency numbers (vendored public data) when a team is picked —
  // this is what turns a generic read into "they pass 70% here, above league".
  const tend = tendencies();
  if (tend) s += "\n\n" + footballData.formatForPrompt(tend);
  const dTend = defenseTendencies();
  if (dTend) s += "\n\n" + footballData.formatDefenseForPrompt(dTend);
  if (tend || dTend) {
    s += "\n\nUSING THE DATA: the numbers above are current and take precedence for anything specific. " +
      "You may add brief scheme or coordinator flavour from your own knowledge, but you MUST label it as " +
      "general and possibly out of date (staffs and personnel change), and never state a team's coverage " +
      "shell or play call as fact — public data has no coverage labels.";
  }
  return s;
}

// ---------------------------------------------------------------- the read
async function generateRead() {
  const hasData = !!tendencies() || !!defenseTendencies();
  const prompt =
    "Give a pre-snap read for the current situation as three short, speakable parts, one sentence each, " +
    "in this order and labeled exactly:\n" +
    "Offense: the likely tendencies here (run/pass lean and a common concept for this down, distance, field zone and personnel).\n" +
    "Defense: what they may show and do (a likely coverage or pressure in this situation).\n" +
    "Watch: one matchup or tell to watch for.\n" +
    (hasData
      ? "You have real tendency numbers for these teams — cite at least one specific figure with its league comparison " +
        "(e.g. \"they pass 97% here, well above league\"), and if defensive numbers are present cite one of those too " +
        "(e.g. \"the Giants blitz 37% here, well above average\") so both sides are team-specific. "
      : "") +
    "Keep the whole thing short enough to say out loud in a room. General tendencies only — you cannot see the play.";
  try {
    const res = await svc.companion.ask(prompt, buildContext(), [], { systemExtra: buildSystemContext() });
    if (res.ok && res.text) return res.text;
    return res.text || "Couldn't get a read right now — check the companion connection in Settings.";
  } catch (e) {
    return "Couldn't get a read right now — check the companion connection in Settings.";
  }
}

// ---------------------------------------------------------------- reference use
function relevantReference() {
  if (!ref) return [];
  const out = [];
  const ddTendency = downDistanceTendencyId();
  const zoneTendency = zoneTendencyId();
  for (const id of [ddTendency, zoneTendency, sit.twoMinute ? "two-minute" : null]) {
    const t = id && (ref.tendencies || []).find((x) => x.id === id);
    if (t) out.push(`- ${t.name}: ${t.detail}`);
  }
  // personnel / formation / coverage mentioned in "what you see"
  if (sit.see) {
    const see = sit.see.toLowerCase();
    for (const p of ref.personnel || []) if (see.includes(p.id) || see.includes(p.name.toLowerCase())) out.push(`- ${p.name}: ${p.detail}`);
    for (const f of ref.formations || []) if (see.includes(f.id.replace(/-/g, " ")) || see.includes(f.name.toLowerCase())) out.push(`- ${f.name}: ${f.detail}`);
    for (const c of ref.coverages || []) if (see.includes(c.name.toLowerCase())) out.push(`- ${c.name}: spot it — ${c.spot} Weakness — ${c.weakness}`);
    if (/single.?high|one high/.test(see)) out.push("- Single-high safety: hints man or Cover 1/3 — one deep defender.");
    if (/two.?high|2.?high/.test(see)) out.push("- Two-high safeties: hints Cover 2/4 or a disguise — two deep defenders.");
  }
  return out.slice(0, 5); // keep the prompt tight
}

function downDistanceTendencyId() {
  const d = sit.down, dist = sit.distance;
  if (d === 1) return "first-10";
  if (d === 2) return dist <= 3 ? "second-short" : dist >= 8 ? "second-long" : "second-short";
  if (d >= 3) return dist <= 2 ? "third-short" : dist <= 6 ? "third-medium" : "third-long";
  return null;
}
function zoneTendencyId() {
  return { "red-zone": "red-zone", "goal-line": "goal-line", "backed-up": "backed-up" }[sit.zone] || null;
}

const WORD_NUM = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6" };
function lookupReference(term) {
  if (!ref) return null;
  // Normalise spelled-out coverage numbers: "cover two" → "cover-2".
  const norm = term.toLowerCase().replace(/\bcover\s+(zero|one|two|three|four|five|six)\b/,
    (_, w) => "cover " + WORD_NUM[w]);
  const t = norm.replace(/^cover /, "cover-").replace(/\s+/g, "-");
  const bare = norm;
  const c = (ref.coverages || []).find((x) => x.id === t || x.name.toLowerCase().includes(bare));
  if (c) return `${c.name}. How to spot it: ${c.spot} Weakness: ${c.weakness}`;
  const f = (ref.formations || []).find((x) => x.id === t || x.name.toLowerCase().includes(bare));
  if (f) return `${f.name}. ${f.detail}`;
  const p = (ref.personnel || []).find((x) => x.id === bare || x.name.toLowerCase().includes(bare));
  if (p) return `${p.name}. ${p.detail}`;
  const pr = (ref.pressures || []).find((x) => x.name.toLowerCase().includes(bare));
  if (pr) return `${pr.name}. ${pr.detail}`;
  const g = (ref.glossary || []).find((x) => x.term.toLowerCase() === bare || bare.includes(x.term.toLowerCase()));
  if (g) return `${g.term}: ${g.def}`;
  return null; // let the model field it
}

// ---------------------------------------------------------------- parsing
const NUM = { first: 1, second: 2, third: 3, fourth: 4, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, goal: 0 };
function parseDownDistance(q) {
  // "third and long/short/medium", "3rd and 7", "first and ten", "3rd and goal"
  const m = q.match(/(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:and|&|n)\s+(long|short|medium|goal|\d+|one|two|three|four|five|six|seven|eight|nine|ten)/);
  if (!m) return null;
  const down = NUM[m[1]];
  let distance;
  if (m[2] === "long") distance = 10;
  else if (m[2] === "short") distance = 2;
  else if (m[2] === "medium") distance = 5;
  else distance = m[2] in NUM ? NUM[m[2]] : parseInt(m[2], 10);
  if (!isFinite(distance)) return null;
  const out = { down, distance };
  if (m[2] === "goal") out.zone = sit.zone === "goal-line" ? "goal-line" : "red-zone";
  return out;
}

// ---------------------------------------------------------------- helpers
function ordinal(n) { return ["0th", "1st", "2nd", "3rd", "4th"][n] || n + "th"; }
function describeSituation() {
  return `${ordinal(sit.down)} and ${sit.distance === 0 ? "goal" : sit.distance}`;
}
function persist() { store.set("situation", sit); }

// ---------------------------------------------------------------- UI
function renderPanel() {
  const w = root;
  const z = (id) => ZONES.find((x) => x.id === id);
  w.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 6px;">
          <span style="font-size:22px;">🏈</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Read the game</div>
            <div style="font-size:11px; color:var(--dim);">General tendencies — it can't see the broadcast. You set the situation.</div>
          </div>
        </div>

        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="ghostBtn accent" data-el="scanBtn" style="flex:1;">📷 Scan scoreboard</button>
        </div>
        <input type="file" data-el="scanInput" accept="image/*" capture="environment" style="display:none;">
        <div data-el="scanNote" style="font-size:11px; color:var(--dim); margin-top:6px; line-height:1.45;"></div>

        <div class="fbRow ${hit("offense")} ${hit("defense")}" style="margin-top:8px;"><span class="fbLbl">Matchup</span><span class="fbSeg">
          ${teamSelect("offense", sit.offense, "Offense")}
          <span style="color:var(--dim); font-size:12px;">vs</span>
          ${teamSelect("defense", sit.defense, "Defense")}
        </span></div>

        <div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid); padding:12px; margin-top:8px;">
          <div class="fbRow ${hit("down")}"><span class="fbLbl">Down</span><span class="fbSeg" data-group="down">
            ${[1,2,3,4].map((d) => `<button class="fbChip ${sit.down===d?"on":""}" data-down="${d}">${ordinal(d)}</button>`).join("")}
          </span></div>
          <div class="fbRow ${hit("distance")}"><span class="fbLbl">Distance</span><span class="fbSeg">
            <button class="fbChip" data-dist="-1">–</button>
            <span class="fbVal" data-el="distVal">${sit.distance===0?"Goal":sit.distance}</span>
            <button class="fbChip" data-dist="1">+</button>
            <button class="fbChip ${sit.distance<=2?"on":""}" data-distset="2">Short</button>
            <button class="fbChip ${sit.distance>=7?"on":""}" data-distset="10">Long</button>
          </span></div>
          <div class="fbRow ${hit("field")}"><span class="fbLbl">Field</span><span class="fbSeg fbWrap">
            ${ZONES.map((zn) => `<button class="fbChip ${sit.zone===zn.id?"on":""}" data-zone="${zn.id}">${zn.label}</button>`).join("")}
          </span></div>
          <div class="fbRow ${hit("quarter")} ${hit("clock")}"><span class="fbLbl">Quarter</span><span class="fbSeg">
            ${[1,2,3,4].map((qn) => `<button class="fbChip ${sit.quarter===qn?"on":""}" data-qtr="${qn}">Q${qn}</button>`).join("")}
            <button class="fbChip ${sit.twoMinute?"on":""}" data-el="twoMin" style="margin-left:6px;">2-min</button>
            <input type="text" data-el="clock" value="${escapeAttr(sit.clock)}" placeholder="clock"
              autocomplete="off" style="width:66px; text-align:center; margin-left:6px;">
          </span></div>
          <div class="fbRow ${hit("score")}"><span class="fbLbl">Score</span><span class="fbSeg">
            <button class="fbChip" data-margin="-1">–</button>
            <span class="fbVal" data-el="marginVal">${marginLabel()}</span>
            <button class="fbChip" data-margin="1">+</button>
          </span></div>
          <div style="margin-top:10px;">
            <label class="fbLbl" style="display:block; margin-bottom:5px;">What you see (personnel / formation / coverage)</label>
            <input type="text" data-el="see" value="${escapeAttr(sit.see)}" placeholder="e.g. shotgun, trips right, 11 personnel, single-high"
              autocomplete="off" style="width:100%;">
          </div>
        </div>

        <div data-el="statCard"></div>

        <div style="display:flex; gap:8px; margin-top:12px;">
          <button class="bigBtn" data-el="readBtn" style="flex:1; padding:13px;">📣 Read it</button>
          <button class="ghostBtn" data-el="resetBtn">Reset</button>
        </div>
        <div style="font-size:11px; color:var(--dim); text-align:center; margin-top:8px;">
          Hands-free: open ✦ and say “third and long”, “red zone”, “read it”, or “explain cover two”.</div>

        <div style="margin-top:18px;">
          <div style="font-weight:700; font-size:13px; margin:0 2px 8px;">Quick reference</div>
          <div data-el="refTabs" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
            ${["coverages","formations","personnel","pressures","tendencies","glossary"].map((k, i) =>
              `<button class="fbChip ${i===0?"on":""}" data-reftab="${k}">${cap(k)}</button>`).join("")}
          </div>
          <div data-el="refCards" style="display:flex; flex-direction:column; gap:8px;"></div>
        </div>
      </div>
    </div>`;
  for (const el of w.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.panel = w;
  wirePanel();
  renderRefCards("coverages");
  renderStatCard();
}

// Highlight class for a field the last scan just filled (fades after a few seconds).
function hit(field) { return justFilled.has(field) ? "fbHit" : ""; }

// A team <select> populated from the provider seam (empty option = none).
function teamSelect(kind, value, label) {
  const teams = dataReady ? footballData.getTeams() : [];
  const opts = [`<option value="">${label}</option>`]
    .concat(teams.map((t) => `<option value="${t}" ${t === value ? "selected" : ""}>${t}</option>`))
    .join("");
  return `<select data-team="${kind}" style="flex:1; min-width:0;">${opts}</select>`;
}

// Live raw numbers for the selected team + situation (readable without the model),
// plus the honesty/attribution note.
function renderStatCard() {
  const host = els.statCard;
  if (!host) return;
  const tend = tendencies();
  const dTend = defenseTendencies();
  if (!tend && !dTend) {
    host.innerHTML = dataReady
      ? '<div style="font-size:11px; color:var(--dim); margin-top:10px;">Pick the teams to see real tendency numbers here.</div>'
      : "";
    return;
  }
  const seasons = (tend || dTend).meta.seasons.join("–");
  const block = (label, colour, lines) => `
      <div style="font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:${colour}; margin:0 0 6px;">${label}</div>
      ${lines.map((l) => `<div style="font-size:12px; color:var(--text); line-height:1.55;">${l}</div>`).join("")}`;
  host.innerHTML = `
    <div style="border:1px solid rgba(255,209,102,0.35); border-radius:12px; background:rgba(255,209,102,0.05); padding:10px 12px; margin-top:10px;">
      ${tend ? block(`${tend.team} OFFENSE · ${seasons}`, "var(--gold)", footballData.cardLines(tend)) : ""}
      ${tend && dTend ? '<div style="height:1px; background:var(--line); margin:8px 0;"></div>' : ""}
      ${dTend ? block(`${dTend.team} DEFENSE · ${seasons}`, "var(--accent)", footballData.defenseCardLines(dTend)) : ""}
      <div style="font-size:10px; color:var(--dim); margin-top:7px; line-height:1.4;">
        Tendencies from public data (nflverse), season-to-date — not a prediction.
        Coverage shells aren't in public data.</div>
    </div>`;
}

function wirePanel() {
  root.addEventListener("click", onPanelClick);
  els.see.addEventListener("change", () => { sit.see = els.see.value; persist(); });
  root.querySelectorAll("[data-team]").forEach((sel) => {
    sel.addEventListener("change", () => { sit[sel.dataset.team] = sel.value; persist(); renderStatCard(); });
  });
  els.clock.addEventListener("change", () => { sit.clock = els.clock.value.trim(); persist(); });
  els.scanBtn.addEventListener("click", startScan);
  els.scanInput.addEventListener("change", () => {
    const f = els.scanInput.files && els.scanInput.files[0];
    if (f) scanFromFile(f);
  });
  renderScanUI();
  els.readBtn.addEventListener("click", async () => {
    els.readBtn.disabled = true;
    els.readBtn.textContent = "Reading…";
    const read = await generateRead();
    els.readBtn.disabled = false;
    els.readBtn.textContent = "📣 Read it";
    svc.speak(read);
    showReadCard(read);
  });
  els.resetBtn.addEventListener("click", () => { sit = freshSituation(); persist(); renderPanel(); });
}

function onPanelClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.down) { sit.down = +d.down; }
  else if (d.dist) { sit.distance = Math.max(0, Math.min(30, sit.distance + (+d.dist))); }
  else if (d.distset) { sit.distance = +d.distset; }
  else if (d.zone) { sit.zone = d.zone; }
  else if (d.qtr) { sit.quarter = +d.qtr; }
  else if (b === els.twoMin) { sit.twoMinute = !sit.twoMinute; }
  else if (d.margin) { sit.margin = Math.max(-40, Math.min(40, sit.margin + (+d.margin))); }
  else if (d.reftab) { root.querySelectorAll("[data-reftab]").forEach((x) => x.classList.toggle("on", x === b)); renderRefCards(d.reftab); return; }
  else return;
  persist();
  // light in-place refresh of the value chips without losing focus/scroll
  refreshValues();
  root.querySelectorAll("[data-down]").forEach((x) => x.classList.toggle("on", +x.dataset.down === sit.down));
  root.querySelectorAll("[data-zone]").forEach((x) => x.classList.toggle("on", x.dataset.zone === sit.zone));
  root.querySelectorAll("[data-qtr]").forEach((x) => x.classList.toggle("on", +x.dataset.qtr === sit.quarter));
  root.querySelectorAll("[data-distset]").forEach((x) => x.classList.toggle("on",
    (+x.dataset.distset === 2 && sit.distance <= 2) || (+x.dataset.distset === 10 && sit.distance >= 7)));
  if (els.twoMin) els.twoMin.classList.toggle("on", sit.twoMinute);
  renderStatCard(); // down/distance/zone changed → refresh the real-numbers card
}

function refreshValues() {
  if (els.distVal) els.distVal.textContent = sit.distance === 0 ? "Goal" : sit.distance;
  if (els.marginVal) els.marginVal.textContent = marginLabel();
}

function renderRefCards(kind) {
  const host = els.refCards;
  if (!host || !ref) { if (host) host.innerHTML = '<div style="color:var(--dim); font-size:12px;">Reference unavailable.</div>'; return; }
  const items = ref[kind] || [];
  host.innerHTML = items.map((it) => {
    if (kind === "glossary") return refCard(it.term, it.def);
    if (kind === "coverages") return refCard(it.name, `<b>Spot:</b> ${it.spot}<br><b>Weakness:</b> ${it.weakness}`);
    if (kind === "personnel") return refCard(it.name, it.detail);
    return refCard(it.name, it.detail);
  }).join("");
}
function refCard(title, body) {
  return `<div style="border:1px solid var(--line); border-radius:11px; background:var(--panel); padding:9px 11px;">
    <div style="font-weight:600; font-size:12.5px;">${title}</div>
    <div style="font-size:11.5px; color:var(--dim); line-height:1.5; margin-top:3px;">${body}</div></div>`;
}

function showReadCard(read) {
  if (!els.readCard) {
    els.readCard = document.createElement("div");
    els.readCard.style.cssText = "border:1px solid rgba(77,163,255,0.4); border-radius:12px; background:rgba(77,163,255,0.06); padding:11px 13px; margin-top:10px; font-size:13px; line-height:1.5; white-space:pre-wrap;";
    els.readBtn.parentElement.after(els.readCard);
  }
  els.readCard.textContent = read;
}

function marginLabel() {
  if (sit.margin === 0) return "Even";
  return (sit.margin > 0 ? "Up " : "Down ") + Math.abs(sit.margin);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }
