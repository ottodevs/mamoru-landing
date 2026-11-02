/**
 * CSS for /ops/money/registry (src/ops-registry.ts, otto/mamoru#296). Selectors start with `.rg`. Concatenated into the
 * console's one `<style>` (renderDocument in ops.ts). Washi, ink, hairlines; no cards, shadows or accent borders. Controls
 * are plain buttons and selectors: nothing underlined.
 */

export const REGISTRY_STYLE = `
.rg-lead { margin: 0.9rem 0 0; max-width: 44rem; color: var(--muted); }
.rg-pick { display: flex; flex-wrap: wrap; align-items: end; gap: 0.6rem 0.9rem; margin: 1.1rem 0 0.4rem; }
.rg-pick label { display: grid; gap: 0.25rem; font-size: 0.85rem; color: var(--muted); }
.rg-pick select { font: inherit; color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 0; padding: 0.5rem 0.6rem; min-width: 9rem; }
.rg { padding-bottom: 2rem; min-width: 0; max-width: 100%; }
.rg .sec-head > span { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
.rg-addr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86rem; overflow-wrap: anywhere; }
.rg-facts { margin: 0.5rem 0 0; font-size: 0.9rem; max-width: 46rem; }
.rg-empty { margin: 0.8rem 0 0.4rem; }
.rg .rg-h { margin: 1.6rem 0 0.6rem; font-size: 1rem; font-weight: 400; color: var(--muted); }
.rg h4 { margin: 0 0 0.4rem; font-size: 1.05rem; font-weight: 400; }

/* ---- waiting to take effect: the heavy rule and the large serif figure are the highlight ---- */
.rg-pend { border-top: 2px solid var(--ink); padding: 0.9rem 0 1.3rem; margin-bottom: 0.4rem; }
.rg-when { margin: 0 0 0.2rem; font-size: 1.7rem; line-height: 1.2; color: var(--warn); font-variant-numeric: tabular-nums; }
.rg-when.ready { color: var(--emerald); }
.rg-kv { margin: 0.6rem 0 0; display: grid; gap: 0.35rem; }
.rg-kv > div { display: grid; grid-template-columns: 9rem minmax(0, 1fr); column-gap: 1rem; }
.rg-kv dt { color: var(--muted); font-size: 0.88rem; }
.rg-kv dd { margin: 0; overflow-wrap: anywhere; }
.rg-cd { margin-top: 1rem; border-top: 1px solid var(--rule-soft); padding-top: 0.7rem; }
.rg-cd-h { margin: 0 0 0.2rem; }
.rg-cd-to { margin: 0 0 0.4rem; font-size: 0.85rem; }
.rg-data { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; line-height: 1.5; overflow-wrap: anywhere; word-break: break-all; border: 1px solid var(--rule); padding: 0.55rem 0.7rem; user-select: all; }
.rg-act { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.8rem; }
button.rg-copy { background: var(--ink); color: var(--paper); text-decoration: none; padding: 0.5rem 0.9rem; min-height: 2.25rem; }
button.rg-copy:hover { background: var(--emerald); }
.rg-fb { font-size: 0.88rem; color: var(--emerald); min-height: 1.2em; }

/* ---- in force, history ---- */
.rg-kinds { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.4rem; }
.rg-kinds > div, .rg-pend, .rg-cd, .rg-kv > div > dd { min-width: 0; }
.rg-scroll { overflow-x: auto; }
table.rg-t { font-variant-numeric: tabular-nums; }
table.rg-t th, table.rg-t td { padding: 0.5rem 1rem 0.5rem 0; }
@media (max-width: 720px) {
  .rg-kv > div { grid-template-columns: minmax(0, 1fr); }
  .rg-when { font-size: 1.45rem; }
  table.rg-t { min-width: 30rem; }
}
`;
