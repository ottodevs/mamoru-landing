/**
 * The Funding part of /ops/infra (otto/mamoru-astro#32): every wallet Mamoru spends from, chain by chain, with what
 * it holds, what a healthy one holds, what it lacks and how long it lasts; what is deployed on each chain; and one
 * place to send funds, either to every wallet that is short in one run (split as the reader chooses) or to one
 * wallet. Pure string building over an Infra reading. The browser side is the `infra` module of the console script:
 * `Topup` drives the one-wallet widget, `FundPlan` the run; `data-topup` on the wrapper is their shared config.
 */

import { DEPLOYMENTS } from "./deployments";
import { FUNDING_TARGETS, fundingStatus, shortfallWei, usesLeft, widgetTarget, type FundingRow, type FundingStatus } from "./funding";
import type { InfraSnapshot } from "./infra-snapshot";
import { fmtUsd } from "./metrics-math";
import { esc } from "./text";

const E18 = 10n ** 18n;

/** wei → native units, trimmed to four decimals (six under 0.001), with the symbol. */
export function fmtNative(wei: bigint, symbol: string): string {
  const d = wei !== 0n && wei < E18 / 1000n ? 6 : 4;
  const scale = 10n ** BigInt(d);
  const whole = wei / E18;
  const frac = ((wei % E18) * scale) / E18;
  const f = frac.toString().padStart(d, "0").replace(/0+$/, "");
  return `${whole.toString()}${f ? "." + f : ""}${symbol ? " " + symbol : ""}`;
}

/** wei → the plain decimal a person types back: no symbol, no trailing zeros, up to six decimals. */
const typed = (wei: bigint) => fmtNative(wei, "").trim();

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATUS_WORDS: Record<FundingStatus, string> = { ok: "Healthy", low: "Running low", empty: "Empty", unknown: "Not read" };
const statusClass = (s: FundingStatus) => `status-${s === "unknown" ? "low" : s}`;

function usdOf(wei: bigint | null, row: FundingRow, ethUsd: number | null): string {
  if (wei === null || !row.target.priceAsEth || ethUsd === null) return "";
  return fmtUsd((Number(wei / 10n ** 9n) / 1e9) * ethUsd);
}

/** Every target with its balance from the reading; a target the reading does not carry is "not read", never zero. */
export function fundingRows(s: InfraSnapshot): FundingRow[] {
  const read = new Map((s.funding ?? []).map((f) => [f.id, f.balanceWei === null ? null : BigInt(f.balanceWei)]));
  return FUNDING_TARGETS.map((target) => {
    const balanceWei = read.has(target.id) ? (read.get(target.id) ?? null) : null;
    return { target, balanceWei, status: fundingStatus(balanceWei, target.lowWei) };
  });
}

/** "Funds 7 more accounts", "3 more activations", or "". */
function lasts(row: FundingRow, s: InfraSnapshot): string {
  const t = row.target;
  if (row.balanceWei === null) return "";
  const n = usesLeft(row.balanceWei, t);
  if (n !== null && t.runway) return `${n} more ${t.runway.use}${n === 1 ? "" : "s"}`;
  // The Base relayer: what one new account costs it today, from the same reading.
  const cost = t.id === "relayer-base" && s.cost ? BigInt(s.cost.totalWei ?? Math.round(s.cost.totalEth * 1e18)) : 0n;
  if (cost > 0n) {
    const k = Number(row.balanceWei / cost);
    return `${k} more new account${k === 1 ? "" : "s"}`;
  }
  return "";
}

// ---- overview: one line, then chain by chain ----

function overview(rows: FundingRow[], s: InfraSnapshot): string {
  const short = rows.filter((r) => (shortfallWei(r.balanceWei, r.target) ?? 0n) > 0n);
  const unread = rows.filter((r) => r.balanceWei === null).length;
  const usd = short.reduce((sum, r) => sum + (r.target.priceAsEth && s.ethUsd !== null ? (Number(shortfallWei(r.balanceWei, r.target)! / 10n ** 9n) / 1e9) * s.ethUsd : 0), 0);
  const mon = short.filter((r) => !r.target.priceAsEth).map((r) => fmtNative(shortfallWei(r.balanceWei, r.target)!, r.target.chain.symbol));
  // An unread wallet is never counted as healthy: the line says it could not be read.
  const missing = unread ? ` ${unread} could not be read just now, so ${unread === 1 ? "its" : "their"} state is unknown.` : "";
  const lead = short.length
    ? `${short.length} of ${rows.length} wallets are below where they should be: ${[usd > 0 ? `about ${fmtUsd(usd)} in ETH` : "", ...mon].filter(Boolean).join(" and ")} brings them back.${missing}`
    : unread === rows.length
      ? "No wallet could be read just now."
      : unread
        ? `The wallets that could be read hold what they should.${missing}`
        : "Every wallet holds what it should.";
  const chains = DEPLOYMENTS.map((d) => {
    const mine = rows.filter((r) => r.target.chain.chainId === d.chainId);
    const explorer = mine[0]?.target.chain.explorerAddress ?? "";
    const wallets = mine
      .map(
        (r) => `<li><span class="fd-w">${esc(r.target.label.replace(/ on .*/, ""))}</span><span class="fd-b">${r.balanceWei === null ? "not read" : esc(fmtNative(r.balanceWei, r.target.chain.symbol))}</span><span class="${statusClass(r.status)}">${STATUS_WORDS[r.status]}</span></li>`,
      )
      .join("");
    const contracts = d.contracts
      .map((c) => `<li><a href="${esc(explorer + c.address)}">${esc(c.name)}</a><span class="soft">${esc(c.role)}</span></li>`)
      .join("");
    return `<div class="fd-chain">
      <h3>${esc(d.name)}</h3>
      <p class="soft">${esc(d.role)}</p>
      <ul class="fd-wallets">${wallets}</ul>
      <details class="fd-dep"><summary>What is deployed (${d.contracts.length})</summary><ul>${contracts}</ul></details>
    </div>`;
  }).join("");
  return `<section class="sec full fd-over" style="--s:0ms" aria-labelledby="fd-over">
    <div class="sec-head"><h2 id="fd-over">Funding</h2></div>
    <p class="fd-lead${short.length || unread ? " short" : ""}">${esc(lead)}</p>
    <div class="fd-chains">${chains}</div>
  </section>`;
}

// ---- the lines: one per wallet ----

function lines(rows: FundingRow[], s: InfraSnapshot, selected: string): string {
  const body = rows
    .map((r) => {
      const t = r.target;
      const sym = t.chain.symbol;
      const sf = shortfallWei(r.balanceWei, t);
      const usd = usdOf(r.balanceWei, r, s.ethUsd);
      const ticket = t.ticket ? ` <a href="${esc(t.ticket.href)}">${esc(t.ticket.label)}</a>` : "";
      const last = lasts(r, s);
      return `<tr data-target="${esc(t.id)}"${t.id === selected ? ' aria-current="true"' : ""}>
        <td class="f-who"><b>${esc(t.label)}</b><span class="soft">${esc(t.pays)}${ticket}</span><a class="f-addr" href="${esc(t.chain.explorerAddress + t.address)}">${esc(shortAddr(t.address))}</a></td>
        <td class="f-bal" data-k="Holds"><b>${r.balanceWei === null ? "not read" : esc(fmtNative(r.balanceWei, sym))}</b><span class="${statusClass(r.status)}">${STATUS_WORDS[r.status]}${usd ? ` · ${esc(usd)}` : ""}</span></td>
        <td class="f-tgt" data-k="Healthy at">${esc(fmtNative(t.targetWei, sym))}${last ? `<span class="soft">${esc(last)}</span>` : ""}</td>
        <td class="f-short" data-k="Short by">${sf === null ? `<span class="soft">—</span>` : sf === 0n ? `<span class="soft">nothing</span>` : `<b>${esc(fmtNative(sf, sym))}</b>`}</td>
        <td class="f-act"><button type="button" class="link" data-fund="${esc(t.id)}">Fund</button></td>
      </tr>`;
    })
    .join("");
  const a = s.accounts;
  const safes = a && !a.error
    ? `<tr class="f-info"><td class="f-who"><b>Gas in account Safes</b><span class="soft">Each Safe pays its own operations from a small ETH reserve. A Safe that runs low is topped up by the relayer on Base, so funding the relayer covers it.</span></td><td class="f-bal" data-k="Holds"><b>${esc(fmtNative(BigInt(Math.round(a.gasReservesEth * 1e18)), "ETH"))}</b><span class="soft">across ${a.rows.length} Safe${a.rows.length === 1 ? "" : "s"}</span></td><td class="f-tgt" data-k="Healthy at">0.0005 ETH each</td><td class="f-short"></td><td class="f-act"></td></tr>`
    : "";
  return `<section class="sec full fd-lines" aria-labelledby="fd-lines">
    <div class="sec-head"><h2 id="fd-lines">What each wallet holds</h2><p class="asof">Healthy at is where a top-up brings it; below Running low, new accounts start waiting.</p></div>
    <table class="fund"><thead><tr><th>Wallet</th><th>Holds</th><th>Healthy at</th><th>Short by</th><th></th></tr></thead><tbody>${body}${safes}</tbody></table>
  </section>`;
}

// ---- send: every short wallet in one run, or one wallet ----

function planPanel(rows: FundingRow[], show: boolean): string {
  const byChain = new Map<number, FundingRow[]>();
  for (const r of rows) byChain.set(r.target.chain.chainId, [...(byChain.get(r.target.chain.chainId) ?? []), r]);
  const groups = [...byChain.values()]
    .map((list) => {
      const c = list[0]!.target.chain;
      const items = list
        .map((r) => {
          const sf = shortfallWei(r.balanceWei, r.target) ?? 0n;
          const id = `fp-${r.target.id}`;
          return `<li class="fp-row" data-id="${esc(r.target.id)}" data-phase="waiting">
            <label class="fp-on"><input type="checkbox" name="fp_on" value="${esc(r.target.id)}"${sf > 0n ? " checked" : ""} /><span>${esc(r.target.label.replace(/ on .*/, ""))}</span></label>
            <span class="fp-in"><input id="${id}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${sf > 0n ? esc(typed(sf)) : ""}" placeholder="0" aria-label="Amount for ${esc(r.target.label)}" /><span class="unit">${esc(c.symbol)}</span></span>
            <span class="fp-state" aria-live="polite"></span>
          </li>`;
        })
        .join("");
      const split =
        list.length > 1
          ? `<p class="fp-split"><label for="fp-split-${c.chainId}">Split</label><span class="fp-in"><input id="fp-split-${c.chainId}" data-split="${esc(c.hex)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="total" /><span class="unit">${esc(c.symbol)}</span></span><span class="soft">across the ticked wallets, in proportion to what each lacks</span></p>`
          : "";
      return `<div class="fp-chain" data-chain="${esc(c.hex)}"><h4>${esc(c.name)} <span class="soft">${esc(c.symbol)}</span></h4><ul>${items}</ul>${split}<p class="fp-total soft" data-total="${esc(c.hex)}"></p></div>`;
    })
    .join("");
  return `<div class="fp" id="fd-plan" role="tabpanel" aria-labelledby="fd-tab-plan"${show ? "" : " hidden"}>
    <p class="fp-lead soft">Each wallet starts at what it lacks to be healthy. Change any amount, untick what you skip, or type a total to split it. Your wallet asks once per transfer and switches network once per chain.</p>
    <div class="fp-chains">${groups}</div>
    <p class="fp-line" id="fp-line" role="status" aria-live="polite">Sending from this page needs a browser wallet and JavaScript.</p>
    <div class="fp-actions"><button type="button" class="go" id="fp-send" disabled>Send</button><button type="button" class="link" id="fp-stop" hidden>Stop after this one</button></div>
  </div>`;
}

/** The one-wallet widget. Its ids and behaviour are the `Topup` module's, unchanged since otto/mamoru-astro#27. */
function onePanel(first: FundingRow, show: boolean): string {
  const presets = first.target.presets
    .map((amt) => `<button type="button" class="tu-preset" data-amt="${amt}" aria-pressed="false">${amt}</button>`)
    .join("");
  return `<div class="fd-one" id="fd-one" role="tabpanel" aria-labelledby="fd-tab-one"${show ? "" : " hidden"}>
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
  </div>`;
}

/** Overview, lines and the send panel. One wrapper (`#topup`) so a Fund button in the lines drives the widget. */
export function fundingSection(s: InfraSnapshot): string {
  const rows = fundingRows(s);
  // Open on the wallet that needs it most: empty first, then low, then the Base relayer.
  const rank: Record<FundingStatus, number> = { empty: 0, low: 1, unknown: 2, ok: 3 };
  const first = [...rows].sort((a, b) => rank[a.status] - rank[b.status])[0] ?? rows[0]!;
  const anyShort = rows.some((r) => (shortfallWei(r.balanceWei, r.target) ?? 0n) > 0n);
  const config = JSON.stringify({
    relayer: first.target.address,
    costWei: s.cost ? (s.cost.totalWei ?? String(Math.round(s.cost.totalEth * 1e18))) : null,
    ethUsd: s.ethUsd,
    targets: rows.map(widgetTarget),
    selected: first.target.id,
    tab: anyShort ? "plan" : "one",
  });
  const tab = (id: "plan" | "one", label: string) =>
    `<button type="button" role="tab" id="fd-tab-${id}" aria-controls="fd-${id}" aria-selected="${(id === "plan") === anyShort}" data-tab="${id}">${label}</button>`;
  return `<div class="fd" id="topup" data-topup="${esc(config)}">
    ${overview(rows, s)}
    ${lines(rows, s, first.target.id)}
    <section class="sec full fd-send" aria-labelledby="fd-send">
      <div class="sec-head"><h2 id="fd-send">Send funds</h2><div class="fd-tabs" role="tablist" aria-label="How to send">${tab("plan", "Every wallet that is short")}${tab("one", "One wallet")}</div></div>
      ${planPanel(rows, anyShort)}
      ${onePanel(first, !anyShort)}
    </section>
  </div>`;
}
