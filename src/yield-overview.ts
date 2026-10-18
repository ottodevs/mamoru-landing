/**
 * Builds the /ops/yield model from yield-store.ts's raw D1 rows, plus the loader that reads them. The build
 * step (buildYieldOverview and below) is pure, same split as metrics-overview.ts, so every rule here is
 * testable without a database. Per-account figures match apps/mamoru-app/src/api/accounts/yield.ts's
 * loadYieldLedger exactly (earned so far = accrued + lifetime collected; value vs hold = this account's open
 * positions' value + accrued - hold baseline, read on the account's own current day) — otto/mamoru-astro#20's
 * acceptance criteria is that this page's numbers match that endpoint, so the formulas are ported, not
 * reinvented.
 */

import type { AccountFilter } from "./account-filter";
import type { D1Db } from "./d1-infra";
import { addDays, dayRange, daysBetween, utcDay } from "./metrics-math";
import { currentFlagStates } from "./ops-flags-store";
import { fetchAccountDaily, fetchPositionDaily, fetchYieldAccounts, type AccountSnapshotRow, type DailyLedgerRow, type PositionDailyRow, type PositionSnapshot } from "./yield-store";

export type YieldPeriod = "24h" | "7d" | "30d" | "all";

export const YIELD_PERIODS: readonly YieldPeriod[] = ["24h", "7d", "30d", "all"];

export function parseYieldPeriod(raw: string | null | undefined): YieldPeriod {
  return raw === "24h" || raw === "30d" || raw === "all" ? raw : "7d";
}

const dayOf = (iso: string): string => iso.slice(0, 10);

function sumWei(values: readonly (string | null)[]): { total: bigint; any: boolean } {
  let total = 0n;
  let any = false;
  for (const v of values) {
    if (v === null) continue;
    try {
      total += BigInt(v);
      any = true;
    } catch {
      // Not a parseable integer: skipped rather than thrown, same "degrade, never crash the page" rule as
      // every other D1 read in this Worker.
    }
  }
  return { total, any };
}

/** Wei of the native gas token to USD. Safe for realistic lifetime gas totals (well under 2^53). */
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
  /** This position's own current day. Null when migration 0010 is missing or that day has no row. */
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
  gasRecorded: boolean;
  netToDateUsd: number;
  feesEarnedPeriodUsd: number;
  gasRecordedInPeriod: boolean;
  aprPeriodPct: number | null;
  /** Null when migration 0010 is missing or there is no readable row for this account's current day. */
  vsHoldUsd: number | null;
  positionsInRange: number;
  positionsTotal: number;
  lastReadIso: string | null;
  positions: YieldPositionView[];
}

export interface YieldDailyBar {
  day: string;
  feesUsd: number;
  /** Null when gas was not recorded on this day; the chart only ever draws the gas series when at least one
   * day in the period has a value. */
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
  netYieldPeriodUsd: number;
  /** True when the hero figure above is a real net (gas known); false means it is fees only. */
  netYieldIsNet: boolean;
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
  daily: DailyLedgerRow[] | null;
  /** Null when yield_ledger_position_daily could not be read: migration 0010 is not applied. */
  positionDaily: PositionDailyRow[] | null;
}

const EMPTY_OVERVIEW_BASE = {
  netYieldPeriodUsd: 0,
  netYieldIsNet: false,
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

function buildPosition(p: PositionSnapshot, accountKey: string, day: string, positionDaily: readonly PositionDailyRow[] | null): YieldPositionView {
  if (positionDaily === null) {
    return { tokenId: p.tokenId, pool: p.pool, inRange: p.inRange, valueUsd: p.valueUsd, accruedFeesUsd: p.feesUsd, collectedUsd: null, vsHoldUsd: null };
  }
  const rows = positionDaily.filter((r) => r.accountKey === accountKey && r.tokenId === p.tokenId);
  const collected = rows.reduce((s, r) => s + (r.collectedUsd ?? 0), 0);
  const anyCollected = rows.some((r) => r.collectedUsd !== null);
  const today = rows.find((r) => r.day === day);
  const vsHoldUsd = today ? today.valueUsd + today.accruedUsdClose - today.holdValueUsd : null;
  return {
    tokenId: p.tokenId,
    pool: p.pool,
    inRange: p.inRange,
    valueUsd: p.valueUsd,
    accruedFeesUsd: p.feesUsd,
    collectedUsd: anyCollected ? collected : null,
    vsHoldUsd,
  };
}

function buildAccount(
  snap: AccountSnapshotRow,
  daily: readonly DailyLedgerRow[],
  positionDaily: readonly PositionDailyRow[] | null,
  sinceDay: string | null,
  periodDays: number,
  ethUsd: number | null,
): YieldAccountView {
  const mine = daily.filter((d) => d.accountKey === snap.accountKey);
  const collectedToDateUsd = mine.reduce((s, d) => s + (d.collectedUsd ?? 0), 0);
  const { total: gasToDateWei, any: gasRecorded } = sumWei(mine.map((d) => d.gasPaidWei));
  const earnedToDateUsd = snap.feesUsd + collectedToDateUsd;
  const gasToDateUsd = gasRecorded && ethUsd !== null ? weiToUsd(gasToDateWei, ethUsd) : 0;
  const netToDateUsd = earnedToDateUsd - gasToDateUsd;

  const period = mine.filter((d) => sinceDay === null || d.day >= sinceDay);
  const feesEarnedPeriodUsd = period.reduce((s, d) => s + (d.feesCloseUsd - d.feesOpenUsd + (d.collectedUsd ?? 0)), 0);
  const { any: gasRecordedInPeriod } = sumWei(period.map((d) => d.gasPaidWei));
  const avgLpPeriod = period.length ? period.reduce((s, d) => s + d.lpCloseUsd, 0) / period.length : null;
  const aprPeriodPct = avgLpPeriod && avgLpPeriod > 0 ? (feesEarnedPeriodUsd / avgLpPeriod) * (365 / periodDays) * 100 : null;

  const day = dayOf(snap.readAt);
  const positions = snap.positions.map((p) => buildPosition(p, snap.accountKey, day, positionDaily));
  const openTokenIds = new Set(snap.positions.map((p) => p.tokenId));
  let vsHoldUsd: number | null = null;
  if (positionDaily !== null && openTokenIds.size > 0) {
    const rows = positionDaily.filter((r) => r.accountKey === snap.accountKey && r.day === day && openTokenIds.has(r.tokenId));
    if (rows.length) vsHoldUsd = rows.reduce((s, r) => s + (r.valueUsd + r.accruedUsdClose - r.holdValueUsd), 0);
  }

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

export function buildYieldOverview(inputs: YieldInputs, filter: AccountFilter, period: YieldPeriod, now: Date, ethUsd: number | null, flagOn: boolean): YieldOverview {
  const today = utcDay(now);
  const missing0009 = inputs.snapshots === null || inputs.daily === null;
  if (missing0009) {
    return { filter, period, periodDays: 1, asOf: null, missing0009: true, missing0010: inputs.positionDaily === null, flagOn, noRows: false, ...EMPTY_OVERVIEW_BASE };
  }
  const snapshots = inputs.snapshots!;
  const daily = inputs.daily!;
  const missing0010 = inputs.positionDaily === null;
  const noRows = flagOn && snapshots.length === 0;
  if (!flagOn || noRows) {
    return { filter, period, periodDays: 1, asOf: null, missing0009: false, missing0010, flagOn, noRows, ...EMPTY_OVERVIEW_BASE };
  }

  const earliestDay = daily.reduce<string | null>((min, d) => (min === null || d.day < min ? d.day : min), null);
  const sinceDay = periodSinceDay(period, today);
  const periodDays = period === "all" ? Math.max(1, earliestDay ? daysBetween(earliestDay, today) + 1 : 1) : (sinceDay === today ? 1 : daysBetween(sinceDay!, today) + 1);

  const accounts = snapshots
    .map((snap) => buildAccount(snap, daily, inputs.positionDaily, sinceDay, periodDays, ethUsd))
    .sort((a, b) => b.earnedToDateUsd - a.earnedToDateUsd);

  const capitalInPositionsUsd = snapshots.reduce((s, r) => s + r.lpUsd, 0);
  const feesEarnedToDateUsd = accounts.reduce((s, a) => s + a.earnedToDateUsd, 0);
  const projectedFeeCollectedUsd = accounts.reduce((s, a) => s + a.collectedToDateUsd, 0) * 0.1;
  const projectedFeeUncollectedUsd = accounts.reduce((s, a) => s + a.feesUncollectedUsd, 0) * 0.1;
  const gasRecordedAnywhere = accounts.some((a) => a.gasRecorded);

  const scopedDaily = daily.filter((d) => snapshots.some((s) => s.accountKey === d.accountKey));
  const periodRows = scopedDaily.filter((d) => sinceDay === null || d.day >= sinceDay);
  const byDay = new Map<string, { fees: number; lp: number; lpN: number; gasWei: bigint[]; gasAny: boolean }>();
  for (const row of periodRows) {
    const bucket = byDay.get(row.day) ?? { fees: 0, lp: 0, lpN: 0, gasWei: [], gasAny: false };
    bucket.fees += row.feesCloseUsd - row.feesOpenUsd + (row.collectedUsd ?? 0);
    bucket.lp += row.lpCloseUsd;
    bucket.lpN += 1;
    if (row.gasPaidWei !== null) {
      bucket.gasAny = true;
      try {
        bucket.gasWei.push(BigInt(row.gasPaidWei));
      } catch {
        // skipped, same tolerance as sumWei above
      }
    }
    byDay.set(row.day, bucket);
  }
  const feesEarnedPeriodUsd = [...byDay.values()].reduce((s, b) => s + b.fees, 0);
  const daysWithLp = [...byDay.values()].filter((b) => b.lpN > 0);
  const avgLpAggregate = daysWithLp.length ? daysWithLp.reduce((s, b) => s + b.lp, 0) / daysWithLp.length : null;
  const feeAprPeriodPct = avgLpAggregate && avgLpAggregate > 0 ? (feesEarnedPeriodUsd / avgLpAggregate) * (365 / periodDays) * 100 : null;
  const gasRecordedInPeriodAnywhere = [...byDay.values()].some((b) => b.gasAny);
  const gasPeriodWeiTotal = [...byDay.values()].reduce((s, b) => s + b.gasWei.reduce((x, y) => x + y, 0n), 0n);
  const netYieldIsNet = gasRecordedInPeriodAnywhere && ethUsd !== null;
  const netYieldPeriodUsd = netYieldIsNet ? feesEarnedPeriodUsd - weiToUsd(gasPeriodWeiTotal, ethUsd as number) : feesEarnedPeriodUsd;

  const barStart = sinceDay ?? earliestDay ?? today;
  const dailyBars: YieldDailyBar[] = dayRange(barStart, today).map((day) => {
    const bucket = byDay.get(day);
    const gasUsd = bucket?.gasAny && ethUsd !== null ? weiToUsd(bucket.gasWei.reduce((x, y) => x + y, 0n), ethUsd) : null;
    return { day, feesUsd: bucket?.fees ?? 0, gasUsd };
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

/**
 * Reads everything /ops/yield needs and builds the model. The `yield_ledger` flag (ops-flags-store.ts,
 * migration 0012) is read here, not passed in: a missing ops_flag_changes table reads as off, same "no row
 * = off" convention the store itself uses, so a console that has not applied 0012 yet still renders a
 * coherent "it's off" page instead of a second kind of error.
 */
export async function loadYieldOverview(db: D1Db | undefined, filter: AccountFilter, period: YieldPeriod, now: Date, ethUsd: number | null): Promise<YieldOverview> {
  if (!db) return buildYieldOverview({ snapshots: null, daily: null, positionDaily: null }, filter, period, now, ethUsd, false);
  const [flagStates, snapshots] = await Promise.all([currentFlagStates(db), fetchYieldAccounts(db, filter)]);
  const flagOn = flagStates?.get("yield_ledger")?.enabled ?? false;
  if (snapshots === null) {
    return buildYieldOverview({ snapshots: null, daily: null, positionDaily: null }, filter, period, now, ethUsd, flagOn);
  }
  const accountKeys = snapshots.map((s) => s.accountKey);
  const [daily, positionDaily] = await Promise.all([fetchAccountDaily(db, filter.chainId, accountKeys), fetchPositionDaily(db, filter.chainId, accountKeys)]);
  return buildYieldOverview({ snapshots, daily, positionDaily }, filter, period, now, ethUsd, flagOn);
}
