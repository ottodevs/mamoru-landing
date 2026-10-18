import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER } from "../src/account-filter";
import type { D1Db } from "../src/d1-infra";
import { fetchAccountDaily, fetchPositionDaily, fetchYieldAccounts } from "../src/yield-store";

/** The columns these queries read from ottodevs/mamoru's schema: accounts (migrations/d1/0001, plus the
 * env/is_test columns from otto/mamoru#130) and account_snapshot_latest/account_daily/yield_ledger_position_daily
 * (migrations/d1/0009 and 0010). USD columns are raw USDC base units (6 decimals) as INTEGER, matching both
 * migrations' header comments. */
const SCHEMA = `
CREATE TABLE accounts (account_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, created_at TEXT NOT NULL, env TEXT NOT NULL DEFAULT 'prod', is_test INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account_snapshot_latest (chain_id INTEGER NOT NULL, address TEXT NOT NULL, account_key TEXT NOT NULL, env TEXT NOT NULL, block INTEGER NOT NULL, read_at TEXT NOT NULL, deployed INTEGER NOT NULL, idle_usdc INTEGER NOT NULL, lp_usdc INTEGER NOT NULL, fees_usdc INTEGER NOT NULL, owed_usdc INTEGER NOT NULL, total_usdc INTEGER NOT NULL, positions_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE account_daily (day TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, account_key TEXT NOT NULL, env TEXT NOT NULL, block_open INTEGER NOT NULL, block_close INTEGER NOT NULL, total_open_usdc INTEGER NOT NULL, total_close_usdc INTEGER NOT NULL, idle_close_usdc INTEGER NOT NULL, lp_close_usdc INTEGER NOT NULL, fees_open_usdc INTEGER NOT NULL, fees_close_usdc INTEGER NOT NULL, collected_usdc INTEGER, gas_paid_wei TEXT);
CREATE TABLE yield_ledger_position_daily (day TEXT NOT NULL, chain_id INTEGER NOT NULL, token_id INTEGER NOT NULL, account_key TEXT NOT NULL, address TEXT NOT NULL, env TEXT NOT NULL, pool TEXT NOT NULL, block_open INTEGER NOT NULL, block_close INTEGER NOT NULL, accrued0_open TEXT NOT NULL, accrued1_open TEXT NOT NULL, accrued_usd_open INTEGER NOT NULL, accrued0_close TEXT NOT NULL, accrued1_close TEXT NOT NULL, accrued_usd_close INTEGER NOT NULL, value_usd INTEGER NOT NULL, hold_value_usd INTEGER NOT NULL, collected0 TEXT, collected1 TEXT, collected_usd INTEGER, fee_accrued_usd INTEGER, updated_at TEXT NOT NULL);
INSERT INTO accounts VALUES ('acc1', 'u1', 8453, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '2026-09-01T00:00:00Z', 'prod', 0);
INSERT INTO accounts VALUES ('acc2', 'u2', 8453, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '2026-09-02T00:00:00Z', 'beta', 0);
INSERT INTO accounts VALUES ('acc3', 'u3', 8453, '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', '2026-09-03T00:00:00Z', 'prod', 1);
INSERT INTO account_snapshot_latest VALUES (8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 100, '2026-10-18T09:00:00Z', 1, 1000000, 130000000, 300000, 0, 131300000, '[{"tokenId":"1","pool":"pool:USDC/ETH/500","inRange":true,"valueUsdc":"130000000","feesUsdc":"300000","owedUsdc":"0"}]', '2026-10-18T09:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'acc2', 'unknown', 100, '2026-10-18T09:00:00Z', 1, 500000, 10000000, 50000, 0, 10550000, '[]', '2026-10-18T09:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0xcccccccccccccccccccccccccccccccccccccccc', 'acc3', 'unknown', 100, '2026-10-18T09:00:00Z', 1, 0, 0, 0, 0, 0, '[]', '2026-10-18T09:00:05Z');
INSERT INTO account_daily VALUES ('2026-10-17', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 90, 95, 120000000, 121000000, 0, 120000000, 1000000, 1500000, 500000, '2000000000000000');
INSERT INTO account_daily VALUES ('2026-10-18', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 96, 100, 121000000, 131300000, 1000000, 130000000, 1500000, 2000000, NULL, NULL);
INSERT INTO yield_ledger_position_daily VALUES ('2026-10-18', 8453, 1, 'acc1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'unknown', 'pool:USDC/ETH/500', 96, 100, '0', '0', 1000000, '0', '0', 300000, 130000000, 125000000, NULL, NULL, NULL, NULL, '2026-10-18T09:00:05Z');
`;

function memoryDb(withSchema = true): D1Db {
  const db = new Database(":memory:");
  if (withSchema) db.exec(SCHEMA);
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
  });
  return { prepare: (sql: string) => stmt(sql) };
}

describe("fetchYieldAccounts", () => {
  test("joins accounts for env/is_test, scopes by the filter, and converts raw USDC units to dollars", async () => {
    const db = memoryDb();
    const rows = await fetchYieldAccounts(db, DEFAULT_FILTER); // prod, all chains, no account term
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.accountKey)).toEqual(["acc1"]); // acc2 is beta, acc3 is_test
    expect(rows![0]!.totalUsd).toBeCloseTo(131.3, 6);
    expect(rows![0]!.lpUsd).toBeCloseTo(130, 6);
    expect(rows![0]!.feesUsd).toBeCloseTo(0.3, 6);
    expect(rows![0]!.positions).toEqual([{ tokenId: 1, pool: "pool:USDC/ETH/500", inRange: true, valueUsd: 130, feesUsd: 0.3 }]);
  });

  test("env: all reads every account, test ones included", async () => {
    const db = memoryDb();
    const rows = await fetchYieldAccounts(db, { ...DEFAULT_FILTER, env: "all" });
    expect(rows!.map((r) => r.accountKey).sort()).toEqual(["acc1", "acc2", "acc3"]);
  });

  test("the free-text account term matches the key or the address, case-insensitively, after the SQL scope", async () => {
    const db = memoryDb();
    const byAddress = await fetchYieldAccounts(db, { ...DEFAULT_FILTER, env: "all", account: "0xBBBB" });
    expect(byAddress!.map((r) => r.accountKey)).toEqual(["acc2"]);
    const byKey = await fetchYieldAccounts(db, { ...DEFAULT_FILTER, env: "all", account: "ACC3" });
    expect(byKey!.map((r) => r.accountKey)).toEqual(["acc3"]);
  });

  test("missing table reads as null, not a thrown error", async () => {
    const db = memoryDb(false);
    expect(await fetchYieldAccounts(db, DEFAULT_FILTER)).toBeNull();
  });
});

describe("fetchAccountDaily / fetchPositionDaily", () => {
  test("every column is converted from raw USDC units, oldest first; an empty account list never queries", async () => {
    const db = memoryDb();
    const daily = await fetchAccountDaily(db, 8453, ["acc1"]);
    expect(daily).toEqual([
      { day: "2026-10-17", accountKey: "acc1", feesOpenUsd: 1, feesCloseUsd: 1.5, lpCloseUsd: 120, collectedUsd: 0.5, gasPaidWei: "2000000000000000" },
      { day: "2026-10-18", accountKey: "acc1", feesOpenUsd: 1.5, feesCloseUsd: 2, lpCloseUsd: 130, collectedUsd: null, gasPaidWei: null },
    ]);
    expect(await fetchAccountDaily(db, 8453, [])).toEqual([]);
  });

  test("position daily rows read value/accrued/hold for value-vs-hold math", async () => {
    const db = memoryDb();
    const rows = await fetchPositionDaily(db, 8453, ["acc1"]);
    expect(rows).toEqual([{ day: "2026-10-18", accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.3, holdValueUsd: 125, collectedUsd: null }]);
  });

  test("migration 0010 missing reads as null for position-daily only", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA.split("CREATE TABLE yield_ledger_position_daily")[0]! + "CREATE TABLE accounts_dummy (x INTEGER);");
    const fake: D1Db = {
      prepare: (sql: string) => {
        const stmt = (s: string, values: unknown[] = []): any => ({
          bind: (...v: unknown[]) => stmt(s, v),
          first: async () => (db.query(s).get(...(values as never[])) as unknown) ?? null,
          all: async () => ({ results: db.query(s).all(...(values as never[])), success: true }),
        });
        return stmt(sql);
      },
    };
    expect(await fetchPositionDaily(fake, 8453, ["acc1"])).toBeNull();
    expect(await fetchAccountDaily(fake, 8453, ["acc1"])).not.toBeNull();
  });
});
