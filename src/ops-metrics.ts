/** Renders /ops, the metrics overview. Pure string building over an Overview model. */

import { renderBars, renderFunnel, renderTally, renderTimeChart } from "./metrics-charts";
import { dauSlots, fmtInt, fmtUsd, shortDay } from "./metrics-math";
import { DAU_DAYS, type Change, type Overview } from "./metrics-overview";
import { pageHead, renderDocument, type SectionView } from "./ops";
import { esc } from "./text";

function signed(value: number, format: "usd" | "int"): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  return `${sign}${format === "usd" ? fmtUsd(abs) : fmtInt(abs)}`;
}

/** "+9 in 7 days", "no change in 7 days", "−$4.10 since 21 Sep". Direction is carried by the sign, not by color. */
export function changeLine(change: Change | null, format: "usd" | "int"): string {
  if (!change) return "";
  const span = change.exact ? "in 7 days" : `since ${shortDay(change.since)}`;
  if (change.delta.dir === "flat") return `No change ${span}`;
  const pct =
    format === "int" || change.delta.pct === null || Math.abs(change.delta.pct) < 1
      ? ""
      : ` (${change.delta.pct > 0 ? "+" : "−"}${Math.abs(change.delta.pct).toFixed(0)}%)`;
  return `${signed(change.delta.abs, format)}${pct} ${span}`;
}

function count(value: number, format: "usd" | "int" | "dec1" = "int"): string {
  const text = format === "usd" ? fmtUsd(value) : format === "dec1" ? value.toFixed(1) : fmtInt(value);
  return `<span data-n="${value}" data-f="${format}">${esc(text)}</span>`;
}

function figure(opts: { col: number; lead?: boolean; label: string; value: string; lines: string[] }): string {
  const lines = opts.lines.filter(Boolean).map((line) => `<span>${esc(line)}</span>`).join("");
  return `<div class="fig${opts.lead ? " lead" : ""}" style="--c:${opts.col};--m:${opts.col - 1}">
    <dt>${esc(opts.label)}</dt>
    <dd class="fig-n">${opts.value}</dd>
    <dd class="fig-s">${lines}</dd>
  </div>`;
}

function figures(o: Overview): string {
  const since = o.firstSignup ? `Since ${shortDay(o.firstSignup)}` : "";
  const money = o.chainOk || o.value.length > 0;
  const avg = o.dauAvg
    ? `${o.dauAvg.days >= 7 ? "7-day" : `${o.dauAvg.days}-day`} average ${o.dauAvg.avg.toFixed(1)}`
    : "Not recorded yet";
  return `<dl class="figs" aria-label="Headline figures">
    ${figure({
      col: 1,
      lead: true,
      label: "Value held",
      value: money ? count(o.tvl, "usd") : "—",
      lines: money
        ? [`${fmtUsd(o.lp)} in positions · ${fmtUsd(o.idle)} idle USDC`, changeLine(o.changes.tvl, "usd") || "History starts today"]
        : ["Not available right now"],
    })}
    ${figure({ col: 2, label: "Users", value: count(o.users), lines: [changeLine(o.changes.users, "int") || since] })}
    ${figure({ col: 3, label: "Accounts", value: count(o.accounts), lines: [changeLine(o.changes.accounts, "int") || since] })}
    ${figure({
      col: 4,
      label: "Activated",
      value: count(o.activated),
      lines: ["With a position", changeLine(o.changes.activated, "int")],
    })}
    ${figure({
      col: 5,
      label: "Active today",
      value: o.dauToday === null ? "—" : count(o.dauToday),
      lines: [avg],
    })}
    ${figure({
      col: 6,
      label: "In range",
      value: `${count(o.positionsInRange)}<span class="of">of ${fmtInt(o.positions)}</span>`,
      lines: [o.positions === 1 ? "Position" : "Positions"],
    })}
  </dl>`;
}

function table(summary: string, head: string[], rows: string[][]): string {
  if (!rows.length) return "";
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
  return `<details class="tbl"><summary>${esc(summary)}</summary><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></details>`;
}

function valueSection(o: Overview): string {
  const chart = renderTimeChart({
    id: "value",
    title: "Value held over the last 30 days, split into idle USDC and positions",
    days: o.value.map((p) => p.day),
    series: [
      { label: "Idle USDC", tone: "stone", values: o.value.map((p) => p.idle) },
      { label: "In positions", tone: "emerald", values: o.value.map((p) => p.lp) },
    ],
    stacked: true,
    totalLabel: "Value held",
    format: "usd",
    emptyNote: "Nothing captured yet. The first daily snapshot starts the line.",
    singleNote: "History starts today. One capture a day draws the line from here.",
  });
  return `<section class="sec" style="--s:0ms">
    <div class="sec-head">
      <h2>Value held, last 30 days</h2>
      <ul class="legend">
        <li><span class="key sw sw-emerald"></span>In positions<b>${esc(fmtUsd(o.lp))}</b></li>
        <li><span class="key sw sw-stone"></span>Idle USDC<b>${esc(fmtUsd(o.idle))}</b></li>
      </ul>
    </div>
    ${chart}
    ${table(
      "Figures",
      ["Day", "Value held", "In positions", "Idle USDC"],
      o.value.map((p) => [shortDay(p.day), fmtUsd(p.idle + p.lp), fmtUsd(p.lp), fmtUsd(p.idle)]),
    )}
  </section>`;
}

function growthSection(o: Overview): string {
  const chart = renderTimeChart({
    id: "growth",
    title: "Users and accounts, running total since the first signup",
    days: o.growth.map((p) => p.day),
    series: [
      { label: "Users", tone: "ink", values: o.growth.map((p) => p.users) },
      { label: "Accounts", tone: "emerald", values: o.growth.map((p) => p.accounts), dashed: true },
    ],
    format: "int",
    emptyNote: "Nobody has signed up yet.",
    singleNote: "The first signups arrived today.",
  });
  const since = o.firstSignup ? `, since ${shortDay(o.firstSignup)}` : "";
  return `<section class="sec" style="--s:0ms">
    <div class="sec-head">
      <h2>Users and accounts${esc(since)}</h2>
      <ul class="legend">
        <li><span class="key"></span>Users<b>${fmtInt(o.users)}</b></li>
        <li><span class="key k-emerald dashed"></span>Accounts<b>${fmtInt(o.accounts)}</b></li>
      </ul>
    </div>
    ${chart}
    ${table(
      "Figures",
      ["Day", "Users", "Accounts"],
      o.growth.slice(-30).map((p) => [shortDay(p.day), fmtInt(p.users), fmtInt(p.accounts)]),
    )}
  </section>`;
}

function dauSection(o: Overview): string {
  const slots = o.dau ?? dauSlots(new Map(), null, o.today, DAU_DAYS);
  const tracked = slots.filter((s) => s.n !== null);
  const note = o.dau === null ? "Activity is not being recorded yet." : "No activity recorded yet.";
  const chart = renderBars({
    id: "dau",
    title: "Accounts active per day, last 14 days",
    slots,
    emptyNote: note,
  });
  const aside =
    tracked.length > 0 && tracked.length < slots.length
      ? `<p class="soft cap">Recorded since ${esc(shortDay(tracked[0].day))}.</p>`
      : "";
  return `<section class="sec" style="--s:120ms">
    <div class="sec-head"><h2>Active accounts, last 14 days</h2></div>
    ${chart}
    ${aside}
    ${table("Figures", ["Day", "Active"], tracked.map((s) => [shortDay(s.day), fmtInt(s.n ?? 0)]))}
  </section>`;
}

function funnelSection(o: Overview): string {
  return `<section class="sec" style="--s:120ms">
    <div class="sec-head"><h2>From signup to in range</h2></div>
    ${renderFunnel(o.funnel)}
  </section>`;
}

const STATUS_COPY = { ok: "OK", low: "Low", empty: "Empty" } as const;

function runwaySection(o: Overview): string {
  const link = `<a href="/ops/infra">Infra and costs</a>`;
  if (!o.relayer) {
    return `<section class="sec full" style="--s:0ms">
      <div class="sec-head"><h2>Relayer runway</h2>${link}</div>
      <p class="soft" style="margin-top:1rem">Base is unreachable right now, so the relayer balance is not shown.</p>
    </section>`;
  }
  const r = o.relayer;
  const eth = `${r.ethBalance.toFixed(r.ethBalance < 0.001 ? 6 : 4)} ETH`;
  const usd = r.usd === null ? "" : ` · ${fmtUsd(r.usd)}`;
  const can = r.canFund ?? 0;
  const lead =
    r.canFund === null
      ? `<p class="run-n soft">Cost per account is not available.</p>`
      : `<p class="run-n"><span class="fig-n">${count(can)}</span><span class="soft">more ${can === 1 ? "account" : "accounts"} it can fund</span></p>`;
  return `<section class="sec full" style="--s:0ms">
    <div class="sec-head"><h2>Relayer runway</h2>${link}</div>
    <div class="runway">
      ${lead}
      ${renderTally(can) || "<span></span>"}
      <p class="run-s">${esc(eth)}${esc(usd)}<br /><span class="status-${r.status}">Status: ${STATUS_COPY[r.status]}</span></p>
    </div>
  </section>`;
}

/** The Overview as a section body: figures, charts, funnel, runway. */
export function overviewSection(o: Overview, csrf: string): SectionView {
  const notes = o.notes.length
    ? `<div class="notes soft">${o.notes.map((note) => `<p>${esc(note)}</p>`).join("")}</div>`
    : "";
  return {
    section: "overview",
    title: "Overview",
    html: `${pageHead({ title: "Overview", asOf: o.asOf, refresh: { action: "/ops/metrics/snapshot", csrf } })}
    ${notes}
    ${figures(o)}
    <div class="cols">
      ${valueSection(o)}
      ${funnelSection(o)}
      ${growthSection(o)}
      ${dauSection(o)}
      ${runwaySection(o)}
    </div>`,
  };
}

/** Full document for the Overview. */
export function renderOverview(opts: { overview: Overview; csrf: string; nonce: string; who?: string }): string {
  return renderDocument(overviewSection(opts.overview, opts.csrf), { csrf: opts.csrf, who: opts.who, nonce: opts.nonce });
}
