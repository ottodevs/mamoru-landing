/** Renders the Infra section. Pure string building over an Infra reading. */

import type { RelayerStatus } from "./cost";
import type { InfraReading } from "./infra-cache";
import type { InfraSnapshot } from "./infra-snapshot";
import { fmtInt, fmtUsd } from "./metrics-math";
import { countUp, csrfField, noticeHtml, pageHead, renderDocument, type SectionView, when } from "./ops";
import { fundingSection } from "./ops-funding";
import { esc } from "./text";

const STATUS_WORDS: Record<RelayerStatus, string> = { ok: "Healthy", low: "Running low", empty: "Empty" };

function fmtEth(value: number): string {
  return value.toFixed(value < 0.001 ? 6 : 4);
}

function usdOrDash(value: number | null): string {
  return value === null ? "—" : fmtUsd(value);
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const count = countUp;

function retryForm(csrf: string): string {
  return `<form method="post" action="/ops/money/funding/refresh" data-ops-form>${csrfField(csrf)}<button type="submit">Retry</button></form>`;
}

/** The line that says what the reader is looking at when it is not a clean, current reading. */
export function noticeFor(reading: InfraReading): string | null {
  const s = reading.snapshot;
  if (reading.stale) {
    const why =
      reading.stale.reason === "unreachable" ? "a fresh read failed just now" : "a fresh read came back incomplete just now";
    return `Showing the last complete reading from ${when(s.asOf)}; ${why}.`;
  }
  if (s.rpcError) return "Base could not be read, and there is no earlier reading to show.";
  if (s.partial) {
    const total = s.accounts?.rows.length ?? 0;
    const n = s.partial.unreadAccounts;
    const what =
      n > 0
        ? `Some balances could not be read: ${n} of ${total} ${total === 1 ? "account" : "accounts"}.`
        : "Prices could not be read, so dollar values are missing.";
    return `${what} Totals below are incomplete, and there is no earlier complete reading to show.`;
  }
  if (s.accounts?.error) return s.accounts.error;
  return null;
}

function figures(s: InfraSnapshot): string {
  const r = s.relayer;
  const c = s.cost;
  const lead = r
    ? `<dd class="fig-n">${count(r.ethBalance, r.ethBalance < 0.001 ? "dec6" : "dec4", fmtEth(r.ethBalance))}<span class="unit">ETH</span></dd>
       <dd class="fig-s"><span><b class="status-${r.status}">${STATUS_WORDS[r.status]}</b>${r.usd === null ? "" : ` · ${esc(fmtUsd(r.usd))}`}</span><span><a href="${esc(r.basescanUrl)}">${esc(shortAddr(r.address))}</a> on Base</span>${r.status === "ok" ? "" : `<span>New accounts wait until it is <a href="#topup">topped up</a>.</span>`}</dd>`
    : `<dd class="fig-n none">—</dd><dd class="fig-s"><span>Not read yet</span></dd>`;
  const fund = c
    ? `<dd class="fig-n">${count(c.accountsFunded, "int", fmtInt(c.accountsFunded))}</dd><dd class="fig-s"><span>More ${c.accountsFunded === 1 ? "account" : "accounts"} at today's cost</span></dd>`
    : `<dd class="fig-n none">—</dd><dd class="fig-s"></dd>`;
  const cost = c
    ? `<dd class="fig-n">${c.totalUsd === null ? esc(fmtEth(c.totalEth)) : count(c.totalUsd, "usd", fmtUsd(c.totalUsd))}</dd><dd class="fig-s"><span>${esc(fmtEth(c.totalEth))} ETH each</span></dd>`
    : `<dd class="fig-n none">—</dd><dd class="fig-s"></dd>`;
  const gas = c
    ? `<dd class="fig-n">${esc(c.gasPriceGwei.toFixed(4))}<span class="unit">gwei</span></dd><dd class="fig-s"><span>${s.ethUsd === null ? "ETH price not read" : `ETH at ${esc(fmtUsd(s.ethUsd))}`}</span></dd>`
    : `<dd class="fig-n none">—</dd><dd class="fig-s"></dd>`;
  return `<dl class="figs" style="--n:3" aria-label="Relayer">
    <div class="fig lead" style="--c:1;--m:0"><dt>Relayer balance</dt>${lead}</div>
    <div class="fig" style="--c:2;--m:1"><dt>Can fund</dt>${fund}</div>
    <div class="fig" style="--c:3;--m:2"><dt>Cost per new account</dt>${cost}</div>
    <div class="fig" style="--c:4;--m:3"><dt>Gas on Base</dt>${gas}</div>
  </dl>`;
}

function costSection(s: InfraSnapshot): string {
  const c = s.cost;
  if (!c) {
    return `<section class="sec" style="--s:120ms">
      <div class="sec-head"><h2>What one new account costs</h2></div>
      <p class="soft sum">Not available until Base can be read.</p>
    </section>`;
  }
  const rows = [
    ["Safe deploy", c.deployEth, c.deployUsd, ""],
    ["Activation", c.activationEth, c.activationUsd, ""],
    ["Gas reserve, sent to the Safe", c.reserveEth, c.reserveUsd, ""],
    ["Total", c.totalEth, c.totalUsd, "total"],
  ] as const;
  const body = rows
    .map(
      ([label, eth, usd, cls]) =>
        `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(label)}</td><td>${esc(fmtEth(eth))}</td><td class="${cls ? "" : "dim"}">${esc(usdOrDash(usd))}</td></tr>`,
    )
    .join("");
  return `<section class="sec" style="--s:120ms">
    <div class="sec-head"><h2>What one new account costs</h2></div>
    <table class="ledger">
      <thead><tr><th></th><th>ETH</th><th>USD</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="ledger-note">The reserve is not burned. It lands in the user's Safe and pays for that account's own operations. What is spent for good is the deploy plus the activation.</p>
  </section>`;
}

/** Infra as a section body: the relayer figures, then Funding (src/ops-funding.ts), and the cost ledger. The per-account value table moved to Accounts (Pulse and Accounts already show it); the Ethereum column lives in src/ops-outside.ts. */
export function infraSection(reading: InfraReading, csrf: string): SectionView {
  const s = reading.snapshot;
  const notice = noticeFor(reading);
  return {
    section: "infra",
    title: "Funding",
    ...(reading.refreshing ? { refreshing: true } : {}),
    html: `${pageHead({ title: "Funding", asOf: s.asOf, refresh: { action: "/ops/money/funding/refresh", csrf } })}
    ${notice ? noticeHtml(notice, { action: retryForm(csrf) }) : ""}
    ${figures(s)}
    <div class="cols">
      ${fundingSection(s)}
      ${costSection(s)}
    </div>
    <p class="quiet-line">RPC usage and automatic top-up alerts are not live yet.</p>`,
  };
}

/** Full document for Infra. */
export function renderInfra(opts: { reading: InfraReading; csrf: string; nonce: string; who?: string }): string {
  return renderDocument(infraSection(opts.reading, opts.csrf), { csrf: opts.csrf, who: opts.who, nonce: opts.nonce });
}
