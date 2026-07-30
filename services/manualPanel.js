// Reality Engine · services/manualPanel — the form, demoted.
//
// Every mode keeps its manual controls, but they stop being the ENTRY POINT and
// become the fallback: collapsed, secondary, one line of chrome. Football worked
// this way already; this makes the same pattern available to every mode instead
// of four hand-rolled copies that drift apart.
//
// Typing must keep working everywhere — loud rooms, privacy, and precision are
// all real reasons to prefer a keyboard, and "voice first" must never mean
// "voice only". So this hides the panel; it never removes it.

// Markup for the expander. `inner` is the mode's existing panel HTML, untouched.
export function manualPanelHTML({ open = false, label = "Set manually", hint = "", inner = "", key = "manual" } = {}) {
  return `
    <button class="ghostBtn" data-el="${key}Btn" style="width:100%; margin-top:12px; text-align:left;">
      ${open ? "▾" : "▸"} ${label}</button>
    ${hint ? `<div style="color:var(--dim); font-size:11px; line-height:1.45; margin:5px 2px 0;">${hint}</div>` : ""}
    <div data-el="${key}Wrap" style="display:${open ? "block" : "none"}; border:1px solid var(--line);
         border-radius:14px; background:var(--panel-solid); padding:12px; margin-top:8px;">${inner}</div>`;
}

// Wire the toggle. Returns the new open state so the mode can persist it.
export function wireManualPanel(els, { key = "manual", label = "Set manually", onToggle } = {}) {
  const btn = els[`${key}Btn`], wrap = els[`${key}Wrap`];
  if (!btn || !wrap) return;
  btn.onclick = () => {
    const open = wrap.style.display === "none";
    wrap.style.display = open ? "block" : "none";
    btn.textContent = `${open ? "▾" : "▸"} ${label}`;
    if (typeof onToggle === "function") onToggle(open);
  };
}

// The line that replaces the form at the top of a mode: what to SAY.
export function voiceFirstHint(examples) {
  const list = (Array.isArray(examples) ? examples : [examples]).filter(Boolean);
  if (!list.length) return "";
  return `<div style="color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 2px 12px;">
    Just say it — open ✦ and try ${list.map((e) => `<b style="color:var(--fg)">“${e}”</b>`).join(" or ")}.
    Everything below still works if you'd rather tap or type.</div>`;
}

export default { manualPanelHTML, wireManualPanel, voiceFirstHint };
