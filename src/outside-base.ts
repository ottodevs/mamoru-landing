/**
 * Holdings outside Base (otto/mamoru-astro#31): the same account address on Ethereum Mainnet can hold
 * native ETH and USDC that the working Base figures never see. This reads them with one Multicall3
 * aggregate3 call per chunk of accounts and reports them as a SEPARATE figure: never added into the
 * working (Base) value held. A failed read leaves the account's `outside` unset ("not read"); it is never
 * counted as zero and never touches the Base numbers.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { hourRotation, ownRpcs, PUBLIC_RPCS, publicPool, readPooled, RunHealth } from "./rpc-pool";

export const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const ETHEREUM_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Public pool, tried after any `ETHEREUM_RPC_URLS` (secret, optional, comma separated). See rpc-pool.ts. */
export const ETHEREUM_PUBLIC_RPCS: readonly string[] = PUBLIC_RPCS.ethereum;
export const ETH_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
/** Accounts per aggregate3 call (two sub-calls each): keeps one eth_call small and the subrequest count low. */
const CHUNK = 100;
const TIMEOUT_MS = 3_000;
/** The whole Ethereum read gives up after this, so it can never hold the Base snapshot back (waitUntil is capped at 30 s). */
export const OUTSIDE_DEADLINE_MS = 12_000;
/**
 * One phase: every RPC of the configured tier, or of a public wave, gets this long. One ask is aggregate3 and, only
 * when that gave nothing, a plain batch, each within TIMEOUT_MS, so a slow-but-answering RPC is never cut off.
 */
const PHASE_MS = 2 * TIMEOUT_MS + 250;
/** otto/mamoru-astro#42: public RPCs asked at once; the next ones only for what these left without two agreeing hosts. */
const WAVE = 3;
/** Public hosts one run may ask at most, across every chunk (the rest of the pool is reached on later runs, by rotation). */
const PUBLIC_PER_RUN = 9;

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

export function ethereumRpcList(secret?: string, rotation = 0): string[] {
  return ethereumRpcTiers(secret, rotation).flat();
}

/**
 * [the configured https RPCs, the public pool rotated for this run]: the second tier is asked only for what the
 * first left unanswered, a few at a time.
 */
export function ethereumRpcTiers(secret?: string, rotation = 0): string[][] {
  const own = ownRpcs(secret);
  return [own, publicPool("ethereum", rotation, own)];
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
/**
 * Why a read failed, as "host: kind", where kind is only a category: an HTTP status, a JSON-RPC error code, a
 * timeout, a network error or no answer. No free text from the error ever goes in, so a key in a configured URL
 * (path, query, or echoed back by the RPC in any form) can never reach KV or a page.
 */
export const whyFailed = (url: string, e: unknown): string => {
  const name = e instanceof Error ? e.name : "";
  const text = e instanceof Error ? e.message : String(e);
  const status = /^(rpc|batch) (\d{3})$/.exec(text);
  const code = /^rpc error \{"code":(-?\d{1,6})\b/.exec(text);
  const kind = status
    ? `HTTP ${status[2]}`
    : code
      ? `JSON-RPC error ${code[1]}`
      : name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : /no balance answered$/.test(text)
          ? "no balance answered"
          : /not a list$/.test(text)
            ? "batch not supported"
            : "network error";
  return `${hostOf(url)}: ${kind}`;
};

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

/**
 * One RPC's balances for a chunk: aggregate3, and the plain batch when aggregate3 refused with a JSON-RPC error or gave
 * no balance (otto/mamoru-astro#40: from Cloudflare a plain eth_getBalance answered where aggregate3 did not). Throws
 * when the RPC itself failed (HTTP status, timeout, network) or both ways failed.
 */
async function askEthereum(url: string, addresses: readonly string[], fetchFn: OutsideFetch): Promise<(OutsideRaw | null)[]> {
  try {
    const got = parseAggregate(addresses, await rpcCall(url, ETHEREUM_MULTICALL3, callData(addresses), fetchFn));
    if (got.some((r) => r !== null)) return got;
  } catch (e) {
    if (!(e instanceof Error && /^rpc error /.test(e.message))) throw e;
  }
  return readChunkBatch(addresses, url, fetchFn);
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
  opts: { rpcUrls?: string; baseEthUsd: number | null; fetchFn?: OutsideFetch; deadlineMs?: number; onError?: ReadError; rotation?: number },
): Promise<Map<string, OutsideHolding>> {
  const out = new Map<string, OutsideHolding>();
  const fetchFn = opts.fetchFn ?? fetch;
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (unique.length === 0) return out;
  const [own, pub] = ethereumRpcTiers(opts.rpcUrls, opts.rotation ?? hourRotation());
  const raws = new Map<string, OutsideRaw>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.deadlineMs ?? OUTSIDE_DEADLINE_MS);
  });
  // On the deadline, every balance already settled is kept; the rest stay "not read".
  const read = readPooled(
    chunks,
    { own, public: pub, phaseMs: PHASE_MS, wave: WAVE, publicHosts: PUBLIC_PER_RUN },
    { ask: (url, which) => askEthereum(url, which, fetchFn), key: (r) => `${r.ethWei}:${r.usdcRaw}`, failed: (url, e) => opts.onError?.(whyFailed(url, e)) },
    new RunHealth(own),
    raws,
  ).catch(() => undefined);
  await Promise.race([deadline, read]);
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
