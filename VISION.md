# Reality Engine — Vision & Design Principles

> A system that helps people understand and interact with the physical world more confidently.

This document is the platform's compass. It is not a feature list and not a roadmap. It exists to answer one question whenever a new idea shows up:

**Does this feature reveal something hidden, teach the user, or help them become more confident and independent?**

If yes, it probably belongs. If no, it may be a clever gadget rather than part of the platform.

---

## The three principles

1. **Reveal what's hidden.** Surface the information the world doesn't show on its own — the position of a planet below the horizon, the forces in a swinging pendulum, the failing subsystem in a machine, the meaning behind an indirect instruction.
2. **Teach, don't replace.** The goal is to grow the user's own understanding and skill, not to do the thing for them and leave them dependent.
3. **Increase confidence, then step back.** Support should fade as competence grows. Success is the user needing the system less over time. Move skills from conscious effort to confidence.

These three are a filter, applied in order. A feature that fails all three is out, however impressive it is.

---

## The core insight: pipelines, not domains

Domains (cooking, automotive, football, astronomy) are **not** the deepest unit of the system. **Reusable cognitive pipelines are.** A domain is built by combining a few pipelines with domain knowledge, tools, and safety rules.

- Cooking combines nearly all of them.
- Automotive = Diagnostic + Coaching + Procedure + Memory.
- Football = Interpretation (pre-snap) + Decision (likely plays) + Monitoring (the play) + Coaching (afterward).

This is why the platform scales: new domains are assembled from existing loops rather than invented from scratch.

### The pipeline catalog

| Pipeline | Loop | Good for |
|---|---|---|
| **Interpretation** | Observe → Understand → Retrieve → Reason → Explain | identifying and explaining what's in front of you |
| **Scientific / Experiment** | Measure → Model → Predict → Test → Update | understanding how a system behaves (fitness, cooking, home energy, astronomy) |
| **Diagnostic** | Detect → Diagnose → Isolate → Repair → Verify | troubleshooting machines, vehicles, electronics, software, 3D printers |
| **Design** | Goal → Constraints → Generate → Compare → Execute | open-ended optimization (room layout, PC build, meal planning, robot design) |
| **Coaching** | Demonstrate → Observe → Correct → Repeat → Fade | skill acquisition through repetition (technique, sports, speaking) |
| **Monitoring / Sentinel** | Watch → Detect → Alert → Explain → Act | waiting quietly until something meaningful happens (cooking, prints, home safety) |
| **Decision** | Situation → Options → Simulate → Choose → Review | uncertain calls where announcing one answer isn't enough (strategy, finance, games) |
| **Memory / Chronicle** | Capture → Reconstruct → Reflect → Preserve | documentation (repairs, travel, experiments, project portfolio) |
| **Procedure / Checklist** | Rules → State → Enforce → Record → Audit | sequence-and-record environments (lab safety, torque specs, food safety) |
| **Inventory / Keeper** | Scan → Inventory → Organize → Locate → Replenish | managing an environment (workshop, pantry, collections, moving) |

A domain declares which loops it uses. That declaration, plus its knowledge and safety rules, *is* the mode.

---

## The three families

Modes group into three fundamentally different kinds of activity:

- **Learn** — physics, cooking, astronomy, sports, movies. *Understand a subject.*
- **Build** — engineering, robotics, room design, automotive, DIY. *Make or fix something.*
- **Live** — communication, travel, daily planning, organization, health routines. *Navigate daily life.*

Every mode should know which family it's in, because the tone, safety bar, and success metric differ across them.

---

## Assistive / Confidence Mode (deferred, high priority)

A Live-family direction with unusually high potential value: a private support companion built on the three principles taken seriously.

- **Prepare before** a situation (preview who/what/where, rehearse responses, plan for changes).
- **Support lightly during** (one step at a time, brief prompts, a pause-and-breathe cue).
- **Reflect supportively after** (what happened, what was hard, what to try next time — never a right/wrong score).
- **Track confidence, not knowledge** — skills moving from "needs full instructions" to "independent" over months, shown as circles slowly filling.
- **Fade the support** — the win is needing the system less.

**Safeguards (stronger than any other mode, mandatory before any build):** meaningful consent from the person using it; clearly separate fact from interpretation; **no** emotion- or intent-from-appearance claims; the user can review and delete their own memories; an easy off switch; involve trusted people only per permissions the user understands; escalate genuine emergencies to a human rather than trying to handle them alone.

**Status: backburner.** Build this only after the platform is solid and trustworthy, and as AR glasses become cheaper and more common. Rushing it is the way to get it wrong.

---

## How to use this document

When a new idea appears, run it through the filter, then place it: which family, which pipelines, what knowledge, what safety rules. If it doesn't reveal, teach, or build confidence, set it aside. The platform grows by adding aligned modes, not clever ones.
