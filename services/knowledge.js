// Reality Engine · services/knowledge — the Knowledge Library client (RAG).
//
// Semantic reference lookup against the user's own bridge: seeded reference
// packs (cooking / astronomy / physics) plus anything they've asked the
// companion to remember. Everything is embedded and stored on THEIR machine —
// no cloud, no vector service, no per-query cost.
//
// Design notes:
//  - Retrieval is best-effort. If the bridge is unreachable or slow, search()
//    resolves to [] and the companion simply answers unaided — knowledge must
//    never be able to block or break a conversation.
//  - Queries are composed from the question AND the active mode's context,
//    which measurably improves ranking: "does a heavier weight swing faster"
//    alone mis-ranks, but prefixed with the pendulum context it retrieves the
//    period-formula chunk at 0.85 instead of 0.65 for the wrong one.
//
// Reads the same bridge config the companion uses (storage keys), so it stays
// independent of companion.js — no import cycle.

import storage from "./storage.js";

const SEARCH_TIMEOUT_MS = 8_000;  // retrieval is ~0.1 s; this is a stall guard
const ADD_TIMEOUT_MS = 30_000;    // embedding a long note takes a little longer

function scrub(value) {
  return (value || "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, "");
}
function endpoint() { return scrub(storage.get("companion.endpoint", "")).replace(/\/+$/, ""); }
function token() { return scrub(storage.get("companion.token", "")); }
function configured() { return Boolean(endpoint() && token()); }

async function call(path, { method = "POST", body, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint() + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + token() },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("knowledge " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export const knowledge = {
  isConfigured: configured,

  // Best-effort semantic search. Never throws.
  async search(question, { context = "", topK = 3, packs = null } = {}) {
    if (!configured() || !question) return [];
    // The mode's context disambiguates the question — see the note above.
    const query = (context ? context + " " : "") + question;
    try {
      const data = await call("/knowledge/search", { body: { query: query.slice(0, 1000), topK, packs } });
      return Array.isArray(data.results) ? data.results : [];
    } catch (err) {
      return []; // bridge down / slow / model missing → answer unaided
    }
  },

  // Store something the user asked to remember. Throws so the caller can report.
  async add(text, { title = "", pack = "my-notes" } = {}) {
    if (!configured()) throw new Error("the companion bridge isn't configured yet");
    return call("/knowledge/add", { body: { text, title, pack }, timeoutMs: ADD_TIMEOUT_MS });
  },

  async packs() {
    if (!configured()) return { packs: [], chunks: 0 };
    try { return await call("/knowledge/packs", { method: "GET" }); }
    catch (err) { return { packs: [], chunks: 0 }; }
  },

  // Render retrieved chunks into the prompt block the model sees.
  format(results) {
    return results
      .map((r) => `[${r.packLabel || r.pack} — ${r.title}]\n${r.text}`)
      .join("\n\n");
  },
};

export default knowledge;
