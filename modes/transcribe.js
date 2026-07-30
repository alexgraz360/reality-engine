// Reality Engine · Transcribe — record a meeting or class, then ask about it later.
//
// Record → local Whisper on your own bridge → transcript → a chunked summary →
// pushed into the EXISTING memory store so "what did we decide about the budget?"
// answers a week later through the normal recall path. No second retrieval system.
//
// HARD RULES BUILT IN:
//   • Never ambient, never auto-start. Recording begins only on an explicit tap.
//   • An obvious indicator with elapsed time is visible the whole time it runs.
//   • Raw audio is deleted on the bridge after transcription by default.
//   • Everything stays on the user's own machine.
//
// Transcription is an ASYNC JOB: uploading returns a job id and we poll. The app
// stays fully usable while a session processes — you can leave the mode and come
// back, because sessions and polling live at module scope, not in the DOM.

let root, svc, store, els = {};
let sessions = [];            // persisted: [{id,title,ts,durationMs,status,progress,text,summary,points,memIds,error}]
let recorder = null, chunks = [], recStream = null;
let recording = false, recStartAt = 0, tickTimer = 0;
let pendingTitle = "";   // a name heard in the utterance, used by the next session
let pollTimers = {};          // sessionId -> interval id
let consentSeen = false;

const MAX_MS = 90 * 60 * 1000;        // hard stop at 90 minutes
const CHUNK_WORDS = 900;              // map-reduce chunk size (well inside context)

// Pick a container the browser ACTUALLY supports. iOS Safari gives mp4/AAC and
// does not support webm at all, so assuming webm/opus would silently fail there.
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/mp4",                    // iOS Safari
    "audio/mp4;codecs=mp4a.40.2",
    "audio/webm;codecs=opus",       // Chrome/Firefox
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return "";                        // let the browser choose its default
}
function extFor(mime) {
  if (/mp4|aac|m4a/i.test(mime)) return "m4a";
  if (/webm/i.test(mime)) return "webm";
  if (/ogg/i.test(mime)) return "ogg";
  if (/wav/i.test(mime)) return "wav";
  return "m4a";
}

function persist() { store.set("sessions", sessions.map((s) => ({ ...s, _blob: undefined }))); }
function fmtDur(ms) {
  const t = Math.round(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------- recording
async function startRecording() {
  if (recording) return;
  if (typeof MediaRecorder === "undefined") { note("This browser can't record audio — nothing to do here."); return; }
  let stream;
  try {
    stream = await svc.sensors.requestMic ? await svc.sensors.requestMic() : await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    note("Microphone access was denied — recording needs the mic.");
    return;
  }
  const mime = pickMime();
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (err) {
    try { recorder = new MediaRecorder(stream); } catch (e2) { note("Couldn't start the recorder here."); return; }
  }
  recStream = stream;
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => finishRecording();
  recorder.start(1000);              // gather in 1s slices so a long run is safe
  recording = true;
  recStartAt = Date.now();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    renderIndicator();
    if (Date.now() - recStartAt > MAX_MS) stopRecording();
  }, 1000);
  renderIndicator();
  render();
}

function stopRecording() {
  if (!recording || !recorder) return;
  recording = false;
  clearInterval(tickTimer);
  try { recorder.stop(); } catch (e) { finishRecording(); }
}

function releaseMic() {
  if (recStream) { try { recStream.getTracks().forEach((t) => t.stop()); } catch (e) {} recStream = null; }
  if (svc && svc.sensors && svc.sensors.releaseStream) { try { svc.sensors.releaseStream(recStream); } catch (e) {} }
}

async function finishRecording() {
  const durationMs = Date.now() - recStartAt;
  releaseMic();
  renderIndicator();
  const mime = (recorder && recorder.mimeType) || "audio/mp4";
  const blob = new Blob(chunks, { type: mime });
  chunks = [];
  recorder = null;
  if (blob.size < 2000) { note("That was too short to transcribe."); render(); return; }

  const session = {
    // A name resolved from speech ("record this standup") wins over the dated
    // default; it's consumed here so it can't leak into the next recording.
    id: "s" + Date.now().toString(36), title: pendingTitle || `Session ${fmtDate(Date.now())}`,
    ts: Date.now(), durationMs, status: "uploading", progress: 0,
    text: "", summary: "", points: [], memIds: [], sizeKB: Math.round(blob.size / 1024),
  };
  sessions.unshift(session);
  persist(); render();

  const b64 = await blobToBase64(blob);
  const res = await svc.companion.transcribeStart(b64, { format: extFor(mime) });
  if (!res.ok) {
    session.status = "error"; session.error = res.text || "Upload failed.";
    persist(); render(); return;
  }
  session.jobId = res.jobId;
  session.status = "transcribing";
  persist(); render();
  pollSession(session.id);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- polling
// Module-scope, so leaving the mode never interrupts a job.
function pollSession(id) {
  clearInterval(pollTimers[id]);
  pollTimers[id] = setInterval(async () => {
    const s = sessions.find((x) => x.id === id);
    if (!s || !s.jobId) { clearInterval(pollTimers[id]); return; }
    const st = await svc.companion.transcribeStatus(s.jobId);
    if (!st.ok) {
      if (st.reason === "gone") { s.status = "error"; s.error = "The job expired on the bridge."; clearInterval(pollTimers[id]); persist(); render(); }
      return;                       // transient (offline) → keep polling
    }
    s.progress = typeof st.progress === "number" ? st.progress : s.progress;
    if (st.status === "done") {
      clearInterval(pollTimers[id]);
      s.text = st.text || "";
      s.audioSeconds = st.audioSeconds; s.rate = st.rate;
      s.status = s.text ? "summarizing" : "empty";
      persist(); render();
      if (s.text) summarizeSession(id);
    } else if (st.status === "error") {
      clearInterval(pollTimers[id]);
      s.status = "error"; s.error = st.error || "Transcription failed.";
      persist(); render();
    } else {
      s.status = "transcribing";
      render();
    }
  }, 3000);
}

// ---------------------------------------------------------------- summarize
// MAP-REDUCE: an hour of speech is far past the local model's context, so we
// summarize each chunk, then summarize the summaries. Never one giant prompt.
function chunkTranscript(text, maxWords = CHUNK_WORDS) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(" "));
  return out.length ? out : [""];
}

async function summarizeSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s || !s.text) return;
  const parts = chunkTranscript(s.text);
  s.chunkCount = parts.length;
  persist(); render();
  try {
    // MAP: one short summary per chunk.
    const partial = [];
    for (let i = 0; i < parts.length; i++) {
      s.progress = 0.1 + 0.7 * (i / parts.length);
      render();
      const r = await svc.companion.ask(
        "Summarise this part of a meeting transcript in at most 60 words. Keep any decisions, " +
        "numbers, dates and action items. Plain prose, no preamble.\n\n" + parts[i],
        "", [], { maxTokens: 140, temperature: 0.1, stable: true });
      partial.push(r.ok && r.text ? r.text.trim() : "");
    }
    // REDUCE: one short summary + key points from the partials only.
    s.progress = 0.85; render();
    const joined = partial.filter(Boolean).join("\n\n");
    const r2 = await svc.companion.ask(
      "These are summaries of consecutive parts of one meeting. Write:\n" +
      "SUMMARY: two or three sentences covering the whole meeting.\n" +
      "POINTS: up to five bullet lines, each starting with '- ', covering decisions and action items " +
      "(include who owns an action if it is stated).\n" +
      "Use only what is in the text. Do not invent anything.\n\n" + joined,
      "", [], { maxTokens: 320, temperature: 0.1, stable: true });
    const out = (r2.ok && r2.text) ? r2.text : joined;
    const sum = (out.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*POINTS:|$)/i) || [])[1];
    const pts = (out.match(/POINTS:\s*([\s\S]*)$/i) || [])[1];
    s.summary = (sum || out).trim().slice(0, 900);
    s.points = (pts || "").split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
      .filter((l) => l.length > 2).slice(0, 6);
    s.status = "ready"; s.progress = 1;
    persist(); render();
    await pushToMemory(id);
    emitReadyCard(s);
  } catch (err) {
    console.error("transcribe: summarize failed", err);
    s.status = "ready"; s.summary = s.summary || "(summary unavailable — the transcript is still here)";
    persist(); render();
  }
}

// ---------------------------------------------------------------- memory
// The whole point: the summary lands in the EXISTING personal memory store, so
// recall works through the path that already exists — no second retrieval system.
async function pushToMemory(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s || !s.summary) return;
  const when = new Date(s.ts).toLocaleDateString([], { month: "long", day: "numeric" });
  const body = `Meeting on ${when} — ${s.title}.\n${s.summary}` +
    (s.points.length ? `\nKey points: ${s.points.join("; ")}` : "");
  try {
    const meta = { scope: "personal", kind: "session", subject: s.title, ts: s.ts, source: "said" };
    const r = await svc.knowledge.add(body, { title: s.title, pack: "my-memories", meta });
    s.memIds = [s.title];         // matched by subject on delete
    s.inMemory = true;
    persist(); render();
    return r;
  } catch (err) {
    console.warn("transcribe: couldn't store the summary in memory —", err && err.message);
    s.memoryError = true; persist(); render();
  }
}

async function deleteSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  clearInterval(pollTimers[id]); delete pollTimers[id];
  // Remove the memory entries this session created, so a delete really is a
  // delete — transcript, summary AND what it put in your memories.
  if (s.inMemory) {
    try {
      const mems = await svc.knowledge.personal();
      for (const m of mems) {
        if (m.kind === "session" && (m.subject === s.title || Math.abs((m.ts || 0) - s.ts) < 5000)) {
          await svc.knowledge.remove(m.id);
        }
      }
    } catch (err) { console.warn("transcribe: memory cleanup failed —", err && err.message); }
  }
  sessions = sessions.filter((x) => x.id !== id);
  persist(); render();
  // The bridge deletes the uploaded audio automatically after transcription, so
  // there is nothing else to clean up there.
}

// ---------------------------------------------------------------- glance cards
function emitReadyCard(s) {
  if (!svc.glasses) return;
  svc.glasses.send({
    title: "Session ready", lines: svc.glasses.wrap(s.summary, 24, 3),
    spoken: `Session ready. ${s.summary}`, holdMs: 8000,
  });
}
function glanceCard() {
  if (recording) {
    return { title: "● Recording", lines: [fmtDur(Date.now() - recStartAt), "tap Stop when done"],
             spoken: "", holdMs: 3000 };
  }
  const s = sessions.find((x) => x.status === "ready");
  if (!s) return null;
  return { title: String(s.title).slice(0, 20), lines: svc.glasses ? svc.glasses.wrap(s.summary, 24, 3) : [s.summary.slice(0, 24)],
           spoken: s.summary, holdMs: 8000 };
}

// ---------------------------------------------------------------- rendering
function note(t) { if (els.note) els.note.textContent = t; }
function renderIndicator() {
  const el = els.recIndicator;
  if (!el) return;
  el.style.display = recording ? "flex" : "none";
  if (recording && els.recElapsed) els.recElapsed.textContent = fmtDur(Date.now() - recStartAt);
}

function statusLine(s) {
  switch (s.status) {
    case "uploading": return "uploading…";
    case "transcribing": return `transcribing… ${Math.round((s.progress || 0) * 100)}%`;
    case "summarizing": return `summarising${s.chunkCount ? ` (${s.chunkCount} chunk${s.chunkCount > 1 ? "s" : ""})` : ""}… ${Math.round((s.progress || 0) * 100)}%`;
    case "ready": return `ready${s.inMemory ? " · in your memories" : ""}`;
    case "empty": return "no speech detected";
    case "error": return `error — ${s.error || "unknown"}`;
    default: return s.status;
  }
}

function render() {
  if (!root) return;
  root.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 8px;">
          <span style="font-size:22px;">🎙</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Transcribe</div>
            <div style="font-size:11px; color:var(--dim);">Record, transcribe on your own bridge, then ask about it later.</div>
          </div>
        </div>

        <div data-el="recIndicator" style="display:${recording ? "flex" : "none"}; align-items:center; gap:9px;
          background:rgba(190,40,40,0.95); color:#fff; border-radius:12px; padding:10px 13px; margin-bottom:10px;
          font-family:var(--mono); font-size:13px;">
          <span style="width:10px; height:10px; border-radius:50%; background:#fff; animation:pulse 1.1s infinite;"></span>
          <strong>RECORDING</strong><span data-el="recElapsed">0:00</span>
          <span style="flex:1"></span><span style="font-size:10px; opacity:0.85;">foreground only</span>
        </div>

        <div style="display:flex; gap:8px;">
          <button class="bigBtn" data-el="recBtn" style="flex:1; padding:13px;">
            ${recording ? "⏹ Stop recording" : "● Start recording"}</button>
        </div>
        <div data-el="note" style="font-size:11.5px; color:var(--warn); min-height:15px; margin-top:6px; line-height:1.45;"></div>

        <div style="font-size:10px; color:var(--dim); margin-top:6px; line-height:1.5;">
          Nothing is recorded until you tap Start — there's no background or ambient listening.
          Recording only runs while this screen is open. Audio goes to your own bridge, is transcribed there,
          and the audio file is <strong>deleted straight after</strong>; the transcript and summary stay on your machine.
        </div>
        <div style="font-size:10px; color:var(--dim); margin-top:6px; line-height:1.5;">
          Recording other people has consent and legal implications that vary by where you are, so it's worth
          telling people you're recording. (Not legal advice.)
        </div>
        <div style="font-size:10px; color:var(--dim); margin-top:6px; line-height:1.5;">
          <strong>Honest limits:</strong> transcription runs on CPU at roughly <strong>4× real time</strong>
          (about 15 minutes of audio per minute of processing) — a long meeting takes a few minutes to come back.
          Accuracy drops with background noise, strong accents, crosstalk and distance from the mic.
          There are <strong>no speaker labels</strong> — it won't tell you who said what.
        </div>

        <div style="font-weight:700; font-size:13px; margin:16px 2px 8px;">Sessions</div>
        <div data-el="list"></div>
      </div>
    </div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  els.recBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
  renderList();
  renderIndicator();
}

function renderList() {
  const host = els.list;
  if (!host) return;
  if (!sessions.length) {
    host.innerHTML = '<div class="nrEmpty">No sessions yet — tap Start recording.</div>';
    return;
  }
  host.innerHTML = "";
  for (const s of sessions) {
    const card = document.createElement("div");
    card.style.cssText = "border:1px solid var(--line); border-radius:12px; background:var(--panel-solid); padding:11px 12px; margin-bottom:8px;";
    const done = s.status === "ready";
    card.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(s.title)}</div>
          <div style="font-family:var(--mono); font-size:10.5px; color:var(--dim); margin-top:2px;">
            ${fmtDate(s.ts)} · ${fmtDur(s.durationMs)} · ${statusLine(s)}</div>
        </div>
        <button class="nrDel" data-rename="${s.id}">Rename</button>
        <button class="nrDel" data-del="${s.id}">Delete</button>
      </div>
      ${!done && s.status !== "error" && s.status !== "empty" ? `
        <div style="height:4px; background:var(--line); border-radius:2px; margin-top:8px; overflow:hidden;">
          <div style="height:100%; width:${Math.round((s.progress || 0) * 100)}%; background:var(--accent); transition:width .4s;"></div>
        </div>
        <div style="font-size:10px; color:var(--dim); margin-top:5px;">You can leave this screen — it keeps working.</div>` : ""}
      ${done && s.summary ? `<div style="font-size:12.5px; line-height:1.5; margin-top:8px;">${escapeHtml(s.summary)}</div>` : ""}
      ${done && s.points.length ? `<ul style="margin:8px 0 0 16px; padding:0; font-size:12px; line-height:1.55; color:var(--text);">
        ${s.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}
      ${s.text ? `<details style="margin-top:8px;"><summary style="font-size:11px; color:var(--dim); cursor:pointer;">full transcript</summary>
        <div style="font-size:11.5px; color:var(--dim); line-height:1.55; margin-top:6px; white-space:pre-wrap;">${escapeHtml(s.text)}</div></details>` : ""}`;
    host.appendChild(card);
  }
  host.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const s = sessions.find((x) => x.id === b.dataset.del);
    if (!s) return;
    if (!confirm(`Delete “${s.title}”?\n\nThis removes the recording, transcript, summary and what it added to your memories.`)) return;
    await deleteSession(b.dataset.del);
  }));
  host.querySelectorAll("[data-rename]").forEach((b) => b.addEventListener("click", () => {
    const s = sessions.find((x) => x.id === b.dataset.rename);
    if (!s) return;
    const next = prompt("Rename this session:", s.title);
    if (next === null || !next.trim()) return;
    s.title = next.trim().slice(0, 80);
    persist(); render();
  }));
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- mode API
export default {
  id: "transcribe",
  title: "Transcribe · record & recall",
  icon: "🎙",
  family: "Live",
  permissions: ["mic"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("transcribe");
    sessions = store.get("sessions") || [];
    consentSeen = !!store.get("consentSeen");
    // Anything left mid-flight from a previous visit resumes its polling.
    for (const s of sessions) {
      if (s.status === "transcribing" && s.jobId) pollSession(s.id);
      else if (s.status === "uploading") { s.status = "error"; s.error = "Upload was interrupted."; }
    }
    if (!consentSeen) { store.set("consentSeen", true); consentSeen = true; }
    render();
  },
  async start() {},
  // Leaving the mode or backgrounding the app stops recording — a phone web app
  // can't record reliably in the background, and we won't pretend otherwise.
  stop() { if (recording) stopRecording(); },
  teardown() { if (recording) stopRecording(); releaseMic(); els = {}; root = null; },

  getContext() {
    if (recording) return `Transcribe mode — recording, ${fmtDur(Date.now() - recStartAt)} so far.`;
    const busy = sessions.filter((s) => s.status === "transcribing" || s.status === "summarizing").length;
    const ready = sessions.filter((s) => s.status === "ready");
    let out = `Transcribe mode. ${sessions.length} session${sessions.length === 1 ? "" : "s"}` +
      (busy ? `, ${busy} still processing` : "") + ".";
    if (ready[0]) out += ` Most recent: “${ready[0].title}” — ${ready[0].summary.slice(0, 200)}`;
    return out;
  },

  handleCommand(text) {
    const q = String(text || "").toLowerCase().trim();
    if (/^(start recording|record this|start the recording)$/.test(q)) { startRecording(); return "Recording."; }
    if (/^(stop recording|stop the recording|stop)$/.test(q) && recording) { stopRecording(); return "Stopped — transcribing now."; }
    return null;
  },

  // Voice router: start/stop from anywhere. Asking about what was said is
  // deliberately NOT claimed — the normal recall path already answers it from
  // the memory entries this mode writes.
  // ---------------------------------------------------------------- slots
  // One optional slot: what to call this recording. "Record this standup" names
  // it without a keyboard, and an unnamed session still gets the dated default —
  // recording must never wait behind a question, because by the time you've
  // answered, the thing you wanted to capture has been said.
  //
  // NOT a slot: consent. The recording gate and the "never ambient, off by
  // default" rule are untouched — a slot only ever supplies a title.
  describeSlots() {
    return [{
      id: "sessionTitle", label: "a name for this recording", required: false,
      sources: ["utterance"],
      parse: (t) => {
        const s = String(t || "").trim();
        const m = s.match(/\brecord (?:this|the)\s+([\w' -]{2,40})/i)
          || s.match(/\b(?:call|name) (?:it|this)\s+([\w' -]{2,40})/i);
        if (!m) return null;
        const v = m[1].trim().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
        // "record this meeting" is the generic phrasing, not a name.
        return /^(meeting|call|class|thing|it|session)$/i.test(v) ? null : v.charAt(0).toUpperCase() + v.slice(1);
      },
      current: () => pendingTitle || null,
      default: null,             // no default: the dated title is already good
      apply: (v) => { pendingTitle = v; },
      say: (v) => `calling it ${v}`,
    }];
  },

  describeCapabilities() {
    return [
      { id: "transcribe.start", label: "Transcribe", needsMode: true, sideEffect: true, fillsSlots: true,
        patterns: [/\b(start|begin) recording\b/i, /\brecord (this|the) (meeting|class|call)\b/i],
        examples: ["start recording", "record this meeting"],
        run: () => { startRecording(); return "Recording — tap Stop when you're done."; } },
      { id: "transcribe.stop", label: "Stop recording", needsMode: true,
        patterns: [/\bstop recording\b/i],
        examples: ["stop recording"],
        run: () => { if (!recording) return null; stopRecording(); return "Stopped — transcribing now."; } },
    ];
  },

  getGlanceCard() { return glanceCard(); },

  // verification hooks (#debug)
  _state: () => ({ recording, sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, progress: s.progress, inMemory: s.inMemory, points: s.points, summary: s.summary })) }),
  _pickMime: () => pickMime(),
  _chunk: (t, n) => chunkTranscript(t, n),
  _addSession: (s) => { sessions.unshift(s); persist(); render(); return s.id; },
  _summarize: (id) => summarizeSession(id),
  _pushToMemory: (id) => pushToMemory(id),
  _delete: (id) => deleteSession(id),
  _glance: () => glanceCard(),
  _setRecording: (v) => { recording = v; recStartAt = Date.now(); renderIndicator(); render(); },
};
