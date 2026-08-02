// Reality Engine · services/tokens — the context-overflow guard.
//
// WHY THIS EXISTS, and it is not theoretical. The RAM pass found that `num_ctx`
// was never set, so Ollama's 4096 default was live and long transcripts were
// being SILENTLY TRUNCATED: the same meeting processed 2,050 tokens at 4096 and
// 5,799 at 8192, and the model wrote a confident summary of a meeting it had
// read two-thirds of. Raising num_ctx to 8192 moved the cliff. It did not remove
// it. Any prompt that grows with input length — a map-reduce REDUCE over a long
// meeting, a heavy retrieval set, a big pack — walks back up to the same edge.
//
// The rule this module enforces: WE decide what to leave out, we say so, and if
// what's left still doesn't fit we refuse out loud. The runtime silently
// dropping the front of a prompt is the one outcome that is not allowed, because
// it is indistinguishable from a good answer.
//
// ESTIMATION, HONESTLY. There is no tokenizer in the browser and Ollama 0.31
// exposes no /api/tokenize, so this is an ESTIMATE. It is calibrated against
// Ollama's real tokenizer (prompt_eval_count) across prose, transcript speech,
// meeting summaries, JSON schemas, code, numbers/units and accented text, and
// deliberately tuned to OVER-count on every one of those — an over-estimate
// costs a little headroom, an under-estimate costs a silent truncation. The
// measured ratios are in the Build Log.
//
// The estimate is prevention. It is not the proof: the bridge returns the real
// prompt_eval_count with every answer, and companion.js compares the two, so an
// estimator that is ever wrong gets caught by ground truth rather than trusted.

// Fallback only. The real number comes from the bridge's /health (`numCtx`),
// because the bridge is the only thing that knows what it set — hardcoding 8192
// while the bridge runs 4096 would recreate the exact bug this guards against.
export const DEFAULT_CONTEXT_TOKENS = 8192;

// Room the answer needs inside the same window. The longest reply we ask for is
// the transcription REDUCE at maxTokens 320; 768 leaves that headroom plus the
// chat template's own scaffolding.
export const REPLY_RESERVE = 768;

// Fixed scaffolding the chat template wraps around a whole request. MEASURED at
// 30 tokens, twice and independently: Ollama returns no prompt_eval_count for an
// empty prompt, so it was derived from two repeat series instead — a transcript
// line repeated 20/60/120 times came out perfectly linear at 46 tokens/rep
// (30 + 20×46 = 950 ✓), and a summary repeated 10/30 times gave 29.
export const TEMPLATE_OVERHEAD = 30;

// Per-message overhead: ChatML wraps each turn in <|im_start|>role\n … <|im_end|>\n.
// That's 4; carried at 6 to stay on the over-counting side.
export const PER_MESSAGE_OVERHEAD = 6;

// Count tokens the way the model will, near enough and NEVER UNDER.
//
// Two independent lower bounds, larger wins, because the text families this app
// handles fail in opposite directions: dense prose packs several characters into
// a token, while transcript speech is full of short words ("um", "so", "i")
// that each cost a whole token however few characters they are.
//
// The per-class weights are not guesses — they were fitted against Ollama's own
// tokenizer over 18 real samples (prose, transcript speech, meeting summaries,
// JSON schemas, code, dense numbers/units, accented French, em-dash prose, table
// rows, and long repeats up to 5,520 tokens) and chosen as the cheapest set that
// under-counts NOTHING. Digits cost the most per character by a distance:
// "185/65 R15 88H, 2026-08-02T14:30" tokenizes at close to one token per
// character, and the first version of this function — which treated everything
// as prose with a small punctuation surcharge — estimated that line at 34
// tokens when it was really 84. That is precisely the direction that gets a
// prompt silently truncated, and it was caught by measuring rather than reading.
//
// Measured ratios (estimate ÷ real) after fitting: worst case 1.10, long-form
// transcript 1.29, reduce prompts 1.40, nothing below 1.0. So roughly a quarter
// to a third of the window is given up as margin on ordinary prose. That is the
// deliberate price of never guessing low, and the bridge's real token count
// (below) is what stops the margin from having to be bigger.
export function estimateTokens(text) {
  const s = String(text == null ? "" : text);
  if (!s) return 0;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const spaces = (s.match(/\s/g) || []).length;
  const other = s.length - letters - digits - spaces;   // punctuation, symbols, non-ASCII
  const words = (s.match(/\S+/g) || []).length;
  const byClass = letters / 3.5 + digits * 1.6 + other * 1.0 + spaces * 0.08;
  return Math.ceil(Math.max(byClass, words * 1.35));
}

// A whole messages[] array as the bridge will send it.
export function estimateMessages(messages) {
  let total = TEMPLATE_OVERHEAD;
  for (const m of messages || []) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(m && m.content);
  }
  return total;
}

// How many prompt tokens are actually usable.
export function promptBudget(contextTokens = DEFAULT_CONTEXT_TOKENS, replyReserve = REPLY_RESERVE) {
  return Math.max(256, contextTokens - replyReserve);
}

// ---------------------------------------------------------------- fitting
//
// Given the message list companion.ask() built, drop the droppable parts, in a
// fixed order, until it fits — and report exactly what went.
//
// WHAT MAY NEVER BE DROPPED, and why:
//   • the system prompt      — it defines the action/JSON contract; without it
//                              the model can emit an unparseable or, worse, an
//                              unrequested action block
//   • any systemExtra        — modes put SAFETY instructions here
//   • the user's own message — dropping the question to fit the notes is absurd
//
// So the drop order is: conversation history oldest-first, then retrieved
// reference notes. If the undroppable core still doesn't fit, this returns
// `fits: false` and the caller must refuse out loud rather than send it.
export function fitMessages(messages, budget) {
  const list = (messages || []).map((m, i) => ({ ...m, _i: i }));
  const dropped = [];

  const isHistory = (m) => m.role === "user" || m.role === "assistant";
  const isReference = (m) => m.role === "system" && m._reference === true;

  const total = () => estimateMessages(list);

  // 1. Conversation history, oldest first. The last user message is the actual
  //    question and is excluded by construction (callers append it last), but
  //    guard on index anyway so a reordering can never eat the question.
  const lastIdx = list.length - 1;
  while (total() > budget) {
    const i = list.findIndex((m, idx) => idx !== lastIdx && isHistory(m));
    if (i === -1) break;
    dropped.push({ what: "history", role: list[i].role, tokens: estimateTokens(list[i].content) });
    list.splice(i, 1);
  }

  // 2. Retrieved reference notes. Last in, first out — search returns them
  //    best-first, so the weakest match goes first.
  while (total() > budget) {
    let i = -1;
    for (let k = list.length - 1; k >= 0; k--) if (isReference(list[k])) { i = k; break; }
    if (i === -1) break;
    dropped.push({ what: "reference", notes: list[i]._noteCount || 1,
      tokens: estimateTokens(list[i].content) });
    list.splice(i, 1);
  }

  const estimated = total();
  return { messages: list, dropped, estimated, budget, fits: estimated <= budget };
}

// One short sentence naming what was left out. Returned as a NOTICE beside the
// answer rather than glued into it — callers like Guide's draft parser and the
// transcription reducer read res.text as data, and prose spliced into it would
// corrupt them.
export function describeDrops(dropped) {
  if (!dropped || !dropped.length) return "";
  const hist = dropped.filter((d) => d.what === "history").length;
  const refs = dropped.filter((d) => d.what === "reference")
    .reduce((n, d) => n + (d.notes || 1), 0);
  const bits = [];
  if (hist) bits.push(`${hist} earlier turn${hist > 1 ? "s" : ""} of this conversation`);
  if (refs) bits.push(`${refs} reference note${refs > 1 ? "s" : ""}`);
  return `This was long enough that I had to leave out ${bits.join(" and ")} to fit it in one pass — ` +
    `the question itself went through in full.`;
}

// The refusal, when even the core doesn't fit. Says the size, because "too long"
// without a number is not actionable.
export function overflowMessage(estimated, budget) {
  return `That's longer than I can read in one pass — about ${estimated.toLocaleString()} tokens against a ` +
    `${budget.toLocaleString()}-token window — so I haven't sent it rather than answering from a piece of it. ` +
    `Break it into parts and I'll take them one at a time.`;
}

// ---------------------------------------------------------------- batching
//
// Split items into consecutive groups that each fit a budget. This is what makes
// the transcription reduce HIERARCHICAL: reduce in batches, then reduce the
// reductions, so a long meeting degrades gently instead of falling off a cliff.
//
// `overheadTokens` is the fixed instruction text wrapped around each batch.
// An item too big for an empty batch still gets its own batch — the caller is
// told via `oversize` rather than having it silently dropped.
export function batchToFit(items, budget, overheadTokens = 0) {
  const batches = [];
  const oversize = [];
  let cur = [], curTokens = 0;
  for (const item of items) {
    const t = estimateTokens(item);
    if (overheadTokens + t > budget) {
      if (cur.length) { batches.push(cur); cur = []; curTokens = 0; }
      batches.push([item]);
      oversize.push(t);
      continue;
    }
    if (cur.length && overheadTokens + curTokens + t > budget) {
      batches.push(cur); cur = []; curTokens = 0;
    }
    cur.push(item); curTokens += t;
  }
  if (cur.length) batches.push(cur);
  return { batches: batches.length ? batches : [[]], oversize };
}

export default {
  DEFAULT_CONTEXT_TOKENS, REPLY_RESERVE, PER_MESSAGE_OVERHEAD, TEMPLATE_OVERHEAD,
  estimateTokens, estimateMessages, promptBudget, fitMessages,
  describeDrops, overflowMessage, batchToFit,
};
