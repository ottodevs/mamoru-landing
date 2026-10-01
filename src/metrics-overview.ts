/** Builds the /ops overview model from the Infra snapshot plus D1 history. The build step is pure. */

import type { RelayerStatus } from "./cost";
import type { D1Db } from "./d1-infra";
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
  type DailyRow,
  hasChainData,
  readActivity,
  readDaily,
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
}

export interface OverviewInputs {
  daily: DailyRow[] | null;
  activity: ActivityRead | null;
  signups: SignupDays | null;
}

function change(current: number, past: number | undefined, since: string | undefined, target: string): Change | null {
  if (since === undefined) return null;
  const d = delta(current, past);
  return d ? { delta: d, since, exact: since === target } : null;
}

export function buildOverview(snapshot: InfraSnapshot, inputs: OverviewInputs, now: Date): Overview {
  const today = utcDay(now);
  const target = addDays(today, -DELTA_DAYS);
  const a = snapshot.accounts;
  const rows = a?.rows ?? [];
  const chainOk = snapshotHasChain(snapshot);
  const countsOk = snapshotHasCounts(snapshot);
  const real = (inputs.daily ?? []).filter(hasChainData);
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
  const idle = fromRow ? fromRow.idle_usdc_usd : (a?.idleUsdcUsd ?? 0);
  const lp = fromRow ? fromRow.lp_usd : (a?.lpUsd ?? 0);
  const tvl = idle + lp;

  const growth = inputs.signups ? cumulativeGrowth(inputs.signups.users, inputs.signups.accounts, today) : [];
  const lastGrowth = growth[growth.length - 1];
  const users = countsOk ? (a?.totalUsers ?? 0) : (lastGrowth?.users ?? 0);
  const accounts = countsOk ? (a?.totalAccounts ?? 0) : (lastGrowth?.accounts ?? 0);

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
  };
}

/** Reads the history the overview needs. Each read degrades on its own. */
export async function loadOverview(db: D1Db | undefined, snapshot: InfraSnapshot, now = new Date()): Promise<Overview> {
  const today = utcDay(now);
  if (!db) return buildOverview(snapshot, { daily: null, activity: null, signups: null }, now);
  const [daily, activity, signups] = await Promise.all([
    readDaily(db, addDays(today, -(TVL_DAYS + DELTA_DAYS))),
    readActivity(db, addDays(today, -(DAU_DAYS - 1))),
    readSignupDays(db),
  ]);
  return buildOverview(snapshot, { daily, activity, signups }, now);
}
