// Reality Engine · Translate — read it for me / talk for me.
//
// The last of the four day-to-day glasses functions. READ: point at a sign or
// menu, OCR it on the bridge, translate on the local model, hear it in your
// language. TALK: a two-way spoken conversation — you speak, it says it in their
// language; they answer, it says it back in yours.
//
// CRITICAL voice rule (handled via services.voice.speak): English uses our Piper
// voice; a FOREIGN target uses the system speechSynthesis voice whose language
// matches. If no system voice exists for that language we SHOW the text and say
// so rather than mispronouncing it with an English voice.
//
// HONESTY: machine translation from a local model — useful but can be wrong,
// better on common languages, and never to be relied on for medical/legal/
// safety-critical wording.

let root, svc, store, els = {};
let yourLang = "en", theirLang = "es";
let last = null;              // { dir, original, translation } — feeds the glance card
let busy = false;            // READ/translate in flight
let talkRec = null, talkListening = false, talkSide = "you"; // who's speaking this turn
let talkDiscard = false;
let lastSpokenVoice = null;  // {name, lang, engine} — debug/verification hook

// A modest, well-supported list. `rec` is the BCP-47 tag for recognition/TTS.
// "common" flags the ones a local model + system voices handle well.
const LANGS = [
  { code: "en", name: "English",    rec: "en-US", common: true },
  { code: "es", name: "Spanish",    rec: "es-ES", common: true },
  { code: "fr", name: "French",     rec: "fr-FR", common: true },
  { code: "de", name: "German",     rec: "de-DE", common: true },
  { code: "it", name: "Italian",    rec: "it-IT", common: true },
  { code: "pt", name: "Portuguese", rec: "pt-BR", common: true },
  { code: "nl", name: "Dutch",      rec: "nl-NL", common: false },
  { code: "ja", name: "Japanese",   rec: "ja-JP", common: false },
  { code: "zh", name: "Chinese",    rec: "zh-CN", common: false },
  { code: "ko", name: "Korean",     rec: "ko-KR", common: false },
  { code: "ru", name: "Russian",    rec: "ru-RU", common: false },
  { code: "ar", name: "Arabic",     rec: "ar-SA", common: false },
  { code: "hi", name: "Hindi",      rec: "hi-IN", common: false },
];
const L = (code) => LANGS.find((x) => x.code === code) || LANGS[0];

function persist() { store.set("langs", { yourLang, theirLang }); }
function dirLabel() { return `${yourLang.toUpperCase()} → ${theirLang.toUpperCase()}`; }

// ---------------------------------------------------------------- context + glance
function buildContext() {
  return `Translate mode. Your language ${L(yourLang).name}, their language ${L(theirLang).name}.` +
    (last ? ` Last: “${last.original}” → “${last.translation}”.` : "");
}

// getGlanceCard: the translation for the HUD. title = direction, lines = the
// translation word-wrapped to the lens, spoken = the full translation.
function glanceCard() {
  if (!last || !last.translation) return null;
  const wrap = svc.glasses && svc.glasses.wrap;
  const lines = wrap ? wrap(last.translation) : [last.translation.slice(0, 24)];
  return { title: last.dir, lines, spoken: last.translation, holdMs: 9000 };
}

// ---------------------------------------------------------------- translate
// Tight translate-only prompt on the local model. Low temperature + stable so a
// phrase reads the same each time; numbers/prices/names preserved.
async function translate(text, fromCode, toCode) {
  const src = String(text || "").trim();
  if (!src) return { ok: false, text: "" };
  const from = L(fromCode).name, to = L(toCode).name;
  const prompt =
    `Translate the following text from ${from} to ${to}. ` +
    "Output ONLY the translation — no explanations, no notes, no quotation marks, no romanization. " +
    "Keep numbers, prices, and proper names unchanged. Preserve line breaks.\n\nTEXT:\n" + src;
  const res = await svc.companion.ask(prompt, "", [], { temperature: 0.1, stable: true, maxTokens: 300 });
  if (!res.ok || !res.text) return { ok: false, text: res.text || "Translation unavailable." };
  return { ok: true, text: cleanTranslation(res.text, to) };
}
// Strip the little wrappers a 7B sometimes adds despite the instruction.
function cleanTranslation(t, toName) {
  let s = String(t).trim();
  s = s.replace(new RegExp(`^(translation|${toName})\\s*[:\\-—]\\s*`, "i"), "");
  s = s.replace(/^["“'](.*)["”']$/s, "$1");
  return s.trim();
}

// ---------------------------------------------------------------- READ
function frameToJpegBase64(source, w, h) {
  const MAX = 1100; // menu/sign text needs the pixels
  const scale = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}
function findLiveVideo() {
  const v = document.querySelector("#modeRoot video");
  return v && v.videoWidth ? v : null;
}
function startRead() {
  if (busy) return;
  const v = findLiveVideo();
  if (v) { runRead(frameToJpegBase64(v, v.videoWidth, v.videoHeight)); return; }
  els.readInput.value = "";
  els.readInput.click();   // iOS opens the camera, returns ONE photo
}
async function readFromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { const b64 = frameToJpegBase64(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); runRead(b64); };
  img.onerror = () => { URL.revokeObjectURL(url); setNote("Couldn't read that photo — try again."); };
  img.src = url;
}
// READ = the sign is in THEIR language; you want it in YOURS.
async function runRead(b64) {
  busy = true; setNote("Reading…"); renderControls();
  try {
    const ocr = await svc.companion.ocr(b64);
    if (!ocr.ok) {
      setNote(ocr.reason === "offline" || ocr.reason === "unconfigured"
        ? ocr.text + " Manual typing still works."
        : "Couldn't reach the reader — " + (ocr.text || "try again."));
      return;
    }
    const raw = (ocr.text || "").trim();
    if (!raw) { setNote("No readable text — fill more of the frame with the sign and hold steady."); return; }
    setNote("Translating…");
    const tr = await translate(raw, theirLang, yourLang);
    if (!tr.ok) { setNote(tr.text); return; }
    showResult(raw, tr.text, `${theirLang.toUpperCase()} → ${yourLang.toUpperCase()}`);
    speakOut(tr.text, yourLang);
    setNote("");
  } finally {
    busy = false; renderControls();
  }
}

// ---------------------------------------------------------------- TALK (two-way)
// Own recognizer, but the shell's single instance is stopped first so the two
// never run together, and we never listen while speaking (mic/TTS never overlap).
function talkTurn(side) {
  const SR = svc.voice.Recognition();
  if (!SR) { setNote("Voice input isn't supported here — type the phrase instead."); return; }
  if (talkListening) { stopTalk(); return; }
  svc.voice.stopShellDictation();  // yield the single recognizer
  svc.voice.stopSpeak();           // never listen over our own speech
  talkSide = side;
  const speaking = side === "you" ? yourLang : theirLang;   // recognizer language = who's talking
  talkRec = new SR();
  talkRec.lang = L(speaking).rec;
  talkRec.interimResults = true;
  talkRec.continuous = false;
  talkRec.maxAlternatives = 1;
  let finalText = "";
  talkRec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
    els.heard.textContent = (finalText + interim).trim();
  };
  talkRec.onerror = (e) => {
    // Benign events are silent, exactly like the shell's recognizer.
    if (e.error === "aborted") return;
    if (e.error === "no-speech") { setNote("Didn't catch that — tap and try again, or type."); return; }
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { setNote("Microphone access was denied — allow the mic, or type."); return; }
    if (e.error === "audio-capture") { setNote("No microphone found — type the phrase instead."); return; }
    // anything exotic: stay quiet, typing always works
  };
  talkRec.onend = () => {
    talkListening = false;
    const said = !talkDiscard && finalText.trim();
    talkDiscard = false;
    renderControls();
    if (said) handleSpoken(finalText.trim(), side);
  };
  talkListening = true; talkDiscard = false;
  els.heard.textContent = "";
  setNote(`Listening in ${L(speaking).name}…`);
  renderControls();
  try { talkRec.start(); } catch (err) { talkListening = false; renderControls(); }
}
function stopTalk(discard = true) {
  if (!talkListening || !talkRec) return;
  talkDiscard = discard;
  try { discard ? talkRec.abort() : talkRec.stop(); } catch (e) {}
}
// A spoken (or typed) phrase from `side`: translate to the OTHER language, speak
// it there, show both, then flip and listen for the reply.
async function handleSpoken(text, side) {
  const fromCode = side === "you" ? yourLang : theirLang;
  const toCode = side === "you" ? theirLang : yourLang;
  els.heard.textContent = text;
  setNote("Translating…");
  const tr = await translate(text, fromCode, toCode);
  if (!tr.ok) { setNote(tr.text); return; }
  showResult(text, tr.text, `${fromCode.toUpperCase()} → ${toCode.toUpperCase()}`);
  const spoke = speakOut(tr.text, toCode);
  setNote(spoke.spoken ? "" : spoke.note);
  // Flip to the other side so the reply can be caught with one tap. Auto-listen
  // only when we actually spoke (so we don't listen over a "no voice" notice).
  talkSide = side === "you" ? "them" : "you";
  renderControls();
}
function submitTyped() {
  const t = els.typed.value.trim();
  if (!t) return;
  els.typed.value = "";
  handleSpoken(t, talkSide);
}

// ---------------------------------------------------------------- speak
// Returns { spoken, note } — the note explains a no-voice miss for the UI.
function speakOut(text, code) {
  const rec = L(code).rec;
  const r = svc.voice.speak(text, rec, () => {});
  lastSpokenVoice = r.spoken ? { engine: r.engine, voice: r.voice || null, lang: rec } : null;
  if (r.spoken) return { spoken: true, note: "" };
  if (r.reason === "no-voice") {
    return { spoken: false, note: `No ${L(code).name} voice on this device — showing the text instead of mispronouncing it.` };
  }
  if (r.reason === "muted") return { spoken: false, note: "Turn on 🔊 Speak to hear it." };
  return { spoken: false, note: "" };
}

// ---------------------------------------------------------------- rendering
function setNote(t) { if (els.note) els.note.textContent = t; }
function showResult(original, translation, dir) {
  last = { dir, original, translation };
  if (els.translation) els.translation.textContent = translation;
  if (els.original) els.original.textContent = original;
  if (els.result) els.result.style.display = "block";
}
function renderControls() {
  if (els.readBtn) { els.readBtn.disabled = busy; els.readBtn.textContent = busy ? "…" : "📷 Read this"; }
  if (els.talkYou) els.talkYou.classList.toggle("on", talkListening && talkSide === "you");
  if (els.talkThem) els.talkThem.classList.toggle("on", talkListening && talkSide === "them");
}

function langOptions(sel) {
  return LANGS.map((l) => `<option value="${l.code}"${l.code === sel ? " selected" : ""}>${l.name}${l.common ? "" : " *"}</option>`).join("");
}
function render() {
  root.innerHTML = `
    <div style="position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch;
      background:radial-gradient(120% 90% at 50% 0%, #0d1526 0%, var(--bg) 70%); padding:14px 14px 40px;">
      <div style="max-width:560px; margin:0 auto;">
        <div style="display:flex; align-items:center; gap:8px; margin:2px 2px 8px;">
          <span style="font-size:22px;">🌐</span>
          <div style="flex:1;">
            <div style="font-weight:700; font-size:17px;">Read &amp; talk</div>
            <div style="font-size:11px; color:var(--dim);">Machine translation on the local model — it can be wrong, and it's best on common languages.</div>
          </div>
        </div>

        <div class="fbRow" style="margin:6px 0 2px;"><span class="fbSeg" style="align-items:center;">
          <select data-el="yourSel" title="Your language" style="max-width:40%;">${langOptions(yourLang)}</select>
          <button class="fbChip" data-el="swapBtn" title="Swap languages">⇄</button>
          <select data-el="theirSel" title="Their language" style="max-width:40%;">${langOptions(theirLang)}</select>
        </span></div>
        <div style="font-size:10px; color:var(--dim); margin:0 2px 10px;">You ↔ them. Languages marked * are less reliable on a local model.</div>

        <!-- READ -->
        <div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid); padding:12px; margin-bottom:10px;">
          <div style="font-weight:700; font-size:13px; margin-bottom:8px;">Read a sign or menu</div>
          <button class="ghostBtn accent" data-el="readBtn" style="width:100%; padding:12px;">📷 Read this</button>
          <input type="file" data-el="readInput" accept="image/*" capture="environment" style="display:none;">
          <div style="font-size:10.5px; color:var(--dim); margin-top:6px;">Point at ${L(theirLang).name} text; hear it in ${L(yourLang).name}. Fill the frame and hold steady.</div>
        </div>

        <!-- TALK -->
        <div style="border:1px solid var(--line); border-radius:14px; background:var(--panel-solid); padding:12px; margin-bottom:10px;">
          <div style="font-weight:700; font-size:13px; margin-bottom:8px;">Talk both ways</div>
          <div style="display:flex; gap:8px;">
            <button class="ghostBtn accent" data-el="talkYou" style="flex:1; padding:11px;">🎤 You (${L(yourLang).name})</button>
            <button class="ghostBtn accent" data-el="talkThem" style="flex:1; padding:11px;">🎤 Them (${L(theirLang).name})</button>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="text" data-el="typed" placeholder="…or type a phrase" autocomplete="off" style="flex:1;">
            <button class="ghostBtn" data-el="typedBtn">Say it</button>
          </div>
          <div style="font-size:10.5px; color:var(--dim); margin-top:6px;">Tap the side that's speaking. It translates, speaks the other language, then flips to listen for the reply.</div>
        </div>

        <div data-el="note" style="font-size:12px; color:var(--warn); min-height:16px; margin:2px 2px 8px; line-height:1.45;"></div>

        <!-- RESULT -->
        <div data-el="result" style="display:none; border:1px solid rgba(77,163,255,0.4); border-radius:14px; background:rgba(77,163,255,0.07); padding:13px 15px;">
          <div data-el="heard" style="font-size:11px; color:var(--dim); margin-bottom:4px;"></div>
          <div data-el="translation" style="font-size:19px; font-weight:600; line-height:1.4;"></div>
          <details style="margin-top:8px;">
            <summary style="font-size:11px; color:var(--dim); cursor:pointer;">original</summary>
            <div data-el="original" style="font-size:12px; color:var(--dim); margin-top:4px; white-space:pre-wrap;"></div>
          </details>
        </div>

        <div style="font-size:10px; color:var(--dim); margin-top:14px; line-height:1.5;">
          ⚠︎ Machine translation from a local model — it can be wrong and is better on common languages.
          Don't rely on it for medical, legal, or safety-critical wording.
        </div>
      </div>
    </div>`;
  for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
  wire();
  if (last) showResult(last.original, last.translation, last.dir);
  renderControls();
}

function wire() {
  els.yourSel.addEventListener("change", () => { yourLang = els.yourSel.value; if (yourLang === theirLang) theirLang = yourLang === "en" ? "es" : "en"; persist(); render(); });
  els.theirSel.addEventListener("change", () => { theirLang = els.theirSel.value; if (theirLang === yourLang) yourLang = theirLang === "en" ? "es" : "en"; persist(); render(); });
  els.swapBtn.addEventListener("click", () => { const t = yourLang; yourLang = theirLang; theirLang = t; persist(); render(); });
  els.readBtn.addEventListener("click", startRead);
  els.readInput.addEventListener("change", () => { const f = els.readInput.files && els.readInput.files[0]; if (f) readFromFile(f); });
  els.talkYou.addEventListener("click", () => talkTurn("you"));
  els.talkThem.addEventListener("click", () => talkTurn("them"));
  els.typedBtn.addEventListener("click", submitTyped);
  els.typed.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitTyped(); } });
}

// ---------------------------------------------------------------- mode API
export default {
  id: "translate",
  title: "Translate · read & talk",
  icon: "🌐",
  family: "Live",
  permissions: ["mic", "camera"],

  async init(ctx) {
    root = ctx.root; svc = ctx.services;
    store = svc.storage.scope("translate");
    const saved = store.get("langs") || {};
    if (saved.yourLang && L(saved.yourLang)) yourLang = saved.yourLang;
    if (saved.theirLang && L(saved.theirLang)) theirLang = saved.theirLang;
    render();
  },
  async start() {},
  stop() { stopTalk(true); svc && svc.voice && svc.voice.stopSpeak(); },
  teardown() { stopTalk(true); if (svc && svc.voice) svc.voice.stopSpeak(); els = {}; root = null; last = null; },

  // What this mode can be asked to do from ANYWHERE (voice intent router).
  // Static data — safe to read without the mode being open. The router owns no
  // knowledge of Translate; it only reads what's declared here.
  describeCapabilities() {
    return [
      {
        id: "translate.read", label: "Translate", needsMode: true,
        patterns: [/\b(what does (this|that) say|read (this|that|the sign|the menu)|translate (this|that|it))\b/i,
                   /\bwhat('?s| is) (this|that) (say|sign|menu)\b/i],
        examples: ["what does this say", "read this sign", "translate this menu"],
        run: () => { startRead(); return "Reading it now…"; },
      },
      {
        id: "translate.say", label: "Translate a phrase", needsMode: true, sideEffect: false,
        patterns: [/\bhow do (i|you) say\b/i, /\bsay .+ in (spanish|french|german|italian|portuguese|japanese|chinese|korean|russian|arabic|hindi|dutch)\b/i],
        examples: ["how do I say where is the station", "say two coffees in spanish"],
        run: (text) => {
          const m = String(text).match(/how do (?:i|you) say\s+(.+?)(?:\s+in\s+\w+)?\s*$/i)
                 || String(text).match(/\bsay\s+(.+?)\s+in\s+\w+\s*$/i);
          const phrase = m ? m[1].trim().replace(/^["'](.*)["']$/, "$1") : "";
          if (!phrase) return null;    // decline → falls through to the companion
          handleSpoken(phrase, "you");
          return `Translating “${phrase}”…`;
        },
      },
    ];
  },

  getContext() { return buildContext(); },

  // Voice/typed commands from the shell's ✦ input while Translate is active.
  handleCommand(text) {
    const q = String(text || "").toLowerCase().trim();
    if (/^(read it|read this|read the sign|read the menu)$/.test(q)) { startRead(); return "Reading…"; }
    const m = q.match(/^(?:swap|flip)( languages)?$/);
    if (m) { const t = yourLang; yourLang = theirLang; theirLang = t; persist(); render(); return `Swapped — ${L(yourLang).name} to ${L(theirLang).name}.`; }
    // "say <phrase>" → translate your→their and speak it
    const say = String(text || "").match(/^say\s+(.+)/i);
    if (say) { handleSpoken(say[1].trim(), "you"); return null; }
    return null; // fall through to the companion
  },

  getGlanceCard() { return glanceCard(); },

  // debug/verification hooks (#debug)
  _state: () => ({ yourLang, theirLang, last, talkListening, talkSide }),
  _setLangs: (y, t) => { yourLang = y; theirLang = t; persist(); render(); },
  _translate: (text, from, to) => translate(text, from, to),
  _handleSpoken: (text, side) => handleSpoken(text, side),
  _runReadB64: (b64) => runRead(b64),
  _speakOut: (text, code) => speakOut(text, code),
  _lastSpokenVoice: () => lastSpokenVoice,
  _glanceCard: () => glanceCard(),
};
