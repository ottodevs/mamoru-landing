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
export const ETHEREUM_PUBLIC_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
export const ETH_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
/** Accounts per aggregate3 call (two sub-calls each): keeps one eth_call small and the subrequest count low. */
const CHUNK = 100;
const TIMEOUT_MS = 8_000;

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

async function rpcCall(url: string, to: string, data: string, fetchFn: OutsideFetch): Promise<`0x${string}`> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error("rpc error");
  return body.result as `0x${string}`;
}

/** One chunk, trying each RPC in order. null when every RPC failed. */
async function readChunk(addresses: readonly string[], urls: readonly string[], fetchFn: OutsideFetch): Promise<(OutsideRaw | null)[] | null> {
  const data = callData(addresses);
  for (const url of urls) {
    try {
      return parseAggregate(addresses, await rpcCall(url, ETHEREUM_MULTICALL3, data, fetchFn));
    } catch {
      // Next RPC.
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
  opts: { rpcUrls?: string; baseEthUsd: number | null; fetchFn?: OutsideFetch },
): Promise<Map<string, OutsideHolding>> {
  const out = new Map<string, OutsideHolding>();
  const fetchFn = opts.fetchFn ?? fetch;
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (unique.length === 0) return out;
  const urls = ethereumRpcList(opts.rpcUrls);
  const raws = new Map<string, OutsideRaw>();
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const read = await readChunk(chunk, urls, fetchFn);
      read?.forEach((r, k) => {
        if (r) raws.set(chunk[k], r);
      });
    }
  } catch {
    // Keep whatever was read; the rest stays "not read".
  }
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
