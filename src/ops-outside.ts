/**
 * otto/mamoru-astro#35: the "On Ethereum" column that used to live in the Funding page's "Accounts and value"
 * table, moved to /ops/accounts. The rest of that table (value held, idle USDC, positions) is already on Pulse
 * and Accounts, so only what is unique here survives: the same address on Ethereum Mainnet, kept apart from the
 * Base figures and never added into them (otto/mamoru-astro#31).
 */

import type { AccountView, InfraSnapshot } from "./infra-snapshot";
import { fmtInt, fmtUsd } from "./metrics-math";
import { outsideLine, summarizeOutside } from "./outside-base";
import type { SectionView } from "./ops";
import { esc } from "./text";

const ROWS = 25;

function fmtEth(value: number): string {
  return value.toFixed(value < 0.001 ? 6 : 4);
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function holding(row: AccountView): string {
  const o = row.outside;
  if (!o) return "not read";
  const parts: string[] = [];
  if (o.eth > 0) parts.push(`${fmtEth(o.eth)} ETH`);
  if (o.usdc > 0) parts.push(`${fmtUsd(o.usdc)} USDC`);
  return `${parts.join(" + ")}${o.usd === null ? "" : ` · ${fmtUsd(o.usd)}`}`;
}

/** The sheet appended to the Accounts view, or "" when there is nothing to say (no accounts reading at all). */
export function outsideSheet(snapshot: InfraSnapshot | null | undefined): string {
  const a = snapshot?.accounts;
  if (!a || a.error || !a.rows.length) return "";
  const held = a.rows.filter((r) => r.outside && (r.outside.eth > 0 || r.outside.usdc > 0)).sort((x, y) => (y.outside?.usd ?? 0) - (x.outside?.usd ?? 0));
  const unreadRows = a.rows.filter((r) => !r.outside);
  const shown = held.slice(0, ROWS);
  const folded = held.length - shown.length;
  // Every account that could not be read is listed by name: never folded, never counted as zero.
  const rowsOf = (r: AccountView) => `<tr><td>${esc(r.accountKey)}</td><td><a href="${esc(r.basescanUrl)}">${esc(shortAddr(r.address))}</a></td><td${r.outside ? "" : ' class="unread"'}>${esc(holding(r))}</td></tr>`;
  const table = shown.length || unreadRows.length
    ? `<table class="ledger ops-outside"><thead><tr><th>Account</th><th>Address</th><th>On Ethereum</th></tr></thead><tbody>${[...shown, ...unreadRows].map(rowsOf).join("")}</tbody></table>`
    : `<p class="c-empty">No account holds anything on Ethereum.</p>`;
  const notes = [
    folded ? `<p class="c-foot">${fmtInt(folded)} more ${folded === 1 ? "account holds" : "accounts hold"} ETH or USDC on Ethereum.</p>` : "",
    unreadRows.length ? `<p class="c-foot">Accounts marked "not read" could not be read on Ethereum. None counted as zero.</p>` : "",
  ].join("");
  return `<section class="c-sheet"><header class="c-sheet-h"><h2>Held on Ethereum</h2><p>${esc(outsideLine(summarizeOutside(a.rows), fmtUsd))}. Not working, and not in any Base figure.</p></header>${table}${notes}</section>`;
}

/** Puts the sheet before the account drawers (templates) of the Accounts view, or at the end of its wrapper. */
export function withOutside(view: SectionView, snapshot: InfraSnapshot | null | undefined): SectionView {
  const sheet = outsideSheet(snapshot);
  if (!sheet) return view;
  const at = view.html.indexOf('<template id="c-acct-');
  if (at >= 0) return { ...view, html: view.html.slice(0, at) + sheet + view.html.slice(at) };
  const end = view.html.lastIndexOf("</div>");
  return { ...view, html: end >= 0 ? view.html.slice(0, end) + sheet + view.html.slice(end) : view.html + sheet };
}
