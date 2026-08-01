// Reality Engine · services/sampleCards — the glance-card review gallery's data.
//
// Reviewing the glasses experience used to mean opening every mode in turn and
// getting each one into the right state. This is one flip-through instead: a
// representative card from every mode plus every global card type, so you can
// see the whole HUD vocabulary in about a minute and say which ones read badly.
//
// THESE ARE SAMPLES, not live readings. The gallery labels them as such on every
// card, because a plausible-looking football read or a "don't mix" verdict must
// never be mistaken for the real thing.
//
// The POLISH RULES every card here follows — the point of the pass:
//
//  1. LEAD WITH THE ANSWER. Line 1 is the thing you looked up for. The football
//     card leads with "RUN 68%", not with the down and distance you already know;
//     the navigator leads with the direction and distance, not the pin's name.
//  2. NOTHING CRITICAL TRUNCATES. Every line here is written to fit LINE_MAX (24)
//     as authored, so the adapter's clamp never has to cut a word in half. The
//     gallery asserts this rather than trusting me.
//  3. CONSISTENT TITLES. An emoji, then a short noun phrase naming the SOURCE,
//     never a sentence and never the content. "🏈 3rd & 7" tells you where you
//     are; the read goes in the body.
//  4. SPOKEN CARRIES THE FULL THING. The lens is a summary; `spoken` is the whole
//     sentence, because that's what you actually hear.
//  5. ALERTS EARN IT. priority:"alert" is only for something with a deadline or a
//     hazard — a timer that just ended, a chemical you must not mix.
//  6. NO BLANK SPACER LINES. I wrote several cards with an empty string as a
//     visual gap and the adapter silently dropped every one of them
//     (`if (c) lines.push(c)`), so the intended separation never existed. On a
//     four-line lens a blank line is a quarter of the display anyway. What is
//     authored here is exactly what renders — the gallery asserts that.

export const SAMPLE_CARDS = [
  // ---------------------------------------------------------------- global
  {
    mode: "companion", label: "Companion answer",
    card: {
      title: "✦ Companion",
      lines: ["Jupiter is the biggest", "planet — about 11 Earths", "across and twice the", "mass of all the rest."],
      spoken: "Jupiter is the biggest planet in the solar system — about eleven Earths across, and more than twice the mass of every other planet combined.",
      holdMs: 9000,
    },
  },
  {
    mode: "companion", label: "Look answer (vision)",
    card: {
      title: "👁 Look",
      lines: ["A mug of coffee on a", "wooden desk, next to a", "closed laptop and a", "pair of glasses."],
      spoken: "A mug of coffee on a wooden desk, next to a closed laptop and a pair of glasses.",
      holdMs: 9000,
    },
  },
  {
    mode: "memory", label: "Memory recall",
    card: {
      // Leads with the ANSWER, not with "you asked about your passport".
      title: "🧠 Passport",
      lines: ["Top drawer of the desk,", "in the grey folder.", "saved Tuesday"],
      spoken: "Your passport is in the top drawer of the desk, in the grey folder. You saved that on Tuesday.",
      holdMs: 10000,
    },
  },
  {
    mode: "memory", label: "Save confirmation",
    card: {
      title: "🧠 Saved",
      lines: ["“The oven runs about", "20° hot.”", "in your memories"],
      spoken: "Saved to your memories: the oven runs about twenty degrees hot.",
      holdMs: 6000,
    },
  },
  {
    mode: "reminder", label: "Reminder alert",
    card: {
      // An alert with a deadline: the thing itself first, the time second.
      title: "⏰ Now",
      lines: ["Take the bread out", "of the oven", "reminder · 6:40 pm"],
      spoken: "Reminder: take the bread out of the oven.",
      holdMs: 15000, priority: "alert",
    },
  },

  // ---------------------------------------------------------------- Learn
  {
    mode: "guide", label: "Guide · cooking step",
    card: {
      title: "Step 3/8",
      lines: ["⏱ 4:20 left", "Simmer uncovered until", "the sauce coats the", "back of a spoon."],
      spoken: "Step three of eight: simmer uncovered until the sauce coats the back of a spoon. Four minutes twenty left on the timer.",
      holdMs: 9000,
    },
  },
  {
    mode: "repair", label: "Repair · safety prep",
    card: {
      // Safety leads, and it says what to DO, not "please read the safety notes".
      title: "⚠️ Before you start",
      lines: ["Turn the water off at", "the isolation valve", "under the sink.", "Say “ready” to go on."],
      spoken: "Before you start: turn the water off at the isolation valve under the sink, then open the tap to drain the line. Say ready when that's done.",
      holdMs: 14000, priority: "alert",
    },
  },
  {
    mode: "repair", label: "Repair · final check",
    card: {
      title: "Final check",
      lines: ["Run the tap two minutes", "and feel every joint", "for damp. Dry means", "the fix held."],
      spoken: "Final check: run the tap for two minutes and feel every joint for damp. Dry means the fix held.",
      holdMs: 11000,
    },
  },
  {
    mode: "football", label: "Football · pre-snap read",
    card: {
      // The READ first. You already know it's 3rd and 7 — that's the title.
      title: "🏈 3rd & 7",
      lines: ["RUN 68%", "Heavy set, 2 TE, both", "safeties deep.", "Watch the A gap."],
      spoken: "Run, sixty-eight percent. Heavy personnel with two tight ends and both safeties deep — watch the A gap.",
      holdMs: 9000,
    },
  },
  {
    mode: "baseball", label: "Baseball · pitch read",
    card: {
      title: "⚾ 1-2 count",
      lines: ["SLIDER 54%", "Low and away.", "K 31% · hit 18%"],
      spoken: "Slider, fifty-four percent, low and away. Strikeout chance thirty-one percent, hit eighteen.",
      holdMs: 9000,
    },
  },
  {
    mode: "formcoach", label: "Form Coach · one cue",
    card: {
      // One cue, and it's an instruction you can act on mid-rep.
      title: "🏀 Rep 7",
      lines: ["Finish the arm —", "extend all the way up", "through the release."],
      spoken: "Finish the arm — extend all the way up through the release.",
      holdMs: 7000,
    },
  },
  {
    mode: "formcoach", label: "Form Coach · cue retired",
    card: {
      title: "🏀 Rep 12",
      lines: ["Follow-through is", "holding well.", "now: set point"],
      spoken: "Follow-through is holding well. Let's look at your set point.",
      holdMs: 7000,
    },
  },
  {
    mode: "chemistry", label: "Chemistry · explanation",
    card: {
      title: "🧪 Rust",
      lines: ["Iron giving electrons", "to oxygen — needs both", "water and air. Salt", "speeds it up a lot."],
      spoken: "Rust is iron giving its electrons away to oxygen. It needs both water and oxygen, and dissolved salt speeds it up enormously.",
      holdMs: 11000,
    },
  },
  {
    mode: "chemistry", label: "Chemistry · do not mix",
    card: {
      // The verdict is the whole card. Nothing above it, nothing softening it.
      title: "⚠️ Don't mix",
      lines: ["Bleach + ammonia makes", "chloramine gas — it", "burns your airways.", "Ventilate, don't mix."],
      spoken: "Don't mix them. Bleach and ammonia give off chloramine gases, which attack the lining of your airways.",
      holdMs: 15000, priority: "alert",
    },
  },
  {
    mode: "soundlab", label: "Sound Lab · pitch",
    card: {
      // The number leads: the frequency, not "Sound Lab is measuring".
      title: "440 Hz",
      lines: ["A4 +1¢", "speech clarity band", "-31 dB rel"],
      spoken: "440 hertz, A4 plus one cent.",
      holdMs: 6000,
    },
  },
  {
    mode: "colorlab", label: "Light & Color · a shadow",
    card: {
      // Verified against the real path: #5A6B84 genuinely names as "grey", and
      // its hue of 216 degrees is what gives the shadow away as blue. The card
      // says exactly what the mode says, not a nicer version of it.
      title: "#5A6B84",
      lines: ["grey — but hue 216°", "RGB 90 107 132", "light: cool"],
      spoken: "That's a blue-grey, hex 5A6B84. The light looks cool — that shadow is lit by the sky, not the sun.",
      holdMs: 9000,
    },
  },
  {
    mode: "freefall", label: "Free Fall · measured g",
    card: {
      title: "g ≈ 9.21",
      lines: ["m/s² · 6 drops", "spread 8.6–9.8", "-6% vs 9.81"],
      spoken: "g measured 9.21 metres per second squared across six drops, 6 percent below the textbook value.",
      holdMs: 9000,
    },
  },
  {
    mode: "spring", label: "Spring · stiffness",
    card: {
      title: "k ≈ 18.4 N/m",
      lines: ["T = 0.655 s", "9 cycles · 0.2 kg", "±0.012 s spread"],
      spoken: "Period 0.66 seconds, so the spring constant is about 18 newtons per metre.",
      holdMs: 9000,
    },
  },
  {
    mode: "pendulum", label: "Pendulum · measurement",
    card: {
      title: "🪀 Pendulum",
      lines: ["g = 9.79 m/s²", "T = 1.42 s · L = 0.50 m", "12 swings averaged"],
      spoken: "Period one point four two seconds over a half-metre string gives g as nine point seven nine metres per second squared.",
      holdMs: 9000,
    },
  },
  {
    mode: "projectile", label: "Projectile · throw",
    card: {
      title: "⚾ Throw",
      lines: ["11.4 m/s at 38°", "peak 2.6 m · range 13 m", "tracked on-device"],
      spoken: "Launch speed eleven point four metres per second at thirty-eight degrees — peak height two point six metres, range thirteen metres.",
      holdMs: 9000,
    },
  },
  {
    mode: "astronomy", label: "Astronomy · what you're seeing",
    card: {
      title: "🔭 Saturn",
      lines: ["SE, 34° up", "mag 0.5 · rings 18″", "best around 11 pm"],
      spoken: "That's Saturn, south-east and thirty-four degrees up, magnitude zero point five. It's highest around eleven tonight.",
      holdMs: 9000,
    },
  },

  // ---------------------------------------------------------------- Live
  {
    mode: "translate", label: "Translate · sign read",
    card: {
      title: "ES → EN",
      lines: ["Closed Sundays.", "Deliveries at the rear", "entrance."],
      spoken: "Closed Sundays. Deliveries at the rear entrance.",
      holdMs: 10000,
    },
  },
  {
    mode: "navigator", label: "Navigator · point me back",
    card: {
      // Direction and distance lead. The pin's name is the title.
      title: "🧭 Car",
      lines: ["340 m north-east", "→ 40° right of where", "you're facing", "GPS good (±6 m)"],
      spoken: "Your car is three hundred and forty metres north-east — about forty degrees to your right. GPS is good to six metres.",
      holdMs: 9000,
    },
  },
  {
    mode: "navigator", label: "Navigator · heading unusable",
    card: {
      title: "🧭 Tent",
      lines: ["120 m north", "no reliable compass —", "direction only, no arrow"],
      spoken: "Your tent is a hundred and twenty metres north. I can't trust the compass here, so I'm giving you the direction in words rather than a wrong arrow.",
      holdMs: 9000,
    },
  },
  {
    mode: "transcribe", label: "Transcribe · recording",
    card: {
      title: "🎙 Recording",
      lines: ["14:32 elapsed", "tap to stop — audio", "is deleted after"],
      spoken: "Recording, fourteen minutes thirty-two seconds so far.",
      holdMs: 8000,
    },
  },
  {
    mode: "transcribe", label: "Transcribe · summary ready",
    card: {
      title: "🎙 Summary",
      lines: ["3 actions for you:", "send the deck, book", "the room, chase the", "invoice by Friday."],
      spoken: "Your summary is ready. Three actions for you: send the deck, book the room, and chase the invoice by Friday.",
      holdMs: 12000,
    },
  },

  // ---------------------------------------------------------------- system
  {
    mode: "system", label: "Bridge degraded",
    card: {
      // Names the piece. This card exists because "bridge unreachable" didn't.
      title: "⚠️ OCR sidecar",
      lines: ["Not responding on 8788.", "Scoreboard scan and", "Translate READ are off.", "Everything else works."],
      spoken: "The OCR sidecar isn't responding on port 8788, so scoreboard scanning and Translate's read are unavailable. Everything else is working.",
      holdMs: 12000, priority: "alert",
    },
  },
];

// Which modes have at least one sample. Used to assert coverage against the
// live registry so a future mode can't quietly ship without a gallery card.
export function coveredModes() {
  return [...new Set(SAMPLE_CARDS.map((s) => s.mode))];
}

export default SAMPLE_CARDS;
