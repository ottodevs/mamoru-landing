/** Renders /ops/yield (otto/mamoru-astro#20). Pure string building over a YieldOverview model. */

import { renderBars } from "./metrics-charts";
import { fmtInt } from "./metrics-math";
import { accountFilterBar, figure, pageHead, type SectionView } from "./ops";
import { fmtAccountKey, fmtApr, fmtCapitalUsd, fmtEth, fmtMoneyUsd, fmtRelative } from "./ops-format";
import { esc } from "./text";
import { YIELD_PERIODS, type YieldAccountView, type YieldOverview, type YieldPeriod, type YieldPositionView } from "./yield-overview";

const PERIOD_LABEL: Record<YieldPeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "all time" };

const sel = (value: string, current: string): string => (value === current ? " selected" : "");

function periodField(period: YieldPeriod): string {
  const options = YIELD_PERIODS.map((p) => `<option value="${p}"${sel(p, period)}>${PERIOD_LABEL[p]}</option>`).join("");
  return `<label class="yld-period">Period<select name="period">${options}</select></label>`;
}

function heroValueAndLines(o: YieldOverview): { value: string; lines: string[] } {
  if (o.netYieldUnpriced) {
    // Gas was recorded this period but there is no ETH price yet: a fabricated $0 of cost would overstate
    // net (code review, otto/mamoru-astro#20 PR #10), so the figure itself reads "—", not a number.
    return { value: "—", lines: [`${esc(fmtEth(o.netYieldGasEth ?? 0))} of gas recorded, not yet priced`, "Net unavailable until the ETH price is read."] };
  }
  if (!o.netYieldIsNet) return { value: esc(fmtMoneyUsd(o.netYieldPeriodUsd ?? 0)), lines: ["Fees only. Gas not recorded yet."] };
  return { value: esc(fmtMoneyUsd(o.netYieldPeriodUsd ?? 0)), lines: [] };
}

function statRow(o: YieldOverview): string {
  const hero = heroValueAndLines(o);
  return `<dl class="figs" style="--n:5;--lead:1.5fr" aria-label="Yield headline figures">
    ${figure({ col: 1, lead: true, label: "Net yield to users", value: hero.value, lines: hero.lines })}
    ${figure({ col: 2, label: "Fees earned to date", value: esc(fmtMoneyUsd(o.feesEarnedToDateUsd)) })}
    ${figure({ col: 3, label: "Fee APR", value: o.feeAprPeriodPct === null ? "—" : esc(fmtApr(o.feeAprPeriodPct)), lines: ["Gross, over the period"] })}
    ${figure({ col: 4, label: "Capital in positions", value: esc(fmtCapitalUsd(o.capitalInPositionsUsd)) })}
    ${figure({
      col: 5,
      label: "Projected fee",
      value: esc(fmtMoneyUsd(o.projectedFeeCollectedUsd)),
      lines: [`+${esc(fmtMoneyUsd(o.projectedFeeUncollectedUsd))} if every uncollected fee were harvested too`],
    })}
  </dl>`;
}

function dailyBarsSection(o: YieldOverview): string {
  const label = PERIOD_LABEL[o.period];
  const feesChart = renderBars({
    id: "yield-fees",
    title: `Fees earned per day, ${label}`,
    slots: o.dailyBars.map((b) => ({ day: b.day, n: b.feesUsd })),
    emptyNote: "Nothing captured yet. The first snapshot starts the line.",
    format: "usd",
    label: "Fees earned",
  });
  const gasDays = o.dailyBars.filter((b) => b.gasUsd !== null);
  // Gas is drawn as its own bars, shown only when at least one day in the period actually recorded it
  // (otto/mamoru-astro#20): renderBars has no negative-value mode, so a true single-chart net-of-gas view
  // is not this primitive's shape. A second reading of the same primitive, directly under the fees it is a
  // cost against, says the same thing without inventing a new chart idiom.
  const gasChart = gasDays.length
    ? `<div class="sec-head"><h3>Gas paid, ${esc(label)}</h3></div>${renderBars({
        id: "yield-gas",
        title: `Gas Mamoru paid per day, ${label}`,
        slots: o.dailyBars.map((b) => ({ day: b.day, n: b.gasUsd })),
        emptyNote: "Gas is not recorded yet.",
        format: "usd",
        label: "Gas paid",
      })}<p class="plot-note" style="position:static">Shown as a cost, not subtracted from the bars above.</p>`
    : "";
  return `<section class="sec full" style="--s:0ms">
    <div class="sec-head"><h2>Fees earned per day</h2></div>
    ${feesChart}
    ${gasChart}
  </section>`;
}

function positionsTable(accountKey: string, positions: readonly YieldPositionView[]): string {
  if (!positions.length) return `<p class="soft" style="margin:0 0 0.9rem 1.2rem">No open positions.</p>`;
  const rows = positions
    .map(
      (p) => `<tr>
        <td>${esc(p.pool)}</td>
        <td>${p.inRange ? "In range" : "Out of range"}</td>
        <td>${esc(fmtCapitalUsd(p.valueUsd))}</td>
        <td>${esc(fmtMoneyUsd(p.accruedFeesUsd))}</td>
        <td>${p.collectedUsd === null ? "—" : esc(fmtMoneyUsd(p.collectedUsd))}</td>
        <td>${p.vsHoldUsd === null ? "—" : esc(fmtMoneyUsd(p.vsHoldUsd))}</td>
      </tr>`,
    )
    .join("");
  return `<table class="yld-positions" aria-label="Positions of ${esc(fmtAccountKey(accountKey))}">
    <thead><tr><th>Pool</th><th>Range</th><th>Value</th><th>Accrued fees</th><th>Collected</th><th>vs hold</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Gas to date: "—" when never recorded, the ETH amount with an "unpriced" note when recorded but there is
 * no ETH price yet (never a fabricated $0.00 — code review, otto/mamoru-astro#20 PR #10), else the USD sum. */
function gasToDateCell(a: YieldAccountView): string {
  if (!a.gasRecorded) return "—";
  if (a.gasUnpriced) return `${esc(fmtEth(a.gasToDateEth ?? 0))}, unpriced`;
  return esc(fmtMoneyUsd(a.gasToDateUsd ?? 0));
}

function accountRow(a: YieldAccountView): string {
  const summary = `<summary><div class="yld-row">
    <span>${esc(fmtAccountKey(a.accountKey))}</span>
    <span class="yld-wide">${esc(a.env)}</span>
    <span>${esc(fmtCapitalUsd(a.totalUsd))}</span>
    <span>${esc(fmtCapitalUsd(a.inPositionsUsd))}</span>
    <span>${esc(fmtMoneyUsd(a.feesUncollectedUsd))}</span>
    <span>${esc(fmtMoneyUsd(a.collectedToDateUsd))}</span>
    <span class="yld-wide">${gasToDateCell(a)}</span>
    <span${a.netToDateUsd === null ? ' title="Net unavailable: gas recorded, not yet priced"' : ""}>${a.netToDateUsd === null ? "—" : esc(fmtMoneyUsd(a.netToDateUsd))}</span>
    <span>${a.aprPeriodPct === null ? "—" : esc(fmtApr(a.aprPeriodPct))}</span>
    <span class="yld-wide">${a.vsHoldUsd === null ? "—" : esc(fmtMoneyUsd(a.vsHoldUsd))}</span>
    <span class="yld-wide">${fmtInt(a.positionsInRange)} of ${fmtInt(a.positionsTotal)}</span>
    <span>${a.lastReadIso ? esc(fmtRelative(a.lastReadIso)) : "—"}</span>
  </div></summary>`;
  return `<details class="yld-acct">${summary}${positionsTable(a.accountKey, a.positions)}</details>`;
}

function accountsTable(o: YieldOverview): string {
  const header = `<div class="yld-row yld-head" role="row">
    <span>Account</span><span class="yld-wide">Env</span><span>Total</span><span>In positions</span>
    <span>Uncollected</span><span>Collected</span><span class="yld-wide">Gas</span><span>Net</span>
    <span>Fee APR</span><span class="yld-wide">vs hold</span><span class="yld-wide">Positions</span><span>Last read</span>
  </div>`;
  const rows = o.accounts.map(accountRow).join("");
  return `<div class="yld-table" role="table" aria-label="Yield per account">${header}${rows}</div>`;
}

function emptyBody(o: YieldOverview): string {
  if (o.missing0009) return `<p class="empty">Migration 0009 is not applied yet; nothing can be shown.</p>`;
  if (!o.flagOn) return `<p class="empty">The yield ledger is off. <a href="/ops/engine/functions">Turn it on in Functions</a>.</p>`;
  return `<p class="empty">Waiting for the first snapshot. The Worker stores one every 10 minutes.</p>`;
}

/** The Yield overview as a section body: the shared account filter plus a period control, the headline
 * figures, the daily bars, and the per-account ledger. Read-only: no form here posts anything, so unlike
 * ops-settings.ts/ops-functions.ts this section needs no CSRF token (same as ops-experiments.ts's ledger). */
export function yieldSection(o: YieldOverview): SectionView {
  const head = pageHead({ title: "Yield", asOf: o.asOf ?? undefined });
  const filterBar = accountFilterBar({ filter: o.filter, action: "/ops/yield", extra: periodField(o.period) });
  if (o.missing0009 || !o.flagOn || o.noRows) {
    return { section: "yield", title: "Yield", html: `${head}${filterBar}${emptyBody(o)}` };
  }
  const note = o.missing0010 ? `<p class="quiet-line">Migration 0010 is not applied yet: "vs hold" and a position's "collected" read as "—".</p>` : "";
  return {
    section: "yield",
    title: "Yield",
    html: `${head}
    ${filterBar}
    ${note}
    ${statRow(o)}
    <div class="cols">
      ${dailyBarsSection(o)}
      <section class="sec full" style="--s:0ms">
        <div class="sec-head"><h2>Per account</h2></div>
        ${accountsTable(o)}
      </section>
    </div>`,
  };
}
