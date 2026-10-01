/** Renders /ops/infra. Pure string building: the snapshot is already computed. */

import { RELAYER_ADDRESS, WALLET_ADD_CHAIN_RPC, basescanTx } from "./chain-addresses";
import type { RelayerStatus } from "./cost";
import type { AccountView, InfraSnapshot } from "./infra-snapshot";
import { opsShell, renderNav } from "./ops";
import { esc } from "./text";

function fmtEth(value: number): string {
  return `${value.toFixed(value < 0.001 ? 6 : 4)} ETH`;
}

function fmtUsd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const STATUS_LABEL: Record<RelayerStatus, string> = { ok: "OK", low: "LOW", empty: "EMPTY" };

function statusPill(status: RelayerStatus): string {
  return `<span class="status status-${status}">${STATUS_LABEL[status]}</span>`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")} ${hh}:${mm}:${ss} UTC`;
}

function relayerSection(snapshot: InfraSnapshot): string {
  if (snapshot.rpcError || !snapshot.relayer) {
    return `<h2>Relayer</h2><p class="quiet">${esc(snapshot.rpcError ?? "Not available.")}</p>`;
  }
  const r = snapshot.relayer;
  return `<h2>Relayer</h2>
  <p>
    <a href="${esc(r.basescanUrl)}">${esc(shortAddr(r.address))}</a> on Base ${statusPill(r.status)}
  </p>
  <p>${fmtEth(r.ethBalance)} · ${fmtUsd(r.usd)}</p>`;
}

function costSection(snapshot: InfraSnapshot): string {
  if (snapshot.rpcError || !snapshot.cost) {
    return `<h2>Cost per new account</h2><p class="quiet">${esc(snapshot.rpcError ?? "Not available.")}</p>`;
  }
  const c = snapshot.cost;
  const rows = [
    ["Safe deploy", c.deployEth, c.deployUsd],
    ["Activation tx", c.activationEth, c.activationUsd],
    ["Gas reserve to Safe", c.reserveEth, c.reserveUsd],
    ["Total", c.totalEth, c.totalUsd],
  ] as const;
  const body = rows
    .map(
      ([label, eth, usd]) =>
        `<tr><td>${esc(label)}</td><td>${fmtEth(eth)}</td><td>${fmtUsd(usd)}</td></tr>`,
    )
    .join("");
  return `<h2>Cost per new account</h2>
  <p class="quiet">At ${c.gasPriceGwei.toFixed(4)} gwei on Base right now.</p>
  <table>
    <thead><tr><th></th><th>ETH</th><th>USD</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p>Accounts this balance funds: <strong>${snapshot.rpcError ? "—" : c.accountsFunded}</strong></p>
  <p class="quiet">The reserve is not burned: it lands in the user's Safe and pays its own engine ops. The sunk cost is the deploy plus the activation.</p>`;
}

function accountRow(row: AccountView): string {
  return `<tr>
    <td>${esc(row.accountKey)}</td>
    <td><a href="${esc(row.basescanUrl)}">${esc(shortAddr(row.address))}</a></td>
    <td>${fmtEth(row.ethBalance)}</td>
    <td>${fmtUsd(row.usdcIdle)}</td>
    <td>${fmtUsd(row.lpUsd)}</td>
    <td>${row.positions}</td>
    <td>${row.inRange}</td>
  </tr>`;
}

function accountsSection(snapshot: InfraSnapshot): string {
  const a = snapshot.accounts;
  if (!a) return `<h2>Accounts &amp; TVL</h2><p class="quiet">D1 is not connected.</p>`;
  const error = a.error ? `<p class="quiet">${esc(a.error)}</p>` : "";
  // Funded accounts first, by value; the ones that never held anything are only counted.
  const value = (r: AccountView) => r.usdcIdle + r.lpUsd;
  const funded = a.rows.filter((r) => r.ethBalance > 0 || value(r) > 0).sort((x, y) => value(y) - value(x));
  const empty = a.rows.length - funded.length;
  const table = funded.length
    ? `<table>
        <thead><tr><th>Account</th><th>Address</th><th>ETH</th><th>USDC idle</th><th>LP $</th><th>Positions</th><th>In range</th></tr></thead>
        <tbody>${funded.map(accountRow).join("")}</tbody>
      </table>${empty ? `<p class="quiet">${empty} more accounts never funded.</p>` : ""}`
    : !a.error
      ? `<p>${a.rows.length ? "No funded accounts yet." : "No accounts yet."}</p>`
      : "";
  return `<h2>Accounts &amp; TVL</h2>
  <p>${a.totalUsers} users · ${a.totalAccounts} accounts · ${a.last7d} created in the last 7d</p>
  <p>TVL ${fmtUsd(a.tvlUsd)} (idle USDC ${fmtUsd(a.idleUsdcUsd)} + LP ${fmtUsd(a.lpUsd)}) · gas reserves ${fmtEth(a.gasReservesEth)} held separately in Safes</p>
  ${error}
  ${table}`;
}

/** Vanilla EIP-1193 top-up widget. No framework, no CDN, runs only under the CSP nonce. */
function walletScript(nonce: string): string {
  const relayer = JSON.stringify(RELAYER_ADDRESS);
  const addChainRpc = JSON.stringify(WALLET_ADD_CHAIN_RPC);
  return `<script nonce="${nonce}">
(function () {
  var RELAYER = ${relayer};
  var ADD_CHAIN_RPC = ${addChainRpc};
  var BASE_CHAIN_HEX = "0x2105";
  var status = document.getElementById("topup-status");
  var connectBtn = document.getElementById("topup-connect");
  var sendBtn = document.getElementById("topup-send");
  var confirmBox = document.getElementById("topup-confirm");
  var confirmText = document.getElementById("topup-confirm-text");
  var confirmYes = document.getElementById("topup-confirm-yes");
  var confirmNo = document.getElementById("topup-confirm-no");
  var amountInput = document.getElementById("topup-amount");
  var account = null;
  var pending = null;

  function say(text) { status.textContent = text; }

  function presets() {
    var buttons = document.querySelectorAll("[data-topup-preset]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (ev) {
        amountInput.value = ev.target.getAttribute("data-topup-preset");
      });
    }
  }

  async function ensureBase() {
    var chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId === BASE_CHAIN_HEX) return true;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_HEX }],
      });
      return true;
    } catch (err) {
      if (err && err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_CHAIN_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [ADD_CHAIN_RPC],
            blockExplorerUrls: ["https://basescan.org"],
          }],
        });
        return true;
      }
      say("Could not switch to Base: " + (err && err.message ? err.message : err));
      return false;
    }
  }

  connectBtn.addEventListener("click", async function () {
    if (!window.ethereum) {
      say("No wallet found. Install one (MetaMask, Rabby, Coinbase Wallet…) and reload.");
      return;
    }
    try {
      var accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = accounts[0];
      if (!(await ensureBase())) return;
      say("Connected: " + account);
      sendBtn.disabled = false;
    } catch (err) {
      say("Connection declined.");
    }
  });

  sendBtn.addEventListener("click", function () {
    var amount = parseFloat(amountInput.value);
    if (!account || !(amount > 0)) {
      say("Connect a wallet and enter an amount first.");
      return;
    }
    pending = amount;
    confirmText.textContent = amount + " ETH to " + RELAYER + " on Base";
    confirmBox.hidden = false;
  });

  confirmNo.addEventListener("click", function () {
    pending = null;
    confirmBox.hidden = true;
  });

  confirmYes.addEventListener("click", async function () {
    confirmBox.hidden = true;
    if (!pending) return;
    var weiHex = "0x" + BigInt(Math.round(pending * 1e18)).toString(16);
    try {
      var hash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: RELAYER, value: weiHex }],
      });
      say("Sent. Waiting for confirmation…");
      var link = document.createElement("a");
      link.href = "https://basescan.org/tx/" + hash;
      link.textContent = hash;
      status.appendChild(document.createElement("br"));
      status.appendChild(link);
      poll(hash);
    } catch (err) {
      say("Transaction not sent: " + (err && err.message ? err.message : err));
    }
    pending = null;
  });

  function poll(hash) {
    window.ethereum
      .request({ method: "eth_getTransactionReceipt", params: [hash] })
      .then(function (receipt) {
        if (receipt) {
          say("Confirmed. Reloading…");
          window.location.href = "/ops/infra?fresh=1";
        } else {
          setTimeout(function () { poll(hash); }, 3000);
        }
      })
      .catch(function () { setTimeout(function () { poll(hash); }, 3000); });
  }

  presets();
})();
</script>`;
}

function topUpSection(nonce: string): string {
  return `<h2>Top up the relayer</h2>
  <p id="topup-status" class="quiet">Not connected.</p>
  <p><button type="button" id="topup-connect">Connect wallet</button></p>
  <p>
    <button type="button" data-topup-preset="0.005">0.005 ETH</button>
    <button type="button" data-topup-preset="0.01">0.01 ETH</button>
    <button type="button" data-topup-preset="0.02">0.02 ETH</button>
    <input id="topup-amount" type="number" step="0.0001" min="0" placeholder="custom ETH" />
  </p>
  <p><button type="button" id="topup-send" disabled>Send to relayer</button></p>
  <div id="topup-confirm" hidden>
    <p>Send <span id="topup-confirm-text"></span>?</p>
    <button type="button" id="topup-confirm-yes">Confirm</button>
    <button type="button" id="topup-confirm-no" class="quiet">Cancel</button>
  </div>
  ${walletScript(nonce)}`;
}

function roadmapSection(): string {
  return `<h2>Coming next</h2>
  <p class="quiet">RPC usage — coming from the operator's /metrics (phase 2, not live).</p>
  <p class="quiet">Auto top-up — alert when LOW (phase 2, not live).</p>`;
}

export function renderInfra(opts: {
  snapshot: InfraSnapshot;
  csrf: string;
  nonce: string;
}): string {
  const { snapshot, csrf, nonce } = opts;
  const refresh = `<form method="post" action="/ops/infra/refresh">
    <input type="hidden" name="csrf" value="${esc(csrf)}" />
    <button class="quiet" type="submit">Refresh</button>
  </form>`;
  return opsShell(
    "Infra & costs",
    `<h1>Infra &amp; costs</h1>
    <p class="quiet">As of ${esc(when(snapshot.asOf))} ${refresh}</p>
    ${relayerSection(snapshot)}
    ${costSection(snapshot)}
    ${topUpSection(nonce)}
    ${accountsSection(snapshot)}
    ${roadmapSection()}
    <p><a href="/ops">The list</a></p>`,
    renderNav("infra"),
  );
}
