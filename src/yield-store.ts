/**
 * D1 access for /ops/yield (otto/mamoru-astro#20). Schema owned by ottodevs/mamoru: account_snapshot_latest
 * and account_daily (migrations/d1/0009_account_snapshots.sql, otto/mamoru#136) and
 * yield_ledger_position_daily (migrations/d1/0010_yield_ledger.sql, otto/mamoru#129). Read-only, additive
 * only elsewhere in this Worker, same rule as d1-infra.ts and metrics-store.ts. Every USD column on these
 * three tables is raw USDC base units (6 decimals) as INTEGER, per both migrations' header comments; every
 * read below divides by 1e6 so nothing downstream has to remember the scale.
 */

import { accountScopeSql, type AccountFilter } from "./account-filter";
import type { D1Db } from "./d1-infra";

const USDC = 1_000_000;

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

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
 * accountScopeSql, same as fetchInfraCounts in d1-infra.ts), then the free-text `?account=` term matched
 * against the key or the address in JS (same rule as infra-snapshot.ts's matchesFilter — the SQL above only
 * narrows env/chain, never the free-text term). Null when account_snapshot_latest or accounts is missing,
 * i.e. migration 0009 is not applied. Capped: an ops console reads hundreds of accounts, not millions.
 */
export async function fetchYieldAccounts(db: D1Db, filter: AccountFilter, cap = 1000): Promise<AccountSnapshotRow[] | null> {
  const { sql, params } = accountScopeSql(filter, "a");
  const where = sql ? `WHERE ${sql}` : "";
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
    const rows: AccountSnapshotRow[] = results.map((r) => ({
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
    if (!filter.account) return rows;
    const needle = filter.account.toLowerCase();
    return rows.filter((r) => r.accountKey.toLowerCase().includes(needle) || r.address.toLowerCase().includes(needle));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export type DailyLedgerRow = {
  day: string;
  accountKey: string;
  feesOpenUsd: number;
  feesCloseUsd: number;
  lpCloseUsd: number;
  /** Null until a harvest-receipt tracker exists (yield-ledger.ts's own comment); never fabricated as zero. */
  collectedUsd: number | null;
  /** Raw wei, decimal string; null until a harvest-receipt tracker exists. */
  gasPaidWei: string | null;
};

type RawDaily = { day: string; account_key: string; fees_open_usdc: number; fees_close_usdc: number; lp_close_usdc: number; collected_usdc: number | null; gas_paid_wei: string | null };

/**
 * Every account_daily row for these accounts, oldest first, unbounded by day: the per-account "collected to
 * date" and "gas to date" figures are lifetime sums (same contract as apps/mamoru-app/src/api/accounts/yield.ts's
 * loadYieldLedger), and the period figures (fees earned in N days, the daily bars) are derived from the same
 * rows in ops-yield-overview.ts rather than fetched twice. Null when account_daily is missing, i.e. migration
 * 0009 is not applied. Empty `accountKeys` short-circuits to `[]` without a query (an empty IN () is invalid SQL).
 */
export async function fetchAccountDaily(db: D1Db, chainId: number | "all", accountKeys: readonly string[], cap = 20_000): Promise<DailyLedgerRow[] | null> {
  if (accountKeys.length === 0) return [];
  const placeholders = accountKeys.map(() => "?").join(", ");
  const chainClause = chainId === "all" ? "" : "AND chain_id = ?";
  try {
    const { results } = await db
      .prepare(
        `SELECT day, account_key, fees_open_usdc, fees_close_usdc, lp_close_usdc, collected_usdc, gas_paid_wei
         FROM account_daily WHERE account_key IN (${placeholders}) ${chainClause} ORDER BY day ASC LIMIT ?`,
      )
      .bind(...accountKeys, ...(chainId === "all" ? [] : [chainId]), cap)
      .all<RawDaily>();
    return results.map((r) => ({
      day: String(r.day),
      accountKey: String(r.account_key),
      feesOpenUsd: Number(r.fees_open_usdc) / USDC,
      feesCloseUsd: Number(r.fees_close_usdc) / USDC,
      lpCloseUsd: Number(r.lp_close_usdc) / USDC,
      collectedUsd: r.collected_usdc === null || r.collected_usdc === undefined ? null : Number(r.collected_usdc) / USDC,
      gasPaidWei: r.gas_paid_wei ?? null,
    }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export type PositionDailyRow = {
  day: string;
  accountKey: string;
  tokenId: number;
  valueUsd: number;
  accruedUsdClose: number;
  holdValueUsd: number;
  collectedUsd: number | null;
};

type RawPositionDaily = { day: string; account_key: string; token_id: number; value_usd: number; accrued_usd_close: number; hold_value_usd: number; collected_usd: number | null };

/**
 * Every yield_ledger_position_daily row for these accounts, oldest first, unbounded by day: lifetime
 * per-position "collected" sums the same way, and "value vs hold" is read for each account's own current
 * day (openPositionsValueVsHold's exact rule in apps/mamoru-app/src/api/accounts/yield.ts) by the caller,
 * from these same rows, so the two never drift. Null when yield_ledger_position_daily is missing, i.e.
 * migration 0010 is not applied — distinct from 0009: an account can have a current snapshot with no
 * position-level yield detail yet.
 */
export async function fetchPositionDaily(db: D1Db, chainId: number | "all", accountKeys: readonly string[], cap = 50_000): Promise<PositionDailyRow[] | null> {
  if (accountKeys.length === 0) return [];
  const placeholders = accountKeys.map(() => "?").join(", ");
  const chainClause = chainId === "all" ? "" : "AND chain_id = ?";
  try {
    const { results } = await db
      .prepare(
        `SELECT day, account_key, token_id, value_usd, accrued_usd_close, hold_value_usd, collected_usd
         FROM yield_ledger_position_daily WHERE account_key IN (${placeholders}) ${chainClause} ORDER BY day ASC LIMIT ?`,
      )
      .bind(...accountKeys, ...(chainId === "all" ? [] : [chainId]), cap)
      .all<RawPositionDaily>();
    return results.map((r) => ({
      day: String(r.day),
      accountKey: String(r.account_key),
      tokenId: Number(r.token_id),
      valueUsd: Number(r.value_usd) / USDC,
      accruedUsdClose: Number(r.accrued_usd_close) / USDC,
      holdValueUsd: Number(r.hold_value_usd) / USDC,
      collectedUsd: r.collected_usd === null || r.collected_usd === undefined ? null : Number(r.collected_usd) / USDC,
    }));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}
