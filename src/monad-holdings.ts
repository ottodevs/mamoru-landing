/**
 * Holdings on Monad at the account addresses (otto/mamoru-astro#39). A Safe has the same address on every chain,
 * and the app runs a Monad sleeve (WMON/USDC) at that address, so every account address is read here, whatever
 * chain its D1 row names. One Multicall3 aggregate3 call per chunk: native MON, USDC, WMON and the number of
 * position NFTs. A failed read leaves the account's `monad` unset ("not read"); it is never counted as zero.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { type OutsideFetch, rpcCall } from "./outside-base";
import { hourRotation, ownRpcs, PUBLIC_RPCS, publicPool, readPooled, RunHealth, settleWithin } from "./rpc-pool";

export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const MONAD_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
export const MONAD_NPM = "0x7197E214c0b767cFB76Fb734ab638E2c192F4E53";
/** WMON/USDC 0.30 %, token0 = WMON: prices MON only when some account holds MON or WMON. */
export const MONAD_WMON_USDC_POOL = "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da";
export const MONAD_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Public pool (otto/mamoru-astro#42, see rpc-pool.ts), after any `MONAD_RPC_URLS`. */
export const MONAD_PUBLIC_RPCS: readonly string[] = PUBLIC_RPCS.monad;
/** Public RPCs asked at once; the next ones only for what these left without two agreeing hosts. */
const WAVE = 3;
/** Public hosts one run may ask at most, across every chunk; later runs start elsewhere in the pool. */
const PUBLIC_PER_RUN = 6;
/** One phase: each configured RPC, or each RPC of a public wave, gets this long (one call within its 3 s timeout). */
const PHASE_MS = 3_250;
const CHUNK = 100;
const PER = 4;
export const MONAD_DEADLINE_MS = 6_000;

const abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function balanceOf(address owner) view returns (uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

export interface MonadHolding {
  /** Native MON plus WMON. */
  mon: number;
  usdc: number;
  /** Uniswap v3 position NFTs held on Monad. Their value is not read here: any position makes the Safe's figure a floor. */
  positions: number;
  /** The priced part in dollars: USDC, plus MON when it has a price. Positions are never in it. */
  usd: number;
  /** True when MON is held and no price was read: `usd` is then a floor (the USDC still counts). */
  monUnpriced: boolean;
  /** otto/mamoru-astro#40: set when this figure was carried from an earlier reading because the latest read failed. */
  at?: string;
}

export interface MonadRaw {
  monWei: bigint;
  usdcRaw: bigint;
  wmonWei: bigint;
  nfts: bigint;
}

/** [the configured RPCs in their order, the public pool rotated for this run and capped]. */
export function monadRpcTiers(secret?: string, rotation = 0): string[][] {
  const own = ownRpcs(secret);
  return [own, publicPool("monad", rotation, own)];
}

export function monadRpcList(secret?: string, rotation = 0): string[] {
  return monadRpcTiers(secret, rotation).flat();
}

const sub = (target: string, data: `0x${string}`) => ({ target: target as `0x${string}`, allowFailure: true, callData: data });

function callData(addresses: readonly string[]): `0x${string}` {
  const calls = addresses.flatMap((a) => {
    const owner = [a as `0x${string}`] as const;
    const bal = encodeFunctionData({ abi, functionName: "balanceOf", args: owner });
    return [
      sub(MONAD_MULTICALL3, encodeFunctionData({ abi, functionName: "getEthBalance", args: owner })),
      sub(MONAD_USDC, bal),
      sub(MONAD_WMON, bal),
      sub(MONAD_NPM, bal),
    ];
  });
  return encodeFunctionData({ abi, functionName: "aggregate3", args: [calls] });
}

/** One entry per address; null where any sub-call failed or was malformed. */
export function parseMonadAggregate(addresses: readonly string[], returnData: `0x${string}`): (MonadRaw | null)[] {
  const results = decodeFunctionResult({ abi, functionName: "aggregate3", data: returnData }) as readonly {
    success: boolean;
    returnData: `0x${string}`;
  }[];
  if (results.length !== addresses.length * PER) throw new Error("unexpected aggregate3 length");
  const word = (r: { success: boolean; returnData: `0x${string}` }): bigint | null =>
    r.success && r.returnData.length === 66 ? BigInt(r.returnData) : null;
  return addresses.map((_, i) => {
    const [monWei, usdcRaw, wmonWei, nfts] = results.slice(i * PER, i * PER + PER).map(word);
    return monWei === null || usdcRaw === null || wmonWei === null || nfts === null ? null : { monWei, usdcRaw, wmonWei, nfts };
  });
}

/** USDC per MON from the pool's sqrtPriceX96 (token0 WMON 18 decimals, token1 USDC 6). null when not positive. */
export function monUsdFromSqrt(sqrtPriceX96: bigint): number | null {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const p = r * r * 1e12;
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * MON in USDC from the pool's slot0, within `ms`: the configured RPCs first (list order), else the public hosts that
 * already answered this run, and then only a price two different hosts agree on within 1 % (the lower one). null
 * when none could be had.
 */
async function readMonUsd(own: readonly string[], answered: readonly string[], fetchFn: OutsideFetch, ms: number): Promise<number | null> {
  const data = encodeFunctionData({ abi, functionName: "slot0" });
  const price = async (url: string): Promise<number | null> => {
    const out = decodeFunctionResult({ abi, functionName: "slot0", data: await rpcCall(url, MONAD_WMON_USDC_POOL, data, fetchFn) }) as readonly [bigint, ...unknown[]];
    return monUsdFromSqrt(out[0]);
  };
  const started = Date.now();
  if (own.length) {
    const got = await settleWithin(own.map(price), ms);
    const hit = got.find((p) => p != null);
    if (hit != null) return hit;
  }
  const left = ms - (Date.now() - started);
  if (left <= 0 || answered.length < 2) return null;
  // One answer per host (the list holds distinct URLs of distinct hosts); a pair within 1 % gives the lower of the two.
  const got = (await settleWithin(answered.slice(0, WAVE).map(price), left)).filter((p): p is number => p != null);
  let best: number | null = null;
  for (let a = 0; a < got.length; a++)
    for (let b = a + 1; b < got.length; b++)
      if (Math.abs(got[a] - got[b]) <= Math.min(got[a], got[b]) * 0.01) best = Math.min(best ?? Infinity, got[a], got[b]);
  return best;
}

export function toMonadHolding(raw: MonadRaw, monUsd: number | null): MonadHolding {
  const mon = Number(raw.monWei + raw.wmonWei) / 1e18;
  const usdc = Number(raw.usdcRaw) / 1e6;
  const positions = Number(raw.nfts);
  const monUnpriced = mon > 0 && monUsd === null;
  return { mon, usdc, positions, usd: usdc + (monUsd === null ? 0 : mon * monUsd), monUnpriced };
}

/** Reads every address on Monad. Map keyed by lowercase address of the accounts that were read; absent = not read. Never throws. */
export async function readMonadHoldings(
  addresses: readonly string[],
  opts: { rpcUrls?: string; fetchFn?: OutsideFetch; deadlineMs?: number; rotation?: number },
): Promise<Map<string, MonadHolding>> {
  const out = new Map<string, MonadHolding>();
  const fetchFn = opts.fetchFn ?? fetch;
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (unique.length === 0) return out;
  const [own, pub] = monadRpcTiers(opts.rpcUrls, opts.rotation ?? hourRotation());
  const raws = new Map<string, MonadRaw>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  const health = new RunHealth(own);
  const answered = new Set<string>();
  const deadlineMs = opts.deadlineMs ?? MONAD_DEADLINE_MS;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  const read = readPooled(
    chunks,
    { own, public: pub, phaseMs: PHASE_MS, wave: WAVE, publicHosts: PUBLIC_PER_RUN },
    {
      ask: async (url, which) => {
        const got = parseMonadAggregate(which, await rpcCall(url, MONAD_MULTICALL3, callData(which), fetchFn));
        if (got.some((r) => r !== null)) answered.add(url);
        return got;
      },
      key: (r) => `${r.monWei}:${r.usdcRaw}:${r.wmonWei}:${r.nfts}`,
    },
    health,
    raws,
  ).catch(() => undefined);
  await Promise.race([deadline, read]);
  clearTimeout(timer);
  // The price is read within what is left of the same deadline, never after it.
  const left = deadlineMs - (Date.now() - started);
  const holdsMon = [...raws.values()].some((r) => r.monWei + r.wmonWei > 0n);
  const publicAnswered = pub.filter((u) => answered.has(u));
  const monUsd = holdsMon && left > 0 ? await readMonUsd(health.healthy(own), publicAnswered, fetchFn, left) : null;
  for (const [address, raw] of raws) out.set(address, toMonadHolding(raw, monUsd));
  return out;
}
