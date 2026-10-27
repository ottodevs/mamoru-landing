/**
 * otto/mamoru-astro#28: CSS for `/ops/lab`, ported from the approved prototype (spec 008, PoC artifact
 * `VsgFUusHzAnzes1pHT6juU`) as closely as the console's constraints allow:
 *
 * - Every selector is scoped under `.lab-root` (and every custom class renamed `lab-*`) so nothing here can
 *   bleed into or collide with OPS_STYLE/CONSOLE_STYLE (both already define `.chart`, `.legend`, `.tabs`…).
 *   This file adds markup inside one section, same as every other `/ops` page — "one `<style>` tag" still
 *   holds; this constant is only concatenated into it (see `renderDocument` in ops.ts).
 * - Typography reuses the console's own tokens (`var(--serif)`, `var(--mono)`) instead of the prototype's
 *   Google Fonts `<link>`: the CSP here is `font-src 'self'` with no stylesheet origin allowed at all, and
 *   both "Noto Serif" and "IBM Plex Mono" are already self-hosted (OPS_STYLE, CONSOLE_STYLE).
 * - Breakpoints are the prototype's own, 1180px and 820px (B-11), not the console's 1180/860 — the Lab's
 *   three-column shell is its own layout, not the generic `.c-grid`.
 * - Dark mode reuses the console's existing `data-theme` attribute/toggle (console-client.ts): no separate
 *   theme switch for the Lab.
 */
export const LAB_STYLE = `
.lab-root {
  --paper: #f4f0e6; --rice: #f8f5ef; --card: #fbf9f4; --ink: #0f0f0e; --ink2: #4a4740; --stone: #8a8578; --wash: #d9d2c3; --grid: #e8e2d5;
  --mamoru: #13805a; --hold: #b8792a; --usdc: #8a8578; --ghost: rgba(15, 15, 14, .38);
  --band: rgba(19, 128, 90, .13); --bandedge: rgba(19, 128, 90, .42); --gain: #13805a; --loss: #9b2c2c; --sel: rgba(19, 128, 90, .08);
  --r: 8px;
  background: var(--paper); color: var(--ink); font-family: var(--serif); font-size: 15px; line-height: 1.45;
  border-radius: 4px; overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .lab-root {
    color-scheme: dark;
    --paper: #141412; --rice: #1a1a17; --card: #1f1f1b; --ink: #eeeae0; --ink2: #bdb7a9; --stone: #8f8a7e; --wash: #36342e; --grid: #26251f;
    --mamoru: #2fa77c; --hold: #bf8033; --usdc: #8f8a7e; --ghost: rgba(238, 234, 224, .4);
    --band: rgba(47, 167, 124, .15); --bandedge: rgba(47, 167, 124, .5); --gain: #2fa77c; --loss: #d06262; --sel: rgba(47, 167, 124, .1);
  }
}
:root[data-theme="dark"] .lab-root {
  color-scheme: dark;
  --paper: #141412; --rice: #1a1a17; --card: #1f1f1b; --ink: #eeeae0; --ink2: #bdb7a9; --stone: #8f8a7e; --wash: #36342e; --grid: #26251f;
  --mamoru: #2fa77c; --hold: #bf8033; --usdc: #8f8a7e; --ghost: rgba(238, 234, 224, .4);
  --band: rgba(47, 167, 124, .15); --bandedge: rgba(47, 167, 124, .5); --gain: #2fa77c; --loss: #d06262; --sel: rgba(47, 167, 124, .1);
}
.lab-root [hidden] { display: none !important; }
/* :where() keeps this at the bare tag-selector specificity the prototype relied on (button,input,select{...}
   at its CSS root) — without it, scoping under .lab-root would outrank single-class rules like .lab-run and
   silently override their color (otto/mamoru-astro#28 visual check: this exact bug hid the "Ejecutar
   escenario" button's text, ink-on-ink). */
:where(.lab-root) button, :where(.lab-root) input, :where(.lab-root) select { font: inherit; color: inherit; }
.lab-root :focus-visible { outline: 2px solid var(--mamoru); outline-offset: 2px; }
.lab-mono { font-family: var(--mono); }
.lab-num { font-variant-numeric: tabular-nums; }
.lab-k { font-family: var(--mono); font-size: .7rem; letter-spacing: .07em; text-transform: uppercase; color: var(--stone); }
.lab-pos { color: var(--gain); } .lab-neg { color: var(--loss); }

.lab-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding-block: 14px; padding-inline: 20px; border-bottom: 1px solid var(--wash); background: var(--paper); }
.lab-brand { font-weight: 600; font-size: 1.05rem; white-space: nowrap; font-family: var(--serif); }
.lab-brand span { font-weight: 400; color: var(--stone); }
.lab-seg { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--wash); border-radius: 999px; background: var(--rice); flex-wrap: wrap; }
.lab-seg button { border: 0; background: none; padding: 5px 12px; border-radius: 999px; cursor: pointer; color: var(--ink2); font-size: .86rem; white-space: nowrap; }
.lab-seg button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.lab-simchip { margin-left: auto; font-family: var(--mono); font-size: .72rem; color: var(--stone); border: 1px dashed var(--wash); border-radius: 999px; padding: 4px 10px; white-space: nowrap; }

.lab-shell { display: grid; grid-template-columns: 250px minmax(0, 1fr) 330px; gap: 0; }
.lab-shell aside.lab-left, .lab-shell aside.lab-right { padding-block: 18px; padding-inline: 18px; display: grid; gap: 18px; align-content: start; min-width: 0; }
.lab-shell aside.lab-left { border-right: 1px solid var(--wash); }
.lab-shell aside.lab-right { border-left: 1px solid var(--wash); background: var(--rice); }
.lab-shell main > *, .lab-shell aside > * { min-width: 0; }
.lab-shell main { padding-block: 18px; padding-inline: 22px; display: grid; gap: 16px; align-content: start; min-width: 0; }

.lab-cap .lab-v { font-size: 2rem; line-height: 1.1; margin-top: 4px; }
.lab-cap .lab-v small { font-size: .9rem; color: var(--stone); font-family: var(--mono); margin-left: 4px; }
.lab-cap .lab-d { font-family: var(--mono); font-size: .82rem; margin-top: 6px; display: grid; gap: 2px; }
.lab-variants { display: grid; gap: 6px; }
.lab-var { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; text-align: left; border: 1px solid var(--wash); background: var(--card); border-radius: var(--r); padding: 9px 11px; cursor: pointer; }
.lab-var[aria-pressed="true"] { border-color: var(--mamoru); background: var(--sel); }
.lab-var b { font-weight: 600; font-size: .92rem; }
.lab-var .lab-n { font-family: var(--mono); font-size: .8rem; text-align: right; }
.lab-var small { grid-column: 1 / -1; font-size: .78rem; color: var(--stone); }
.lab-ass { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 5px 10px; font-size: .84rem; }
.lab-ass dt { color: var(--ink2); } .lab-ass dd { margin: 0; text-align: right; font-family: var(--mono); font-size: .78rem; }
.lab-box summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; }
.lab-box summary::-webkit-details-marker { display: none; }
.lab-box summary::after { content: "+"; font-family: var(--mono); color: var(--stone); }
.lab-box[open] summary::after { content: "\\2212"; }

.lab-benchhead { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 10px 16px; }
.lab-benchhead h1 { margin: 0; font-size: 1.35rem; font-weight: 400; text-wrap: balance; font-family: var(--serif); }
.lab-benchhead h1 b { font-weight: 600; }
.lab-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.lab-tile { border: 1px solid var(--wash); border-radius: var(--r); padding: 10px 12px; background: var(--card); min-width: 0; }
.lab-tile.lab-main { border-color: var(--mamoru); }
.lab-tile .lab-v { font-size: 1.35rem; font-family: var(--mono); margin-top: 2px; white-space: nowrap; }
.lab-tile .lab-s { font-family: var(--mono); font-size: .75rem; color: var(--stone); }
.lab-tile i { display: inline-block; width: 14px; border-top: 2px solid; vertical-align: middle; margin-right: 6px; }
.lab-pooltabs { display: flex; gap: 4px; flex-wrap: wrap; }
.lab-pooltabs button { border: 1px solid var(--wash); background: var(--card); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: .85rem; }
.lab-pooltabs button[aria-pressed="true"] { border-color: var(--ink); background: var(--ink); color: var(--paper); }
.lab-chart { position: relative; }
.lab-chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.lab-chart .lab-axis text { font-family: var(--mono); font-size: 10.5px; fill: var(--stone); }
.lab-chart .lab-lbl { font-family: var(--mono); font-size: 10.5px; fill: var(--ink2); }
.lab-chart .lab-lblb { font-family: var(--mono); font-size: 11px; fill: var(--ink); }
.lab-charthead { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 14px; }
.lab-charthead h2 { margin: 0; font-size: 1rem; font-weight: 600; font-family: var(--serif); }
.lab-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-family: var(--mono); font-size: .72rem; color: var(--ink2); }
.lab-legend i { display: inline-block; width: 14px; border-top: 2px solid; vertical-align: middle; margin-right: 5px; }
.lab-narr { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; border-left: 2px solid var(--ink); padding: 4px 0 4px 12px; min-height: 3.4em; }
.lab-narr .lab-when { font-family: var(--mono); font-size: .72rem; color: var(--stone); grid-column: 1 / -1; }
.lab-transport { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lab-ctl { font-family: var(--mono); font-size: .78rem; cursor: pointer; background: var(--card); border: 1px solid var(--wash); border-radius: 6px; padding: 6px 10px; white-space: nowrap; }
.lab-ctl.lab-play { background: var(--ink); color: var(--paper); border-color: var(--ink); min-width: 5.5rem; }
.lab-track { flex: 1 1 240px; min-width: 0; position: relative; padding-top: 10px; }
.lab-track input { width: 100%; accent-color: var(--mamoru); margin: 0; }
.lab-ticks { position: relative; height: 10px; margin-inline: 7px; }
.lab-ticks span { position: absolute; top: 0; width: 2px; height: 8px; transform: translateX(-50%); border-radius: 1px; }

.lab-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--wash); }
.lab-tab { border: 0; background: none; padding: 8px 12px; cursor: pointer; color: var(--ink2); border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: .92rem; }
.lab-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.lab-evlist { display: grid; gap: 0; max-height: 260px; overflow: auto; }
.lab-ev { display: grid; grid-template-columns: 7.5rem 5rem minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 7px 4px; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 6px; width: 100%; }
.lab-ev:hover, .lab-ev.lab-cur { background: var(--sel); }
.lab-ev .lab-t { font-family: var(--mono); font-size: .74rem; color: var(--stone); }
.lab-ev .lab-p { font-size: .82rem; color: var(--ink2); }
.lab-ev .lab-m { font-family: var(--mono); font-size: .76rem; text-align: right; white-space: nowrap; }
.lab-tbl { overflow-x: auto; }
.lab-tbl table { border-collapse: collapse; font-variant-numeric: tabular-nums; width: 100%; min-width: 520px; }
.lab-tbl th, .lab-tbl td { text-align: right; padding: 7px 10px; font-family: var(--mono); font-size: .8rem; border-bottom: 1px solid var(--grid); }
.lab-tbl th:first-child, .lab-tbl td:first-child { text-align: left; font-family: var(--serif); font-size: .88rem; }
.lab-tbl thead th { font-size: .7rem; color: var(--stone); font-weight: 400; letter-spacing: .04em; text-transform: uppercase; }
.lab-tbl tr.lab-cur td { background: var(--sel); }
.lab-cell { display: inline-block; min-width: 4.5rem; padding: 2px 6px; border-radius: 4px; }
.lab-diag { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.lab-bar { display: grid; grid-template-columns: minmax(0, 1fr) 3.5rem; gap: 8px; align-items: center; font-size: .82rem; }

.lab-rtabs { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--wash); border-radius: 999px; background: var(--paper); }
.lab-rtabs button { flex: 1; border: 0; background: none; border-radius: 999px; padding: 6px 10px; cursor: pointer; color: var(--ink2); font-size: .9rem; }
.lab-rtabs button[aria-selected="true"] { background: var(--ink); color: var(--paper); }
.lab-field { display: grid; gap: 6px; }
.lab-field label { font-size: .86rem; display: flex; justify-content: space-between; gap: 8px; }
.lab-field label span { font-family: var(--mono); font-size: .78rem; color: var(--ink2); }
.lab-field input[type=range] { width: 100%; accent-color: var(--mamoru); }
.lab-field .lab-scale { display: flex; justify-content: space-between; font-family: var(--mono); font-size: .68rem; color: var(--stone); }
.lab-toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: .86rem; }
.lab-toggle input { accent-color: var(--mamoru); width: 18px; height: 18px; }
.lab-run { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); border-radius: var(--r); padding: 10px 12px; cursor: pointer; font-size: .92rem; width: 100%; }
.lab-run:active { transform: translateY(1px); }
/* Busy or unavailable stays readable: ink on paper at reduced strength (Ot 23-oct: feedback must be visible). The doubled class outranks the console's generic button:disabled. */
.lab-run.lab-run:disabled { background: var(--ink); color: var(--paper); border-color: var(--ink); opacity: .72; cursor: progress; }
.lab-run.lab-run:disabled:not([aria-busy="true"]) { cursor: not-allowed; opacity: .45; }
.lab-note { font-size: .8rem; color: var(--stone); }
.lab-later { opacity: .55; }
.lab-later label::after { content: "más adelante"; font-family: var(--mono); font-size: .64rem; color: var(--stone); border: 1px solid var(--wash); border-radius: 999px; padding: 0 6px; margin-left: 6px; }

/* ---- "Ejecutar escenario" feedback (otto/mamoru-astro#28 follow-up, Ot 23 Oct) ---- */
@keyframes lab-spin { to { transform: rotate(360deg); } }
.lab-spinner { display: inline-block; width: 13px; height: 13px; border-radius: 50%; border: 2px solid rgba(248, 245, 239, .35); border-top-color: var(--paper); animation: lab-spin .7s linear infinite; flex: none; }

/* the detail card, right under the Run button */
.lab-status-card { margin-top: 2px; border: 1px solid var(--wash); border-radius: var(--r); background: var(--card); padding: 10px 11px; display: grid; gap: 4px; position: relative; }
.lab-status-card.lab-failed { border-color: var(--loss); }
.lab-status-spec { font-family: var(--mono); font-size: .72rem; color: var(--stone); overflow-wrap: anywhere; }
.lab-status-text { font-size: .88rem; line-height: 1.35; padding-right: 1.1rem; }
.lab-status-card.lab-failed .lab-status-text { color: var(--loss); }
.lab-status-sub { font-size: .76rem; color: var(--stone); }
.lab-status-close { position: absolute; top: 6px; right: 7px; border: 0; background: none; color: var(--stone); font-size: .95rem; line-height: 1; cursor: pointer; padding: 2px 4px; }
.lab-status-close:hover { color: var(--ink); }
.lab-retry { justify-self: start; margin-top: 2px; border: 1px solid var(--loss); background: none; color: var(--loss); border-radius: var(--r); padding: 4px 10px; font-size: .78rem; cursor: pointer; }
.lab-retry:hover { background: var(--loss); color: var(--paper); }

/* indeterminate progress, queued/running only */
@keyframes lab-indeterminate { 0% { left: -30%; width: 30%; } 60% { left: 100%; width: 40%; } 100% { left: 100%; width: 40%; } }
.lab-progress { position: relative; height: 3px; border-radius: 2px; background: var(--wash); overflow: hidden; margin-top: 2px; }
.lab-progress i { position: absolute; top: 0; bottom: 0; background: var(--mamoru); border-radius: 2px; animation: lab-indeterminate 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .lab-progress i { animation: none; left: 0; width: 100%; opacity: .5; } }

/* compact chip, left column, queued/running only */
.lab-chip-job { font-family: var(--mono); font-size: .74rem; border: 1px dashed var(--wash); border-radius: 999px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px; width: fit-content; }
.lab-chip-job .lab-spinner { width: 10px; height: 10px; border-color: rgba(138, 133, 120, .35); border-top-color: var(--mamoru); }

/* the strategy card just computed/selected gets a brief wash, never a loud flash */
@keyframes lab-flash { 0% { background: color-mix(in oklab, var(--mamoru) 22%, var(--card)); } 100% { background: var(--sel); } }
.lab-var.lab-flash { animation: lab-flash 1.2s ease-out 1; }

.lab-chat { display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; gap: 10px; min-height: 0; min-width: 0; }
/* Same reasoning as ".lab-shell main > *, .lab-shell aside > * { min-width: 0 }" above, one level deeper: a
   grid track's implicit sizing otherwise grows to fit a wide child (a long message, a chip row) instead of
   letting that child wrap inside the 330px right column -- every row of .lab-chat's own grid needs the same
   min-width: 0 floor, and so does .lab-ans's own nested grid (claim chips/verdict sentences wrap inside it,
   not the whole card growing past the column). */
.lab-chat > * { min-width: 0; }
.lab-ans > * { min-width: 0; }
.lab-msg { display: grid; gap: 6px; }
.lab-msg.lab-me { justify-items: end; }
.lab-msg.lab-me p { margin: 0; background: var(--ink); color: var(--paper); border-radius: 12px 12px 2px 12px; padding: 8px 12px; max-width: 92%; font-size: .9rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.lab-ans { border: 1px solid var(--wash); background: var(--card); border-radius: 12px 12px 12px 2px; padding: 12px; display: grid; gap: 10px; }
.lab-ans.lab-failed { border-color: var(--loss); }
.lab-verdict { font-size: 1rem; line-height: 1.35; margin: 0; }
.lab-verdict b { font-weight: 600; }
.lab-verdict-claim { display: block; }
.lab-prose { border-top: 1px dashed var(--wash); padding-top: 8px; font-size: .84rem; color: var(--ink2); display: grid; gap: 4px; }
.lab-prose p { margin: 0; }
.lab-prose-label { font-family: var(--mono); font-size: .68rem; letter-spacing: .04em; text-transform: uppercase; color: var(--stone); }

/* "Preguntar al Lab" (otto/mamoru-astro#30, spec 008 phase 2) */
.lab-ask-head { display: flex; gap: 8px; align-items: center; }
.lab-ask-threadsel { flex: 1; min-width: 0; border: 1px solid var(--wash); background: var(--rice); color: var(--ink); border-radius: var(--r); padding: 6px 8px; font-size: .86rem; font-family: var(--serif); }
.lab-ask-new { border: 1px solid var(--wash); background: none; color: var(--ink2); border-radius: var(--r); padding: 6px 10px; font-size: .82rem; cursor: pointer; white-space: nowrap; }
.lab-ask-new:hover { border-color: var(--mamoru); color: var(--mamoru); }
.lab-ask-messages { display: grid; gap: 14px; overflow-y: auto; min-height: 120px; max-height: 52vh; padding-right: 2px; min-width: 0; }
.lab-ask-messages > * { min-width: 0; }
.lab-ask-empty { font-size: .84rem; color: var(--stone); }
.lab-ask-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.lab-ask-chip { display: inline-grid; gap: 1px; border: 1px solid var(--wash); background: var(--rice); border-radius: var(--r); padding: 5px 9px; }
.lab-ask-chip b { font-size: .86rem; font-weight: 600; }
.lab-ask-chip small { font-size: .68rem; color: var(--stone); }
.lab-ask-chip:hover { border-color: var(--mamoru); }
.lab-ask-openbench { justify-self: start; border: 1px solid var(--mamoru); background: none; color: var(--mamoru); border-radius: var(--r); padding: 5px 10px; font-size: .8rem; cursor: pointer; }
.lab-ask-openbench:hover { background: var(--mamoru); color: var(--paper); }
.lab-ask-partial { margin: 0; font-size: .78rem; color: var(--hold); border: 1px dashed var(--hold); border-radius: var(--r); padding: 5px 8px; }
.lab-ask-footer { font-family: var(--mono); font-size: .68rem; color: var(--stone); border-top: 1px dashed var(--wash); padding-top: 6px; overflow-wrap: anywhere; }
/* the pending answer card, same persistent-status discipline as the Run button's (#28): role=status written
   once per shape, the ticking seconds live in their own aria-hidden span, never inside the announced text. */
.lab-ask-pending-text { display: block; }
.lab-ask-pending-secs { font-family: var(--mono); color: var(--stone); }
.lab-ask-suggestions { display: flex; flex-wrap: wrap; gap: 6px; }
.lab-ask-suggestion { border: 1px dashed var(--wash); background: none; color: var(--ink2); border-radius: 999px; padding: 5px 10px; font-size: .78rem; cursor: pointer; text-align: left; }
.lab-ask-suggestion:hover { border-color: var(--mamoru); color: var(--mamoru); }
.lab-ask-err { margin: 0; font-size: .78rem; color: var(--loss); }
.lab-ask-err:empty { display: none; }
.lab-ask-form { display: flex; gap: 8px; align-items: flex-end; }
.lab-ask-input { flex: 1; min-width: 0; resize: none; border: 1px solid var(--wash); background: var(--rice); color: var(--ink); border-radius: var(--r); padding: 8px 10px; font-family: var(--serif); font-size: .9rem; max-height: 120px; }
.lab-ask-input:focus { outline: 2px solid var(--mamoru); outline-offset: 1px; }
.lab-ask-send { border: 1px solid var(--ink); background: var(--ink); color: var(--paper); border-radius: var(--r); padding: 8px 14px; font-size: .86rem; cursor: pointer; }
.lab-ask-send:disabled { opacity: .45; cursor: not-allowed; }
/* Disabled stays readable in light and dark: the doubled class outranks the console's generic button:disabled (same as .lab-run). */
.lab-ask-send.lab-ask-send:disabled { background: var(--ink); color: var(--paper); border-color: var(--ink); opacity: .5; }
.lab-ask-new.lab-ask-new:disabled { background: none; color: var(--stone); border-color: var(--wash); opacity: .7; cursor: default; }

@media (max-width: 1180px) { .lab-shell { grid-template-columns: 220px minmax(0, 1fr); } .lab-shell aside.lab-right { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--wash); } }
@media (max-width: 820px) {
  .lab-shell { grid-template-columns: minmax(0, 1fr); min-height: 0; align-content: start; }
  .lab-shell aside.lab-left { border-right: 0; border-bottom: 1px solid var(--wash); order: 0; }
  .lab-shell main { order: 1; padding-inline: 16px; }
  .lab-shell aside.lab-right { order: 2; }
  .lab-shell aside.lab-left, .lab-shell aside.lab-right { padding-inline: 16px; }
  .lab-top { padding-inline: 16px; }
  .lab-simchip { margin-left: 0; }
  .lab-tiles { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .lab-tile { padding: 8px; }
  .lab-tile .lab-v { font-size: 1rem; }
  .lab-ev { grid-template-columns: 5.6rem minmax(0, 1fr) auto; }
  .lab-ev .lab-p { display: none; }
  /* otto/mamoru-astro#30: the chat panel already stacks under the bench (aside.lab-right order: 2, above) --
     cap the message list shorter here so "Enviar" is always one scroll away, never pushed fully off-screen. */
  .lab-ask-messages { max-height: none; overflow-y: visible; }
}
@media (prefers-reduced-motion: reduce) { .lab-root * { transition: none !important; animation: none !important; } }
/* GPT-6 Sol review (otto/mamoru-astro#28 follow-up): the rule above already stops the spin (animation: none
   !important), but a frozen ring with one differently-coloured side reads as a broken shape, not a paused one.
   Placed last so it wins the cascade over .lab-spinner's and .lab-chip-job .lab-spinner's own unconditional
   sizing/border rules above — a plain static dot says "busy" without needing motion. */
@media (prefers-reduced-motion: reduce) {
  .lab-spinner { border: none; width: 7px; height: 7px; background: var(--paper); }
  .lab-chip-job .lab-spinner { width: 6px; height: 6px; background: var(--mamoru); }
}
`;
