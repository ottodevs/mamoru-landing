/**
 * Builds the /ops/yield model from yield-store.ts's aggregate D1 rows, plus the loader that reads them. The
 * build step (buildYieldOverview and below) is pure, same split as metrics-overview.ts, so every rule here
 * is testable without a database. Per-account figures match apps/mamoru-app/src/api/accounts/yield.ts's
 * loadYieldLedger: earned so far = accrued + lifetime collected; value vs hold = this account's open
 * positions' value + accrued - hold baseline, read on each position's own latest day — otto/mamoru-astro#20's
 * acceptance criteria is that this page's numbers match that endpoint, so the formulas are ported, not
 * reinvented.
 *
 * Two rules code review flagged on PR #10 hold everywhere below:
 * - One source per figure. "Earned to date" (account_snapshot_latest.fees_usdc + Σ account_daily.collected_usdc)
 *   never reads yield_ledger_position_daily; that table is read only for the per-position drill-down and for
 *   vs-hold. Nothing here sums a mix of account-level and position-level rows into one figure.
 * - A recorded gas_paid_wei with no ETH price yet is "unpriced", never a fabricated $0 of cost: net reads as
 *   null (rendered "—") instead of silently equalling earned, and the raw ETH amount is still carried so the
 *   page can say so.
 */

import type { AccountFilter } from "./account-filter";
import type { D1Db } from "./d1-infra";
import { addDays, dayRange, daysBetween, utcDay } from "./metrics-math";
import { currentFlagStates } from "./ops-flags-store";
import {
  fetchAccountAggregates,
  fetchDailyAggregates,
  fetchEarliestDay,
  fetchGasRows,
  fetchPositionLatest,
  fetchPositionLifetimeCollected,
  fetchYieldAccounts,
  positionKey,
  type AccountAggregates,
  type AccountSnapshotRow,
  type DayAggregate,
  type GasRow,
  type OpenPosition,
  type PositionLatest,
  type PositionSnapshot,
} from "./yield-store";

export type YieldPeriod = "24h" | "7d" | "30d" | "all";

export const YIELD_PERIODS: readonly YieldPeriod[] = ["24h", "7d", "30d", "all"];

export function parseYieldPeriod(raw: string | null | undefined): YieldPeriod {
  return raw === "24h" || raw === "30d" || raw === "all" ? raw : "7d";
}

/** Wei of the native gas token to USD. Only ever called with a non-null price; see `gasUnpriced` below. */
function weiToUsd(wei: bigint, ethUsd: number): number {
  return (Number(wei) / 1e18) * ethUsd;
}

export interface YieldPositionView {
  tokenId: number;
  pool: string;
  inRange: boolean;
  valueUsd: number;
  accruedFeesUsd: number;
  /** Lifetime. Null when migration 0010 is missing or this position has no recorded harvest yet. */
  collectedUsd: number | null;
  /** This position's own latest recorded day. Null when migration 0010 is missing or there is no row. */
  vsHoldUsd: number | null;
}

export interface YieldAccountView {
  accountKey: string;
  env: string;
  chainId: number;
  totalUsd: number;
  inPositionsUsd: number;
  feesUncollectedUsd: number;
  collectedToDateUsd: number;
  earnedToDateUsd: number;
  /** Lifetime: true once this account has ever had a non-null gas_paid_wei row. */
  gasRecorded: boolean;
  /** True when gas was recorded but there is no ETH price to convert it: `gasToDateUsd`/`netToDateUsd` are
   * null, never a fabricated $0 — `gasToDateEth` still carries the raw amount. */
  gasUnpriced: boolean;
  gasToDateEth: number | null;
  gasToDateUsd: number | null;
  /** Null exactly when `gasUnpriced`: a recorded cost with no known price is not the same as no cost. */
  netToDateUsd: number | null;
  feesEarnedPeriodUsd: number;
  gasRecordedInPeriod: boolean;
  aprPeriodPct: number | null;
  /** Null when migration 0010 is missing or there is no readable row for any open position. */
  vsHoldUsd: number | null;
  positionsInRange: number;
  positionsTotal: number;
  lastReadIso: string | null;
  positions: YieldPositionView[];
}

export interface YieldDailyBar {
  day: string;
  feesUsd: number;
  /** Null when gas was not recorded that day, or recorded with no price to convert it. */
  gasUsd: number | null;
}

export interface YieldOverview {
  filter: AccountFilter;
  period: YieldPeriod;
  periodDays: number;
  asOf: string | null;
  /** account_snapshot_latest/account_daily missing: migration 0009 is not applied. Nothing else is computed. */
  missing0009: boolean;
  /** yield_ledger_position_daily missing: migration 0010 is not applied. Degrades "vs hold" and a position's
   * "collected" to null; everything else (fees, gas, capital) still reads. */
  missing0010: boolean;
  flagOn: boolean;
  /** flagOn and migration 0009 present, but zero accounts matched (no snapshot has ever been written yet,
   * or none matches this filter). */
  noRows: boolean;
  /** Null exactly when `netYieldUnpriced`. */
  netYieldPeriodUsd: number | null;
  /** True when the hero figure above is a real net (gas known and priced). */
  netYieldIsNet: boolean;
  /** True when gas was recorded in the period but there is no ETH price: the hero is neither a net nor
   * "fees only", it is unavailable. */
  netYieldUnpriced: boolean;
  /** The period's recorded gas in ETH, present whenever gas was recorded at all that period (priced or not). */
  netYieldGasEth: number | null;
  feesEarnedToDateUsd: number;
  feeAprPeriodPct: number | null;
  capitalInPositionsUsd: number;
  projectedFeeCollectedUsd: number;
  projectedFeeUncollectedUsd: number;
  dailyBars: YieldDailyBar[];
  gasRecordedAnywhere: boolean;
  /** Sorted by fees earned to date, descending. */
  accounts: YieldAccountView[];
}

export interface YieldInputs {
  /** Null when account_snapshot_latest/accounts could not be read: migration 0009 is not applied. */
  snapshots: AccountSnapshotRow[] | null;
  /** Null when account_daily could not be read: migration 0009 is not applied. */
  accountAggregates: Map<string, AccountAggregates> | null;
  /** Null when account_daily could not be read. Empty in the overwhelmingly common case (no harvest-receipt
   * tracker has ever filled gas_paid_wei yet). */
  gasRows: GasRow[] | null;
  /** Null when account_daily could not be read. */
  dailyAggregates: DayAggregate[] | null;
  /** Earliest account_daily day across these accounts; only used by the "all" period. */
  earliestDay: string | null;
  /** Null when yield_ledger_position_daily could not be read: migration 0010 is not applied. */
  positionLatest: PositionLatest[] | null;
  /** Null when yield_ledger_position_daily could not be read. Keyed "<chainId>:<tokenId>". */
  positionCollected: Map<string, number> | null;
}

const EMPTY_OVERVIEW_BASE = {
  netYieldPeriodUsd: null as number | null,
  netYieldIsNet: false,
  netYieldUnpriced: false,
  netYieldGasEth: null as number | null,
  feesEarnedToDateUsd: 0,
  feeAprPeriodPct: null,
  capitalInPositionsUsd: 0,
  projectedFeeCollectedUsd: 0,
  projectedFeeUncollectedUsd: 0,
  dailyBars: [] as YieldDailyBar[],
  gasRecordedAnywhere: false,
  accounts: [] as YieldAccountView[],
};

function periodSinceDay(period: YieldPeriod, today: string): string | null {
  if (period === "24h") return today;
  if (period === "7d") return addDays(today, -6);
  if (period === "30d") return addDays(today, -29);
  return null;
}

/** Every per-position lookup keys by (chain, account, token) — positionKey() in yield-store.ts — so a
 * position never reads another account's row, and the same token id on two different chains for the same
 * account never collides (code review, otto/mamoru-astro#20 PR #10 round 2). */
function buildPosition(p: PositionSnapshot, chainId: number, accountKey: string, latestByKey: ReadonlyMap<string, PositionLatest>, collectedByKey: ReadonlyMap<string, number>): YieldPositionView {
  const key = positionKey(chainId, accountKey, p.tokenId);
  const latest = latestByKey.get(key);
  const collectedUsd = collectedByKey.get(key) ?? null;
  const vsHoldUsd = latest ? latest.valueUsd + latest.accruedUsdClose - latest.holdValueUsd : null;
  return { tokenId: p.tokenId, pool: p.pool, inRange: p.inRange, valueUsd: p.valueUsd, accruedFeesUsd: p.feesUsd, collectedUsd, vsHoldUsd };
}

function buildAccount(
  snap: AccountSnapshotRow,
  agg: AccountAggregates | undefined,
  gasLifetimeWei: bigint | null,
  gasRecordedInPeriod: boolean,
  periodDays: number,
  ethUsd: number | null,
  positionLatestByKey: ReadonlyMap<string, PositionLatest>,
  positionCollected: ReadonlyMap<string, number>,
): YieldAccountView {
  // One source per part (code review, otto/mamoru-astro#20 PR #10): the freshest accrued figure is
  // account_snapshot_latest.fees_usdc (snap.feesUsd, already converted by yield-store.ts), lifetime
  // collected is Σ account_daily.collected_usdc (agg.collectedToDateUsd, SQL SUM in fetchAccountAggregates).
  // yield_ledger_position_daily never feeds this figure — see buildPosition above for where it is read.
  const collectedToDateUsd = agg?.collectedToDateUsd ?? 0;
  const earnedToDateUsd = snap.feesUsd + collectedToDateUsd;

  const gasRecorded = gasLifetimeWei !== null;
  const gasUnpriced = gasRecorded && ethUsd === null;
  const gasToDateEth = gasRecorded ? Number(gasLifetimeWei) / 1e18 : null;
  const gasToDateUsd = gasRecorded && ethUsd !== null ? weiToUsd(gasLifetimeWei as bigint, ethUsd) : null;
  // A recorded cost with no price yet is not the same as no cost: net is unavailable, never earned-minus-zero.
  const netToDateUsd = gasUnpriced ? null : earnedToDateUsd - (gasToDateUsd ?? 0);

  const feesEarnedPeriodUsd = agg?.feesEarnedPeriodUsd ?? 0;
  const avgLpPeriod = agg?.avgLpPeriodUsd ?? null;
  const aprPeriodPct = avgLpPeriod && avgLpPeriod > 0 ? (feesEarnedPeriodUsd / avgLpPeriod) * (365 / periodDays) * 100 : null;

  const positions = snap.positions.map((p) => buildPosition(p, snap.chainId, snap.accountKey, positionLatestByKey, positionCollected));
  const vsHoldRows = snap.positions
    .map((p) => positionLatestByKey.get(positionKey(snap.chainId, snap.accountKey, p.tokenId)))
    .filter((r): r is PositionLatest => r !== undefined);
  const vsHoldUsd = vsHoldRows.length ? vsHoldRows.reduce((s, r) => s + (r.valueUsd + r.accruedUsdClose - r.holdValueUsd), 0) : null;

  return {
    accountKey: snap.accountKey,
    env: snap.env,
    chainId: snap.chainId,
    totalUsd: snap.totalUsd,
    inPositionsUsd: snap.lpUsd,
    feesUncollectedUsd: snap.feesUsd,
    collectedToDateUsd,
    earnedToDateUsd,
    gasRecorded,
    gasUnpriced,
    gasToDateEth,
    gasToDateUsd,
    netToDateUsd,
    feesEarnedPeriodUsd,
    gasRecordedInPeriod,
    aprPeriodPct,
    vsHoldUsd,
    positionsInRange: snap.positions.filter((p) => p.inRange).length,
    positionsTotal: snap.positions.length,
    lastReadIso: snap.readAt,
    positions,
  };
}

/** Lifetime and period-scoped gas, grouped by account, summed with BigInt (gasRows is already the sparse,
 * non-null-only read — see yield-store.ts's fetchGasRows). A parse failure on one row is skipped, never
 * thrown, same tolerance as every other D1 read in this Worker. */
function groupGasByAccount(gasRows: readonly GasRow[], sinceDay: string | null): { lifetime: Map<string, bigint>; periodAny: Set<string> } {
  const lifetime = new Map<string, bigint>();
  const periodAny = new Set<string>();
  for (const row of gasRows) {
    let wei: bigint;
    try {
      wei = BigInt(row.gasPaidWei);
    } catch {
      continue;
    }
    lifetime.set(row.accountKey, (lifetime.get(row.accountKey) ?? 0n) + wei);
    if (sinceDay === null || row.day >= sinceDay) periodAny.add(row.accountKey);
  }
  return { lifetime, periodAny };
}

/** Period gas, grouped by day (for the chart and the page-level hero). Same BigInt tolerance as above. */
function groupGasByDay(gasRows: readonly GasRow[], sinceDay: string | null): Map<string, bigint> {
  const byDay = new Map<string, bigint>();
  for (const row of gasRows) {
    if (sinceDay !== null && row.day < sinceDay) continue;
    let wei: bigint;
    try {
      wei = BigInt(row.gasPaidWei);
    } catch {
      continue;
    }
    byDay.set(row.day, (byDay.get(row.day) ?? 0n) + wei);
  }
  return byDay;
}

/** Flat, keyed by positionKey() (chain + account + token): the same key fetchPositionLifetimeCollected's
 * map already uses, so both are looked up identically in buildPosition above. */
function groupPositionLatest(rows: readonly PositionLatest[]): Map<string, PositionLatest> {
  const map = new Map<string, PositionLatest>();
  for (const r of rows) map.set(positionKey(r.chainId, r.accountKey, r.tokenId), r);
  return map;
}

export function buildYieldOverview(inputs: YieldInputs, filter: AccountFilter, period: YieldPeriod, now: Date, ethUsd: number | null, flagOn: boolean): YieldOverview {
  const today = utcDay(now);
  const missing0009 = inputs.snapshots === null || inputs.accountAggregates === null;
  if (missing0009) {
    return { filter, period, periodDays: 1, asOf: null, missing0009: true, missing0010: inputs.positionLatest === null || inputs.positionCollected === null, flagOn, noRows: false, ...EMPTY_OVERVIEW_BASE };
  }
  const snapshots = inputs.snapshots!;
  const aggByAccount = inputs.accountAggregates!;
  const gasRows = inputs.gasRows ?? [];
  const dailyAggregates = inputs.dailyAggregates ?? [];
  const missing0010 = inputs.positionLatest === null || inputs.positionCollected === null;
  const positionCollected = inputs.positionCollected ?? new Map<string, number>();
  const noRows = flagOn && snapshots.length === 0;
  if (!flagOn || noRows) {
    return { filter, period, periodDays: 1, asOf: null, missing0009: false, missing0010, flagOn, noRows, ...EMPTY_OVERVIEW_BASE };
  }

  const sinceDay = periodSinceDay(period, today);
  const periodDays = period === "all" ? Math.max(1, inputs.earliestDay ? daysBetween(inputs.earliestDay, today) + 1 : 1) : (sinceDay === today ? 1 : daysBetween(sinceDay!, today) + 1);

  const gasByAccount = groupGasByAccount(gasRows, sinceDay);
  const positionLatestByKey = groupPositionLatest(inputs.positionLatest ?? []);

  const accounts = snapshots
    .map((snap) =>
      buildAccount(
        snap,
        aggByAccount.get(snap.accountKey),
        gasByAccount.lifetime.get(snap.accountKey) ?? null,
        gasByAccount.periodAny.has(snap.accountKey),
        periodDays,
        ethUsd,
        positionLatestByKey,
        positionCollected,
      ),
    )
    .sort((a, b) => b.earnedToDateUsd - a.earnedToDateUsd);

  const capitalInPositionsUsd = snapshots.reduce((s, r) => s + r.lpUsd, 0);
  const feesEarnedToDateUsd = accounts.reduce((s, a) => s + a.earnedToDateUsd, 0);
  const projectedFeeCollectedUsd = accounts.reduce((s, a) => s + a.collectedToDateUsd, 0) * 0.1;
  const projectedFeeUncollectedUsd = accounts.reduce((s, a) => s + a.feesUncollectedUsd, 0) * 0.1;
  const gasRecordedAnywhere = accounts.some((a) => a.gasRecorded);

  const feesEarnedPeriodUsd = dailyAggregates.reduce((s, d) => s + d.feesUsd, 0);
  const avgLpAggregate = dailyAggregates.length ? dailyAggregates.reduce((s, d) => s + d.lpUsdSum, 0) / dailyAggregates.length : null;
  const feeAprPeriodPct = avgLpAggregate && avgLpAggregate > 0 ? (feesEarnedPeriodUsd / avgLpAggregate) * (365 / periodDays) * 100 : null;

  const gasByDay = groupGasByDay(gasRows, sinceDay);
  const gasRecordedInPeriodAnywhere = gasByDay.size > 0;
  const gasPeriodWeiTotal = [...gasByDay.values()].reduce((s, w) => s + w, 0n);
  const netYieldUnpriced = gasRecordedInPeriodAnywhere && ethUsd === null;
  const netYieldIsNet = gasRecordedInPeriodAnywhere && ethUsd !== null;
  const netYieldPeriodUsd = netYieldUnpriced ? null : netYieldIsNet ? feesEarnedPeriodUsd - weiToUsd(gasPeriodWeiTotal, ethUsd as number) : feesEarnedPeriodUsd;
  const netYieldGasEth = gasRecordedInPeriodAnywhere ? Number(gasPeriodWeiTotal) / 1e18 : null;

  const barStart = sinceDay ?? inputs.earliestDay ?? today;
  const byDayFees = new Map(dailyAggregates.map((d) => [d.day, d.feesUsd]));
  const dailyBars: YieldDailyBar[] = dayRange(barStart, today).map((day) => {
    const gasWei = gasByDay.get(day) ?? null;
    const gasUsd = gasWei !== null && ethUsd !== null ? weiToUsd(gasWei, ethUsd) : null;
    return { day, feesUsd: byDayFees.get(day) ?? 0, gasUsd };
  });

  const asOf = snapshots.reduce<string | null>((max, s) => (max === null || s.readAt > max ? s.readAt : max), null);

  return {
    filter,
    period,
    periodDays,
    asOf,
    missing0009: false,
    missing0010,
    flagOn,
    noRows: false,
    netYieldPeriodUsd,
    netYieldIsNet,
    netYieldUnpriced,
    netYieldGasEth,
    feesEarnedToDateUsd,
    feeAprPeriodPct,
    capitalInPositionsUsd,
    projectedFeeCollectedUsd,
    projectedFeeUncollectedUsd,
    dailyBars,
    gasRecordedAnywhere,
    accounts,
  };
}

/** Every open position across these snapshots, chain + token id + owning account, for the position-daily
 * lookups (yield-store.ts's fetchPositionLatest/fetchPositionLifetimeCollected). */
function openPositionsOf(snapshots: readonly AccountSnapshotRow[]): OpenPosition[] {
  return snapshots.flatMap((s) => s.positions.map((p) => ({ chainId: s.chainId, tokenId: p.tokenId, accountKey: s.accountKey })));
}

/**
 * Reads everything /ops/yield needs and builds the model. The `yield_ledger` flag (ops-flags-store.ts,
 * migration 0012) is read here, not passed in: a missing ops_flag_changes table reads as off, same "no row
 * = off" convention the store itself uses, so a console that has not applied 0012 yet still renders a
 * coherent "it's off" page instead of a second kind of error.
 */
export async function loadYieldOverview(db: D1Db | undefined, filter: AccountFilter, period: YieldPeriod, now: Date, ethUsd: number | null): Promise<YieldOverview> {
  const empty: YieldInputs = { snapshots: null, accountAggregates: null, gasRows: null, dailyAggregates: null, earliestDay: null, positionLatest: null, positionCollected: null };
  if (!db) return buildYieldOverview(empty, filter, period, now, ethUsd, false);

  const [flagStates, snapshots] = await Promise.all([currentFlagStates(db), fetchYieldAccounts(db, filter)]);
  const flagOn = flagStates?.get("yield_ledger")?.enabled ?? false;
  if (snapshots === null) return buildYieldOverview(empty, filter, period, now, ethUsd, flagOn);

  const today = utcDay(now);
  const sinceDay = periodSinceDay(period, today) ?? "";
  const accountKeys = snapshots.map((s) => s.accountKey);
  const [accountAggregates, gasRows, dailyAggregates, earliestDay] = await Promise.all([
    fetchAccountAggregates(db, filter.chainId, accountKeys, sinceDay),
    fetchGasRows(db, filter.chainId, accountKeys),
    fetchDailyAggregates(db, filter.chainId, accountKeys, sinceDay),
    fetchEarliestDay(db, filter.chainId, accountKeys),
  ]);

  const openPositions = openPositionsOf(snapshots);
  const [positionLatest, positionCollected] = await Promise.all([fetchPositionLatest(db, openPositions), fetchPositionLifetimeCollected(db, openPositions)]);

  return buildYieldOverview({ snapshots, accountAggregates, gasRows, dailyAggregates, earliestDay, positionLatest, positionCollected }, filter, period, now, ethUsd, flagOn);
}
