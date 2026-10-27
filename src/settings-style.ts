/**
 * otto/mamoru-astro#22: CSS for `/ops/settings`. Every selector starts with `.set-` so nothing here reaches another
 * section; concatenated into the console's one `<style>` (renderDocument in ops.ts). The console's language: washi,
 * ink, serif figures, hairlines. No cards, shadows or accent borders.
 */

export const SETTINGS_STYLE = `
/* ---- what runs now: one column per environment, a sentence per decision ---- */
.set-now .asof { max-width: 30rem; }
.set-envs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: clamp(1.5rem, 5vw, 4.5rem); margin-top: 1.1rem; }
.set-env h3 { margin: 0 0 0.6rem; font-size: 1.35rem; font-weight: 400; letter-spacing: 0.01em; }
.set-env h3 a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--rule); }
.set-env h3 a:hover { border-bottom-color: var(--ink); }
.set-env dl { margin: 0; }
.set-say { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); column-gap: 1rem; padding: 0.55rem 0; border-top: 1px solid var(--rule-soft); }
.set-say dt { color: var(--muted); font-size: 0.85rem; padding-top: 0.12rem; }
.set-say dd { margin: 0; line-height: 1.45; text-wrap: pretty; }
.set-ver, .set-canary { margin: 0.7rem 0 0; font-size: 0.85rem; color: var(--muted); line-height: 1.45; }
.set-canary { color: var(--warn); }

/* ---- the form ---- */
.set-edit .sec-head h2 { font-size: 1.35rem; }
.set-seg { display: flex; gap: 1.2rem; }
.set-seg a { color: var(--muted); text-decoration: none; padding: 0.2rem 0; border-bottom: 1px solid transparent; }
.set-seg a:hover { color: var(--ink); }
.set-seg a[aria-current] { color: var(--ink); border-bottom-color: var(--ink); }
.set-lead { margin: 0.5rem 0 0.9rem; font-size: 0.95rem; }
.set-pres { display: flex; flex-wrap: wrap; gap: 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.set-pre { flex: 1 1 12rem; min-width: 0; padding: 0.7rem 1.2rem 0.75rem 0; color: var(--ink); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.set-pre + .set-pre { padding-left: 1.2rem; border-left: 1px solid var(--rule-soft); }
.set-pre b { display: block; font-weight: 400; }
.set-pre span { display: block; font-size: 0.8rem; color: var(--muted); line-height: 1.35; margin-top: 0.15rem; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.set-pre:hover b { color: var(--emerald); }
.set-pre[aria-current] { border-bottom-color: var(--ink); }

fieldset.set-grp { margin: 0; padding: 1.6rem 0 1.8rem; border: 0; border-top: 1px solid var(--rule); display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr); column-gap: clamp(1.5rem, 5vw, 4.5rem); min-width: 0; }
.set-pres + .set-form fieldset.set-grp:first-of-type { border-top: 0; }
.set-grp-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 0.7rem; align-items: baseline; align-content: start; }
.set-n { margin: 0; font-size: 0.85rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.set-grp-head h3 { margin: 0; font-size: 1.15rem; font-weight: 400; }
.set-grp-head p.soft { grid-column: 2 / -1; margin: 0.45rem 0 0; font-size: 0.9rem; line-height: 1.5; text-wrap: pretty; }
.set-grp-body { min-width: 0; transition: opacity 160ms ease-out; }
.set-grp.has-tgl:has(.set-tgl input:not(:checked)) .set-grp-body { opacity: 0.35; }
.set-eg { margin: 1rem 0 0; font-size: 0.9rem; color: var(--muted); max-width: 34rem; font-style: italic; }

.set-tgl { display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.9rem; position: relative; }
.set-tgl input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.set-sw { width: 2.1rem; height: 1.15rem; border: 1px solid var(--ink); border-radius: 1rem; position: relative; flex: none; transition: background 140ms ease-out; }
.set-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: calc(1.15rem - 6px); height: calc(1.15rem - 6px); border-radius: 50%; background: var(--ink); transition: transform 160ms var(--out); }
.set-tgl input:checked + .set-sw { background: var(--ink); }
.set-tgl input:checked + .set-sw::after { background: var(--paper); transform: translateX(0.95rem); }
.set-tgl input:checked ~ .when-off, .set-tgl input:not(:checked) ~ .when-on { display: none; }
.set-tgl input:not(:checked) ~ .when-off { color: var(--muted); }
.set-tgl:has(input:focus-visible) .set-sw { outline: 2px solid var(--emerald); outline-offset: 3px; }
.set-tgl.changed .when-on, .set-tgl.changed .when-off { color: var(--emerald); }

.set-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.6rem clamp(1.2rem, 3vw, 2.4rem); }
.set-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 36rem; }
.set-grid.one { grid-template-columns: minmax(0, 20rem); }
.set-fld { display: flex; flex-direction: column; min-width: 0; }
.set-fld > label, .set-why label, .set-more label { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.15rem; }
.set-in { display: flex; align-items: baseline; gap: 0.45rem; border-bottom: 1px solid var(--ink); }
.set-in.wide { flex: 1; }
.set-in input { flex: 1; min-width: 0; width: 100%; border: 0; background: none; padding: 0.1rem 0 0.2rem; font-size: 1.75rem; line-height: 1.15; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; outline: none; }
.set-in.wide input { font-size: 1rem; padding: 0.35rem 0; letter-spacing: 0; }
.set-in input::placeholder { color: rgba(15, 15, 14, 0.3); font-size: 0.55em; letter-spacing: 0; }
.set-in.wide input::placeholder { font-size: 1em; }
.set-in:focus-within { border-bottom-color: var(--emerald); box-shadow: 0 1px 0 var(--emerald); }
.set-in .unit { font-size: 0.9rem; color: var(--muted); white-space: nowrap; }
.set-fld.changed .set-in { border-bottom-color: var(--emerald); }
.set-fld.changed > label { color: var(--emerald); }
.set-fld.bad .set-in { border-bottom-color: var(--bad); }

/* The scale: a hairline from the lower to the upper bound; a tick for the recommended value, a ring for what runs,
   a dot for what is typed. Log axis, so every bound fits on the same line. */
.set-scale { position: relative; display: block; height: 1.9rem; margin: 0.55rem 0 0; }
.set-track { position: absolute; left: 0; right: 0; top: 0.45rem; height: 1px; background: var(--rule); }
.set-mk { position: absolute; top: 0.45rem; transform: translate(-50%, -50%); }
.set-mk.rec { width: 1px; height: 0.7rem; background: var(--emerald); }
.set-mk.now { width: 0.55rem; height: 0.55rem; border: 1px solid var(--ink); border-radius: 50%; background: var(--rice); }
.set-mk.val { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--ink); transition: left 140ms var(--out); }
.set-fld.changed .set-mk.val { background: var(--emerald); }
.set-end { position: absolute; top: 0.85rem; font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.set-end.lo { left: 0; }
.set-end.hi { right: 0; }
.set-hint { display: flex; flex-wrap: wrap; gap: 0.1rem 0.9rem; margin-top: 0.1rem; font-size: 0.8rem; line-height: 1.4; color: var(--muted); }
.set-hint .k-rec::before { content: ""; display: inline-block; width: 1px; height: 0.65rem; background: var(--emerald); margin-right: 0.35rem; vertical-align: -0.05rem; }
.set-hint .k-now::before { content: ""; display: inline-block; width: 0.45rem; height: 0.45rem; border: 1px solid var(--ink); border-radius: 50%; margin-right: 0.35rem; vertical-align: 0; }

.set-more { border-top: 1px solid var(--rule); padding: 1rem 0 1.2rem; }
.set-more summary { cursor: pointer; color: var(--emerald); width: fit-content; }
.set-more[open] summary { margin-bottom: 0.8rem; }
.set-more label { display: block; }
.set-more textarea { display: block; width: 100%; max-width: 36rem; font: inherit; font-size: 0.9rem; font-variant-numeric: tabular-nums; color: var(--ink); background: none; border: 0; border-bottom: 1px solid var(--ink); border-radius: 0; padding: 0.3rem 0; resize: vertical; outline: none; }
.set-more textarea:focus { border-bottom-color: var(--emerald); }

/* The apply bar stays in view at the bottom of the screen while the form is on it. */
.set-bar { position: sticky; bottom: 0; z-index: 3; display: grid; grid-template-columns: minmax(0, 16rem) minmax(0, 1fr) auto; align-items: end; gap: 0.6rem clamp(1rem, 3vw, 2.2rem); padding: 1rem 0 1.1rem; border-top: 1px solid var(--ink); background: var(--rice) url("/rice-washi-tile.webp") repeat; background-size: 256px 256px; }
.set-count { margin: 0; align-self: center; line-height: 1.35; }
.set-bar.dirty .set-count { color: var(--emerald); }
.set-why { display: flex; flex-direction: column; min-width: 0; }
.set-bar button { padding: 0.7rem 1.3rem; }
.set-foot { margin-top: 0.7rem; max-width: 36rem; display: block; }

/* ---- confirm ---- */
.set-confirm { border-top: 1px solid var(--ink); margin-bottom: 1rem; }
.set-confirm h2 { margin-bottom: 0.7rem; }
.set-risks { margin: 0 0 1rem; padding-left: 1.1rem; line-height: 1.55; }
.set-diff { max-width: 46rem; margin-bottom: 1.2rem; }
.set-diff th, .set-diff td { text-align: left !important; white-space: normal !important; padding-right: 1.2rem; }
.set-diff tbody th { color: var(--ink); font-size: 0.95rem; }
.set-go { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1.4rem; padding-top: 1.1rem; border-top: 1px solid var(--rule); }

/* ---- history: one entry per version, what it changed against the one before ---- */
.set-hist { list-style: none; margin: 0.9rem 0 0; padding: 0; }
.set-h { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr) auto; column-gap: 1.4rem; padding: 0.9rem 0; border-top: 1px solid var(--rule-soft); }
.set-h-id { margin: 0; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
.set-h-id span { display: block; font-size: 0.8rem; color: var(--muted); }
.set-h-body p { margin: 0; }
.set-h-why { line-height: 1.4; }
.set-ch { list-style: none; margin: 0.35rem 0 0; padding: 0; font-size: 0.9rem; line-height: 1.5; }
.set-ch .dim, p.set-ch.dim { color: var(--muted); }
.set-h-meta { margin-top: 0.35rem !important; font-size: 0.8rem; color: var(--muted); }
.set-rb summary { cursor: pointer; color: var(--emerald); font-size: 0.85rem; white-space: nowrap; }
.set-rb form { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: baseline; margin-top: 0.5rem; min-width: 14rem; }

@media (max-width: 900px) {
  fieldset.set-grp { grid-template-columns: minmax(0, 1fr); row-gap: 1.1rem; }
  .set-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .set-envs { grid-template-columns: minmax(0, 1fr); row-gap: 1.6rem; }
  .set-say { grid-template-columns: 6.2rem minmax(0, 1fr); }
  .set-pre { flex-basis: 100%; padding-left: 0 !important; border-left: 0 !important; border-top: 1px solid var(--rule-soft); }
  .set-pre:first-child { border-top: 0; }
  .set-grid, .set-grid.two, .set-grid.one { grid-template-columns: minmax(0, 1fr); }
  .set-bar { grid-template-columns: minmax(0, 1fr); }
  .set-bar button { width: 100%; }
  .set-h { grid-template-columns: minmax(0, 1fr); row-gap: 0.4rem; }
  .set-h-id span { display: inline; margin-left: 0.6rem; }
}
`;
