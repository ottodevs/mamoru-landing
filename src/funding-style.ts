/**
 * otto/mamoru-astro#32: CSS for the Funding part of /ops/infra (src/ops-funding.ts). Selectors start with `.fd`, `.fp`
 * or `table.fund`, the last building on the funding list rules in OPS_STYLE. Concatenated into the console's one
 * `<style>` (renderDocument in ops.ts). Washi, ink, hairlines; no cards, shadows or accent borders.
 */

export const FUNDING_STYLE = `
.fd { display: contents; }

/* ---- overview ---- */
.fd-lead { margin: 0.6rem 0 0; font-size: 1.3rem; line-height: 1.35; max-width: 44rem; text-wrap: pretty; }
.fd-lead.short { color: var(--warn); }
.fd-chains { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: clamp(1.4rem, 4vw, 3.5rem); margin-top: 1.3rem; }
.fd-chain { min-width: 0; border-top: 1px solid var(--ink); padding-top: 0.75rem; }
.fd-chain h3 { margin: 0; font-size: 1.15rem; font-weight: 400; }
.fd-chain > p.soft { margin: 0.3rem 0 0.7rem; font-size: 0.85rem; line-height: 1.45; min-height: 3.7em; }
.fd-wallets { list-style: none; margin: 0; padding: 0; }
.fd-wallets li { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 0.8rem; padding: 0.45rem 0; border-top: 1px solid var(--rule-soft); font-variant-numeric: tabular-nums; }
.fd-w { color: var(--muted); font-size: 0.9rem; }
.fd-b { text-align: right; font-size: 1.05rem; }
.fd-wallets li > span:last-child { grid-column: 2; text-align: right; font-size: 0.8rem; }
.fd-dep { margin-top: 0.6rem; font-size: 0.85rem; }
.fd-dep summary { cursor: pointer; color: var(--emerald); width: fit-content; }
.fd-dep ul { list-style: none; margin: 0.5rem 0 0; padding: 0; }
.fd-dep li { padding: 0.3rem 0; border-top: 1px solid var(--rule-soft); line-height: 1.35; }
.fd-dep li span { display: block; font-size: 0.8rem; }

/* ---- the lines ---- */
table.fund { margin: 0.9rem 0 0.4rem; }
table.fund thead th { color: var(--muted); font-size: 0.85rem; padding: 0.4rem 0 0.4rem 1rem; text-align: right; white-space: nowrap; }
table.fund thead th:first-child { text-align: left; padding-left: 0.6rem; }
table.fund td { vertical-align: top; }
table.fund td.f-who { max-width: 30rem; }
table.fund .f-who .f-addr { display: inline-block; margin-top: 0.25rem; font-size: 0.8rem; font-variant-numeric: tabular-nums; }
table.fund td.f-bal b, table.fund td.f-short b { font-weight: 400; font-size: 1.15rem; display: block; }
table.fund td.f-tgt, table.fund td.f-short { text-align: right; white-space: nowrap; }
table.fund td.f-tgt span { display: block; font-size: 0.8rem; margin-top: 0.15rem; }
table.fund td.f-short b { color: var(--warn); }
table.fund tr.f-info td { background: none; color: var(--ink); }
table.fund tr.f-info td.f-who b { color: var(--muted); }

/* ---- send ---- */
.fd-send { padding-bottom: 2.6rem; }
.fd-tabs { display: flex; gap: 1.3rem; }
.fd-tabs button { background: none; color: var(--muted); padding: 0.25rem 0; border-bottom: 1px solid transparent; }
.fd-tabs button:hover { background: none; color: var(--ink); }
.fd-tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.fd-one { margin-top: 1rem; }
.fp-lead { margin: 0.8rem 0 1.1rem; font-size: 0.95rem; max-width: 44rem; }
.fp-chains { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: clamp(1.4rem, 4vw, 3.5rem); }
.fp-chain { min-width: 0; }
.fp-chain h4 { margin: 0 0 0.3rem; font-size: 1rem; font-weight: 400; border-bottom: 1px solid var(--ink); padding-bottom: 0.35rem; }
.fp-chain ul { list-style: none; margin: 0; padding: 0; }
.fp-row { padding: 0.7rem 0 0.6rem; border-bottom: 1px solid var(--rule-soft); }
.fp-on { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; }
.fp-on input { width: 1rem; height: 1rem; margin: 0; accent-color: var(--ink); }
.fp-in { display: flex; align-items: baseline; gap: 0.45rem; border-bottom: 1px solid var(--ink); margin-top: 0.3rem; }
.fp-in input { flex: 1; min-width: 0; width: 100%; border: 0; background: none; padding: 0.1rem 0 0.15rem; font-size: 1.55rem; line-height: 1.15; font-variant-numeric: tabular-nums; outline: none; }
.fp-in input::placeholder { color: rgba(15, 15, 14, 0.3); }
.fp-in:focus-within { border-bottom-color: var(--emerald); box-shadow: 0 1px 0 var(--emerald); }
.fp-in .unit { color: var(--muted); font-size: 0.9rem; }
.fp-row:has(.fp-on input:not(:checked)) .fp-in { opacity: 0.35; }
.fp-row.bad .fp-in { border-bottom-color: var(--bad); }
.fp-state { display: block; min-height: 1.3em; margin-top: 0.3rem; font-size: 0.8rem; color: var(--muted); overflow-wrap: anywhere; }
.fp-row.bad .fp-state, .fp-row[data-phase="failed"] .fp-state { color: var(--bad); }
.fp-row[data-phase="confirmed"] .fp-state { color: var(--emerald); }
.fp-row[data-phase="unknown"] .fp-state { color: var(--warn); }
.fp-row[data-phase="switching"] .fp-state, .fp-row[data-phase="signing"] .fp-state, .fp-row[data-phase="sent"] .fp-state { color: var(--ink); }
.fp-split { margin: 0.8rem 0 0; font-size: 0.85rem; }
.fp-split label { color: var(--muted); }
.fp-split .fp-in input { font-size: 1.05rem; }
.fp-split .soft { display: block; margin-top: 0.25rem; font-size: 0.8rem; }
.fp-total { margin: 0.6rem 0 0; font-size: 0.85rem; }
.fp-line { margin: 1.4rem 0 0; font-size: 1.15rem; line-height: 1.4; max-width: 44rem; min-height: 1.4em; }
.fp-line.good { color: var(--emerald); }
.fp-line.warn { color: var(--warn); }
.fp-line.bad { color: var(--bad); }
.fp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem 1.4rem; margin-top: 1rem; }
.fp-actions button.go { padding: 0.75rem 1.3rem; }

@media (max-width: 860px) {
  .fd-chains, .fp-chains { grid-template-columns: minmax(0, 1fr); row-gap: 1.4rem; }
  .fd-chain > p.soft { min-height: 0; }
}
@media (max-width: 640px) {
  .fd-lead { font-size: 1.1rem; }
  /* The lines read as one block per wallet: nothing scrolls sideways. */
  table.fund thead { display: none; }
  table.fund tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; padding: 0.7rem 0; border-bottom: 1px solid var(--rule); }
  table.fund td { display: block; border: 0; padding: 0.15rem 0 !important; text-align: left !important; }
  table.fund td.f-who { grid-column: 1 / -1; padding-left: 0.6rem !important; }
  table.fund td.f-act { grid-column: 2; grid-row: 1; justify-self: end; }
  table.fund td.f-who { grid-row: 1; grid-column: 1; }
  table.fund td[data-k]::before { content: attr(data-k); display: block; font-size: 0.75rem; color: var(--muted); }
  table.fund td.f-bal, table.fund td.f-tgt, table.fund td.f-short { padding-left: 0.6rem !important; }
  .fd-tabs { gap: 1rem; font-size: 0.9rem; }
}
`;
