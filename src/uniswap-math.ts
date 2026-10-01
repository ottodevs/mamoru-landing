/**
 * Uniswap v3 pricing and position-value math, for display only.
 * Floating point throughout: fine for a dashboard number, never for a settled amount.
 */

const Q96 = 2 ** 96;

/** Lower address sorts first, matching how Uniswap v3 assigns token0/token1. */
export function sortTokens(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** token1 per token0, in human units, from the pool's raw sqrtPriceX96. */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const sqrtPrice = Number(sqrtPriceX96) / Q96;
  const rawPrice = sqrtPrice * sqrtPrice;
  return rawPrice * 10 ** (decimals0 - decimals1);
}

/**
 * Price of `base` denominated in `quote`, from a pool's sqrtPriceX96, regardless
 * of which one happens to be token0. Returns null if the price is not finite.
 */
export function priceOfBaseInQuote(opts: {
  sqrtPriceX96: bigint;
  base: string;
  quote: string;
  decimalsOf: (address: string) => number;
}): number | null {
  const [token0] = sortTokens(opts.base, opts.quote);
  const decimals0 = opts.decimalsOf(token0);
  const token1 = sameAddress(token0, opts.base) ? opts.quote : opts.base;
  const decimals1 = opts.decimalsOf(token1);
  const token1PerToken0 = sqrtPriceX96ToPrice(opts.sqrtPriceX96, decimals0, decimals1);
  if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) return null;
  const price = sameAddress(token0, opts.base) ? token1PerToken0 : 1 / token1PerToken0;
  return Number.isFinite(price) ? price : null;
}

/** Unscaled sqrt(price) at a tick: sqrt(1.0001^tick), same domain as sqrtPriceX96/2^96. */
export function tickToSqrtPrice(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

export interface PositionAmounts {
  /** Raw (pre-decimals) amount of token0 backing the position's liquidity. */
  amount0Raw: number;
  /** Raw (pre-decimals) amount of token1 backing the position's liquidity. */
  amount1Raw: number;
  inRange: boolean;
}

/** Standard Uniswap v3 liquidity→amounts split, from the pool's current tick/sqrtPrice. */
export function positionAmounts(opts: {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: bigint;
}): PositionAmounts {
  const liquidity = Number(opts.liquidity);
  const sqrtPrice = Number(opts.sqrtPriceX96) / Q96;
  const sqrtLower = tickToSqrtPrice(opts.tickLower);
  const sqrtUpper = tickToSqrtPrice(opts.tickUpper);
  const inRange = opts.currentTick >= opts.tickLower && opts.currentTick < opts.tickUpper;

  if (opts.currentTick < opts.tickLower) {
    return { amount0Raw: liquidity * (1 / sqrtLower - 1 / sqrtUpper), amount1Raw: 0, inRange };
  }
  if (opts.currentTick >= opts.tickUpper) {
    return { amount0Raw: 0, amount1Raw: liquidity * (sqrtUpper - sqrtLower), inRange };
  }
  return {
    amount0Raw: liquidity * (1 / sqrtPrice - 1 / sqrtUpper),
    amount1Raw: liquidity * (sqrtPrice - sqrtLower),
    inRange,
  };
}

export interface PositionInput {
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
}

export interface PositionValue {
  amount0: number;
  amount1: number;
  usd: number | null;
  inRange: boolean;
}

/**
 * Current value of one LP position: liquidity split by the pool's live price,
 * plus uncollected fees (tokensOwed). `priceUsd` returns null for unpriced tokens,
 * in which case the position's USD value is null (shown separately, not as zero).
 */
export function valuePosition(
  position: PositionInput,
  pool: PoolState,
  priceUsd: (token: string) => number | null,
  decimalsOf: (token: string) => number,
): PositionValue {
  const { amount0Raw, amount1Raw, inRange } = positionAmounts({
    liquidity: position.liquidity,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick: pool.tick,
    sqrtPriceX96: pool.sqrtPriceX96,
  });
  const decimals0 = decimalsOf(position.token0);
  const decimals1 = decimalsOf(position.token1);
  const amount0 = amount0Raw / 10 ** decimals0 + Number(position.tokensOwed0) / 10 ** decimals0;
  const amount1 = amount1Raw / 10 ** decimals1 + Number(position.tokensOwed1) / 10 ** decimals1;
  const price0 = priceUsd(position.token0);
  const price1 = priceUsd(position.token1);
  const usd = price0 === null || price1 === null ? null : amount0 * price0 + amount1 * price1;
  return { amount0, amount1, usd, inRange };
}
