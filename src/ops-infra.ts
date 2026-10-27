/** Renders the Infra section. Pure string building over an Infra reading. */

import { FUNDING_TARGETS, fundingStatus, widgetTarget, type FundingRow, type FundingStatus } from "./funding";
import type { RelayerStatus } from "./cost";
import type { InfraReading } from "./infra-cache";
import type { AccountView, InfraSnapshot } from "./infra-snapshot";
import { fmtInt, fmtUsd } from "./metrics-math";
import { outsideLine, summarizeOutside } from "./outside-base";
import { countUp, csrfField, noticeHtml, pageHead, renderDocument, type SectionView, when } from "./ops";
import { esc } from "./text";

/** Rows of the accounts ledger before the rest is summed in one line. */
const ACCOUNT_ROWS = 25;

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
  return `<form method="post" action="/ops/infra/refresh" data-ops-form>${csrfField(csrf)}<button type="submit">Retry</button></form>`;
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

/** The Ethereum holdings of one account: kept apart from the Base columns, which are the working value. */
function outsideCell(row: AccountView): string {
  const o = row.outside;
  if (!o) return "not read";
  if (o.eth === 0 && o.usdc === 0) return "—";
  const parts: string[] = [];
  if (o.eth > 0) parts.push(`${fmtEth(o.eth)} ETH`);
  if (o.usdc > 0) parts.push(`${fmtUsd(o.usdc)} USDC`);
  return `${parts.join(" + ")}${o.usd === null ? "" : ` · ${fmtUsd(o.usd)}`}`;
}

function accountRow(row: AccountView): string {
  const cell = (text: string, cls = "") =>
    row.unread ? `<td class="unread ${cls}">${esc(text)}</td>` : `<td${cls ? ` class="${cls}"` : ""}>${esc(text)}</td>`;
  return `<tr>
    <td class="a-key wide-only">${esc(row.accountKey)}</td>
    <td class="a-addr"><a href="${esc(row.basescanUrl)}">${esc(shortAddr(row.address))}</a>${row.unread ? ` <span class="soft">not fully read</span>` : ""}</td>
    ${cell(fmtEth(row.ethBalance), "wide-only")}
    ${cell(fmtUsd(row.usdcIdle))}
    ${cell(fmtUsd(row.lpUsd))}
    ${cell(row.positions ? `${row.inRange} of ${row.positions}` : "—")}
    <td class="a-out">${esc(outsideCell(row))}</td>
  </tr>`;
}

function accountsSection(s: InfraSnapshot): string {
  const a = s.accounts;
  if (!a) {
    return `<section class="sec full" style="--s:0ms"><div class="sec-head"><h2>Accounts and value</h2></div><p class="soft sum">The accounts database is not connected.</p></section>`;
  }
  // Funded and unread accounts first, by value; the ones that never held anything are only counted.
  const value = (r: AccountView) => r.usdcIdle + r.lpUsd;
  const listed = a.rows.filter((r) => r.unread || r.ethBalance > 0 || value(r) > 0 || (r.outside && (r.outside.eth > 0 || r.outside.usdc > 0))).sort((x, y) => value(y) - value(x));
  const empty = a.rows.length - listed.length;
  // Unread accounts are always shown; beyond that the ledger stops at the largest ones.
  const shown = listed.filter((r, i) => r.unread || i < ACCOUNT_ROWS);
  const folded = listed.length - shown.length;
  const foldedUsd = listed.filter((r) => !shown.includes(r)).reduce((sum, r) => sum + value(r), 0);
  const unread = a.unreadAccounts ?? 0;
  const table = listed.length
    ? `<table class="accts">
        <thead><tr><th class="a-key wide-only">Account</th><th class="a-addr">Address</th><th class="wide-only">Gas, ETH</th><th>Idle USDC</th><th>In positions</th><th>In range</th><th>On Ethereum</th></tr></thead>
        <tbody>${shown.map(accountRow).join("")}</tbody>
      </table>`
    : "";
  const tail = a.error
    ? ""
    : listed.length
      ? `${folded ? `<p class="soft sum">${fmtInt(folded)} more funded ${folded === 1 ? "account holds" : "accounts hold"} ${esc(fmtUsd(foldedUsd))} between them.</p>` : ""}${
          empty ? `<p class="soft sum">${fmtInt(empty)} more ${empty === 1 ? "account has" : "accounts have"} never been funded.</p>` : ""
        }`
      : `<p class="sum">${a.rows.length ? "No funded accounts yet." : "No accounts yet."}</p>`;
  const totals = a.error
    ? `<p class="soft sum">${esc(a.error)}</p>`
    : `<p class="sum">${unread ? "At least " : ""}${esc(fmtUsd(a.tvlUsd))} held: ${esc(fmtUsd(a.lpUsd))} in positions and ${esc(fmtUsd(a.idleUsdcUsd))} idle USDC. Gas reserves of ${esc(fmtEth(a.gasReservesEth))} ETH sit in the Safes, apart from that.</p><p class="sum soft">Outside Base (not working, not in the figure above): ${esc(outsideLine(summarizeOutside(a.rows), fmtUsd))}.</p>${
        unread
          ? `<p class="sum status-low">Some balances could not be read: ${fmtInt(unread)} of ${fmtInt(a.rows.length)} ${a.rows.length === 1 ? "account" : "accounts"}. They are listed and marked; none were counted as zero.</p>`
          : ""
      }`;
  return `<section class="sec full" style="--s:0ms">
    <div class="sec-head"><h2>Accounts and value</h2><p class="asof">${fmtInt(a.totalUsers)} users · ${fmtInt(a.totalAccounts)} accounts · ${fmtInt(a.last7d)} new in 7 days</p></div>
    ${totals}
    ${table}
    ${tail}
  </section>`;
}

/** wei → native units, trimmed, for the funding list. */
function fmtNative(wei: bigint, symbol: string): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) * 10000n) / 10n ** 18n;
  const f = frac.toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole.toString()}${f ? "." + f : ""} ${symbol}`;
}

const FUND_WORDS: Record<FundingStatus, string> = { ok: "Healthy", low: "Running low", empty: "Empty", unknown: "Not read" };

/** Every wallet the system spends from, with its balance; each row selects it in the widget below. */
function fundingRows(s: InfraSnapshot): FundingRow[] {
  const read = new Map((s.funding ?? []).map((f) => [f.id, f.balanceWei === null ? null : BigInt(f.balanceWei)]));
  return FUNDING_TARGETS.map((target) => {
    const balanceWei = read.has(target.id) ? (read.get(target.id) ?? null) : null;
    return { target, balanceWei, status: fundingStatus(balanceWei, target.lowWei) };
  });
}

/** The widget's markup. Its behaviour is the `infra` module of the console script; `data-topup` is its config. */
function topupSection(s: InfraSnapshot): string {
  const rows = fundingRows(s);
  // Open on the wallet that needs it most: empty first, then low, then the Base relayer.
  const rank: Record<FundingStatus, number> = { empty: 0, low: 1, unknown: 2, ok: 3 };
  const first = [...rows].sort((a, b) => rank[a.status] - rank[b.status])[0] ?? rows[0]!;
  const config = JSON.stringify({
    relayer: first.target.address,
    costWei: s.cost ? (s.cost.totalWei ?? String(Math.round(s.cost.totalEth * 1e18))) : null,
    ethUsd: s.ethUsd,
    targets: rows.map(widgetTarget),
    selected: first.target.id,
  });
  const list = rows
    .map((r) => {
      const t = r.target;
      const bal = r.balanceWei === null ? "not read" : fmtNative(r.balanceWei, t.chain.symbol);
      const ticket = t.ticket ? ` <a href="${esc(t.ticket.href)}">${esc(t.ticket.label)}</a>` : "";
      return `<tr data-target="${esc(t.id)}"${t.id === first.target.id ? ' aria-current="true"' : ""}>
        <td class="f-who"><b>${esc(t.label)}</b><span class="soft">${esc(t.pays)}${ticket}</span></td>
        <td class="f-bal"><a href="${esc(t.chain.explorerAddress + t.address)}">${esc(bal)}</a><span class="status-${r.status === "unknown" ? "low" : r.status}">${FUND_WORDS[r.status]}</span></td>
        <td class="f-act"><button type="button" class="link" data-fund="${esc(t.id)}">Fund</button></td>
      </tr>`;
    })
    .join("");
  const presets = first.target.presets
    .map((amt) => `<button type="button" class="tu-preset" data-amt="${amt}" aria-pressed="false">${amt}</button>`)
    .join("");
  return `<section class="sec" id="topup" style="--s:0ms" data-topup="${esc(config)}">
    <div class="sec-head"><h2>Funding</h2></div>
    <table class="fund"><caption class="soft">Every wallet Mamoru spends from. Choose one to fund it from this page.</caption><tbody>${list}</tbody></table>
    <h3 class="tu-title" id="tu-title">Top up: ${esc(first.target.label)}</h3>
    <div class="tu-top">
      <ol class="tu-steps" aria-label="Steps"><li data-step="1" aria-current="step">Connect</li><li data-step="2">Amount</li><li data-step="3">Send</li></ol>
      <p class="tu-wallet" id="tu-wallet" hidden><span id="tu-wallet-text"></span><button type="button" class="link" data-act="change">Change</button></p>
    </div>
    <p class="tu-line" id="tu-line" role="status" aria-live="polite">Sending from this page needs a browser wallet and JavaScript. The address below works from anywhere.</p>
    <p class="tu-detail soft" id="tu-detail"></p>
    <div class="tu-amount">
      <label for="tu-input">Amount</label>
      <div class="tu-field"><input id="tu-input" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0.00" aria-describedby="tu-hint" /><span class="tu-unit" id="tu-unit">${esc(first.target.chain.symbol)}</span></div>
      <div class="tu-presets" id="tu-presets">${presets}<button type="button" class="tu-preset" id="tu-max" data-act="max" aria-pressed="false" disabled>Max</button></div>
      <p class="tu-hint soft" id="tu-hint"></p>
    </div>
    <div class="tu-actions">
      <button type="button" class="go" id="tu-primary" hidden></button>
      <button type="button" class="link" id="tu-offer" hidden></button>
      <button type="button" class="link" id="tu-secondary" hidden></button>
      <a id="tu-link" href="${esc(first.target.chain.explorerUrl)}" hidden></a>
    </div>
    <div class="tu-manual">
      <h3>Or send from an exchange or another wallet</h3>
      <p class="tu-addr"><code id="tu-addr">${esc(first.target.address)}</code><button type="button" class="link" id="tu-copy">Copy</button></p>
      <p class="soft" id="tu-net">Send ${esc(first.target.chain.symbol)} on the ${esc(first.target.chain.name)} network only. Once it arrives, press Refresh and the balance above goes up.</p>
    </div>
  </section>`;
}

/** Infra as a section body: the relayer first, then the top-up, the cost ledger and the accounts. */
export function infraSection(reading: InfraReading, csrf: string): SectionView {
  const s = reading.snapshot;
  const notice = noticeFor(reading);
  return {
    section: "infra",
    title: "Infra and costs",
    ...(reading.refreshing ? { refreshing: true } : {}),
    html: `${pageHead({ title: "Infra and costs", asOf: s.asOf, refresh: { action: "/ops/infra/refresh", csrf } })}
    ${notice ? noticeHtml(notice, { action: retryForm(csrf) }) : ""}
    ${figures(s)}
    <div class="cols">
      ${topupSection(s)}
      ${costSection(s)}
      ${accountsSection(s)}
    </div>
    <p class="quiet-line">RPC usage and automatic top-up alerts are not live yet.</p>`,
  };
}

/** Full document for Infra. */
export function renderInfra(opts: { reading: InfraReading; csrf: string; nonce: string; who?: string }): string {
  return renderDocument(infraSection(opts.reading, opts.csrf), { csrf: opts.csrf, who: opts.who, nonce: opts.nonce });
}
