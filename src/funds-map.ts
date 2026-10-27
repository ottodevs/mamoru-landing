/**
 * "Where the money is" (otto/mamoru-astro#35): every dollar the system can see, by chain and by bucket, from
 * the existing infra snapshot only (no RPC reads here). Pure.
 *
 * Kinds, never mixed:
 *  - working:  USDC idle and LP positions in the account Safes. Their sum is exactly the headline "Value held".
 *  - reserve:  gas ETH sitting in the Safes. Real money, not part of Value held.
 *  - operator: the relayer wallets that pay for gas. Not user money.
 *  - outside:  balances at the account addresses on Ethereum. Not working, never added to Value held.
 */

import type { AccountView, InfraSnapshot } from "./infra-snapshot";
import { fmtInt, fmtUsd } from "./metrics-math";
import { summarizeOutside } from "./outside-base";
import { esc } from "./text";

export type FundsKind = "working" | "reserve" | "operator" | "outside";

export interface FundsBucket {
  id: string;
  label: string;
  kind: FundsKind;
  /** null: not priced or not read. */
  usd: number | null;
  /** Accounts holding something in this bucket; null for operator wallets (not accounts). */
  accounts: number | null;
  /** Short qualifier: native units, "not priced", "at least", "N not read". */
  note: string;
  /** True when the figure is a floor (some accounts could not be read). */
  atLeast: boolean;
}

export interface FundsChain {
  chainId: number;
  name: string;
  buckets: FundsBucket[];
  /** User money only: working + reserve + outside. Operator (team gas) is never in it. */
  usd: number;
}

export interface FundsMap {
  chains: FundsChain[];
  /** Equals Overview.tvl when the same rows are used: idle + positions. */
  working: number;
  reserve: number;
  operator: number;
  /** Outside Base, not working. Priced part only. */
  notWorking: number;
  /** User money only: working + reserve + notWorking. Operator relayers (team gas) are never added. */
  total: number;
  /** True when any user-money figure is a floor, unread or unpriced: totals are then a floor and shares are not exact. */
  partial: boolean;
  /** Accounts on test networks or unknown chains: left out of the map entirely. */
  excluded: number;
}

export const BASE_ID = 8453;
export const ETHEREUM_ID = 1;
export const MONAD_ID = 143;
/** Only these chains enter the map. Testnets (10143, 84532, 11155111) and unknown ids are counted apart, never mapped. */
const MAPPED = new Set([BASE_ID, ETHEREUM_ID, MONAD_ID]);

type Row = Pick<AccountView, "chainId" | "usdcIdle" | "lpUsd" | "ethBalance" | "positions" | "outside"> & { unread?: boolean };

const chainName = (id: number): string => (id === BASE_ID ? "Base" : id === ETHEREUM_ID ? "Ethereum" : id === MONAD_ID ? "Monad" : `Chain ${id}`);
const canonical = (id: number): number => id;

export type FundsState = "ok" | "floor" | "unread" | "unpriced";
export function stateOf(b: FundsBucket): FundsState {
  if (b.usd === null) return b.note.startsWith("not read") ? "unread" : "unpriced";
  return b.atLeast ? "floor" : "ok";
}
const positive = (n: number): boolean => n > 0;

function wei(snapshot: Pick<InfraSnapshot, "funding">, id: string): number | null {
  const w = snapshot.funding?.find((f) => f.id === id)?.balanceWei;
  return typeof w === "string" && /^\d+$/.test(w) ? Number(BigInt(w)) / 1e18 : null;
}

function fmtNative(n: number, symbol: string): string {
  return `${n.toFixed(n < 0.001 ? 6 : n < 100 ? 4 : 2)} ${symbol}`;
}

export function buildFundsMap(
  snapshot: Pick<InfraSnapshot, "ethUsd" | "relayer" | "funding">,
  allRows: readonly Row[],
): FundsMap {
  const rows = allRows.filter((r) => MAPPED.has(r.chainId));
  const excluded = allRows.length - rows.length;
  const ethUsd = snapshot.ethUsd;
  const byChain = new Map<number, FundsBucket[]>();
  const put = (chainId: number, b: FundsBucket) => {
    const list = byChain.get(chainId);
    if (list) list.push(b);
    else byChain.set(chainId, [b]);
  };

  // Working and reserve: per the chain the account lives on.
  // Mapped chains only: Base, Ethereum, Monad.
  const rowChains = [...new Set(rows.map((r) => canonical(r.chainId)))];
  if (!rowChains.includes(BASE_ID)) rowChains.push(BASE_ID);
  for (const cid of rowChains) {
    const rs = rows.filter((r) => canonical(r.chainId) === cid);
    const gasEth = rs.reduce((s, r) => s + r.ethBalance, 0);
    put(cid, {
      id: "positions",
      label: "In positions (liquidity)",
      kind: "working",
      usd: rs.reduce((s, r) => s + r.lpUsd, 0),
      accounts: rs.filter((r) => positive(r.lpUsd)).length,
      note: "",
      atLeast: rs.some((r) => r.unread === true),
    });
    put(cid, {
      id: "idle",
      label: "Idle USDC",
      kind: "working",
      usd: rs.reduce((s, r) => s + r.usdcIdle, 0),
      accounts: rs.filter((r) => positive(r.usdcIdle)).length,
      note: "",
      atLeast: rs.some((r) => r.unread === true),
    });
    const symbol = cid === MONAD_ID ? "MON" : "ETH";
    const priced = cid !== MONAD_ID && ethUsd !== null;
    put(cid, {
      id: "gas",
      label: "Gas in the Safes",
      kind: "reserve",
      usd: priced ? gasEth * ethUsd : gasEth === 0 ? 0 : null,
      accounts: rs.filter((r) => positive(r.ethBalance)).length,
      note: gasEth > 0 ? fmtNative(gasEth, symbol) + (priced ? "" : ", not priced") : "",
      atLeast: false,
    });
  }

  // Outside: Ethereum balances at the account addresses.
  // Accounts that live on Ethereum are working money there; their own address is not "outside" (no double count).
  const out = summarizeOutside(rows.filter((r) => r.chainId !== ETHEREUM_ID));
  put(ETHEREUM_ID, {
    id: "outside",
    label: "Outside Base, not working",
    kind: "outside",
    usd: out.read === 0 ? null : out.usd,
    accounts: out.holders,
    note:
      out.read === 0
        ? rows.length === 0 ? "" : "not read"
        : [
            out.eth > 0 ? fmtNative(out.eth, "ETH") : "",
            out.usdc > 0 ? `${out.usdc.toFixed(2)} USDC` : "",
            out.usd === null ? "not priced" : "",
            out.unread > 0 ? `${out.unread} not read` : "",
          ].filter(Boolean).join(", "),
    atLeast: out.read > 0 && out.unread > 0,
  });

  // Operator relayers.
  const baseRelayer = snapshot.relayer ? snapshot.relayer.ethBalance : wei(snapshot, "relayer-base");
  if (baseRelayer !== null) {
    put(BASE_ID, {
      id: "relayer",
      label: "Operator relayer",
      kind: "operator",
      usd: snapshot.relayer?.usd ?? (ethUsd === null ? null : baseRelayer * ethUsd),
      accounts: null,
      note: fmtNative(baseRelayer, "ETH"),
      atLeast: false,
    });
  }
  const ethRelayer = wei(snapshot, "relayer-ethereum");
  if (ethRelayer !== null) {
    put(ETHEREUM_ID, {
      id: "relayer",
      label: "Operator relayer",
      kind: "operator",
      usd: ethUsd === null ? null : ethRelayer * ethUsd,
      accounts: null,
      note: fmtNative(ethRelayer, "ETH") + (ethUsd === null ? ", not priced" : ""),
      atLeast: false,
    });
  }
  const monadRelayer = wei(snapshot, "relayer-monad");
  if (monadRelayer !== null) {
    put(MONAD_ID, {
      id: "relayer",
      label: "Operator relayer",
      kind: "operator",
      usd: null,
      accounts: null,
      note: `${fmtNative(monadRelayer, "MON")}, not priced`,
      atLeast: false,
    });
  }

  const order = (id: number) => (id === BASE_ID ? 0 : id === ETHEREUM_ID ? 1 : id === MONAD_ID ? 2 : 3 + id);
  const kindOrder: Record<FundsKind, number> = { working: 0, reserve: 1, operator: 2, outside: 3 };
  const chains: FundsChain[] = [...byChain.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([chainId, all]) => {
      // Chains with nothing at all in them (zero rows, no wallets) drop out; Base always stays.
      const buckets = all
        .filter((b) => (b.usd ?? 0) > 0 || (b.accounts ?? 0) > 0 || b.note !== "" || b.kind === "working")
        .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
      return { chainId, name: chainName(chainId), buckets, usd: buckets.filter((b) => b.kind !== "operator").reduce((s, b) => s + (b.usd ?? 0), 0) };
    })
    .filter((c) => c.chainId === BASE_ID || c.buckets.length > 0);

  const sum = (kind: FundsKind) =>
    chains.reduce((s, c) => s + c.buckets.filter((b) => b.kind === kind).reduce((t, b) => t + (b.usd ?? 0), 0), 0);
  const working = sum("working");
  const reserve = sum("reserve");
  const operator = sum("operator");
  const notWorking = sum("outside");
  return {
    chains,
    working,
    reserve,
    operator,
    notWorking,
    total: working + reserve + notWorking,
    partial: chains.some((c) => c.buckets.some((b) => b.kind !== "operator" && stateOf(b) !== "ok")),
    excluded,
  };
}

export const FUNDS_ANCHOR = "funds-map";

/** Minimal bar scale: a non-zero share never rounds to nothing. */
export function barPct(usd: number, scale: number): number {
  if (!(usd > 0) || !(scale > 0)) return 0;
  return Math.max((usd / scale) * 100, 0.6);
}

// ---- rendering -------------------------------------------------------------------------------------------

const KIND_CLASS: Record<FundsKind, string> = { working: "fm-w", reserve: "fm-r", operator: "fm-o", outside: "fm-x" };
const KIND_TAG: Record<FundsKind, string> = { working: "Working", reserve: "Reserve", operator: "Operator", outside: "Not working" };

export const FUNDS_STYLE = `
.fm { border-top: 1px solid var(--rule); margin-top: 2.1rem; padding: 1.05rem 0 2rem; scroll-margin-top: 4.5rem; }
.fm-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.3rem 1.4rem; }
.fm-sum { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.9rem 1.6rem; margin: 1rem 0 0.4rem; padding: 0; }
.fm-sum div { min-width: 0; }
.fm-sum dt { font-size: 0.85rem; color: var(--muted); }
.fm-sum dd { margin: 0.1rem 0 0; font-size: 1.6rem; line-height: 1.15; font-variant-numeric: tabular-nums; }
.fm-sum .fm-x dd, .fm-sum .fm-x dt { color: var(--warn); }
.fm-sum small { display: block; font-size: 0.8rem; color: var(--muted); line-height: 1.35; }
.fm-chain { margin-top: 1.7rem; }
.fm-chain h3 { font-weight: 400; font-size: 1rem; margin: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.fm-chain h3 span { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.9rem; }
.fm-bar { display: flex; height: 0.7rem; margin: 0.55rem 0 0.2rem; border: 1px solid var(--rule); gap: 1px; background: var(--rule-soft); }
.fm-bar i { display: block; height: 100%; min-width: 2px; }
.fm-bar i.fm-w { background: var(--emerald); }
.fm-bar i.fm-w.fm-idle { background: rgba(47, 93, 80, 0.5); }
.fm-bar i.fm-r { background: var(--stone); }
.fm-bar i.fm-o { background: var(--wash); }
.fm-bar i.fm-x { background: repeating-linear-gradient(135deg, var(--warn) 0 3px, transparent 3px 6px); }
.fm table { width: 100%; border-collapse: collapse; font-size: 0.9rem; font-variant-numeric: tabular-nums; margin-top: 0.4rem; }
.fm th, .fm td { padding: 0.45rem 0.6rem 0.45rem 0; border-top: 1px solid var(--rule-soft); vertical-align: baseline; }
.fm th { color: var(--muted); font-weight: 400; font-size: 0.8rem; border-top: 0; }
.fm td.n, .fm th.n { text-align: right; padding-right: 0; padding-left: 0.6rem; white-space: nowrap; }
.fm td small { display: block; color: var(--muted); font-size: 0.78rem; line-height: 1.3; }
.fm tr.fm-x td, .fm tr.fm-x td a, .fm tr.fm-x td small { color: var(--warn); }
.fm .tag { font-size: 0.72rem; letter-spacing: 0.02em; color: var(--muted); border: 1px solid var(--rule); padding: 0 0.3rem; margin-left: 0.4rem; white-space: nowrap; }
.fm tr.fm-x .tag { color: var(--warn); border-color: var(--warn); }
.fm tbody.fm-team td { color: var(--muted); border-top: 1px solid var(--rule); font-size: 0.85rem; }
.fm tbody.fm-team tr:first-child td { border-top: 2px solid var(--rule); }
.fm-sum .fm-o dd, .fm-sum .fm-o dt { color: var(--muted); }
.fm .fm-note { color: var(--muted); font-size: 0.85rem; margin: 0.9rem 0 0; }
`;

/** A figure that is not known is never printed as $0: unread says "not read", unpriced says "not priced", a floor says "≥". */
const usdCell = (b: FundsBucket): string => {
  const st = stateOf(b);
  return st === "unread" ? "not read" : st === "unpriced" ? "not priced" : `${st === "floor" ? "≥ " : ""}${fmtUsd(b.usd ?? 0)}`;
};

interface Agg { text: string; sub: string }
/** One summary figure for every user bucket of the given kinds, honest about what is unknown. */
function aggregate(f: FundsMap, kinds: FundsKind[], fallbackSub: string): Agg {
  const bs = f.chains.flatMap((c) => c.buckets.filter((b) => kinds.includes(b.kind)));
  const states = bs.map(stateOf);
  const usd = bs.reduce((s, b) => s + (b.usd ?? 0), 0);
  const unreadN = bs.filter((b) => stateOf(b) === "unread").length;
  const unpriced = bs.filter((b) => stateOf(b) === "unpriced");
  if (bs.length > 0 && states.every((x) => x === "unread")) return { text: "not read", sub: fallbackSub };
  if (bs.length > 0 && states.every((x) => x === "unread" || x === "unpriced")) {
    return { text: "not priced", sub: unpriced.map((b) => b.note.replace(/, not priced.*$/, "")).filter(Boolean).join(" · ") || fallbackSub };
  }
  if (states.some((x) => x !== "ok")) {
    const why = [unpriced.length ? `${unpriced.map((b) => b.note.replace(/, not priced.*$/, "")).filter(Boolean).join(" · ")} not priced` : "", unreadN || bs.some((b) => b.atLeast) ? "some not read" : ""].filter(Boolean).join(" · ");
    return { text: `≥ ${fmtUsd(usd)}`, sub: why || fallbackSub };
  }
  return { text: fmtUsd(usd), sub: fallbackSub };
}

function chainTotal(c: FundsChain): string {
  const user = c.buckets.filter((b) => b.kind !== "operator");
  if (user.length === 0) return "team gas only";
  const st = user.map(stateOf);
  if (st.every((x) => x === "unread")) return "not read";
  if (st.every((x) => x === "unread" || x === "unpriced")) return "not priced";
  return `${st.some((x) => x !== "ok") ? "≥ " : ""}${fmtUsd(c.usd)}`;
}

function bar(c: FundsChain, scale: number): string {
  // Known amounts only: unread and unpriced buckets have usd null and draw nothing.
  const segs = c.buckets
    .filter((b) => b.usd !== null && b.usd > 0)
    .filter((b) => b.kind !== "operator")
    .map((b) => {
      const cls = `${KIND_CLASS[b.kind]}${b.id === "idle" ? " fm-idle" : ""}`;
      return `<i class="${cls}" style="width:${barPct(b.usd ?? 0, scale).toFixed(2)}%"></i>`;
    })
    .join("");
  const desc = c.buckets
    .filter((b) => b.kind !== "operator" && b.usd !== null && b.usd > 0)
    .map((b) => `${b.label} ${fmtUsd(b.usd ?? 0)}`)
    .join(", ");
  return `<div class="fm-bar" role="img" aria-label="${esc(`${c.name}: ${desc || "nothing held"}`)}">${segs}</div>`;
}

function chainBlock(c: FundsChain, f: FundsMap, scale: number): string {
  const row = (b: FundsBucket) => {
      const share = f.partial || b.kind === "operator" || b.usd === null || f.total <= 0 ? "—" : `${((b.usd / f.total) * 100).toFixed(1)}%`;
      const label = b.kind === "operator" ? esc("Operator (team gas)") : `<a href="/ops/accounts">${esc(b.label)}</a>`;
      return `<tr class="${KIND_CLASS[b.kind]}"><td>${label}<span class="tag">${KIND_TAG[b.kind]}</span>${b.note ? `<small>${esc(b.note)}</small>` : ""}</td>
        <td class="n">${esc(usdCell(b))}</td><td class="n">${esc(share)}</td><td class="n">${b.accounts === null ? "—" : fmtInt(b.accounts)}</td></tr>`;
  };
  const rows = c.buckets.filter((b) => b.kind !== "operator").map(row).join("");
  const team = c.buckets.filter((b) => b.kind === "operator").map(row).join("");
  return `<div class="fm-chain">
    <h3>${esc(c.name)}<span>${esc(chainTotal(c))}</span></h3>
    ${bar(c, scale)}
    <table><caption class="sr">${esc(c.name)} balances by bucket</caption>
      <thead><tr><th scope="col">Bucket</th><th scope="col" class="n">USD</th><th scope="col" class="n">Share</th><th scope="col" class="n">Accounts</th></tr></thead>
      <tbody>${rows}</tbody>${team ? `<tbody class="fm-team">${team}</tbody>` : ""}</table>
  </div>`;
}

/** The "Where the money is" section. Working and not-working are shown apart; only the last line adds them. */
export function renderFundsMap(f: FundsMap): string {
  const sum = (cls: string, label: string, a: Agg | number, sub = "") => {
    const v = typeof a === "number" ? { text: fmtUsd(a), sub } : a;
    return `<div class="${cls}"><dt>${esc(label)}</dt><dd>${esc(v.text)}</dd>${v.sub ? `<small>${esc(v.sub)}</small>` : ""}</div>`;
  };
  // Bars: against the total when it is exact; otherwise against the largest known chain, so no share is implied.
  const scale = f.partial ? Math.max(0, ...f.chains.map((c) => c.usd)) : f.total;
  const rest = f.total;
  return `<section class="fm" id="${FUNDS_ANCHOR}" aria-labelledby="fm-h">
    <style>${FUNDS_STYLE}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
    <div class="fm-head"><h2 id="fm-h">Where the money is</h2><a href="/ops/accounts">Accounts</a></div>
    <dl class="fm-sum">
      ${sum("fm-w", "Working (Value held)", aggregate(f, ["working"], "Positions and idle USDC"))}
      ${sum("fm-r", "Gas in the Safes", aggregate(f, ["reserve"], "Not part of Value held"))}
      ${sum("fm-o", "Operator relayers (team gas)", f.operator, "Team money, not in any total")}
      ${sum("fm-x", "Not working", aggregate(f, ["outside"], "Outside Base, never in Value held"))}
      ${sum("fm-t", "Total including not working", f.partial ? { text: `≥ ${fmtUsd(rest)}`, sub: "User money only. A floor: some figures are unread or unpriced" } : { text: fmtUsd(rest), sub: "User money only: working + Safe gas + not working" })}
    </dl>
    ${f.chains.map((c) => chainBlock(c, f, scale)).join("")}
    <p class="fm-note">${f.partial ? "Shares are not shown while some figures are unread or unpriced; bars show known amounts only." : "Shares are of user money (working, Safe gas, not working)."} Operator relayers are team gas and sit outside every total and share. Dashed bars are money outside Base that earns nothing.</p>
    ${f.excluded > 0 ? `<p class="fm-note">${fmtInt(f.excluded)} ${f.excluded === 1 ? "account" : "accounts"} on test networks, not counted.</p>` : ""}
  </section>`;
}
