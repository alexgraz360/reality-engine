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

const SYSTEM_PROMPT =
  "You are the Reality Engine companion — a knowledgeable, concise assistant for astronomy, " +
  "physics, and the wider world, living inside an open, phone-first platform of swappable " +
  "reality modes. If a context line describes what the user is doing or seeing right now, " +
  "ground your answer in it; if there is no context line, simply answer from your knowledge. " +
  "Answer in 2–4 short sentences of plain text (no markdown, no code blocks) — the reply may " +
  "be spoken aloud. Recent turns of this conversation may precede the question; use them to " +
  "resolve follow-ups. You are Q&A only: you cannot take actions or control devices.";

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

  // history: optional prior turns [{role:'user'|'assistant', content}] — the
  // caller keeps the rolling window; we defensively re-cap it here so the
  // request always fits the bridge's message-count/size limits.
  async ask(prompt, context = "", history = []) {
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
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...turns,
      {
        role: "user",
        content: (context ? `Context — what I'm doing right now: ${context}\n\nQuestion: ` : "") + prompt,
      },
    ];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
    try {
      const r = await fetch(endpoint + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ messages }),
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
      return { ok: true, source: "local", text: data.text.trim(), stats: data.stats || null };
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
