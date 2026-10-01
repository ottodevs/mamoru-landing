/** Renders /ops/infra. Pure string building over an Infra reading; the top-up widget is the only script. */

import { RELAYER_ADDRESS, WALLET_ADD_CHAIN_RPC } from "./chain-addresses";
import type { RelayerStatus } from "./cost";
import type { InfraReading } from "./infra-cache";
import type { AccountView, InfraSnapshot } from "./infra-snapshot";
import { fmtInt, fmtUsd } from "./metrics-math";
import { opsShell, renderNav } from "./ops";
import { motionHeadScript, OPS_WIDE_STYLE, pageScript } from "./ops-metrics";
import { esc } from "./text";
import { topupLogic } from "./topup-logic";

const INFRA_STYLE = `
.figs.f3 { grid-template-columns: minmax(0, 2.2fr) repeat(3, minmax(0, 1fr)); }
.fig-n .unit { font-size: 0.42em; color: var(--muted); letter-spacing: 0; margin-left: 0.35em; }
.fig:not(.lead) .fig-n .unit { font-size: 0.5em; }
.fig-s b { font-weight: 400; }
.fig-n.none { color: var(--muted); }
.notice { margin: -0.4rem 0 0; padding: 0.85rem 0 1.3rem; border-top: 1px solid var(--ink); display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem 1.5rem; }
.notice p { margin: 0; max-width: 46rem; line-height: 1.45; }
.notice form { margin: 0; }
.sec h3 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 400; }

table.ledger { margin-top: 0.9rem; font-variant-numeric: tabular-nums; }
table.ledger th, table.ledger td { border-color: var(--rule); padding: 0.55rem 0 0.55rem 1rem; text-align: right; white-space: nowrap; }
table.ledger th:first-child, table.ledger td:first-child { padding-left: 0; text-align: left; white-space: normal; }
table.ledger thead th { color: var(--muted); font-size: 0.85rem; }
table.ledger tr.total td { border-top: 1px solid var(--ink); border-bottom: 0; padding-top: 0.7rem; }
table.ledger .dim { color: var(--muted); }
.ledger-note { margin: 0.9rem 0 0; font-size: 0.9rem; line-height: 1.5; color: var(--muted); max-width: 30rem; }
.sum { margin: 0.9rem 0 0; line-height: 1.5; }
.quiet-line { margin: 0 0 2rem; font-size: 0.9rem; color: var(--muted); }

.tu-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.4rem 1.5rem; margin-top: 1rem; min-height: 1.5rem; }
.tu-steps { list-style: none; display: flex; gap: 1.4rem; margin: 0; padding: 0; font-size: 0.85rem; color: var(--muted); }
.tu-steps li[aria-current] { color: var(--ink); border-bottom: 1px solid var(--ink); }
.tu-line { margin: 0.9rem 0 0; font-size: 1.3rem; line-height: 1.35; max-width: 34rem; text-wrap: pretty; min-height: 2.7em; }
.tu-line.warn { color: #7a5a12; }
.tu-line.bad { color: #a33b2e; }
.tu-line.good { color: var(--emerald); }
.tu-detail { margin: 0.4rem 0 0; font-size: 0.95rem; line-height: 1.45; max-width: 34rem; min-height: 2.9em; overflow-wrap: anywhere; }
.tu-wallet { margin: 0; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.tu-amount { margin-top: 1.3rem; }
.tu-amount label { display: block; font-size: 0.9rem; color: var(--muted); }
.tu-field { display: flex; align-items: baseline; gap: 0.6rem; max-width: 17rem; border-bottom: 1px solid var(--ink); }
.tu-field input { flex: 1; min-width: 0; width: 100%; border: 0; background: none; padding: 0.15rem 0 0.25rem; font-size: 2.15rem; line-height: 1.15; letter-spacing: -0.01em; outline: none; }
.tu-field input::placeholder { color: rgba(15, 15, 14, 0.28); }
.tu-field input:read-only { color: var(--muted); }
.tu-field:focus-within { border-bottom-color: var(--emerald); box-shadow: 0 1px 0 var(--emerald); }
.tu-unit { color: var(--muted); }
.tu-presets { display: flex; flex-wrap: wrap; gap: 0.3rem 1.3rem; margin-top: 0.75rem; }
button.tu-preset { background: none; color: var(--emerald); padding: 0.35rem 0; border-bottom: 1px solid transparent; font-variant-numeric: tabular-nums; }
button.tu-preset:hover { color: var(--ink); }
button.tu-preset[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--ink); }
button.tu-preset:disabled { color: rgba(15, 15, 14, 0.35); cursor: default; }
.tu-hint { margin: 0.6rem 0 0; font-size: 0.95rem; min-height: 1.45em; }
.tu-actions { margin: 1.2rem 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem 1.4rem; min-height: 2.6rem; }
.tu-actions button.go { padding: 0.75rem 1.2rem; }
.tu-actions button.go:hover { background: var(--emerald); }
.tu-actions button.go:disabled { background: rgba(15, 15, 14, 0.2); color: var(--rice); cursor: default; }
.tu-actions button.link { margin-left: 0; padding: 0.4rem 0; }
.tu-actions a { font-size: 0.95rem; }
.tu-manual { margin-top: 2rem; padding-top: 1.1rem; border-top: 1px solid var(--rule); }
.tu-addr { margin: 0 0 0.5rem; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1rem; }
.tu-addr code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88rem; overflow-wrap: anywhere; }
.tu-addr button.link { margin-left: 0; }
.tu-manual p.soft { margin: 0; font-size: 0.9rem; line-height: 1.5; max-width: 34rem; }

table.accts { margin-top: 1.1rem; font-variant-numeric: tabular-nums; }
table.accts th, table.accts td { border-color: var(--rule); padding: 0.5rem 0 0.5rem 1.2rem; text-align: right; white-space: nowrap; }
table.accts .a-key { padding-left: 0; text-align: left; }
table.accts .a-addr { text-align: left; }
table.accts thead th { color: var(--muted); font-size: 0.85rem; }
table.accts td.unread { color: #7a5a12; }

@media (max-width: 1040px) {
  .figs.f3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  table.accts .wide-only { display: none; }
  table.accts th, table.accts td { padding-left: 0.7rem; }
  table.accts .a-addr { padding-left: 0; }
  .tu-line { font-size: 1.15rem; }
  .tu-actions button.go { width: 100%; }
}
`;

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

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function count(value: number, format: string, text: string): string {
  return `<span data-n="${value}" data-f="${format}">${esc(text)}</span>`;
}

function refreshForm(csrf: string, label: string, cls = "link"): string {
  return `<form method="post" action="/ops/infra/refresh"><input type="hidden" name="csrf" value="${esc(csrf)}" /><button class="${cls}" type="submit">${esc(label)}</button></form>`;
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
  return `<dl class="figs f3" aria-label="Relayer">
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
  </tr>`;
}

function accountsSection(s: InfraSnapshot): string {
  const a = s.accounts;
  if (!a) {
    return `<section class="sec full" style="--s:0ms"><div class="sec-head"><h2>Accounts and value</h2></div><p class="soft sum">The accounts database is not connected.</p></section>`;
  }
  // Funded and unread accounts first, by value; the ones that never held anything are only counted.
  const value = (r: AccountView) => r.usdcIdle + r.lpUsd;
  const listed = a.rows.filter((r) => r.unread || r.ethBalance > 0 || value(r) > 0).sort((x, y) => value(y) - value(x));
  const empty = a.rows.length - listed.length;
  const unread = a.unreadAccounts ?? 0;
  const table = listed.length
    ? `<table class="accts">
        <thead><tr><th class="a-key wide-only">Account</th><th class="a-addr">Address</th><th class="wide-only">Gas, ETH</th><th>Idle USDC</th><th>In positions</th><th>In range</th></tr></thead>
        <tbody>${listed.map(accountRow).join("")}</tbody>
      </table>`
    : "";
  const tail = a.error
    ? ""
    : listed.length
      ? empty
        ? `<p class="soft sum">${fmtInt(empty)} more ${empty === 1 ? "account has" : "accounts have"} never been funded.</p>`
        : ""
      : `<p class="sum">${a.rows.length ? "No funded accounts yet." : "No accounts yet."}</p>`;
  const totals = a.error
    ? `<p class="soft sum">${esc(a.error)}</p>`
    : `<p class="sum">${unread ? "At least " : ""}${esc(fmtUsd(a.tvlUsd))} held: ${esc(fmtUsd(a.lpUsd))} in positions and ${esc(fmtUsd(a.idleUsdcUsd))} idle USDC. Gas reserves of ${esc(fmtEth(a.gasReservesEth))} ETH sit in the Safes, apart from that.</p>${
        unread
          ? `<p class="sum" style="color:#7a5a12">Some balances could not be read: ${fmtInt(unread)} of ${fmtInt(a.rows.length)} ${a.rows.length === 1 ? "account" : "accounts"}. They are listed and marked; none were counted as zero.</p>`
          : ""
      }`;
  return `<section class="sec full" style="--s:0ms">
    <div class="sec-head"><h2>Accounts and value</h2><p class="asof">${fmtInt(a.totalUsers)} users · ${fmtInt(a.totalAccounts)} accounts · ${fmtInt(a.last7d)} new in 7 days</p></div>
    ${totals}
    ${table}
    ${tail}
  </section>`;
}

/** Wallet glue for the top-up widget. All decisions live in topupLogic(); this only talks to the wallet and the page. */
function topupScript(nonce: string, s: InfraSnapshot): string {
  const config = JSON.stringify({
    relayer: RELAYER_ADDRESS,
    addChainRpc: WALLET_ADD_CHAIN_RPC,
    costWei: s.cost ? (s.cost.totalWei ?? String(Math.round(s.cost.totalEth * 1e18))) : null,
    ethUsd: s.ethUsd,
  }).replaceAll("<", "\\u003c");
  return `<script nonce="${nonce}">
(function () {
  var __name = function (fn) { return fn; };
  var L = (${topupLogic.toString()})();
  var CFG = ${config};
  var root = document.getElementById("topup");
  if (!root || typeof BigInt !== "function") return;
  var $ = function (id) { return document.getElementById(id); };
  var line = $("tu-line"), detail = $("tu-detail"), walletRow = $("tu-wallet"), walletText = $("tu-wallet-text");
  var input = $("tu-input"), hint = $("tu-hint"), maxBtn = $("tu-max");
  var primary = $("tu-primary"), secondary = $("tu-secondary"), offer = $("tu-offer"), link = $("tu-link");
  var ctx = { relayer: CFG.relayer, costWei: CFG.costWei ? BigInt(CFG.costWei) : null, ethUsd: CFG.ethUsd };
  var state = { phase: "idle", account: null, balance: null, fee: null, amountText: "", hash: null, error: "", slow: false, failedTo: "idle" };
  var eth = null, bound = null, run = 0, pollTimer = null;

  function paint() {
    var v = L.view(state, ctx);
    line.textContent = v.line;
    line.className = "tu-line" + (v.tone === "plain" ? "" : " " + v.tone);
    detail.textContent = v.detail;
    walletRow.hidden = !v.wallet;
    walletText.textContent = v.wallet;
    hint.textContent = v.hint;
    input.readOnly = v.amountLocked;
    var steps = root.querySelectorAll(".tu-steps li");
    for (var i = 0; i < steps.length; i++) {
      if (Number(steps[i].getAttribute("data-step")) === v.step) steps[i].setAttribute("aria-current", "step");
      else steps[i].removeAttribute("aria-current");
    }
    var parsed = L.parseEth(state.amountText);
    var presets = root.querySelectorAll(".tu-preset[data-amt]");
    for (var p = 0; p < presets.length; p++) {
      var preset = L.parseEth(presets[p].getAttribute("data-amt"));
      presets[p].setAttribute("aria-pressed", String(Boolean(parsed.ok && preset.ok && parsed.wei === preset.wei)));
      presets[p].disabled = v.amountLocked;
    }
    var most = state.balance !== null && state.fee !== null ? L.maxSend(state.balance, state.fee) : null;
    maxBtn.disabled = v.amountLocked || most === null || !(most > BigInt(0));
    maxBtn.setAttribute("aria-pressed", String(Boolean(most !== null && parsed.ok && parsed.wei === most)));
    button(primary, v.primary);
    button(secondary, v.secondary);
    offer.hidden = !v.offer;
    if (v.offer) { offer.textContent = v.offer.label; offer.setAttribute("data-amt", v.offer.amountText); }
    link.hidden = !v.link;
    if (v.link) { link.href = v.link.href; link.textContent = v.link.text; }
  }
  function button(node, action) {
    node.hidden = !action;
    if (!action) return;
    node.textContent = action.label;
    node.disabled = !action.enabled;
    node.setAttribute("data-act", action.action);
  }
  function set(patch) {
    for (var key in patch) state[key] = patch[key];
    paint();
  }
  function fail(err, backTo) {
    stopPolling();
    set({ phase: "failed", error: L.explain(err), failedTo: backTo });
  }
  function request(method, params) {
    return eth.request({ method: method, params: params || [] });
  }
  function setAmount(text) {
    input.value = text;
    state.amountText = text;
    if (state.phase === "failed" && state.account) state.phase = "ready";
    paint();
  }

  function bind(provider) {
    if (bound === provider) return;
    bound = provider;
    if (!provider.on) return;
    provider.on("accountsChanged", function (accounts) {
      if (state.phase === "sent" || state.phase === "confirmed") return;
      if (!accounts || !accounts.length) { reset(); return; }
      state.account = accounts[0];
      afterAccount();
    });
    provider.on("chainChanged", function () {
      if (!state.account || state.phase === "sent" || state.phase === "confirmed") return;
      afterAccount();
    });
  }
  function detect() {
    eth = window.ethereum || null;
    if (!eth) { set({ phase: "nowallet" }); return; }
    bind(eth);
    var mine = ++run;
    set({ phase: "idle" });
    // Already approved for this site: pick the wallet up without a prompt.
    request("eth_accounts").then(function (accounts) {
      if (mine !== run || !accounts || !accounts.length) return;
      state.account = accounts[0];
      afterAccount();
    }).catch(function () {});
  }
  function reset() {
    stopPolling();
    run++;
    set({ phase: eth ? "idle" : "nowallet", account: null, balance: null, fee: null, hash: null, error: "", slow: false });
  }
  function connect() {
    if (!eth) { detect(); if (!eth) return; }
    var mine = ++run;
    set({ phase: "connecting", error: "" });
    request("eth_requestAccounts").then(function (accounts) {
      if (mine !== run) return;
      if (!accounts || !accounts.length) { fail({ code: 4100 }, "idle"); return; }
      state.account = accounts[0];
      afterAccount();
    }).catch(function (err) { if (mine === run) fail(err, "idle"); });
  }
  function change() {
    var mine = ++run;
    stopPolling();
    request("wallet_requestPermissions", [{ eth_accounts: {} }]).then(function () {
      return request("eth_accounts");
    }).then(function (accounts) {
      if (mine !== run) return;
      if (!accounts || !accounts.length) { reset(); return; }
      state.account = accounts[0];
      afterAccount();
    }).catch(function (err) {
      if (mine !== run) return;
      // Declining the picker just keeps the current wallet.
      if (Number(err && err.code) === 4001) { paint(); return; }
      reset();
    });
  }
  function afterAccount() {
    var mine = ++run;
    set({ phase: "ready", balance: null, fee: null, hash: null, error: "", slow: false });
    request("eth_chainId").then(function (chainId) {
      if (mine !== run) return;
      if (String(chainId).toLowerCase() !== L.BASE_CHAIN_HEX) { set({ phase: "wrongnet" }); return; }
      readBalance(mine);
    }).catch(function (err) { if (mine === run) fail(err, "idle"); });
  }
  function readBalance(mine, then) {
    Promise.all([request("eth_getBalance", [state.account, "latest"]), request("eth_gasPrice")]).then(function (res) {
      if (mine !== run) return;
      var balance = L.fromHex(res[0]), gasPrice = L.fromHex(res[1]);
      if (balance === null || gasPrice === null) { fail({ message: "the wallet did not return a balance" }, "ready"); return; }
      set({ balance: balance, fee: L.estimateFee(gasPrice) });
      if (then) then();
    }).catch(function (err) { if (mine === run) fail(err, "ready"); });
  }
  function switchChain() {
    var mine = ++run;
    request("wallet_switchEthereumChain", [{ chainId: L.BASE_CHAIN_HEX }]).catch(function (err) {
      if (Number(err && err.code) !== 4902) throw err;
      return request("wallet_addEthereumChain", [{
        chainId: L.BASE_CHAIN_HEX,
        chainName: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [CFG.addChainRpc],
        blockExplorerUrls: ["https://basescan.org"],
      }]);
    }).then(function () { if (mine === run) afterAccount(); })
      .catch(function (err) { if (mine === run) fail(err, "wrongnet"); });
  }
  // Preflight: read the balance and gas price again, and only move on when the amount is affordable.
  function review() {
    var mine = ++run;
    readBalance(mine, function () {
      var parsed = L.parseEth(state.amountText);
      if (!parsed.ok || !L.afford(state.balance, parsed.wei, state.fee).ok) { paint(); return; }
      set({ phase: "confirm" });
    });
  }
  function send() {
    var parsed = L.parseEth(state.amountText);
    if (!parsed.ok || state.balance === null || state.fee === null || !L.afford(state.balance, parsed.wei, state.fee).ok) {
      set({ phase: "ready" });
      return;
    }
    var mine = ++run;
    set({ phase: "signing" });
    request("eth_sendTransaction", [{ from: state.account, to: CFG.relayer, value: L.toHex(parsed.wei) }]).then(function (hash) {
      if (mine !== run) return;
      set({ phase: "sent", hash: String(hash), slow: false });
      poll(mine, 0);
    }).catch(function (err) { if (mine === run) fail(err, "ready"); });
  }
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function poll(mine, tries) {
    stopPolling();
    request("eth_getTransactionReceipt", [state.hash]).then(function (receipt) {
      if (mine !== run) return;
      if (receipt && receipt.status) {
        if (Number(receipt.status) === 1) {
          set({ phase: "confirmed" });
          pollTimer = setTimeout(reload, 1800);
        } else {
          fail({ message: "the transaction was included but reverted, so nothing reached the relayer" }, "ready");
        }
        return;
      }
      again(mine, tries);
    }).catch(function () { if (mine === run) again(mine, tries); });
  }
  function again(mine, tries) {
    if (tries >= 30) { set({ slow: true }); return; }
    pollTimer = setTimeout(function () { poll(mine, tries + 1); }, 2500);
  }
  function reload() {
    window.location.href = "/ops/infra?fresh=1";
  }

  var actions = {
    detect: detect,
    connect: connect,
    change: change,
    "switch": switchChain,
    review: review,
    send: send,
    reload: reload,
    reset: reset,
    back: function () { run++; set({ phase: "ready" }); },
    restart: function () { stopPolling(); state.hash = null; afterAccount(); },
    check: function () { set({ slow: false }); poll(++run, 0); },
    retry: function () {
      if (!state.account) { reset(); return; }
      if (state.failedTo === "wrongnet") { afterAccount(); return; }
      afterAccount();
    },
    max: function () {
      if (state.balance === null || state.fee === null) return;
      setAmount(L.formatEth(L.maxSend(state.balance, state.fee)));
    },
  };
  root.addEventListener("click", function (ev) {
    var node = ev.target && ev.target.closest ? ev.target.closest("button") : null;
    if (!node || node.disabled || !root.contains(node)) return;
    if (node.id === "tu-copy") { copy(node); return; }
    var amt = node.getAttribute("data-amt");
    if (amt) { setAmount(amt); return; }
    var act = actions[node.getAttribute("data-act")];
    if (act) act();
  });
  input.addEventListener("input", function () {
    state.amountText = input.value;
    if (state.phase === "failed" && state.account) state.phase = "ready";
    paint();
  });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !primary.hidden && !primary.disabled) primary.click();
  });
  function copy(node) {
    var text = CFG.relayer;
    var done = function () {
      node.textContent = "Copied";
      setTimeout(function () { node.textContent = "Copy"; }, 2000);
    };
    var select = function () {
      var range = document.createRange();
      range.selectNodeContents($("tu-addr"));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      node.textContent = "Selected, now copy";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, select);
    else select();
  }

  detect();
  // Wallets on phones can inject late: look again shortly, and when they announce themselves.
  if (!eth) {
    window.addEventListener("ethereum#initialized", function () { if (!eth) detect(); }, { once: true });
    setTimeout(function () { if (!eth) detect(); }, 1200);
    setTimeout(function () { if (!eth) detect(); }, 3500);
  }
})();
</script>`;
}

function topupSection(): string {
  const presets = ["0.005", "0.01", "0.02"]
    .map((amt) => `<button type="button" class="tu-preset" data-amt="${amt}" aria-pressed="false">${amt}</button>`)
    .join("");
  return `<section class="sec" id="topup" style="--s:0ms">
    <div class="sec-head"><h2>Top up the relayer</h2></div>
    <div class="tu-top">
      <ol class="tu-steps" aria-label="Steps"><li data-step="1" aria-current="step">Connect</li><li data-step="2">Amount</li><li data-step="3">Send</li></ol>
      <p class="tu-wallet" id="tu-wallet" hidden><span id="tu-wallet-text"></span><button type="button" class="link" data-act="change">Change</button></p>
    </div>
    <p class="tu-line" id="tu-line" role="status" aria-live="polite">Sending from this page needs a browser wallet and JavaScript. The address below works from anywhere.</p>
    <p class="tu-detail soft" id="tu-detail"></p>
    <div class="tu-amount">
      <label for="tu-input">Amount</label>
      <div class="tu-field"><input id="tu-input" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0.00" aria-describedby="tu-hint" /><span class="tu-unit">ETH</span></div>
      <div class="tu-presets">${presets}<button type="button" class="tu-preset" id="tu-max" data-act="max" aria-pressed="false" disabled>Max</button></div>
      <p class="tu-hint soft" id="tu-hint"></p>
    </div>
    <div class="tu-actions">
      <button type="button" class="go" id="tu-primary" hidden></button>
      <button type="button" class="link" id="tu-offer" hidden></button>
      <button type="button" class="link" id="tu-secondary" hidden></button>
      <a id="tu-link" href="https://basescan.org/" hidden></a>
    </div>
    <div class="tu-manual">
      <h3>Or send from an exchange or another wallet</h3>
      <p class="tu-addr"><code id="tu-addr">${esc(RELAYER_ADDRESS)}</code><button type="button" class="link" id="tu-copy">Copy</button></p>
      <p class="soft">Send ETH on the Base network only. Once it arrives, press Refresh: the relayer balance and the accounts it can fund go up.</p>
    </div>
  </section>`;
}

export function renderInfra(opts: { reading: InfraReading; csrf: string; nonce: string; who?: string }): string {
  const { reading, csrf, nonce } = opts;
  const s = reading.snapshot;
  const notice = noticeFor(reading);
  const who = opts.who ? `<span class="soft">Signed in as ${esc(opts.who)} · </span>` : "";
  return opsShell(
    "Infra and costs",
    `<header class="ov-head">
      <h1>Infra and costs</h1>
      <div class="asof" style="display:flex;gap:0;align-items:baseline">As of <time datetime="${esc(s.asOf)}" style="margin-left:0.3em">${esc(when(s.asOf))}</time>${refreshForm(csrf, "Refresh")}</div>
    </header>
    ${notice ? `<div class="notice" role="status"><p>${esc(notice)}</p>${refreshForm(csrf, "Retry", "")}</div>` : ""}
    ${figures(s)}
    <div class="cols">
      ${topupSection()}
      ${costSection(s)}
      ${accountsSection(s)}
    </div>
    <p class="quiet-line">RPC usage and automatic top-up alerts are not live yet.</p>
    <footer class="ov-foot">
      <p><a href="/ops/landing">The site</a></p>
      <form method="post" action="/ops/logout">
        <input type="hidden" name="csrf" value="${esc(csrf)}" />
        ${who}<button class="quiet" type="submit">Sign out</button>
      </form>
    </footer>
    ${pageScript(nonce)}
    ${topupScript(nonce, s)}`,
    renderNav("infra"),
    { wide: true, head: `<style>${OPS_WIDE_STYLE}${INFRA_STYLE}</style>${motionHeadScript(nonce)}` },
  );
}
