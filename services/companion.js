// Reality Engine · services/companion — the AI companion (Phase 0: local brain, text-first).
//
// The companion answers questions grounded in the active mode's getContext() string.
// It talks to a personal bridge (a token-gated proxy in front of a local model on the
// user's own machine, reached over HTTPS via a tunnel). NOTHING secret lives in this
// repo: the endpoint URL + token are entered in Settings → Companion and stored in
// localStorage on the device only. If unconfigured, ask() returns the stub message.
//
// Contract (stable since RE0):
//   ask(prompt, context) → Promise<{ ok, text, source, stats? }>
//     prompt  — the user's question
//     context — the active mode's getContext() string ("" if nothing meaningful)
//
// SAFETY: Phase 0 is Q&A ONLY — the companion takes no actions. When tools/actions
// arrive in a later phase, every side-effectful action (send / post / delete / pay)
// must pass a confirmation gate first.
//
// Fast-follow (not required for P0): voice input via the Web Speech API.

import storage from "./storage.js";
import knowledge from "./knowledge.js";
import tokens from "./tokens.js";

const SYSTEM_PROMPT =
  "You are the Reality Engine companion — a knowledgeable, concise assistant for astronomy, " +
  "physics, and the wider world, living inside an open, phone-first platform of swappable " +
  "reality modes. If a context line describes what the user is doing or seeing right now, " +
  "ground your answer in it; if there is no context line, simply answer from your knowledge. " +
  "Answer in 2–4 short sentences of plain text — the reply may be spoken aloud. Recent turns " +
  "of this conversation may precede the question; use them to resolve follow-ups.\n\n" +
  "LOCAL ACTIONS: you can help manage the user's on-device notes and reminders. When — and " +
  "ONLY when — the user clearly asks to create, list, or delete a note or reminder, reply " +
  "with ONE short sentence followed by a fenced JSON block, exactly like:\n" +
  "```json\n{\"action\":\"add_note\",\"note\":\"buy milk\"}\n```\n" +
  "Valid forms: {\"action\":\"add_note\",\"note\":\"...\"} · {\"action\":\"list_notes\"} · " +
  "{\"action\":\"delete_note\",\"match\":\"text to match\"} · " +
  "{\"action\":\"add_reminder\",\"text\":\"...\",\"when\":\"YYYY-MM-DDTHH:MM\"} (local time; " +
  "resolve relative times like 'in 10 minutes' or 'at 6pm' using the current date/time " +
  "provided) · {\"action\":\"list_reminders\"} · {\"action\":\"delete_reminder\",\"match\":\"...\"} · " +
  "{\"action\":\"remember\",\"text\":\"the fact to keep\",\"topic\":\"short label\",\"kind\":\"thing|person|fact|place\"," +
  "\"subject\":\"what it is about\"} when the user tells " +
  "you to remember a lasting fact, a personal detail, where something is, or who someone is " +
  "(\"remember that my oven runs hot\", \"remember I put my passport in the desk drawer\", " +
  "\"this is Maya, she works with Sam\") — that goes into their knowledge library and comes back to " +
  "you in future answers, unlike a note, which is just a list item they read themselves. " +
  "Use kind 'thing' for where an object is, 'person' for who someone is, 'place' for a location " +
  "detail, otherwise 'fact'; subject is the short thing it is about (e.g. \"passport\", \"Maya\"). " +
  "{\"action\":\"forget\",\"match\":\"...\"} when the user asks you to forget or delete something " +
  "they told you to remember. " +
  "The app shows the user a confirmation before anything is saved or deleted, so never claim " +
  "an action is already done — say what you're proposing. Never emit an action block the user " +
  "didn't clearly ask for; for everything else reply normally with no JSON and no code blocks. " +
  "You cannot control devices or reach anything outside this device.";

const ASK_TIMEOUT_MS = 120_000; // local CPU inference can be slow, esp. the first answer

// ---------------------------------------------------------------- context size
//
// The bridge is the only thing that knows what num_ctx it set, so it reports it
// on /health and every /chat answer, and we cache the last value we were told.
// Until we've been told, the fallback is used — deliberately the same 8192 the
// bridge defaults to, and corrected the first time either endpoint answers.
//
// This matters more than it looks: a guard hardcoded at 8192 in front of a
// bridge running 4096 would pass prompts straight through to the truncation it
// exists to prevent.
let knownContextTokens = tokens.DEFAULT_CONTEXT_TOKENS;
let contextTokensSource = "default";
function noteContextTokens(n, source) {
  const v = Number(n);
  if (Number.isFinite(v) && v >= 512 && v <= 1_000_000) {
    knownContextTokens = v;
    contextTokensSource = source;
  }
}

// Copy/paste (especially on iOS) can smuggle in spaces, newlines, and even invisible
// characters (zero-width space, BOM, NBSP) that .trim() alone won't remove — any of
// which makes the bridge reject the token. Scrub aggressively: neither a bearer token
// nor a URL legitimately contains whitespace of any kind.
function scrub(value) {
  // \u200B-\u200D zero-width chars, \u2060 word joiner, \uFEFF BOM;
  // \s covers the rest (incl. NBSP).
  return (value || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, "");
}
function scrubEndpoint(value) {
  return scrub(value).replace(/\/+$/, ""); // also drop trailing slash(es)
}

// ---------------------------------------------------------------- failure copy
// "Couldn't reach the bridge — is the host machine awake?" was the message for
// every failure of five different processes, and it cost us real time chasing a
// sleep theory for what was a dead OCR sidecar. Two facts are available at the
// moment of failure and both are certain, so neither needs guessing:
//
//   • the fetch THREW      -> nothing answered; the proxy or the tunnel is down
//   • the fetch returned !ok -> the proxy is up, so its DEPENDENCY is what broke
//
// Each route names the piece it depends on, and both messages point at
// Diagnostics, which can say definitively which of the five it is.
const DEPENDS_ON = {
  chat: "Ollama (the local model)",
  vision: "the vision model (moondream on Ollama)",
  ocr: "the OCR sidecar (port 8788)",
  scoreboard: "the OCR sidecar (port 8788)",
  transcribe: "the Whisper sidecar (port 8789)",
  tts: "Piper (the local voices)",
  knowledge: "Ollama (embeddings for the knowledge library)",
};
const SEE_DIAG = "Settings → Diagnostics says which piece is actually down.";

// Nothing answered at all.
function offlineText(what) {
  return `Couldn't reach the bridge${what ? " for " + what : ""} — the proxy isn't answering, so either the ` +
    `host machine is off or the Tailscale funnel is down. ${SEE_DIAG}`;
}
// The proxy answered, but the thing behind it is broken.
function dependencyText(kind) {
  return `The bridge is up but ${DEPENDS_ON[kind] || "the piece this needs"} isn't responding. ${SEE_DIAG}`;
}

export const companion = {
  isConfigured() {
    return Boolean(storage.get("companion.endpoint") && storage.get("companion.token"));
  },

  getConfig() {
    return {
      endpoint: storage.get("companion.endpoint", ""),
      token: storage.get("companion.token", ""),
    };
  },

  setConfig(endpoint, token) {
    endpoint = scrubEndpoint(endpoint);
    token = scrub(token);
    if (endpoint) storage.set("companion.endpoint", endpoint); else storage.remove("companion.endpoint");
    if (token) storage.set("companion.token", token); else storage.remove("companion.token");
  },

  // ---- warm on intent (bridge POST /warm) ----
  //
  // THE MEASURED WIN. Cold, the first token takes ~7.3 s; warm, ~340 ms. Firing
  // this the moment the app knows a request is LIKELY — a mode opening, the mic
  // opening, the wake word firing — overlaps the model load with the second or
  // two the user is still acting, and costs no standing RAM (unlike pinning,
  // which was measured and rejected at 4.7 GB and 97.5% of the commit limit).
  //
  // THIS IS AN OPTIMIZATION, NEVER A DEPENDENCY. It cannot block, cannot throw,
  // cannot be awaited into a UI path, and no failure of it — error, 404 on an
  // older bridge, or a hang — may change one pixel of what the user sees. Every
  // exit below returns a reason string for the verification harness and nothing
  // else acts on it.
  _warm: {
    lastAt: 0,          // last SUCCESSFUL dispatch, for the idle-window debounce
    inFlight: false,    // never more than one at a time
    lastRole: null,
    calls: [],          // verification only: what actually went out
  },

  // Roughly one warm per idle minute. Opening four modes in ten seconds must
  // produce ONE call — a warm-on-intent that spams the bridge is worse than none.
  warmDebounceMs: 60_000,

  warmOnIntent(role = "chat", { reason = "" } = {}) {
    const w = this._warm;
    const now = Date.now();
    // Silence beats a doomed request.
    if (!this.isConfigured()) return "skipped:unconfigured";
    if (w.inFlight) return "skipped:in-flight";
    if (now - w.lastAt < this.warmDebounceMs) return "skipped:debounced";
    // If the bridge is known to be down there is no point asking it to warm.
    if (this._lastHealthOk === false) return "skipped:bridge-known-down";
    // Already resident: warming again buys nothing.
    if (role === "chat" && this._lastWarm && this._lastWarm.chat) return "skipped:already-warm";
    if (role === "vision" && this._lastWarm && this._lastWarm.vision) return "skipped:already-warm";

    w.inFlight = true;
    w.lastAt = now;
    w.lastRole = role;
    w.calls.push({ role, reason, at: now });
    if (w.calls.length > 50) w.calls = w.calls.slice(-50);

    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const clearFlag = () => { w.inFlight = false; };
    // TWO independent releases of the in-flight flag, because verification found
    // one wasn't enough. Aborting the signal normally makes fetch reject, which
    // runs .finally() — but a fetch that IGNORES the abort (a stalled proxy, a
    // service worker, a stub) would leave inFlight stuck true forever and
    // silently disable warming for the rest of the session. So a plain timer
    // clears it regardless of what fetch decides to do.
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const failsafe = setTimeout(clearFlag, 6000);
    fetch(scrubEndpoint(cfg.endpoint) + "/warm", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
      body: JSON.stringify({ role }),
      signal: ctrl.signal,
    })
      .then((r) => { if (!r.ok) console.debug(`warm: bridge said ${r.status} (ignored)`); })
      // Swallowed on purpose: an older bridge 404s here and that must be a no-op.
      .catch((e) => console.debug("warm: ignored —", (e && e.name) || e))
      .finally(() => { clearTimeout(timer); clearTimeout(failsafe); clearFlag(); });

    return "sent:" + role;
  },

  // ---- context window, for callers that must size their own work ----
  //
  // Transcription's map-reduce has to decide how many partial summaries can go
  // into one reduce prompt, and that decision has to be made BEFORE any request
  // exists to measure. It asks here rather than hardcoding a number.
  contextTokens() { return knownContextTokens; },
  contextTokensSource() { return contextTokensSource; },
  promptBudget() { return tokens.promptBudget(knownContextTokens); },

  // ---- diagnostics (bridge GET /health with the token) ----
  //
  // The bridge is five independent pieces and for a long time any failure showed
  // up here as one vague "bridge unreachable", which sent us hunting a
  // machine-sleep theory that was never the cause. The bridge now reports each
  // piece separately; this just relays it, and — importantly — describes the
  // failure modes the app can see that the BRIDGE cannot report on, because if
  // the proxy is down it can't tell you it's down.
  async health({ timeoutMs = 6000 } = {}) {
    if (!this.isConfigured()) {
      return { reachable: false, status: "unconfigured", summary:
        "No bridge configured yet — add the endpoint and token in Settings → Companion, or scan the bridge QR.", pieces: [] };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const cfg = this.getConfig();
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/health", {
        headers: { authorization: "Bearer " + scrub(cfg.token) },
        signal: ctrl.signal,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        return { reachable: true, status: "degraded-core", ms, pieces: [],
          summary: `The proxy answered with an error (${r.status}) — the bridge is running but something is wrong with it.` };
      }
      const data = await r.json();
      // A shallow reply means the token didn't match: the proxy deliberately
      // returns the unauthenticated body rather than leaking anything.
      if (!Array.isArray(data.pieces)) {
        return { reachable: true, status: "unauthorized", ms, pieces: [],
          summary: "The proxy is up but it didn't accept the token — re-check the token in Settings → Companion." };
      }
      // Cache what warmOnIntent needs so it can skip pointless calls without
      // making a request of its own to find out.
      this._lastHealthOk = true;
      const ollama = (data.pieces || []).find((p) => p.id === "ollama");
      this._lastWarm = (ollama && ollama.warm) || null;
      // Learn the real context window from the bridge rather than assuming it.
      if (ollama) noteContextTokens(ollama.numCtx, "health");
      return { reachable: true, ms, ...data };
    } catch (err) {
      // Nothing answered at all. Say which of the two plausible causes it is
      // rather than blaming "the bridge" as a lump.
      const timedOut = err && err.name === "AbortError";
      // Remember the bridge is down so warmOnIntent stays quiet instead of
      // firing requests that cannot succeed.
      this._lastHealthOk = false;
      this._lastWarm = null;
      return {
        reachable: false,
        status: "offline",
        ms: Date.now() - t0,
        pieces: [],
        summary: timedOut
          ? `Nothing answered within ${Math.round(timeoutMs / 1000)}s. The tunnel resolved but the proxy didn't reply — the host machine may be busy or asleep.`
          : "Couldn't reach the proxy at all. Either the host machine is off, the Tailscale funnel is down, or the endpoint URL changed (Settings → Companion).",
        fix: "On the host machine, run:  powershell -ExecutionPolicy Bypass -File C:\\Projects\\companion-bridge\\start-bridge.ps1",
      };
    } finally {
      clearTimeout(timer);
    }
  },

  // ---- local Piper voices (bridge /tts) ----
  // Available voices for the picker; [] when unconfigured/unreachable/none.
  async getVoices() {
    if (!this.isConfigured()) return [];
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/tts/voices", {
        headers: { authorization: "Bearer " + scrub(cfg.token) },
        signal: ctrl.signal,
      });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data.voices) ? data.voices : [];
    } catch (err) {
      return [];
    } finally {
      clearTimeout(timer);
    }
  },

  // Synthesize one chunk with a Piper voice; resolves to an audio Blob.
  // Throws on any failure — the caller falls back to speechSynthesis.
  async tts(text, voiceId, rate = 1) {
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/tts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
        body: JSON.stringify({ text, voiceId, rate }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error("tts " + r.status);
      return await r.blob();
    } finally {
      clearTimeout(timer);
    }
  },

  // ---- on-demand vision (bridge /vision) ----
  // ONE downscaled frame, sent ONLY to the user's own bridge. CPU vision is
  // slow (seconds to tens of seconds) — generous timeout, graceful errors.
  async vision(imageBase64, prompt) {
    if (!this.isConfigured()) {
      return { ok: false, text: "The companion isn't configured yet — add your bridge in Settings first." };
    }
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/vision", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
        body: JSON.stringify({ imageBase64, prompt }),
        signal: ctrl.signal,
      });
      if (r.status === 401) return { ok: false, text: "The bridge rejected the token — re-check Settings → Companion." };
      if (r.status === 429) return { ok: false, text: "Vision is rate limited (it's heavy) — wait a minute and try again." };
      if (r.status === 400) return { ok: false, text: "The bridge refused the image — it may be too large. Try again." };
      if (!r.ok) return { ok: false, text: dependencyText("vision") };
      const data = await r.json();
      if (!data || typeof data.text !== "string" || !data.text) {
        return { ok: false, text: "The vision model returned an empty answer — try again." };
      }
      return { ok: true, text: data.text, stats: data.stats || null };
    } catch (err) {
      return {
        ok: false,
        text: err && err.name === "AbortError"
          ? "Vision took too long (over 2 minutes) — the box may be busy; try again."
          : offlineText("vision"),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  // ---- scoreboard OCR (bridge /scoreboard) ----
  // ONE downscaled frame of a TV score bug → { parsed fields, rawText }. Fields
  // the bridge could not read clearly come back null and stay manual — it never
  // fabricates. Image goes only to the user's own bridge, same as vision.
  // ---- transcription (bridge /transcribe) — ASYNC JOBS ----
  // Submitting returns a job id immediately; the caller polls. A long recording
  // takes minutes of CPU, so this must never be a blocking request.
  async transcribeStart(audioBase64, { format = "m4a", keepAudio = false } = {}) {
    if (!this.isConfigured()) {
      return { ok: false, reason: "unconfigured", text: "The companion isn't configured yet — add your bridge in Settings first." };
    }
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);   // the UPLOAD may be large
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
        body: JSON.stringify({ audioBase64, format, keepAudio }),
        signal: ctrl.signal,
      });
      if (r.status === 401) return { ok: false, reason: "unauthorized", text: "The bridge rejected the token — re-check Settings → Companion." };
      if (r.status === 429) return { ok: false, reason: "rate_limited", text: "The bridge is busy transcribing — try again shortly." };
      if (r.status === 400) return { ok: false, reason: "bad_audio", text: "That recording was too large or unreadable." };
      if (!r.ok) return { ok: false, reason: "unavailable", text: dependencyText("transcribe") };
      const data = await r.json();
      return data.jobId ? { ok: true, jobId: data.jobId } : { ok: false, reason: "unavailable", text: "The bridge didn't start the job." };
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      return { ok: false, reason: timedOut ? "timeout" : "offline",
        text: timedOut ? "Uploading took too long — try a shorter recording."
                       : offlineText("transcription") };
    } finally { clearTimeout(timer); }
  },

  async transcribeStatus(jobId) {
    if (!this.isConfigured()) return { ok: false, reason: "unconfigured" };
    const cfg = this.getConfig();
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/transcribe/" + encodeURIComponent(jobId), {
        headers: { authorization: "Bearer " + scrub(cfg.token) },
      });
      if (r.status === 404) return { ok: false, reason: "gone", text: "That job is no longer on the bridge." };
      if (!r.ok) return { ok: false, reason: "unavailable" };
      return { ok: true, ...(await r.json()) };
    } catch (err) {
      return { ok: false, reason: "offline" };
    }
  },

  // ---- raw OCR (bridge /ocr) ----
  // One downscaled frame → the recognized TEXT (for Translate's READ). Same
  // one-frame-to-your-own-bridge path as vision/scoreboard.
  async ocr(imageBase64) {
    if (!this.isConfigured()) {
      return { ok: false, reason: "unconfigured", text: "The companion isn't configured yet — add your bridge in Settings first." };
    }
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/ocr", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
        body: JSON.stringify({ imageBase64 }),
        signal: ctrl.signal,
      });
      if (r.status === 401) return { ok: false, reason: "unauthorized", text: "The bridge rejected the token — re-check Settings → Companion." };
      if (r.status === 429) return { ok: false, reason: "rate_limited", text: "Too many scans just now — wait a moment and try again." };
      if (r.status === 400) return { ok: false, reason: "bad_image", text: "The bridge couldn't use that image — re-aim and try again." };
      if (!r.ok) return { ok: false, reason: "unavailable", text: dependencyText("ocr") };
      const data = await r.json();
      return { ok: true, text: data.text || "", lines: data.lines || [], stats: data.stats || null };
    } catch (err) {
      console.warn("ocr request failed:", err);
      const timedOut = err && err.name === "AbortError";
      return {
        ok: false,
        reason: timedOut ? "timeout" : "offline",
        error: String((err && err.message) || err),
        text: timedOut ? "That took too long — try again." : offlineText("the reader"),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  async scoreboard(imageBase64, opts = {}) {
    if (!this.isConfigured()) {
      return { ok: false, reason: "unconfigured", text: "The companion isn't configured yet — add your bridge in Settings first." };
    }
    const cfg = this.getConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const r = await fetch(scrubEndpoint(cfg.endpoint) + "/scoreboard", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + scrub(cfg.token) },
        // fast: OCR + regex only on the bridge (no LLM parse) — Watch mode uses
        // this so a tick costs ~0.5s instead of ~8s.
        body: JSON.stringify({ imageBase64, ...(opts.fast ? { fast: true } : {}),
          ...(opts.sport ? { sport: opts.sport } : {}) }),
        signal: ctrl.signal,
      });
      // `reason` lets callers message accurately instead of blaming the bridge
      // for every failure (a bad frame is NOT an unreachable host).
      if (r.status === 401) return { ok: false, reason: "unauthorized", text: "The bridge rejected the token — re-check Settings → Companion." };
      if (r.status === 429) return { ok: false, reason: "rate_limited", text: "Scanning too fast — easing off for a moment." };
      if (r.status === 400) return { ok: false, reason: "bad_image", text: "The bridge couldn't use that image — re-aim and try again." };
      if (!r.ok) return { ok: false, reason: "unavailable", text: dependencyText("scoreboard") };
      const data = await r.json();
      return { ok: true, parsed: data.parsed || {}, rawText: data.rawText || "", stats: data.stats || null };
    } catch (err) {
      console.warn("scoreboard request failed:", err);   // real error, for diagnosis
      const timedOut = err && err.name === "AbortError";
      return {
        ok: false,
        reason: timedOut ? "timeout" : "offline",
        error: String((err && err.message) || err),
        text: timedOut
          ? "The scan took too long — try again."
          : offlineText("the scan"),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  // history: optional prior turns [{role:'user'|'assistant', content}] — the
  // caller keeps the rolling window; we defensively re-cap it here so the
  // request always fits the bridge's message-count/size limits.
  // opts.systemExtra: an extra system message (e.g. an active mode's analyst
  // framing) injected after the base prompt — additive, unused by default.
  async ask(prompt, context = "", history = [], opts = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        source: "stub",
        text:
          "The AI companion isn't configured yet. In Settings → Companion, paste the " +
          "endpoint URL and token from your bridge (see GLASSES.md / the companion handoff)" +
          (context ? ` — once connected, it will know what you're doing (right now: “${context}”)` : "") + ".",
      };
    }

    // Scrub on send too — belt-and-braces for configs saved before this fix
    // (or written to localStorage by any other path).
    const cfg = this.getConfig();
    const endpoint = scrubEndpoint(cfg.endpoint);
    const token = scrub(cfg.token);
    const turns = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-8);
    // Local wall-clock so the model can resolve "in 10 minutes" / "at 6pm".
    const now = new Date();
    const pad = (v) => String(v).padStart(2, "0");
    const nowLine = `Current local date/time: ${now.toDateString()} ${pad(now.getHours())}:${pad(now.getMinutes())} ` +
      `(${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())})`;
    // Knowledge Library: retrieve relevant reference material for this question.
    // Best-effort — returns [] if the bridge is unreachable or nothing scores
    // above the relevance threshold, in which case the model answers unaided.
    // MECHANICAL TRANSFORMS DON'T NEED THE LIBRARY. Summarising a chunk of a
    // meeting transcript is not a question about the user's reference packs, so
    // retrieving three of them costs an embedding round trip AND roughly two
    // thousand tokens of the very budget the caller is trying to fit inside.
    // Verification caught this the expensive way: the transcription fold's
    // section prompts were being pushed over budget by notes about cooking.
    const found = opts && opts.noRetrieval
      ? []
      : await knowledge.search(prompt, { context, topK: 3 });
    const reference = found.length ? [{
      role: "system",
      // Tagged so the overflow guard knows this block is droppable — see
      // tokens.fitMessages. Retrieval is best-effort by design (search() already
      // returns [] whenever the bridge is slow or down, and the model answers
      // unaided), so the whole block is one droppable unit rather than being
      // shaved note by note. The tags are stripped before the request is sent.
      _reference: true, _noteCount: found.length,
      content:
        "Reference notes from the user's own knowledge library — these are trusted and " +
        "may be more current or specific than your training. Use them when they answer " +
        "the question, and mention which note it came from (e.g. \"per your cooking " +
        "reference\"). If they don't cover it, answer normally from your own knowledge " +
        "and don't pretend they did.\n\n" +
        "Any note marked YOUR OWN MEMORY is something this user personally asked you to " +
        "remember. Answer from it verbatim, and SAY WHEN they saved it (the note tells " +
        "you) — recency is why they asked. NEVER invent a memory: if no YOUR OWN MEMORY " +
        "note below answers a question about their own things, people or past statements, " +
        "say plainly that you don't have it stored and offer to remember it now.\n\n" +
        knowledge.format(found),
    }] : [];

    const systemExtra = opts && typeof opts.systemExtra === "string" && opts.systemExtra.trim()
      ? [{ role: "system", content: opts.systemExtra.trim() }] : [];

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...systemExtra,
      ...turns,
      ...reference,
      {
        role: "user",
        // opts.stable drops the wall-clock line: callers that need the same
        // prompt to give the same answer (e.g. a repeated pre-snap read) can't
        // have the timestamp re-randomizing the output every minute.
        content: (opts && opts.stable ? "" : nowLine + "\n") +
          (context ? `Context — what I'm doing right now: ${context}\n` : "") +
          "\nQuestion: " + prompt,
      },
    ];

    // ------------------------------------------------------ THE OVERFLOW GUARD
    //
    // Every /chat prompt in the app is built here, so this is the one place the
    // check has to live. Nothing goes out that we haven't sized first.
    //
    // Order of business: drop what's droppable (old turns, then the retrieval
    // block) and SAY SO; if the undroppable core — system prompt, any mode
    // safety instruction, and the user's actual question — still doesn't fit,
    // refuse out loud and send nothing. Answering from the back two-thirds of a
    // prompt is the failure mode this whole pass exists to kill, and it is worse
    // than no answer because it looks exactly like a good one.
    const budget = tokens.promptBudget(knownContextTokens);
    const fitted = tokens.fitMessages(messages, budget);
    if (!fitted.fits) {
      console.warn(`companion: prompt over budget — ~${fitted.estimated} est. tokens vs ${budget} usable ` +
        `of ${knownContextTokens} (${contextTokensSource}); NOT SENT`);
      return {
        ok: false, source: "overflow", overflow: true,
        estimatedTokens: fitted.estimated, budget,
        text: tokens.overflowMessage(fitted.estimated, budget),
      };
    }
    const notice = tokens.describeDrops(fitted.dropped);
    if (notice) console.warn("companion: " + notice + ` (~${fitted.estimated}/${budget} tokens)`);
    // Strip the guard's own tags so the wire format is unchanged.
    const sendMessages = fitted.messages.map((m) => ({ role: m.role, content: m.content }));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
    try {
      const r = await fetch(endpoint + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          messages: sendMessages,
          // Optional hard cap on reply length (the bridge clamps it) — used by
          // short "add colour" calls so they can't ramble on a slow local model.
          ...(Number.isInteger(opts.maxTokens) ? { maxTokens: opts.maxTokens } : {}),
          // Optional temperature override (bridge clamps 0..1). Near-zero makes
          // a read stable across runs instead of a new opinion each tap.
          ...(typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
        }),
        signal: ctrl.signal,
      });
      if (r.status === 401) {
        return { ok: false, source: "error", text: "The bridge rejected the token — re-check the token in Settings → Companion." };
      }
      if (r.status === 429) {
        return { ok: false, source: "error", text: "Rate limited by the bridge — wait a minute and ask again." };
      }
      if (!r.ok) {
        return { ok: false, source: "error", text: dependencyText("chat") + ` (proxy said ${r.status})` };
      }
      const data = await r.json();
      if (!data || typeof data.text !== "string" || !data.text) {
        return { ok: false, source: "error", text: "The bridge returned an empty answer — try again." };
      }
      // GROUND TRUTH, checked against our own estimate. The bridge reports the
      // real prompt_eval_count and the real num_ctx; an estimator that drifts
      // gets caught here rather than believed. If the bridge says the prompt was
      // truncated, that is stated as an outright warning — a silently shortened
      // prompt is the exact failure this pass exists to make impossible.
      noteContextTokens(data.numCtx, "bridge");
      let overflowNotice = notice;
      if (data.truncated) {
        console.error(`companion: BRIDGE REPORTS TRUNCATION — ${data.promptTokens}/${data.numCtx} real tokens ` +
          `(we estimated ${fitted.estimated} and thought it fit in ${budget})`);
        overflowNotice = "Heads up: that prompt was longer than the model's window, so the front of it was cut " +
          "before it was read. Treat this answer as partial.";
      }

      return {
        ok: true, source: "local", text: data.text.trim(), stats: data.stats || null,
        // Present whenever something was left out — either by us, deliberately
        // and in a known order, or by the runtime, in which case it's a warning.
        notice: overflowNotice || null,
        truncated: Boolean(data.truncated),
        promptTokens: Number(data.promptTokens) || null,
        estimatedTokens: fitted.estimated,
        numCtx: Number(data.numCtx) || knownContextTokens,
        sources: found.map((f) => ({ pack: f.packLabel || f.pack, title: f.title, score: f.score })),
        // Memory honesty: a personal question with NO personal memory retrieved
        // must never be answered from the model's imagination. The caller
        // enforces this — a prompt instruction alone can be hallucinated past.
        askedPersonal: knowledge.isPersonalQuestion(prompt),
        personalFound: found.filter((f) => f.meta && f.meta.scope === "personal")
          .map((f) => ({ subject: (f.meta.subject || f.title), ts: f.meta.ts, placeTag: f.meta.placeTag || null,
                         savedVia: f.meta.source || "said", text: f.text })),
      };
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      return {
        ok: false,
        source: "error",
        text: timedOut
          ? "The companion took too long to answer (over 2 minutes) — the host machine may be overloaded."
          : offlineText("") + " If the bridge restarted on a new URL, re-check Settings → Companion.",
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export default companion;
