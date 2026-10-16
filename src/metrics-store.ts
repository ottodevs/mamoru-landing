/**
 * D1 access for the /ops overview: reads of users/accounts/account_activity
 * and the only writes this Worker ever makes to D1, the `metrics_daily` rows.
 * `account_activity` and `metrics_daily` are owned by ottodevs/mamoru and may
 * not exist yet: every read returns null instead of throwing when they do not.
 */

import { accountScopeSql, type AccountScopeFilter } from "./account-filter";
import type { D1Db, D1PreparedStatement } from "./d1-infra";
import { type InfraReading, loadInfraReading, type InfraSources } from "./infra-cache";
import type { AccountView, InfraSnapshot } from "./infra-snapshot";
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

/** The exact unfiltered query `readActivity` always ran, before otto/mamoru#130. */
async function readActivityUnfiltered(db: D1Db, since: string): Promise<ActivityRead | null> {
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

/**
 * Daily active accounts from `since` on. null when account_activity is missing or unreadable.
 * Without `filter`: the exact unfiltered query this function has always run. With it (otto/mamoru#130):
 * joined against `accounts` and scoped by env/chain_id/is_test. If that join fails because the scoping
 * columns are not on this D1 yet, it falls back to the unfiltered query above — safe only because a D1
 * without those columns has no beta or test accounts to mislabel yet; once the migration lands, this
 * fallback never fires again.
 */
export async function readActivity(db: D1Db, since: string, filter?: AccountScopeFilter): Promise<ActivityRead | null> {
  if (!filter) return readActivityUnfiltered(db, since);
  const { sql, params } = accountScopeSql(filter, "acc");
  const where = sql ? `AND ${sql}` : "";
  try {
    const first = await db
      .prepare(`SELECT MIN(aa.day) AS first_day FROM account_activity aa JOIN accounts acc ON acc.account_key = aa.account_key WHERE 1 = 1 ${where}`)
      .bind(...params)
      .first<{ first_day: string | null }>();
    const { results } = await db
      .prepare(
        `SELECT aa.day AS day, COUNT(*) AS n FROM account_activity aa JOIN accounts acc ON acc.account_key = aa.account_key
         WHERE aa.day >= ? ${where} GROUP BY aa.day ORDER BY aa.day ASC`,
      )
      .bind(since, ...params)
      .all<{ day: string; n: number }>();
    return {
      counts: new Map(results.map((r) => [String(r.day), num(r.n)])),
      firstDay: first?.first_day ? String(first.first_day) : null,
    };
  } catch {
    return readActivityUnfiltered(db, since);
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

/** The exact unfiltered query `readSignupDays` always ran, before otto/mamoru#130. */
async function readSignupDaysUnfiltered(db: D1Db): Promise<SignupDays | null> {
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

/**
 * New users and new accounts per UTC day, from created_at. null when unreadable.
 * Without `filter`: the exact unfiltered query this function has always run. With it (otto/mamoru#130): both
 * series come from `accounts`, scoped by env/chain_id/is_test — `users` becomes "distinct users with a
 * matching account" per day, since the `users` table carries no environment of its own. A user's day is
 * their *earliest* matching account's created_at: onboarding refuses a second account for a session that
 * already has one (otto/mamoru#6), so one user has at most one account today, but counting by MIN avoids
 * ever attributing the same user to two different days if that ever changes. Falls back to the unfiltered
 * query when the scoping columns are not on this D1 yet — safe only because there is nothing to mislabel
 * before the migration lands.
 */
export async function readSignupDays(db: D1Db, filter?: AccountScopeFilter): Promise<SignupDays | null> {
  if (!filter) return readSignupDaysUnfiltered(db);
  const { sql, params } = accountScopeSql(filter, "accounts");
  const where = sql ? `WHERE ${sql}` : "";
  const toDayCounts = (rows: { day: string; n: number }[]) => rows.map((r) => ({ day: String(r.day), n: num(r.n) }));
  try {
    const [accountsRows, usersRows] = await Promise.all([
      db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM accounts ${where} GROUP BY day ORDER BY day ASC`).bind(...params).all<{ day: string; n: number }>(),
      db
        .prepare(
          `SELECT substr(first_created_at, 1, 10) AS day, COUNT(*) AS n FROM (
             SELECT MIN(created_at) AS first_created_at FROM accounts ${where} GROUP BY user_id
           ) GROUP BY day ORDER BY day ASC`,
        )
        .bind(...params)
        .all<{ day: string; n: number }>(),
    ]);
    return { users: toDayCounts(usersRows.results), accounts: toDayCounts(accountsRows.results) };
  } catch {
    return readSignupDaysUnfiltered(db);
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

/** One `metrics_daily_v2` row: `metrics_daily`'s fields, keyed additionally by chain and environment (otto/mamoru#130). */
export interface DailyRowV2 extends DailyRow {
  chain_id: number;
  env: string;
}

function cleanRowV2(raw: Record<string, unknown>): DailyRowV2 {
  return { ...cleanRow(raw), chain_id: num(raw.chain_id), env: String(raw.env ?? "") };
}

/** Rows from `since` on, oldest first. null when the table is missing or unreadable (otto/mamoru#130). */
export async function readDailyV2(db: D1Db, since: string): Promise<DailyRowV2[] | null> {
  try {
    const { results } = await db
      .prepare("SELECT * FROM metrics_daily_v2 WHERE day >= ? ORDER BY day ASC LIMIT 1600")
      .bind(since)
      .all<Record<string, unknown>>();
    return results.map(cleanRowV2).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
  } catch {
    return null;
  }
}

/**
 * Sums `metrics_daily_v2` rows matching an env/chain filter into one `metrics_daily`-shaped point per day
 * (otto/mamoru#130). Nothing is summed for `env: "test"`: test accounts are excluded from `metrics_daily_v2`
 * entirely at write time (see `rowsFromSnapshotByGroup`), so there is no test-only history to show.
 *
 * `users` and `accounts` add the matching groups' counts arithmetically, which is exact as long as no real
 * person holds accounts in two of the groups being summed at once. Two different envs can never collide
 * (app.mamoru.lol and beta.mamoru.lol mint a fresh user per hostname), but two chains could, once a second
 * chain exists and `filter.chainId === "all"` sums across them: a user with accounts on two chains would be
 * counted twice. Not reachable today — Base is the only chain — and left as a known gap rather than fixed
 * here, since fixing it needs per-user data this table does not carry.
 */
export function collapseDailyV2(rows: DailyRowV2[], filter: AccountScopeFilter): DailyRow[] {
  if (filter.env === "test") return [];
  const matches = rows.filter(
    (r) => (filter.env === "all" || r.env === filter.env) && (filter.chainId === "all" || r.chain_id === filter.chainId),
  );
  const byDay = new Map<string, DailyRow>();
  for (const r of matches) {
    const acc = byDay.get(r.day);
    if (!acc) {
      byDay.set(r.day, { ...r });
      continue;
    }
    acc.users += r.users;
    acc.accounts += r.accounts;
    acc.funded_accounts += r.funded_accounts;
    acc.active_accounts += r.active_accounts;
    acc.dau += r.dau;
    acc.tvl_usd += r.tvl_usd;
    acc.idle_usdc_usd += r.idle_usdc_usd;
    acc.lp_usd += r.lp_usd;
    acc.positions += r.positions;
    acc.in_range += r.in_range;
    // The relayer is one wallet shared by every group: summing it would double count, so the last group wins.
    acc.relayer_eth = r.relayer_eth;
    acc.eth_usd = r.eth_usd;
    if (!hasChainData(acc) || !hasChainData(r)) acc.captured_at = PARTIAL_MARK;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * One `metrics_daily_v2` row per (chain, env) present among the snapshot's accounts, same day, excluding
 * test accounts entirely (otto/mamoru#130). `dauOf` supplies each group's DAU (see `countDauByGroup`).
 */
export function rowsFromSnapshotByGroup(snapshot: InfraSnapshot, day: string, dauOf: (chainId: number, env: string) => number): DailyRowV2[] {
  const a = snapshot.accounts;
  const chain = snapshotHasChain(snapshot);
  const groups = new Map<string, AccountView[]>();
  for (const r of a?.rows ?? []) {
    if (r.isTest) continue;
    const key = `${r.chainId}:${r.env}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: DailyRowV2[] = [];
  for (const [key, groupRows] of groups) {
    const [chainIdPart, env] = key.split(":") as [string, string];
    const chainId = Number(chainIdPart);
    out.push({
      day,
      chain_id: chainId,
      env,
      users: new Set(groupRows.map((r) => r.userId)).size,
      accounts: groupRows.length,
      funded_accounts: groupRows.filter((r) => r.usdcIdle > 0 || r.lpUsd > 0).length,
      active_accounts: groupRows.filter((r) => r.positions >= 1).length,
      dau: dauOf(chainId, env),
      tvl_usd: chain ? groupRows.reduce((s, r) => s + r.usdcIdle + r.lpUsd, 0) : 0,
      idle_usdc_usd: chain ? groupRows.reduce((s, r) => s + r.usdcIdle, 0) : 0,
      lp_usd: chain ? groupRows.reduce((s, r) => s + r.lpUsd, 0) : 0,
      positions: groupRows.reduce((s, r) => s + r.positions, 0),
      in_range: groupRows.reduce((s, r) => s + r.inRange, 0),
      relayer_eth: snapshot.relayer?.ethBalance ?? 0,
      eth_usd: snapshot.ethUsd ?? 0,
      captured_at: chain ? snapshot.asOf : PARTIAL_MARK,
    });
  }
  return out;
}

/** Each (chain, env) group's active-account count for one day, from `account_activity` joined to `accounts`,
 * excluding test accounts. Empty when either table or the scoping columns are not readable. */
export async function countDauByGroup(db: D1Db, day: string): Promise<Map<string, number>> {
  try {
    const { results } = await db
      .prepare(
        `SELECT acc.chain_id AS chain_id, acc.env AS env, COUNT(*) AS n FROM account_activity aa
         JOIN accounts acc ON acc.account_key = aa.account_key WHERE aa.day = ? AND acc.is_test = 0
         GROUP BY acc.chain_id, acc.env`,
      )
      .bind(day)
      .all<{ chain_id: number; env: string; n: number }>();
    return new Map(results.map((r) => [`${num(r.chain_id)}:${String(r.env)}`, num(r.n)]));
  } catch {
    return new Map();
  }
}

const COLUMNS_V2 =
  "day, chain_id, env, users, accounts, funded_accounts, active_accounts, dau, tvl_usd, idle_usdc_usd, lp_usd, positions, in_range, relayer_eth, eth_usd, captured_at";

/** Same replace-vs-refresh split as `upsertSql`, keyed by (day, chain_id, env). */
export function upsertSqlV2(row: Pick<DailyRowV2, "captured_at">): string {
  const insert = `INSERT INTO metrics_daily_v2 (${COLUMNS_V2}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  if (!hasChainData(row)) {
    return `${insert} ON CONFLICT(day, chain_id, env) DO UPDATE SET users = excluded.users, accounts = excluded.accounts, dau = excluded.dau`;
  }
  return `${insert} ON CONFLICT(day, chain_id, env) DO UPDATE SET users = excluded.users, accounts = excluded.accounts, funded_accounts = excluded.funded_accounts, active_accounts = excluded.active_accounts, dau = excluded.dau, tvl_usd = excluded.tvl_usd, idle_usdc_usd = excluded.idle_usdc_usd, lp_usd = excluded.lp_usd, positions = excluded.positions, in_range = excluded.in_range, relayer_eth = excluded.relayer_eth, eth_usd = excluded.eth_usd, captured_at = excluded.captured_at`;
}

function rowValuesV2(row: DailyRowV2): unknown[] {
  return [
    row.day,
    row.chain_id,
    row.env,
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

/** Best-effort: a D1 without `metrics_daily_v2` yet (the coordinator has not applied otto/mamoru#130's
 * migration) fails silently here so the `metrics_daily` write beside it still lands. */
export async function upsertDailyV2(db: D1Db, row: DailyRowV2): Promise<void> {
  try {
    await (db.prepare(upsertSqlV2(row)).bind(...rowValuesV2(row)) as WriteStatement).run();
  } catch {
    // Not created on this D1 yet; nothing else depends on this write succeeding today.
  }
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
    // otto/mamoru#130: the same capture, broken down by (chain, env), excluding test accounts. Best-effort
    // (upsertDailyV2 swallows a missing table) so a D1 without the migration applied yet still gets its
    // metrics_daily row above. Does not settle yesterday's DAU per group; see rowsFromSnapshotByGroup's caller.
    const dauMap = await countDauByGroup(db, today);
    for (const groupRow of rowsFromSnapshotByGroup(snapshot, today, (chainId, env) => dauMap.get(`${chainId}:${env}`) ?? 0)) {
      await upsertDailyV2(db, groupRow);
    }
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
