/**
 * otto/mamoru-astro#55: the pure math of the War room. Ported from ottodevs/mamoru `packages/decide/src/guard/index.ts`
 * (marketOf, fallBpsOf) so the page reads the same 24 h TWAP fall and 24 h realized volatility the engine's fall-freeze
 * guard acts on. No I/O here.
 */

const DAY = 86_400;
const YEAR = 365 * DAY;
const LN_TICK = Math.log(1.0001);

/** The engine's TWAP window (policy execution.twapWindowSeconds); 24 h is 48 of them. */
export const TWAP_WINDOW_SECONDS = 1800;

/** One pool's tick cumulative at a time (seconds), as `observe` answers it. */
export type CumulativePoint = { time: number; tickCumulative: bigint };

export type MarketPoint = { twap24hAgoTick: number | null; realizedVol24hBps: number | null };

/** Same rules as the engine's marketOf: any missing point, or one taken half a window or more early, makes both null. */
export function marketOf(now: number, windowSeconds: number, cumulativeAt: (t: number) => CumulativePoint | null): MarketPoint {
  const none: MarketPoint = { twap24hAgoTick: null, realizedVol24hBps: null };
  if (windowSeconds <= 0 || DAY % windowSeconds !== 0) return none;
  const segments = DAY / windowSeconds;
  if (segments < 2) return none;
  const points: CumulativePoint[] = [];
  for (let m = segments + 1; m >= 0; m--) {
    const at = now - m * windowSeconds;
    const p = cumulativeAt(at);
    if (!p || p.time > at || at - p.time >= windowSeconds / 2) return none;
    points.push(p);
  }
  const means: number[] = [];
  for (let k = 1; k < points.length; k++) {
    const secs = points[k]!.time - points[k - 1]!.time;
    if (secs <= 0) return none;
    means.push(Number(points[k]!.tickCumulative - points[k - 1]!.tickCumulative) / secs);
  }
  let sum = 0;
  for (let k = 1; k < means.length; k++) sum += ((means[k]! - means[k - 1]!) * LN_TICK) ** 2;
  const vol = Math.sqrt((sum / (means.length - 1)) * (YEAR / windowSeconds));
  return { twap24hAgoTick: Math.floor(means[0]!), realizedVol24hBps: Math.round(vol * 10_000) };
}

/**
 * Fall of the volatile token's price in USDC from `fromTick` to `toTick`, in bps (negative: it rose). The tick prices
 * token0 in token1: the volatile token falls with the tick when it is token0 (WETH/USDC), rises when it is token1
 * (USDC/cbBTC).
 */
export function fallBpsOf(volatileIsToken0: boolean, fromTick: number, toTick: number): number {
  const d = volatileIsToken0 ? toTick - fromTick : fromTick - toTick;
  return Math.round((1 - 1.0001 ** d) * 10_000);
}

/** Mean tick of the last window, floored, from the two newest cumulative points of the grid. */
export function meanTick(a: CumulativePoint, b: CumulativePoint): number | null {
  const secs = b.time - a.time;
  if (secs <= 0) return null;
  return Math.floor(Number(b.tickCumulative - a.tickCumulative) / secs);
}

/** The two pools the page reads, from the registry (packages/registry/base.json): token order and decimals. */
export type WarPool = {
  name: string;
  address: string;
  asset: "ETH" | "BTC";
  /** The volatile token is the pool's token0. */
  volatileIsToken0: boolean;
  /** Guard bucket of this pool in the settings row. */
  bucket: "eth" | "btc";
};

export const WAR_POOLS: readonly WarPool[] = [
  { name: "pool:WETH/USDC/3000", address: "0x6c561B446416E1A00E8E93E221854d6eA4171372", asset: "ETH", volatileIsToken0: true, bucket: "eth" },
  { name: "pool:USDC/cbBTC/500", address: "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef", asset: "BTC", volatileIsToken0: false, bucket: "btc" },
];

/**
 * USDC per ETH or per BTC from a tick. WETH (18) is token0 of WETH/USDC (6): raw token1/token0 = 1.0001^tick, scaled
 * by 10^(18-6). USDC (6) is token0 of USDC/cbBTC (8): raw = 1.0001^tick is cbBTC-units per USDC-unit, so BTC price is
 * 10^(8-6) / 1.0001^tick.
 */
export function priceOfTick(pool: WarPool, tick: number): number {
  const raw = 1.0001 ** tick;
  return pool.asset === "ETH" ? raw * 1e12 : 100 / raw;
}

/** Change in percent from `then` to `now`, or null when either is missing. */
export function changePct(now: number | null, then: number | null): number | null {
  if (now === null || then === null || !(then > 0)) return null;
  return (now / then - 1) * 100;
}

/** Percentage of the price to the nearest edge of a range, given tick edges. Not stored by the snapshots today. */
export function edgeDistancePct(tick: number, tickLower: number, tickUpper: number): number {
  const toLower = 1 - 1.0001 ** (tickLower - tick);
  const toUpper = 1.0001 ** (tickUpper - tick) - 1;
  return Math.min(Math.abs(toLower), Math.abs(toUpper)) * 100;
}

export type GuardThreshold = { fallBps: number; volBps: number };
export type GuardVerdict = { metric: { fallBps: number; volBps: number } | null; wouldTrigger: boolean };

/** Both at or over their thresholds, as fallFreezeOf decides; no metric means the rule abstains (data insufficient). */
export function guardVerdict(metric: { fallBps: number; volBps: number } | null, t: GuardThreshold): GuardVerdict {
  if (!metric) return { metric: null, wouldTrigger: false };
  return { metric, wouldTrigger: metric.fallBps >= t.fallBps && metric.volBps >= t.volBps };
}
