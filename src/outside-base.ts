/**
 * Holdings outside Base (otto/mamoru-astro#31): the same account address on Ethereum Mainnet can hold
 * native ETH and USDC that the working Base figures never see. This reads them with one Multicall3
 * aggregate3 call per chunk of accounts and reports them as a SEPARATE figure: never added into the
 * working (Base) value held. A failed read leaves the account's `outside` unset ("not read"); it is never
 * counted as zero and never touches the Base numbers.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

export const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const ETHEREUM_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Public fallbacks, tried after any `ETHEREUM_RPC_URLS` (secret, optional, comma separated). */
export const ETHEREUM_PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  // otto/mamoru-astro#40: from Cloudflare the aggregate3 read failed on every run since 1 Nov 05:35 while it answered
  // from elsewhere; these two also answer aggregate3 (checked 2026-11-01).
  "https://rpc.mevblocker.io",
  "https://eth-mainnet.public.blastapi.io",
];
export const ETH_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
/** Accounts per aggregate3 call (two sub-calls each): keeps one eth_call small and the subrequest count low. */
const CHUNK = 100;
const TIMEOUT_MS = 3_000;
/** The whole Ethereum read gives up after this, so it can never hold the Base snapshot back (waitUntil is capped at 30 s). */
export const OUTSIDE_DEADLINE_MS = 12_000;

const abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export interface OutsideHolding {
  /** Native ETH on Ethereum Mainnet. */
  eth: number;
  /** USDC on Ethereum Mainnet. */
  usdc: number;
  /** eth * ETH price + usdc; null when there is ETH but no price could be read. */
  usd: number | null;
  /** otto/mamoru-astro#40: set when this figure was carried from an earlier reading because the latest read failed. */
  at?: string;
}

/** " · read 1 Nov 05:00 UTC" for a figure carried from an earlier reading; "" for a fresh one. */
export function readAtNote(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return ` · read ${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export type OutsideFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface OutsideRaw {
  ethWei: bigint;
  usdcRaw: bigint;
}

export function ethereumRpcList(secret?: string): string[] {
  const own = (secret ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s));
  return [...own, ...ETHEREUM_PUBLIC_RPCS];
}

function callData(addresses: readonly string[]): `0x${string}` {
  const calls = addresses.flatMap((a) => [
    {
      target: ETHEREUM_MULTICALL3 as `0x${string}`,
      allowFailure: true,
      callData: encodeFunctionData({ abi, functionName: "getEthBalance", args: [a as `0x${string}`] }),
    },
    {
      target: ETHEREUM_USDC as `0x${string}`,
      allowFailure: true,
      callData: encodeFunctionData({ abi, functionName: "balanceOf", args: [a as `0x${string}`] }),
    },
  ]);
  return encodeFunctionData({ abi, functionName: "aggregate3", args: [calls] });
}

/** Parses an aggregate3 return into one entry per address; null where either sub-call failed or was malformed. */
export function parseAggregate(addresses: readonly string[], returnData: `0x${string}`): (OutsideRaw | null)[] {
  const results = decodeFunctionResult({ abi, functionName: "aggregate3", data: returnData }) as readonly {
    success: boolean;
    returnData: `0x${string}`;
  }[];
  if (results.length !== addresses.length * 2) throw new Error("unexpected aggregate3 length");
  const word = (r: { success: boolean; returnData: `0x${string}` }): bigint | null =>
    r.success && r.returnData.length === 66 ? BigInt(r.returnData) : null;
  return addresses.map((_, i) => {
    const ethWei = word(results[i * 2]);
    const usdcRaw = word(results[i * 2 + 1]);
    return ethWei === null || usdcRaw === null ? null : { ethWei, usdcRaw };
  });
}

export async function rpcCall(url: string, to: string, data: string, fetchFn: OutsideFetch): Promise<`0x${string}`> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error(`rpc error ${JSON.stringify(body.error ?? null).slice(0, 120)}`);
  return body.result as `0x${string}`;
}

/** The host of an RPC URL, never its path or query (a secret URL can carry a key there). */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** Receives why a read failed, short and without secrets: "host: message". */
export type ReadError = (msg: string) => void;
export const whyFailed = (url: string, e: unknown): string => `${hostOf(url)}: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`;

/**
 * The same balances as one JSON-RPC batch of plain eth_getBalance and USDC balanceOf calls, no Multicall3
 * (otto/mamoru-astro#40: from Cloudflare a plain eth_getBalance answered where the aggregate3 call did not).
 */
async function readChunkBatch(addresses: readonly string[], url: string, fetchFn: OutsideFetch): Promise<(OutsideRaw | null)[]> {
  const calls = addresses.flatMap((a, i) => [
    { jsonrpc: "2.0", id: i * 2, method: "eth_getBalance", params: [a, "latest"] },
    { jsonrpc: "2.0", id: i * 2 + 1, method: "eth_call", params: [{ to: ETHEREUM_USDC, data: encodeFunctionData({ abi, functionName: "balanceOf", args: [a as `0x${string}`] }) }, "latest"] },
  ]);
  const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`batch ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("batch answer is not a list");
  const byId = new Map<number, unknown>();
  for (const r of body as { id?: unknown; result?: unknown }[]) if (typeof r?.id === "number") byId.set(r.id, r.result);
  const word = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
  return addresses.map((_, i) => {
    const ethWei = word(byId.get(i * 2));
    const usdcRaw = word(byId.get(i * 2 + 1));
    return ethWei === null || usdcRaw === null ? null : { ethWei, usdcRaw };
  });
}

/** One chunk: aggregate3 on each RPC in order, then a plain batch on each. null when every attempt failed. */
async function readChunk(addresses: readonly string[], urls: readonly string[], fetchFn: OutsideFetch, onError?: ReadError): Promise<(OutsideRaw | null)[] | null> {
  const data = callData(addresses);
  for (const url of urls) {
    try {
      return parseAggregate(addresses, await rpcCall(url, ETHEREUM_MULTICALL3, data, fetchFn));
    } catch (e) {
      onError?.(whyFailed(url, e));
    }
  }
  for (const url of urls) {
    try {
      const out = await readChunkBatch(addresses, url, fetchFn);
      if (out.some((r) => r !== null)) return out;
      onError?.(whyFailed(url, new Error("batch: no balance answered")));
    } catch (e) {
      onError?.(whyFailed(url, e));
    }
  }
  return null;
}

/** ETH/USD from Coinbase spot; null on any failure or a non-positive number. */
export async function readEthSpot(fetchFn: OutsideFetch): Promise<number | null> {
  try {
    const res = await fetchFn(ETH_SPOT_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { amount?: string } };
    const n = Number(body.data?.amount);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function toHolding(raw: OutsideRaw, ethUsd: number | null): OutsideHolding {
  const eth = Number(raw.ethWei) / 1e18;
  const usdc = Number(raw.usdcRaw) / 1e6;
  return { eth, usdc, usd: eth === 0 ? usdc : ethUsd === null ? null : eth * ethUsd + usdc };
}

/**
 * Reads every address on Ethereum. Returns a map keyed by lowercase address holding only the accounts that
 * were read; absent = not read. Never throws.
 * `baseEthUsd` (the Base pool price already in the snapshot) is used when set; otherwise Coinbase spot, and
 * only when some account actually holds ETH.
 */
export async function readOutsideBase(
  addresses: readonly string[],
  opts: { rpcUrls?: string; baseEthUsd: number | null; fetchFn?: OutsideFetch; deadlineMs?: number; onError?: ReadError },
): Promise<Map<string, OutsideHolding>> {
  const out = new Map<string, OutsideHolding>();
  const fetchFn = opts.fetchFn ?? fetch;
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (unique.length === 0) return out;
  const urls = ethereumRpcList(opts.rpcUrls);
  const raws = new Map<string, OutsideRaw>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  // Chunks run in parallel; a chunk that fails stays "not read" and does not affect the others.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.deadlineMs ?? OUTSIDE_DEADLINE_MS);
  });
  // On the deadline, chunks already read are kept; the rest stay "not read".
  await Promise.race([deadline, Promise.all(
    chunks.map(async (chunk) => {
      try {
        (await readChunk(chunk, urls, fetchFn, opts.onError))?.forEach((r, k) => {
          if (r) raws.set(chunk[k], r);
        });
      } catch {
        // Not read.
      }
    }),
  )]);
  clearTimeout(timer);
  if (raws.size < unique.length) opts.onError?.(`${unique.length - raws.size} of ${unique.length} addresses not read`);
  let ethUsd = opts.baseEthUsd;
  if (ethUsd === null && [...raws.values()].some((r) => r.ethWei > 0n)) ethUsd = await readEthSpot(fetchFn);
  for (const [address, raw] of raws) out.set(address, toHolding(raw, ethUsd));
  return out;
}

export interface OutsideSummary {
  /** Accounts whose Ethereum balance was read. */
  read: number;
  /** Accounts that could not be read (or were not tried). */
  unread: number;
  eth: number;
  usdc: number;
  /** Null when any read holding could not be priced. */
  usd: number | null;
  /** Read accounts with anything on Ethereum. */
  holders: number;
}

/** Sums the rows' outside figures. Works on the (filtered) rows the page shows. */
export function summarizeOutside(rows: readonly { outside?: OutsideHolding }[]): OutsideSummary {
  let read = 0, holders = 0, eth = 0, usdc = 0, usd: number | null = 0;
  for (const r of rows) {
    const o = r.outside;
    if (!o) continue;
    read += 1;
    eth += o.eth;
    usdc += o.usdc;
    if (o.eth > 0 || o.usdc > 0) holders += 1;
    usd = usd === null || o.usd === null ? null : usd + o.usd;
  }
  return { read, unread: rows.length - read, eth, usdc, usd, holders };
}

function fmtOutsideEth(n: number): string {
  return n.toFixed(n < 0.001 ? 6 : 4);
}

/** "$128 · 0.0554 ETH on Ethereum · 1 account", or "not read". Pure; `usd` formats the dollar figure. */
export function outsideLine(s: OutsideSummary, usd: (n: number) => string): string {
  if (s.read === 0) return "not read";
  const parts: string[] = [];
  parts.push(s.usd === null ? "USD not priced" : usd(s.usd));
  if (s.eth > 0) parts.push(`${fmtOutsideEth(s.eth)} ETH on Ethereum`);
  if (s.usdc > 0) parts.push(`${usd(s.usdc)} USDC on Ethereum`);
  if (s.eth === 0 && s.usdc === 0) parts.push("nothing on Ethereum");
  parts.push(`${s.holders} ${s.holders === 1 ? "account" : "accounts"}`);
  const base = parts.join(" · ");
  return s.unread > 0 ? `at least ${base} · ${s.unread} not read` : base;
}
