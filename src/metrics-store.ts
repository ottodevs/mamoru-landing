/**
 * D1 access for the /ops overview: reads of users/accounts/account_activity
 * and the only writes this Worker ever makes to D1, the `metrics_daily` rows.
 * `account_activity` and `metrics_daily` are owned by ottodevs/mamoru and may
 * not exist yet: every read returns null instead of throwing when they do not.
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";
import { type InfraReading, loadInfraReading, type InfraSources } from "./infra-cache";
import type { InfraSnapshot } from "./infra-snapshot";
import { addDays, cumulativeGrowth, type DayCount, utcDay } from "./metrics-math";

/** One row of `metrics_daily`. `captured_at` is an ISO time, or a marker for rows without chain data. */
export interface DailyRow {
  day: string;
  users: number;
  accounts: number;
  funded_accounts: number;
  active_accounts: number;
  dau: number;
  tvl_usd: number;
  idle_usdc_usd: number;
  lp_usd: number;
  positions: number;
  in_range: number;
  relayer_eth: number;
  eth_usd: number;
  captured_at: string;
}

/** Past days rebuilt from created_at: counts only, value fields left at 0. */
export const BACKFILL_MARK = "backfill";
/** Written when Base was unreachable: counts are right, value fields are not known. */
export const PARTIAL_MARK = "partial";

/** True when the row carries real on-chain values. */
export function hasChainData(row: Pick<DailyRow, "captured_at">): boolean {
  return row.captured_at !== BACKFILL_MARK && row.captured_at !== PARTIAL_MARK;
}

type WriteStatement = D1PreparedStatement & { run(): Promise<unknown> };

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cleanRow(raw: Record<string, unknown>): DailyRow {
  return {
    day: String(raw.day ?? ""),
    users: num(raw.users),
    accounts: num(raw.accounts),
    funded_accounts: num(raw.funded_accounts),
    active_accounts: num(raw.active_accounts),
    dau: num(raw.dau),
    tvl_usd: num(raw.tvl_usd),
    idle_usdc_usd: num(raw.idle_usdc_usd),
    lp_usd: num(raw.lp_usd),
    positions: num(raw.positions),
    in_range: num(raw.in_range),
    relayer_eth: num(raw.relayer_eth),
    eth_usd: num(raw.eth_usd),
    captured_at: String(raw.captured_at ?? ""),
  };
}

/** Rows from `since` on, oldest first. null when the table is missing or unreadable. */
export async function readDaily(db: D1Db, since: string): Promise<DailyRow[] | null> {
  try {
    const { results } = await db
      .prepare("SELECT * FROM metrics_daily WHERE day >= ? ORDER BY day ASC LIMIT 400")
      .bind(since)
      .all<Record<string, unknown>>();
    return results.map(cleanRow).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
  } catch {
    return null;
  }
}

export interface ActivityRead {
  /** Active accounts per day. */
  counts: Map<string, number>;
  /** First day with any activity recorded, or null when nothing was ever recorded. */
  firstDay: string | null;
}

/** Daily active accounts from `since` on. null when account_activity is missing or unreadable. */
export async function readActivity(db: D1Db, since: string): Promise<ActivityRead | null> {
  try {
    const first = await db.prepare("SELECT MIN(day) AS first_day FROM account_activity").first<{ first_day: string | null }>();
    const { results } = await db
      .prepare("SELECT day, COUNT(*) AS n FROM account_activity WHERE day >= ? GROUP BY day ORDER BY day ASC")
      .bind(since)
      .all<{ day: string; n: number }>();
    return {
      counts: new Map(results.map((r) => [String(r.day), num(r.n)])),
      firstDay: first?.first_day ? String(first.first_day) : null,
    };
  } catch {
    return null;
  }
}

/** Accounts active on one day. 0 when account_activity is missing. */
export async function countDau(db: D1Db, day: string): Promise<number> {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM account_activity WHERE day = ?").bind(day).first<{ n: number }>();
    return num(row?.n);
  } catch {
    return 0;
  }
}

export interface SignupDays {
  users: DayCount[];
  accounts: DayCount[];
}

/** New users and new accounts per UTC day, from created_at. null when unreadable. */
export async function readSignupDays(db: D1Db): Promise<SignupDays | null> {
  const perDay = async (table: "users" | "accounts"): Promise<DayCount[]> => {
    const { results } = await db
      .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM ${table} GROUP BY day ORDER BY day ASC`)
      .all<{ day: string; n: number }>();
    return results.map((r) => ({ day: String(r.day), n: num(r.n) }));
  };
  try {
    return { users: await perDay("users"), accounts: await perDay("accounts") };
  } catch {
    return null;
  }
}

/** Whether the snapshot's on-chain half can be trusted for a daily row. */
export function snapshotHasChain(snapshot: InfraSnapshot): boolean {
  return !snapshot.rpcError && !snapshot.partial && Boolean(snapshot.accounts) && !snapshot.accounts?.error;
}

/** Whether the snapshot's D1 counts were read at all. */
export function snapshotHasCounts(snapshot: InfraSnapshot): boolean {
  const a = snapshot.accounts;
  if (!a) return false;
  return !(a.error && a.totalUsers === 0 && a.totalAccounts === 0);
}

/**
 * The `metrics_daily` row for one day from an Infra snapshot.
 * funded = holds idle USDC or LP value; active = has at least one position.
 */
export function rowFromSnapshot(snapshot: InfraSnapshot, day: string, dau: number): DailyRow {
  const a = snapshot.accounts;
  const rows = a?.rows ?? [];
  const chain = snapshotHasChain(snapshot);
  return {
    day,
    users: a?.totalUsers ?? 0,
    accounts: a?.totalAccounts ?? 0,
    funded_accounts: rows.filter((r) => r.usdcIdle > 0 || r.lpUsd > 0).length,
    active_accounts: rows.filter((r) => r.positions >= 1).length,
    dau,
    tvl_usd: chain ? (a?.tvlUsd ?? 0) : 0,
    idle_usdc_usd: chain ? (a?.idleUsdcUsd ?? 0) : 0,
    lp_usd: chain ? (a?.lpUsd ?? 0) : 0,
    positions: rows.reduce((sum, r) => sum + r.positions, 0),
    in_range: rows.reduce((sum, r) => sum + r.inRange, 0),
    relayer_eth: snapshot.relayer?.ethBalance ?? 0,
    eth_usd: snapshot.ethUsd ?? 0,
    captured_at: chain ? snapshot.asOf : PARTIAL_MARK,
  };
}

const COLUMNS =
  "day, users, accounts, funded_accounts, active_accounts, dau, tvl_usd, idle_usdc_usd, lp_usd, positions, in_range, relayer_eth, eth_usd, captured_at";

/** A full capture replaces the whole row. A partial one only refreshes the counts of a row that exists. */
export function upsertSql(row: Pick<DailyRow, "captured_at">): string {
  const insert = `INSERT INTO metrics_daily (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  if (!hasChainData(row)) {
    return `${insert} ON CONFLICT(day) DO UPDATE SET users = excluded.users, accounts = excluded.accounts, dau = excluded.dau`;
  }
  return `${insert} ON CONFLICT(day) DO UPDATE SET users = excluded.users, accounts = excluded.accounts, funded_accounts = excluded.funded_accounts, active_accounts = excluded.active_accounts, dau = excluded.dau, tvl_usd = excluded.tvl_usd, idle_usdc_usd = excluded.idle_usdc_usd, lp_usd = excluded.lp_usd, positions = excluded.positions, in_range = excluded.in_range, relayer_eth = excluded.relayer_eth, eth_usd = excluded.eth_usd, captured_at = excluded.captured_at`;
}

function rowValues(row: DailyRow): unknown[] {
  return [
    row.day,
    row.users,
    row.accounts,
    row.funded_accounts,
    row.active_accounts,
    row.dau,
    row.tvl_usd,
    row.idle_usdc_usd,
    row.lp_usd,
    row.positions,
    row.in_range,
    row.relayer_eth,
    row.eth_usd,
    row.captured_at,
  ];
}

export async function upsertDaily(db: D1Db, row: DailyRow): Promise<void> {
  const stmt = db.prepare(upsertSql(row)).bind(...rowValues(row)) as WriteStatement;
  await stmt.run();
}

/** Counts-only rows for every day from the first signup up to, not including, `today`. */
export function backfillRows(signups: SignupDays, today: string): DailyRow[] {
  return cumulativeGrowth(signups.users, signups.accounts, today)
    .filter((point) => point.day < today)
    .map((point) => ({
      day: point.day,
      users: point.users,
      accounts: point.accounts,
      funded_accounts: 0,
      active_accounts: 0,
      dau: 0,
      tvl_usd: 0,
      idle_usdc_usd: 0,
      lp_usd: 0,
      positions: 0,
      in_range: 0,
      relayer_eth: 0,
      eth_usd: 0,
      captured_at: BACKFILL_MARK,
    }));
}

/** One-off: fills the past from created_at the first time metrics_daily is found empty. Returns rows written. */
export async function backfillIfEmpty(db: D1Db, today: string): Promise<number> {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM metrics_daily").first<{ n: number }>();
  if (num(existing?.n) > 0) return 0;
  const signups = await readSignupDays(db);
  if (!signups) return 0;
  const rows = backfillRows(signups, today);
  const sql = `INSERT OR IGNORE INTO metrics_daily (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const row of rows) {
    await (db.prepare(sql).bind(...rowValues(row)) as WriteStatement).run();
  }
  return rows.length;
}

export type CaptureOutcome =
  | { ok: true; row: DailyRow; backfilled: number; snapshot: InfraSnapshot }
  | { ok: false; reason: "no-db" | "no-counts" | "write-failed"; snapshot: InfraSnapshot | null };

/**
 * Computes a fresh Infra snapshot and upserts today's row. `settleYesterday`
 * recounts yesterday's DAU, which the last hourly run of that day cut short.
 * Never throws: a missing table is reported as write-failed.
 */
export async function captureDaily(
  sources: InfraSources,
  opts: {
    now?: Date;
    settleYesterday?: boolean;
    load?: (sources: InfraSources, fresh: boolean) => Promise<InfraReading>;
  } = {},
): Promise<CaptureOutcome> {
  const db = sources.db;
  if (!db) return { ok: false, reason: "no-db", snapshot: null };
  const today = utcDay(opts.now ?? new Date());
  // The row records what was read just now, even when the page falls back to an older complete reading.
  const reading = await (opts.load ?? loadInfraReading)(sources, true);
  const snapshot = reading.computed ?? reading.snapshot;
  if (!snapshotHasCounts(snapshot)) return { ok: false, reason: "no-counts", snapshot };
  const row = rowFromSnapshot(snapshot, today, await countDau(db, today));
  try {
    const backfilled = await backfillIfEmpty(db, today);
    await upsertDaily(db, row);
    if (opts.settleYesterday) {
      const yesterday = addDays(today, -1);
      const stmt = db
        .prepare("UPDATE metrics_daily SET dau = ? WHERE day = ?")
        .bind(await countDau(db, yesterday), yesterday) as WriteStatement;
      await stmt.run();
    }
    return { ok: true, row, backfilled, snapshot };
  } catch {
    return { ok: false, reason: "write-failed", snapshot };
  }
}
