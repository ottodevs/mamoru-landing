/** Pure cost-per-account math. No RPC calls here, so it is cheap to unit test. */

/** Rough Safe deploy gas (CREATE2 proxy + setup), from mamoru-operator's own budget. */
export const DEPLOY_GAS = 400_000n;
/** Base's per-tx gas cap is 2^24; the activation batch runs well under it. */
export const ACTIVATION_GAS = 13_900_000n;

/** Mirrors the Conservador policy default in mamoru-app (gasReserveWei). */
export const RESERVE_POLICY_WEI = 300_000_000_000_000n; // 0.0003 ETH
/** Mirrors mamoru-operator's TOP_UP_MARGIN_WEI, added on top of the policy reserve. */
export const RESERVE_TOPUP_MARGIN_WEI = 200_000_000_000_000n; // 0.0002 ETH
/** What actually gets sent to a new Safe: policy reserve + operator margin. */
export const RESERVE_WEI = RESERVE_POLICY_WEI + RESERVE_TOPUP_MARGIN_WEI; // 0.0005 ETH

export const RELAYER_OK_WEI = 3_000_000_000_000_000n; // 0.003 ETH
export const RELAYER_LOW_WEI = 600_000_000_000_000n; // 0.0006 ETH

export type RelayerStatus = "ok" | "low" | "empty";

export function relayerStatus(balanceWei: bigint): RelayerStatus {
  if (balanceWei >= RELAYER_OK_WEI) return "ok";
  if (balanceWei >= RELAYER_LOW_WEI) return "low";
  return "empty";
}

export interface CostBreakdown {
  gasPriceWei: bigint;
  deployWei: bigint;
  activationWei: bigint;
  reserveWei: bigint;
  /** deploy + activation: what is actually spent and not recovered. */
  sunkWei: bigint;
  /** sunk + reserve: what the relayer must hand over per new account. */
  totalWei: bigint;
}

/** Cost to bring up one account at the given Base gas price. */
export function costPerAccount(gasPriceWei: bigint): CostBreakdown {
  const price = gasPriceWei < 0n ? 0n : gasPriceWei;
  const deployWei = DEPLOY_GAS * price;
  const activationWei = ACTIVATION_GAS * price;
  const sunkWei = deployWei + activationWei;
  return {
    gasPriceWei: price,
    deployWei,
    activationWei,
    reserveWei: RESERVE_WEI,
    sunkWei,
    totalWei: sunkWei + RESERVE_WEI,
  };
}

/** How many more accounts the relayer's current balance can fund, floor division. */
export function accountsFunded(balanceWei: bigint, totalWei: bigint): number {
  if (totalWei <= 0n || balanceWei <= 0n) return 0;
  return Number(balanceWei / totalWei);
}

/** Display-only wei→ETH. Precision loss above ~1e16 wei is irrelevant at this scale. */
export function weiToEth(wei: bigint): number {
  return Number(wei) / 1e18;
}

/** Display-only raw-units→human for any ERC-20 decimals count. */
export function unitsToNumber(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function ethToUsd(eth: number, ethUsd: number | null): number | null {
  return ethUsd === null ? null : eth * ethUsd;
}
