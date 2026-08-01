// Reality Engine · services/labTables — vendored lookup tables for the Learn labs.
//
// EVERY NUMBER AND EVERY NAME IN THESE LABS COMES FROM HERE OR FROM ARITHMETIC.
// No model produces a frequency, a note, a colour name or a source band. That is
// the same discipline as the football instant read and the chemistry mixing
// table, and here it should be absolute: an FFT peak is arithmetic, and a colour
// name is a nearest-neighbour lookup. Both work with the bridge switched off,
// because neither ever asks it anything.

// ---------------------------------------------------------------- notes
// Equal temperament. A4 is configurable because orchestras aren't all at 440.
export const A4_DEFAULT = 440;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Frequency -> nearest note, plus how far off in cents. 100 cents = one semitone,
// and ±5 cents is about the limit of what a trained ear notices, which is why the
// tuner shows cents rather than Hz.
export function noteFromFrequency(hz, a4 = A4_DEFAULT) {
  if (!(hz > 0)) return null;
  // Semitones from A4, where 12 semitones is a doubling of frequency.
  const semitonesFromA4 = 12 * Math.log2(hz / a4);
  const nearest = Math.round(semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - nearest) * 100);
  // A4 is MIDI 69; index into the note names from there.
  const midi = 69 + nearest;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const exactHz = a4 * Math.pow(2, nearest / 12);
  return { name, octave, label: `${name}${octave}`, cents, exactHz: +exactHz.toFixed(2), midi };
}

// ---------------------------------------------------------------- source bands
// "What is that hum?" answered from a table, not a guess. Deliberately cautious
// wording: these are the USUAL sources of energy in each band, not an identification.
export const SOURCE_BANDS = [
  { lo: 0,    hi: 35,   label: "below most phone mics", note: "phone mics roll off hard here — treat as unreliable" },
  { lo: 35,   hi: 45,   label: "possible 40 Hz rumble", note: "traffic, machinery, or mic handling noise" },
  { lo: 45,   hi: 53,   label: "mains hum (50 Hz regions)", note: "electrical hum where the grid runs at 50 Hz" },
  { lo: 53,   hi: 67,   label: "mains hum (60 Hz regions)", note: "electrical hum where the grid runs at 60 Hz — the usual one in the US" },
  { lo: 67,   hi: 130,  label: "low rumble / bass", note: "fridges, fans, HVAC, bass notes" },
  { lo: 130,  hi: 300,  label: "male speech fundamentals", note: "also cellos, low guitar strings" },
  { lo: 300,  hi: 800,  label: "speech range", note: "most of the energy in a spoken voice sits here" },
  { lo: 800,  hi: 2000, label: "speech clarity band", note: "consonants live here — this is what makes speech intelligible" },
  { lo: 2000, hi: 5000, label: "presence / alarms", note: "smoke alarms, whistles, and the band ears are most sensitive to" },
  { lo: 5000, hi: 12000, label: "high harmonics / hiss", note: "cymbals, sibilance, electronic whine" },
  { lo: 12000, hi: 24000, label: "very high / near ultrasonic", note: "many adults cannot hear this at all" },
];
export function sourceBand(hz) {
  return SOURCE_BANDS.find((b) => hz >= b.lo && hz < b.hi) || null;
}

// ---------------------------------------------------------------- colour names
// A compact, deliberately ordinary vocabulary — the point is to say what a person
// would call it, not to be a Pantone book. Nearest neighbour in RGB space, which
// is crude but honest and needs no model.
export const COLOR_NAMES = [
  ["black", 0, 0, 0], ["charcoal", 54, 54, 58], ["dark grey", 90, 90, 95],
  ["grey", 128, 128, 130], ["light grey", 190, 190, 193], ["off-white", 235, 235, 230],
  ["white", 255, 255, 255],
  ["red", 200, 30, 35], ["dark red", 130, 20, 25], ["crimson", 170, 25, 60],
  ["orange", 235, 130, 30], ["amber", 240, 180, 40], ["brown", 120, 75, 45],
  ["tan", 190, 155, 110], ["beige", 225, 210, 180],
  ["yellow", 240, 225, 60], ["olive", 130, 130, 45], ["lime", 150, 210, 60],
  ["green", 55, 145, 70], ["dark green", 30, 85, 45], ["mint", 150, 220, 185],
  ["teal", 40, 140, 140], ["cyan", 70, 200, 215],
  ["sky blue", 120, 190, 235], ["blue", 45, 90, 190], ["navy", 25, 45, 100],
  ["indigo", 75, 60, 160], ["purple", 120, 60, 165], ["violet", 160, 100, 210],
  ["magenta", 205, 60, 165], ["pink", 240, 150, 180], ["salmon", 235, 140, 120],
];
export function nearestColorName(r, g, b) {
  let best = null, bestD = Infinity;
  for (const [name, cr, cg, cb] of COLOR_NAMES) {
    // Weighted so the distance tracks perceived difference a little better than
    // raw RGB; still crude, and the mode says so.
    const d = 2 * (r - cr) ** 2 + 4 * (g - cg) ** 2 + 3 * (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// ---------------------------------------------------------------- colour maths
export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
export function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
// Relative luminance (Rec. 709). RELATIVE — an uncalibrated camera with auto
// exposure cannot give absolute lux and this must never be presented as if it could.
export function relLuminance(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

// Warm/cool from the red-blue balance. A ratio, not a colour temperature in
// kelvin — auto white balance has already moved the goalposts before we see it.
export function warmCool(r, b) {
  const ratio = (r + 1) / (b + 1);
  if (ratio > 1.35) return { label: "warm", detail: "more red than blue — tungsten, candle, low sun" };
  if (ratio < 0.75) return { label: "cool", detail: "more blue than red — shade, overcast, screen light" };
  return { label: "neutral-ish", detail: "red and blue roughly balanced" };
}

export default { noteFromFrequency, sourceBand, SOURCE_BANDS, nearestColorName,
  rgbToHex, rgbToHsl, relLuminance, warmCool, A4_DEFAULT, COLOR_NAMES };
