/**
 * Read-only D1 queries against the `mamoru` database (accounts, users).
 * Schema owned by ottodevs/mamoru (migrations/d1/0001_sprint.sql). This
 * Worker's only writes are additive: metrics_daily (src/metrics-store.ts)
 * and exp_events (src/exp-store.ts).
 */

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
  /** 'prod' | 'beta' (otto/mamoru#130). 'prod' when the columns below are not on this D1 yet. */
  env: string;
  /** 1 for Ot's test account and any coordinator smoke-test account; 0 otherwise (otto/mamoru#130). */
  is_test: number;
};

export interface InfraCounts {
  totalUsers: number;
  totalAccounts: number;
  last7d: number;
}

export async function fetchInfraCounts(db: D1Db): Promise<InfraCounts> {
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
