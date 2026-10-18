/**
 * D1 access for /ops/yield (otto/mamoru-astro#20). Schema owned by ottodevs/mamoru: account_snapshot_latest
 * and account_daily (migrations/d1/0009_account_snapshots.sql, otto/mamoru#136) and
 * yield_ledger_position_daily (migrations/d1/0010_yield_ledger.sql, otto/mamoru#129). Read-only, additive
 * only elsewhere in this Worker, same rule as d1-infra.ts and metrics-store.ts. Every USD column on these
 * three tables is raw USDC base units (6 decimals) as INTEGER, per both migrations' header comments; every
 * read below divides by 1e6 so nothing downstream has to remember the scale.
 *
 * Every USDC-scaled sum here is computed in SQL (GROUP BY), never by capping a row list and reducing it in
 * JS: a day's worth of history per account is unbounded in principle (years of account_daily rows), and a
 * LIMIT on the rows feeding a SUM would silently under-count an old or active account instead of refusing or
 * degrading — exactly the kind of wrong-not-missing number this console must never show (code review,
 * otto/mamoru-astro#20 PR #10). The one exception is `gas_paid_wei`: TEXT, not USDC-scaled, so it is fetched
 * (sparse rows only, `IS NOT NULL`, no day bound) and summed with BigInt in the caller instead of SQL SUM,
 * never cast through a float64. The only LIMIT left anywhere in this file bounds how many *accounts* (or
 * distinct positions) are displayed, applied after every filter, never the rows a total is built from.
 */

import { accountScopeSql, type AccountFilter } from "./account-filter";
import type { D1Db } from "./d1-infra";

const USDC = 1_000_000;

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/** Escapes `%` and `_` so a free-text search term can't accidentally use SQL LIKE wildcards. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type PositionSnapshot = {
  tokenId: number;
  pool: string;
  inRange: boolean;
  /** Position principal, current value. */
  valueUsd: number;
  /** Accrued, uncollected fees right now. */
  feesUsd: number;
};

export type AccountSnapshotRow = {
  chainId: number;
  address: string;
  accountKey: string;
  /** From `accounts.env` (otto/mamoru#130), not account_snapshot_latest's own column, which the writer
   * still sets to 'unknown' on every row. */
  env: string;
  isTest: boolean;
  readAt: string;
  idleUsd: number;
  lpUsd: number;
  feesUsd: number;
  totalUsd: number;
  positions: PositionSnapshot[];
};

type RawSnapshot = {
  chain_id: number;
  address: string;
  account_key: string;
  acc_env: string;
  is_test: number;
  read_at: string;
  idle_usdc: number;
  lp_usdc: number;
  fees_usdc: number;
  total_usdc: number;
  positions_json: string;
};

/**
 * positions_json (written by apps/mamoru-app/src/api/yield-ledger.ts's writeAccountSnapshot) carries
 * tokenId/valueUsdc/feesUsdc/owedUsdc as decimal strings, matching the wire types this Worker does not
 * decode as numbers until here (a uint256 fee growth and uint128 liquidity are not always safe as a JS
 * number, PositionWire's own comment; valueUsdc/feesUsdc are USDC-scaled and safe once divided by 1e6).
 */
function parsePositions(json: string): PositionSnapshot[] {
  try {
    const arr = JSON.parse(json) as Array<{ tokenId?: unknown; pool?: unknown; inRange?: unknown; valueUsdc?: unknown; feesUsdc?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({
        tokenId: Number(p.tokenId),
        pool: String(p.pool ?? ""),
        inRange: Boolean(p.inRange),
        valueUsd: Number(p.valueUsdc) / USDC,
        feesUsd: Number(p.feesUsdc) / USDC,
      }))
      .filter((p) => Number.isFinite(p.tokenId) && Number.isFinite(p.valueUsd) && Number.isFinite(p.feesUsd));
  } catch {
    return [];
  }
}

/**
 * Every account_snapshot_latest row in scope: env/chain/is_test from a join against `accounts` (otto/mamoru#130's
 * accountScopeSql, same as fetchInfraCounts in d1-infra.ts) and the free-text `?account=` term, both in the
 * SQL WHERE, bound params, before the LIMIT — a free-text match past the first `cap` account keys (sorted)
 * must still be found; narrowing after the LIMIT instead of before it was a real bug here (code review,
 * otto/mamoru-astro#20 PR #10) since a match sorting after the cutoff would silently never be read at all.
 * Null when account_snapshot_latest or accounts is missing, i.e. migration 0009 is not applied. `cap` bounds
 * how many matching accounts this page shows, never which ones match.
 */
export async function fetchYieldAccounts(db: D1Db, filter: AccountFilter, cap = 1000): Promise<AccountSnapshotRow[] | null> {
  const scope = accountScopeSql(filter, "a");
  const clauses = scope.sql ? [scope.sql] : [];
  const params: unknown[] = [...scope.params];
  if (filter.account) {
    const pattern = `%${likeEscape(filter.account.toLowerCase())}%`;
    clauses.push("(LOWER(asl.account_key) LIKE ? ESCAPE '\\' OR LOWER(asl.address) LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  try {
    const { results } = await db
      .prepare(
        `SELECT asl.chain_id, asl.address, asl.account_key, a.env AS acc_env, a.is_test AS is_test,
                asl.read_at, asl.idle_usdc, asl.lp_usdc, asl.fees_usdc, asl.total_usdc, asl.positions_json
         FROM account_snapshot_latest asl
         JOIN accounts a ON a.chain_id = asl.chain_id AND a.account_key = asl.account_key
         ${where}
         ORDER BY asl.account_key ASC LIMIT ?`,
      )
      .bind(...params, cap)
      .all<RawSnapshot>();
    return results.map((r) => ({
      chainId: Number(r.chain_id),
      address: String(r.address),
      accountKey: String(r.account_key),
      env: String(r.acc_env ?? ""),
      isTest: Number(r.is_test) === 1,
      readAt: String(r.read_at),
      idleUsd: Number(r.idle_usdc) / USDC,
      lpUsd: Number(r.lp_usdc) / USDC,
      feesUsd: Number(r.fees_usdc) / USDC,
      totalUsd: Number(r.total_usdc) / USDC,
      positions: parsePositions(r.positions_json),
    }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** `WHERE account_key IN (...)`, plus chain when the filter narrows to one. Never called with an empty list. */
function accountKeyScope(chainId: number | "all", accountKeys: readonly string[]): { sql: string; params: unknown[] } {
  const placeholders = accountKeys.map(() => "?").join(", ");
  const chainClause = chainId === "all" ? "" : "AND chain_id = ?";
  const params: unknown[] = [...accountKeys, ...(chainId === "all" ? [] : [chainId])];
  return { sql: `account_key IN (${placeholders}) ${chainClause}`, params };
}

export type AccountAggregates = {
  accountKey: string;
  /** Lifetime, from account_daily.collected_usdc. Null when this account has never had one recorded. */
  collectedToDateUsd: number | null;
  /** Σ(fees_close − fees_open + collected) over account_daily rows with day ≥ `sinceDay`. */
  feesEarnedPeriodUsd: number;
  /** Average of lp_close_usdc over the same period rows. Null when there are none. */
  avgLpPeriodUsd: number | null;
};

type RawAccountAgg = { account_key: string; collected_to_date: number | null; fees_period: number | null; lp_period_sum: number | null; days_in_period: number };

/**
 * One row per account: lifetime collected (unconditional SUM, so a years-old account is never truncated)
 * and the period's fees/avg-lp (conditional SUM on `day >= sinceDay`), in one GROUP BY account_key query —
 * no row list is fetched and reduced in JS, so there is nothing here a row-count LIMIT could silently cut
 * off (code review, otto/mamoru-astro#20 PR #10). `collected_usdc`/`lp_close_usdc` are USDC-scaled INTEGER
 * columns (same precision the rest of this Worker already reads as a plain `number`, d1-infra.ts included),
 * so SQL SUM/AVG here is exact at any realistic scale. Gas is deliberately not summed here: `gas_paid_wei`
 * is TEXT precisely because a wei amount has no fixed small decimal scale, so it is read and summed as a
 * BigInt in JS instead (fetchGasRows below), never cast through a float64 in SQL or here. Pass
 * `sinceDay = ""` for the "all" period: every real day string sorts after the empty string, so the period
 * condition is then always true.
 */
export async function fetchAccountAggregates(db: D1Db, chainId: number | "all", accountKeys: readonly string[], sinceDay: string): Promise<Map<string, AccountAggregates> | null> {
  if (accountKeys.length === 0) return new Map();
  const scope = accountKeyScope(chainId, accountKeys);
  try {
    const { results } = await db
      .prepare(
        `SELECT account_key,
                SUM(collected_usdc) AS collected_to_date,
                SUM(CASE WHEN day >= ? THEN fees_close_usdc - fees_open_usdc + COALESCE(collected_usdc, 0) ELSE 0 END) AS fees_period,
                SUM(CASE WHEN day >= ? THEN lp_close_usdc ELSE 0 END) AS lp_period_sum,
                SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END) AS days_in_period
         FROM account_daily WHERE ${scope.sql} GROUP BY account_key`,
      )
      .bind(sinceDay, sinceDay, sinceDay, ...scope.params)
      .all<RawAccountAgg>();
    const map = new Map<string, AccountAggregates>();
    for (const r of results) {
      map.set(String(r.account_key), {
        accountKey: String(r.account_key),
        collectedToDateUsd: r.collected_to_date === null ? null : Number(r.collected_to_date) / USDC,
        feesEarnedPeriodUsd: Number(r.fees_period ?? 0) / USDC,
        avgLpPeriodUsd: r.days_in_period > 0 ? Number(r.lp_period_sum ?? 0) / USDC / r.days_in_period : null,
      });
    }
    return map;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export type DayAggregate = { day: string; feesUsd: number; lpUsdSum: number };

type RawDayAgg = { day: string; fees: number | null; lp_sum: number | null };

/**
 * One row per UTC day across every account in scope, day ≥ `sinceDay` (empty string for "all"): the daily
 * chart and the page's own period totals both read this, already bounded by the period, never by an
 * arbitrary row cap. Gas is not part of this query — see fetchGasRows. Null when account_daily is missing.
 */
export async function fetchDailyAggregates(db: D1Db, chainId: number | "all", accountKeys: readonly string[], sinceDay: string): Promise<DayAggregate[] | null> {
  if (accountKeys.length === 0) return [];
  const scope = accountKeyScope(chainId, accountKeys);
  try {
    const { results } = await db
      .prepare(
        `SELECT day, SUM(fees_close_usdc - fees_open_usdc + COALESCE(collected_usdc, 0)) AS fees, SUM(lp_close_usdc) AS lp_sum
         FROM account_daily WHERE ${scope.sql} AND day >= ? GROUP BY day ORDER BY day ASC`,
      )
      .bind(...scope.params, sinceDay)
      .all<RawDayAgg>();
    return results.map((r) => ({ day: String(r.day), feesUsd: Number(r.fees ?? 0) / USDC, lpUsdSum: Number(r.lp_sum ?? 0) / USDC }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export type GasRow = { accountKey: string; day: string; gasPaidWei: string };

type RawGasRow = { account_key: string; day: string; gas_paid_wei: string };

/**
 * Every account_daily row that actually has a recorded gas_paid_wei, for these accounts, lifetime (no day
 * bound: the caller slices by period in JS). `gas_paid_wei IS NOT NULL` makes this naturally sparse — today
 * it is always empty (no harvest-receipt tracker exists yet, yield-ledger.ts's own comment) — so there is no
 * row-count cap here at all, deliberately: capping a sparse, filtered-to-only-what-matters query would only
 * ever cut real data, never noise. Kept as the raw TEXT wei string so the caller sums with BigInt, exact at
 * any lifetime total (code review, otto/mamoru-astro#20 PR #10: a wei amount must never cross a float64).
 */
export async function fetchGasRows(db: D1Db, chainId: number | "all", accountKeys: readonly string[]): Promise<GasRow[] | null> {
  if (accountKeys.length === 0) return [];
  const scope = accountKeyScope(chainId, accountKeys);
  try {
    const { results } = await db
      .prepare(`SELECT account_key, day, gas_paid_wei FROM account_daily WHERE ${scope.sql} AND gas_paid_wei IS NOT NULL ORDER BY day ASC`)
      .bind(...scope.params)
      .all<RawGasRow>();
    return results.map((r) => ({ accountKey: String(r.account_key), day: String(r.day), gasPaidWei: String(r.gas_paid_wei) }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** MIN(day) across these accounts: the "all" period's start. Null when there is no row at all. */
export async function fetchEarliestDay(db: D1Db, chainId: number | "all", accountKeys: readonly string[]): Promise<string | null> {
  if (accountKeys.length === 0) return null;
  const scope = accountKeyScope(chainId, accountKeys);
  try {
    const r = await db.prepare(`SELECT MIN(day) AS d FROM account_daily WHERE ${scope.sql}`).bind(...scope.params).first<{ d: string | null }>();
    return r?.d ?? null;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** One open position to look up: which chain and token id, and which account it belongs to. */
export type OpenPosition = { chainId: number; tokenId: number; accountKey: string };

/**
 * Key for every per-position map in this module and in yield-overview.ts: chain + account + token. A token
 * id is only unique within its own chain (two chains can mint the same id), and the account is part of the
 * key too, in addition to being bound in the SQL WHERE below, as defense in depth — a row must never be
 * attributed to the wrong account even if a future bug on the writing side let two accounts' rows collide on
 * (chain_id, token_id) (code review, otto/mamoru-astro#20 PR #10 round 2).
 */
export function positionKey(chainId: number, accountKey: string, tokenId: number): string {
  return `${chainId}:${accountKey}:${tokenId}`;
}

/** `(chain_id = ? AND token_id = ? AND account_key = ?) OR ...`, parenthesized as one unit: every row read
 * for a position must belong to the account that opened it, never merely share its chain and token id. */
function positionPairsSql(positions: readonly OpenPosition[]): { sql: string; params: unknown[] } {
  const sql = positions.map(() => "(chain_id = ? AND token_id = ? AND account_key = ?)").join(" OR ");
  const params = positions.flatMap((p) => [p.chainId, p.tokenId, p.accountKey]);
  return { sql: `(${sql})`, params };
}

export type PositionLatest = { chainId: number; accountKey: string; tokenId: number; valueUsd: number; accruedUsdClose: number; holdValueUsd: number };

type RawPositionLatest = { chain_id: number; account_key: string; token_id: number; value_usd: number; accrued_usd_close: number; hold_value_usd: number };

/**
 * The single latest-day row for each of these positions (a MAX(day) correlated subquery per (chain_id,
 * account_key, token_id), never a full history fetch filtered in JS to one day): "value vs hold" reads
 * whatever the most recent write for a position is, which otherwise needed every row for every position's
 * whole lifetime just to find one day (code review, otto/mamoru-astro#20 PR #10 — the old approach also had
 * a row-count LIMIT ahead of that filtering). The correlated subquery binds account_key too, not just chain
 * and token id (round 2 of the same review): a row can never come back under the wrong account. Bounded by
 * the number of positions passed in, not by any day-history cap. Null when yield_ledger_position_daily is
 * missing, i.e. migration 0010 is not applied. Empty `positions` short-circuits to `[]`.
 */
export async function fetchPositionLatest(db: D1Db, positions: readonly OpenPosition[]): Promise<PositionLatest[] | null> {
  if (positions.length === 0) return [];
  const pairs = positionPairsSql(positions);
  try {
    const { results } = await db
      .prepare(
        `SELECT chain_id, account_key, token_id, value_usd, accrued_usd_close, hold_value_usd
         FROM yield_ledger_position_daily pd
         WHERE ${pairs.sql}
           AND day = (SELECT MAX(day) FROM yield_ledger_position_daily WHERE chain_id = pd.chain_id AND token_id = pd.token_id AND account_key = pd.account_key)`,
      )
      .bind(...pairs.params)
      .all<RawPositionLatest>();
    return results.map((r) => ({
      chainId: Number(r.chain_id),
      accountKey: String(r.account_key),
      tokenId: Number(r.token_id),
      valueUsd: Number(r.value_usd) / USDC,
      accruedUsdClose: Number(r.accrued_usd_close) / USDC,
      holdValueUsd: Number(r.hold_value_usd) / USDC,
    }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

type RawPositionCollected = { chain_id: number; account_key: string; token_id: number; collected_sum: number | null };

/**
 * Lifetime `collected_usd`, summed in SQL and grouped by (chain_id, account_key, token_id) — the
 * per-position drill-down's "Collected" column, for exactly the positions passed in, with no history-row
 * cap ahead of the sum. Keyed by positionKey() so this map and fetchPositionLatest's are looked up the same
 * way. Null when yield_ledger_position_daily is missing.
 */
export async function fetchPositionLifetimeCollected(db: D1Db, positions: readonly OpenPosition[]): Promise<Map<string, number> | null> {
  if (positions.length === 0) return new Map();
  const pairs = positionPairsSql(positions);
  try {
    const { results } = await db
      .prepare(
        `SELECT chain_id, account_key, token_id, SUM(collected_usd) AS collected_sum FROM yield_ledger_position_daily WHERE ${pairs.sql} GROUP BY chain_id, account_key, token_id`,
      )
      .bind(...pairs.params)
      .all<RawPositionCollected>();
    const map = new Map<string, number>();
    for (const r of results) {
      if (r.collected_sum === null) continue;
      map.set(positionKey(Number(r.chain_id), String(r.account_key), Number(r.token_id)), Number(r.collected_sum) / USDC);
    }
    return map;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}
