/**
 * Holdings on Monad at the account addresses (otto/mamoru-astro#39). A Safe has the same address on every chain,
 * and the app runs a Monad sleeve (WMON/USDC) at that address, so every account address is read here, whatever
 * chain its D1 row names. One Multicall3 aggregate3 call per chunk: native MON, USDC, WMON and the number of
 * position NFTs. A failed read leaves the account's `monad` unset ("not read"); it is never counted as zero.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { type OutsideFetch, rpcCall } from "./outside-base";
import { hourRotation, ownRpcs, PUBLIC_RPCS, publicPool, RunHealth } from "./rpc-pool";

export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const MONAD_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
export const MONAD_NPM = "0x7197E214c0b767cFB76Fb734ab638E2c192F4E53";
/** WMON/USDC 0.30 %, token0 = WMON: prices MON only when some account holds MON or WMON. */
export const MONAD_WMON_USDC_POOL = "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da";
export const MONAD_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Public pool (otto/mamoru-astro#42, see rpc-pool.ts), after any `MONAD_RPC_URLS`. */
export const MONAD_PUBLIC_RPCS: readonly string[] = PUBLIC_RPCS.monad;
/** RPCs asked at once per chunk; the next wave only when all of these failed. */
const WAVE = 3;
/** Public RPCs one run may ask at most; later runs start elsewhere in the pool. */
const PUBLIC_PER_RUN = 6;
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
  return [own, publicPool("monad", rotation, own).slice(0, PUBLIC_PER_RUN)];
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

async function readMonUsd(urls: readonly string[], fetchFn: OutsideFetch, health: RunHealth): Promise<number | null> {
  const data = encodeFunctionData({ abi, functionName: "slot0" });
  for (const url of health.healthy(urls)) {
    try {
      const out = decodeFunctionResult({ abi, functionName: "slot0", data: await rpcCall(url, MONAD_WMON_USDC_POOL, data, fetchFn) }) as readonly [bigint, ...unknown[]];
      return monUsdFromSqrt(out[0]);
    } catch {
      health.fail(url);
    }
  }
  return null;
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
  const tiers = monadRpcTiers(opts.rpcUrls, opts.rotation ?? hourRotation());
  const urls = tiers.flat();
  const health = new RunHealth();
  const raws = new Map<string, MonadRaw>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.deadlineMs ?? MONAD_DEADLINE_MS);
  });
  await Promise.race([deadline, Promise.all(
    chunks.map(async (chunk) => {
      const data = callData(chunk);
      // A few RPCs at once, the first full answer wins; the next wave only when all of them failed, and an RPC that
      // failed is left out of later waves and chunks this run. A wave never mixes tiers, so a public RPC is asked only
      // after every configured one failed and can never answer ahead of a healthy one.
      const waves: string[][] = [];
      for (const tier of tiers) for (let i = 0; i < tier.length; i += WAVE) waves.push(tier.slice(i, i + WAVE));
      for (const all of waves) {
        const wave = health.healthy(all);
        if (!wave.length) continue;
        try {
          const got = await Promise.any(wave.map(async (url) => {
            try {
              return parseMonadAggregate(chunk, await rpcCall(url, MONAD_MULTICALL3, data, fetchFn));
            } catch (e) {
              health.fail(url);
              throw e;
            }
          }));
          got.forEach((r, k) => {
            if (r) raws.set(chunk[k], r);
          });
          return;
        } catch {
          // Every RPC in the wave failed: next wave.
        }
      }
    }),
  )]);
  clearTimeout(timer);
  const monUsd = [...raws.values()].some((r) => r.monWei + r.wmonWei > 0n) ? await readMonUsd(urls, fetchFn, health) : null;
  for (const [address, raw] of raws) out.set(address, toMonadHolding(raw, monUsd));
  return out;
}
