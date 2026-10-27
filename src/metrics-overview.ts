/** Builds the /ops overview model from the Infra snapshot plus D1 history. The build step is pure. */

import { buildFundsMap, type FundsMap } from "./funds-map";
import { type OutsideSummary, summarizeOutside } from "./outside-base";
import { type AccountFilter, DEFAULT_FILTER, type GroupBy, usesLegacyHistory } from "./account-filter";
import type { RelayerStatus } from "./cost";
import { fetchInfraCounts, type D1Db, type InfraCounts } from "./d1-infra";
import { type AccountView, matchesFilter } from "./infra-snapshot";
import type { InfraSnapshot } from "./infra-snapshot";
import {
  addDays,
  atOrBefore,
  cumulativeGrowth,
  dauAverage,
  dauSlots,
  delta,
  type DauSlot,
  type Delta,
  funnel,
  type FunnelStep,
  type GrowthPoint,
  utcDay,
} from "./metrics-math";
import {
  type ActivityRead,
  collapseDailyV2,
  type DailyRow,
  type DailyRowV2,
  hasChainData,
  readActivity,
  readDaily,
  readDailyV2,
  readSignupDays,
  type SignupDays,
  snapshotHasChain,
  snapshotHasCounts,
} from "./metrics-store";

export const TVL_DAYS = 30;
export const DAU_DAYS = 14;
export const DELTA_DAYS = 7;

export interface Change {
  delta: Delta;
  /** The day being compared against. */
  since: string;
  /** True when `since` is exactly DELTA_DAYS ago. */
  exact: boolean;
}

export interface ValuePoint {
  day: string;
  idle: number;
  lp: number;
}

export interface GroupBreakdown {
  label: string;
  accounts: number;
  users: number;
  funded: number;
  activated: number;
  tvl: number;
  idle: number;
  lp: number;
}

export interface Overview {
  asOf: string;
  today: string;
  /** False when Base could not be read: money and position figures are not current. */
  chainOk: boolean;
  /** False when D1 could not be read: people figures are not current. */
  countsOk: boolean;
  users: number;
  accounts: number;
  funded: number;
  activated: number;
  inRangeAccounts: number;
  positions: number;
  positionsInRange: number;
  tvl: number;
  idle: number;
  lp: number;
  /** Holdings at the same addresses on Ethereum (otto/mamoru-astro#31). Separate from `tvl`, never added to it. */
  outside: OutsideSummary;
  /** Where the money is, by chain and bucket (otto/mamoru-astro#35). Same filtered rows as the figures above. */
  funds: FundsMap;
  firstSignup: string | null;
  changes: { users: Change | null; accounts: Change | null; activated: Change | null; tvl: Change | null };
  value: ValuePoint[];
  growth: GrowthPoint[];
  /** null when activity is not being recorded at all. */
  dau: DauSlot[] | null;
  dauToday: number | null;
  dauAvg: { avg: number; days: number } | null;
  funnel: FunnelStep[];
  relayer: { ethBalance: number; usd: number | null; status: RelayerStatus; canFund: number | null } | null;
  notes: string[];
  /** The filter this Overview was built with (otto/mamoru#130), so the page can render it back as the
   * current selection. */
  filter: AccountFilter;
  /** Today's live accounts split by chain or by environment; empty when filter.group is "none". */
  breakdown: GroupBreakdown[];
}

export interface OverviewInputs {
  daily: DailyRow[] | null;
  /** otto/mamoru#130: used for every filter except the legacy prod/all view (see usesLegacyHistory). */
  dailyV2?: DailyRowV2[] | null;
  activity: ActivityRead | null;
  signups: SignupDays | null;
  /** otto/mamoru#130: the filtered, uncapped users/accounts/last7d count (`fetchInfraCounts`), fetched fresh
   * on every request — never part of the cached Infra snapshot, which is shared unfiltered across every
   * filter a reader might pick. Missing (undefined or null) falls back to the uncapped growth series
   * instead of the live, on-chain `rows` (`fetchChainAccounts` caps those at 500) — except when `?account=`
   * is set, where `rows` is what the reader is actually asking to see. */
  counts?: InfraCounts | null;
}

function change(current: number, past: number | undefined, since: string | undefined, target: string): Change | null {
  if (since === undefined) return null;
  const d = delta(current, past);
  return d ? { delta: d, since, exact: since === target } : null;
}

export interface StaleNote {
  failedAt: string;
}

/** Today's live, filtered rows split by chain or by environment (otto/mamoru#130). */
function breakdownOf(rows: AccountView[], by: Exclude<GroupBy, "none">): GroupBreakdown[] {
  const groups = new Map<string, AccountView[]>();
  for (const r of rows) {
    const key = by === "chain" ? String(r.chainId) : r.env;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.entries()]
    .map(([label, rs]) => ({
      label,
      accounts: rs.length,
      users: new Set(rs.map((r) => r.userId)).size,
      funded: rs.filter((r) => r.usdcIdle > 0 || r.lpUsd > 0).length,
      activated: rs.filter((r) => r.positions >= 1).length,
      tvl: rs.reduce((s, r) => s + r.usdcIdle + r.lpUsd, 0),
      idle: rs.reduce((s, r) => s + r.usdcIdle, 0),
      lp: rs.reduce((s, r) => s + r.lpUsd, 0),
    }))
    .sort((x, y) => x.label.localeCompare(y.label));
}

export function buildOverview(snapshot: InfraSnapshot, inputs: OverviewInputs, now: Date, stale?: StaleNote, filter: AccountFilter = DEFAULT_FILTER): Overview {
  const today = utcDay(now);
  const target = addDays(today, -DELTA_DAYS);
  const a = snapshot.accounts;
  // otto/mamoru#130: every headline figure below reads this filtered set, never the raw a.rows / a.totalUsers
  // / a.totalAccounts — those are DB-wide and would mix beta and test accounts back in.
  const rows = (a?.rows ?? []).filter((r) => matchesFilter(r, filter));
  const chainOk = snapshotHasChain(snapshot);
  const countsOk = snapshotHasCounts(snapshot);
  const legacyView = usesLegacyHistory(filter);
  const dailySource: DailyRow[] = legacyView ? (inputs.daily ?? []) : collapseDailyV2(inputs.dailyV2 ?? [], filter);
  const real = dailySource.filter(hasChainData);
  const latest = real[real.length - 1];

  // Live values when Base answered; otherwise the last captured row stands in.
  const fromRow = !chainOk && latest ? latest : null;
  const funded = fromRow ? fromRow.funded_accounts : rows.filter((r) => r.usdcIdle > 0 || r.lpUsd > 0).length;
  const activated = fromRow ? fromRow.active_accounts : rows.filter((r) => r.positions >= 1).length;
  const positions = fromRow ? fromRow.positions : rows.reduce((sum, r) => sum + r.positions, 0);
  const positionsInRange = fromRow ? fromRow.in_range : rows.reduce((sum, r) => sum + r.inRange, 0);
  const inRangeAccounts = fromRow
    ? Math.min(fromRow.in_range, fromRow.active_accounts)
    : rows.filter((r) => r.inRange >= 1).length;
  const idle = fromRow ? fromRow.idle_usdc_usd : rows.reduce((s, r) => s + r.usdcIdle, 0);
  const lp = fromRow ? fromRow.lp_usd : rows.reduce((s, r) => s + r.lpUsd, 0);
  const tvl = idle + lp;

  const growth = inputs.signups ? cumulativeGrowth(inputs.signups.users, inputs.signups.accounts, today) : [];
  const lastGrowth = growth[growth.length - 1];
  // otto/mamoru#130: a free-text ?account= narrows everything else below (funded/activated/tvl/breakdown)
  // to the matching rows, so the headline users/accounts and the funnel's "Signed up" step (which reuses
  // `users`) must scope the same way, or the funnel reads as a contradiction (fewer funded than signed up
  // looks impossible once "signed up" silently means the whole environment instead of the match). `rows`
  // is on-chain and capped at 500, but a free-text lookup is inherently narrow — it is meant to find one
  // account, not to stand in for a cohort — so the cap is not the concern here that it is below.
  const users = filter.account
    ? new Set(rows.map((r) => r.userId)).size
    : inputs.counts
      ? inputs.counts.totalUsers
      : (lastGrowth?.users ?? 0);
  const accounts = filter.account ? rows.length : inputs.counts ? inputs.counts.totalAccounts : (lastGrowth?.accounts ?? 0);
  const breakdown = filter.group === "none" ? [] : breakdownOf(rows, filter.group);

  const value: ValuePoint[] = real
    .filter((r) => r.day >= addDays(today, -(TVL_DAYS - 1)) && r.day < today)
    .map((r) => ({ day: r.day, idle: r.idle_usdc_usd, lp: r.lp_usd }));
  const todayRow = real.find((r) => r.day === today);
  if (chainOk) value.push({ day: today, idle, lp });
  else if (todayRow) value.push({ day: today, idle: todayRow.idle_usdc_usd, lp: todayRow.lp_usd });

  const pastGrowth = atOrBefore(growth, target);
  const pastReal = atOrBefore(real, target);

  const dau = inputs.activity
    ? dauSlots(inputs.activity.counts, inputs.activity.firstDay, today, DAU_DAYS)
    : null;

  const notes: string[] = [];
  if (!a) notes.push("The accounts database is not connected.");
  else if (!countsOk) notes.push("The accounts database could not be read.");
  if (stale) notes.push("Showing the last complete reading. A fresh read failed just now.");
  if (snapshot.partial) {
    const n = snapshot.partial.unreadAccounts;
    const what = n > 0 ? `${n} ${n === 1 ? "account" : "accounts"} could not be read` : "Prices could not be read";
    notes.push(fromRow ? `${what}. Money figures are from the last capture.` : `${what}. Money figures are incomplete.`);
  }
  if (snapshot.rpcError) notes.push(fromRow ? "Base is unreachable right now. Money figures are from the last capture." : "Base is unreachable right now. Money figures are not shown.");
  else if (a?.error && countsOk) notes.push(a.error);

  const relayer = snapshot.relayer
    ? {
        ethBalance: snapshot.relayer.ethBalance,
        usd: snapshot.relayer.usd,
        status: snapshot.relayer.status,
        canFund: snapshot.cost ? snapshot.cost.accountsFunded : null,
      }
    : null;

  return {
    asOf: snapshot.asOf,
    today,
    chainOk,
    countsOk,
    users,
    accounts,
    funded,
    activated,
    inRangeAccounts,
    positions,
    positionsInRange,
    tvl,
    idle,
    lp,
    outside: summarizeOutside(rows),
    funds: buildFundsMap(snapshot, rows),
    firstSignup: growth[0]?.day ?? null,
    changes: {
      users: change(users, pastGrowth?.users, pastGrowth?.day, target),
      accounts: change(accounts, pastGrowth?.accounts, pastGrowth?.day, target),
      activated: change(activated, pastReal?.active_accounts, pastReal?.day, target),
      tvl: change(tvl, pastReal?.tvl_usd, pastReal?.day, target),
    },
    value,
    growth,
    dau,
    dauToday: dau ? (dau[dau.length - 1]?.n ?? null) : null,
    dauAvg: dau ? dauAverage(dau, 7) : null,
    funnel: funnel([
      { id: "signed", label: "Signed up", count: users },
      { id: "funded", label: "Funded", count: funded },
      { id: "activated", label: "Activated", count: activated },
      { id: "range", label: "In range", count: inRangeAccounts },
    ]),
    relayer,
    notes,
    filter,
    breakdown,
  };
}

/** Reads the history the overview needs. Each read degrades on its own. */
export async function loadOverview(
  db: D1Db | undefined,
  snapshot: InfraSnapshot,
  now = new Date(),
  stale?: StaleNote,
  filter: AccountFilter = DEFAULT_FILTER,
): Promise<Overview> {
  const today = utcDay(now);
  if (!db) return buildOverview(snapshot, { daily: null, dailyV2: null, activity: null, signups: null, counts: null }, now, stale, filter);
  const legacyView = usesLegacyHistory(filter);
  const scope = { env: filter.env, chainId: filter.chainId };
  const [daily, dailyV2, activity, signups, counts] = await Promise.all([
    legacyView ? readDaily(db, addDays(today, -(TVL_DAYS + DELTA_DAYS))) : Promise.resolve(null),
    legacyView ? Promise.resolve(null) : readDailyV2(db, addDays(today, -(TVL_DAYS + DELTA_DAYS))),
    readActivity(db, addDays(today, -(DAU_DAYS - 1)), scope),
    readSignupDays(db, scope),
    fetchInfraCounts(db, scope).catch(() => null),
  ]);
  return buildOverview(snapshot, { daily, dailyV2, activity, signups, counts }, now, stale, filter);
}
