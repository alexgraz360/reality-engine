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
  "{\"action\":\"remember\",\"text\":\"the fact to keep\",\"topic\":\"short label\"} when the user tells " +
  "you to remember a lasting fact or preference (\"remember that my oven runs hot\") — that goes into " +
  "their knowledge library and comes back to you in future answers, unlike a note, which is just a " +
  "list item they read themselves. " +
  "The app shows the user a confirmation before anything is saved or deleted, so never claim " +
  "an action is already done — say what you're proposing. Never emit an action block the user " +
  "didn't clearly ask for; for everything else reply normally with no JSON and no code blocks. " +
  "You cannot control devices or reach anything outside this device.";

const ASK_TIMEOUT_MS = 120_000; // local CPU inference can be slow, esp. the first answer

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
      if (!r.ok) return { ok: false, text: "The vision model isn't available on the bridge right now." };
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
          : "Couldn't reach the bridge for vision — is the host machine awake?",
      };
    } finally {
      clearTimeout(timer);
    }
  },

  // ---- scoreboard OCR (bridge /scoreboard) ----
  // ONE downscaled frame of a TV score bug → { parsed fields, rawText }. Fields
  // the bridge could not read clearly come back null and stay manual — it never
  // fabricates. Image goes only to the user's own bridge, same as vision.
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
      if (!r.ok) return { ok: false, reason: "unavailable", text: "The scoreboard reader isn't available on the bridge right now." };
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
          : "Couldn't reach the bridge to scan — is the host machine awake?",
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
    const found = await knowledge.search(prompt, { context, topK: 3 });
    const reference = found.length ? [{
      role: "system",
      content:
        "Reference notes from the user's own knowledge library — these are trusted and " +
        "may be more current or specific than your training. Use them when they answer " +
        "the question, and mention which note it came from (e.g. \"per your cooking " +
        "reference\"). If they don't cover it, answer normally from your own knowledge " +
        "and don't pretend they did.\n\n" + knowledge.format(found),
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

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
    try {
      const r = await fetch(endpoint + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          messages,
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
        return { ok: false, source: "error", text: `The bridge answered with an error (${r.status}) — the model backend may be down on the host machine.` };
      }
      const data = await r.json();
      if (!data || typeof data.text !== "string" || !data.text) {
        return { ok: false, source: "error", text: "The bridge returned an empty answer — try again." };
      }
      return {
        ok: true, source: "local", text: data.text.trim(), stats: data.stats || null,
        sources: found.map((f) => ({ pack: f.packLabel || f.pack, title: f.title, score: f.score })),
      };
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      return {
        ok: false,
        source: "error",
        text: timedOut
          ? "The companion took too long to answer (over 2 minutes) — the host machine may be overloaded."
          : "Couldn't reach the companion bridge — is the host machine awake and its tunnel running? If it restarted, the endpoint URL may have changed (Settings → Companion).",
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export default companion;
