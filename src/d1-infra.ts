/**
 * Read-only D1 queries against the `mamoru` database (accounts, users).
 * Schema owned by ottodevs/mamoru (migrations/d1/0001_sprint.sql). This
 * Worker's only writes are additive: metrics_daily (src/metrics-store.ts)
 * and exp_events (src/exp-store.ts).
 */

import { accountScopeSql, isFullyUnscoped, type AccountScopeFilter } from "./account-filter";

export interface D1Result<T> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

/** Minimal shape of the Cloudflare D1Database binding this file needs. */
export interface D1Db {
  prepare(query: string): D1PreparedStatement;
}

export type AccountRow = {
  account_key: string;
  user_id: string;
  chain_id: number;
  address: string;
  created_at: string;
  /** 'prod' | 'beta' (otto/mamoru#130). 'prod' when the columns below are not on this D1 yet. Set once, at
   * onboarding, from the host that served the request (ottodevs/mamoru's env-of-host.ts) — it answers only
   * "where was this account created", never "where is it active now". app.mamoru.lol and beta.mamoru.lol
   * share this D1 and chain_id, so an account that signs in from the other host afterward keeps its
   * original env; attributing session-level activity to the host it happened on is out of scope here. */
  env: string;
  /** 1 for Ot's test account and any coordinator smoke-test account; 0 otherwise (otto/mamoru#130). */
  is_test: number;
};

export interface InfraCounts {
  totalUsers: number;
  totalAccounts: number;
  last7d: number;
}

/**
 * Without `filter`, or with a fully unscoped one (otto/mamoru#130's `isFullyUnscoped`): the exact unfiltered,
 * uncapped query this function has always run, read by `rowFromSnapshot` for the legacy `metrics_daily` row,
 * by the Infra page, and by the Overview's `env=all`/`chain=all` view — counting `FROM users` so a person who
 * has not yet created an account is still counted, the documented meaning of that one scope. With a narrower
 * `filter` (otto/mamoru#130): scoped by env/chain_id/is_test, counting `DISTINCT user_id FROM accounts` — this
 * is what the Overview's headline users/accounts/last7d read, uncapped (unlike the on-chain `rows`, which
 * `fetchChainAccounts` caps at 500). Falls back to the unfiltered totals when the scoping columns are not on
 * this D1 yet, except for `env: "beta"` or `"test"`, which have no honest fallback (there is nothing yet known
 * to be beta or test) and so read as zero instead of guessing.
 */
export async function fetchInfraCounts(db: D1Db, filter?: AccountScopeFilter): Promise<InfraCounts> {
  if (!filter || isFullyUnscoped(filter)) {
    const row = await db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM accounts) AS total_accounts,
          (SELECT COUNT(*) FROM accounts WHERE created_at >= datetime('now','-7 days')) AS last7d`,
      )
      .first<{ total_users: number; total_accounts: number; last7d: number }>();
    return {
      totalUsers: row?.total_users ?? 0,
      totalAccounts: row?.total_accounts ?? 0,
      last7d: row?.last7d ?? 0,
    };
  }
  const { sql, params } = accountScopeSql(filter, "accounts");
  const scopeWhere = sql ? `WHERE ${sql}` : "";
  const scopeAnd = sql ? `${sql} AND ` : "";
  try {
    const row = await db
      .prepare(
        `SELECT
          (SELECT COUNT(DISTINCT user_id) FROM accounts ${scopeWhere}) AS total_users,
          (SELECT COUNT(*) FROM accounts ${scopeWhere}) AS total_accounts,
          (SELECT COUNT(*) FROM accounts WHERE ${scopeAnd}created_at >= datetime('now','-7 days')) AS last7d`,
      )
      .bind(...params, ...params, ...params)
      .first<{ total_users: number; total_accounts: number; last7d: number }>();
    return {
      totalUsers: row?.total_users ?? 0,
      totalAccounts: row?.total_accounts ?? 0,
      last7d: row?.last7d ?? 0,
    };
  } catch {
    if (filter.env === "beta" || filter.env === "test") return { totalUsers: 0, totalAccounts: 0, last7d: 0 };
    return fetchInfraCounts(db);
  }
}

export interface GroupCount {
  users: number;
  accounts: number;
}

/**
 * Uncapped users/accounts per (chain_id, env), excluding test accounts, for `metrics_daily_v2` (otto/mamoru#130).
 * A single grouped query so a D1 with more than `fetchChainAccounts`'s 500-row cap worth of accounts still
 * gets an exact count per group instead of one derived from a truncated row list. null when the scoping
 * columns are not on this D1 yet; the caller falls back to deriving counts from the row list it already has.
 */
export async function fetchGroupCounts(db: D1Db): Promise<Map<string, GroupCount> | null> {
  try {
    const { results } = await db
      .prepare(
        `SELECT chain_id AS chain_id, env AS env, COUNT(*) AS accounts, COUNT(DISTINCT user_id) AS users
         FROM accounts WHERE is_test = 0 GROUP BY chain_id, env`,
      )
      .all<{ chain_id: number; env: string; accounts: number; users: number }>();
    const map = new Map<string, GroupCount>();
    for (const r of results) {
      const chainId = Number(r.chain_id);
      const env = String(r.env ?? "");
      if (!Number.isFinite(chainId) || !env) continue;
      map.set(`${chainId}:${env}`, { users: Number(r.users) || 0, accounts: Number(r.accounts) || 0 });
    }
    return map;
  } catch {
    return null;
  }
}

/** Accounts on a given chain, oldest first. Capped so one bad run cannot blow the subrequest budget. */
export async function fetchChainAccounts(
  db: D1Db,
  chainId: number,
  cap = 500,
): Promise<AccountRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT account_key, user_id, chain_id, address, created_at, env, is_test FROM accounts
         WHERE chain_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(chainId, cap)
      .all<AccountRow>();
    return results;
  } catch {
    // otto/mamoru#130's env/is_test columns are not on this D1 yet: read without them and treat every
    // row as prod, non-test — the same as every row was treated before this ticket.
    const { results } = await db
      .prepare(
        `SELECT account_key, user_id, chain_id, address, created_at FROM accounts
         WHERE chain_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(chainId, cap)
      .all<Omit<AccountRow, "env" | "is_test">>();
    return results.map((r) => ({ ...r, env: "prod", is_test: 0 }));
  }
}
