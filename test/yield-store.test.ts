import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER } from "../src/account-filter";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import {
  fetchAccountAggregates,
  fetchDailyAggregates,
  fetchEarliestDay,
  fetchGasRows,
  fetchPositionLatest,
  fetchPositionLifetimeCollected,
  fetchYieldAccounts,
  type OpenPosition,
} from "../src/yield-store";

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
INSERT INTO yield_ledger_position_daily VALUES ('2026-10-17', 8453, 1, 'acc1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'unknown', 'pool:USDC/ETH/500', 90, 95, '0', '0', 200000, '0', '0', 200000, 120000000, 118000000, NULL, NULL, 500000, 50000, '2026-10-17T09:00:05Z');
INSERT INTO yield_ledger_position_daily VALUES ('2026-10-18', 8453, 1, 'acc1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'unknown', 'pool:USDC/ETH/500', 96, 100, '0', '0', 300000, '0', '0', 300000, 130000000, 125000000, NULL, NULL, NULL, NULL, '2026-10-18T09:00:05Z');
`;

function memoryDb(withSchema = true): D1Db & { raw: Database } {
  const db = new Database(":memory:");
  if (withSchema) db.exec(SCHEMA);
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
  });
  return { raw: db, prepare: (sql: string) => stmt(sql) };
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

  test("the free-text account term matches the key or the address, case-insensitively, in SQL", async () => {
    const db = memoryDb();
    const byAddress = await fetchYieldAccounts(db, { ...DEFAULT_FILTER, env: "all", account: "0xBBBB" });
    expect(byAddress!.map((r) => r.accountKey)).toEqual(["acc2"]);
    const byKey = await fetchYieldAccounts(db, { ...DEFAULT_FILTER, env: "all", account: "ACC3" });
    expect(byKey!.map((r) => r.accountKey)).toEqual(["acc3"]);
  });

  test("a free-text match sorting after the LIMIT cutoff is still found: the account filter is applied before the LIMIT, not after (code review, PR #10)", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    // Six more prod accounts, sorted ahead of "target" by account_key, so a cap of 5 would exclude it if the
    // free-text filter were applied in JS after the SQL LIMIT instead of in the SQL WHERE before it.
    for (let i = 0; i < 6; i++) {
      const key = `aaa${i}`;
      db.exec(
        `INSERT INTO accounts VALUES ('${key}', 'u-${key}', 8453, '0x${key.padEnd(40, "0")}', '2026-09-01T00:00:00Z', 'prod', 0);
         INSERT INTO account_snapshot_latest VALUES (8453, '0x${key.padEnd(40, "0")}', '${key}', 'unknown', 1, '2026-10-18T09:00:00Z', 1, 0, 0, 0, 0, 0, '[]', '2026-10-18T09:00:05Z');`,
      );
    }
    db.exec(
      `INSERT INTO accounts VALUES ('zzz-target', 'u-target', 8453, '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', '2026-09-01T00:00:00Z', 'prod', 0);
       INSERT INTO account_snapshot_latest VALUES (8453, '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzz-target', 'unknown', 1, '2026-10-18T09:00:00Z', 1, 0, 0, 0, 0, 0, '[]', '2026-10-18T09:00:05Z');`,
    );
    const stmt = (sql: string, values: unknown[] = []): any => ({
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
      all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    });
    const fake: D1Db = { prepare: (sql: string) => stmt(sql) };
    const rows = await fetchYieldAccounts(fake, { ...DEFAULT_FILTER, env: "all", account: "target" }, 5);
    expect(rows!.map((r) => r.accountKey)).toEqual(["zzz-target"]);
  });

  test("missing table reads as null, not a thrown error", async () => {
    const db = memoryDb(false);
    expect(await fetchYieldAccounts(db, DEFAULT_FILTER)).toBeNull();
  });
});

/** Captures the SQL text of every prepared statement, so a test can assert a query has no LIMIT. */
function spyDb(): D1Db & { raw: Database; queries: string[] } {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const queries: string[] = [];
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
  });
  return {
    raw: db,
    queries,
    prepare: (sql: string) => {
      queries.push(sql);
      return stmt(sql);
    },
  };
}

describe("fetchAccountAggregates: SQL SUM in one GROUP BY query, never a capped row list reduced in JS", () => {
  test("lifetime collected and period fees/avg-lp are correct, and acc2 (no rows) is simply absent", async () => {
    const db = memoryDb();
    const agg = await fetchAccountAggregates(db, 8453, ["acc1", "acc2"], "2026-10-12");
    expect(agg).not.toBeNull();
    const a1 = agg!.get("acc1")!;
    expect(a1.collectedToDateUsd).toBeCloseTo(0.5, 6);
    // (1.5-1.0+0.5) + (2.0-1.5+0) = 1.0 + 0.5 = 1.5 over the two seed rows (fees_open/close converted from raw USDC).
    expect(a1.feesEarnedPeriodUsd).toBeCloseTo(1.5, 6);
    expect(a1.avgLpPeriodUsd).toBeCloseTo((120 + 130) / 2, 6);
    expect(agg!.has("acc2")).toBe(false);
  });

  test("the query has no LIMIT: aggregation is unbounded by row count, only by the account_key scope", async () => {
    const db = spyDb();
    await fetchAccountAggregates(db, 8453, ["acc1"], "2026-10-12");
    expect(db.queries.length).toBeGreaterThan(0);
    for (const sql of db.queries) expect(sql.toUpperCase()).not.toContain("LIMIT");
  });

  test("a lifetime sum is correct over far more rows than the old 20,000-row cap would ever have been raised for", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA.replace(/INSERT INTO account_daily.*\n/g, "")); // same schema, no seed daily rows
    db.exec(
      `INSERT INTO accounts VALUES ('busy', 'u-busy', 8453, '0xBB1111111111111111111111111111111111BB', '2020-01-01T00:00:00Z', 'prod', 0);`,
    );
    const days = 400; // old cap was per-table, not per-account; 400 real rows is enough to prove GROUP BY
    // sums every row rather than silently stopping, without making the test slow.
    const rows: string[] = [];
    for (let i = 0; i < days; i++) {
      const day = `2025-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
      rows.push(`('${day}', 8453, '0xbb1111111111111111111111111111111111bb', 'busy', 'unknown', ${i}, ${i}, 0, 0, 0, 1000000, 0, 1000000, 100, NULL)`);
    }
    db.exec(`INSERT INTO account_daily VALUES ${rows.join(",")};`);
    const stmt = (sql: string, values: unknown[] = []): any => ({
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
      all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    });
    const fake: D1Db = { prepare: (sql: string) => stmt(sql) };
    const agg = await fetchAccountAggregates(fake, 8453, ["busy"], "");
    // collected_usdc is 100 raw units (NULL is never written here) on every one of the 400 rows: 400 * 100 / 1e6.
    expect(agg!.get("busy")!.collectedToDateUsd).toBeCloseTo((days * 100) / 1_000_000, 9);
  });
});

describe("fetchDailyAggregates", () => {
  test("GROUP BY day, bounded by the period's day range, not by a row cap", async () => {
    const db = spyDb();
    const rows = await fetchDailyAggregates(db, 8453, ["acc1"], "2026-10-17");
    expect(rows).toEqual([{ day: "2026-10-17", feesUsd: 1, lpUsdSum: 120 }, { day: "2026-10-18", feesUsd: 0.5, lpUsdSum: 130 }]);
    for (const sql of db.queries) expect(sql.toUpperCase()).not.toContain("LIMIT");
  });

  test("sinceDay = '' (the \"all\" period) includes every day", async () => {
    const db = memoryDb();
    const rows = await fetchDailyAggregates(db, 8453, ["acc1"], "");
    expect(rows!.map((r) => r.day)).toEqual(["2026-10-17", "2026-10-18"]);
  });
});

describe("fetchGasRows", () => {
  test("only the non-null gas rows come back, as the raw TEXT wei string, never SQL-summed", async () => {
    const db = memoryDb();
    const rows = await fetchGasRows(db, 8453, ["acc1"]);
    expect(rows).toEqual([{ accountKey: "acc1", day: "2026-10-17", gasPaidWei: "2000000000000000" }]);
  });

  test("a wei amount far beyond 2^53 is still exact: it is never cast through a float64", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    const huge = "123456789012345678"; // ~1.2e17 wei, safely inside a 64-bit integer but well past 2^53 (~9e15)
    db.exec(
      `INSERT INTO accounts VALUES ('whale', 'u-whale', 8453, '0xCC2222222222222222222222222222222222CC', '2026-09-01T00:00:00Z', 'prod', 0);
       INSERT INTO account_daily VALUES ('2026-10-18', 8453, '0xcc2222222222222222222222222222222222cc', 'whale', 'unknown', 1, 1, 0, 0, 0, 0, 0, 0, NULL, '${huge}');`,
    );
    const stmt = (sql: string, values: unknown[] = []): any => ({
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
      all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    });
    const fake: D1Db = { prepare: (sql: string) => stmt(sql) };
    const rows = await fetchGasRows(fake, 8453, ["whale"]);
    expect(rows![0]!.gasPaidWei).toBe(huge);
    expect(BigInt(rows![0]!.gasPaidWei)).toBe(123456789012345678n);
  });

  test("missing table reads as null", async () => {
    const db = memoryDb(false);
    expect(await fetchGasRows(db, 8453, ["acc1"])).toBeNull();
  });

  test("an empty account list never queries", async () => {
    const db = memoryDb();
    expect(await fetchGasRows(db, 8453, [])).toEqual([]);
  });
});

describe("fetchEarliestDay", () => {
  test("MIN(day) across the scoped accounts", async () => {
    const db = memoryDb();
    expect(await fetchEarliestDay(db, 8453, ["acc1"])).toBe("2026-10-17");
    expect(await fetchEarliestDay(db, 8453, ["acc2"])).toBeNull();
  });
});

describe("fetchPositionLatest / fetchPositionLifetimeCollected", () => {
  const position: OpenPosition = { chainId: 8453, tokenId: 1, accountKey: "acc1" };

  test("fetchPositionLatest returns only the latest day per (chain, token), not every historical row", async () => {
    const db = memoryDb();
    const rows = await fetchPositionLatest(db, [position]);
    expect(rows).toEqual([{ chainId: 8453, accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.3, holdValueUsd: 125 }]);
  });

  test("fetchPositionLifetimeCollected sums collected_usd across every day for the position, in SQL", async () => {
    const db = spyDb();
    const map = await fetchPositionLifetimeCollected(db, [position]);
    expect(map!.get("8453:acc1:1")).toBeCloseTo(0.5, 6);
    for (const sql of db.queries) expect(sql.toUpperCase()).not.toContain("LIMIT");
  });

  test("an empty position list never queries", async () => {
    const db = memoryDb();
    expect(await fetchPositionLatest(db, [])).toEqual([]);
    expect(await fetchPositionLifetimeCollected(db, [])).toEqual(new Map());
  });

  test("two accounts sharing the same (chain_id, token_id): each sees only its own row (code review, PR #10 round 2)", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    // acc9 collides with acc1 on (chain_id=8453, token_id=1) — should never happen in real data (a Uniswap
    // token id has one owner), but the query must not rely on that: it binds account_key too.
    db.exec(
      `INSERT INTO accounts VALUES ('acc9', 'u9', 8453, '0xDD3333333333333333333333333333333333DD', '2026-09-01T00:00:00Z', 'prod', 0);
       INSERT INTO yield_ledger_position_daily VALUES ('2026-10-18', 8453, 1, 'acc9', '0xdd3333333333333333333333333333333333dd', 'unknown', 'pool:OTHER', 10, 10, '0', '0', 900000, '0', '0', 900000, 999000000, 1000000, NULL, NULL, 700000, NULL, '2026-10-18T09:00:05Z');`,
    );
    const stmt = (sql: string, values: unknown[] = []): any => ({
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
      all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    });
    const fake: D1Db = { prepare: (sql: string) => stmt(sql) };
    const positions: OpenPosition[] = [{ chainId: 8453, tokenId: 1, accountKey: "acc1" }, { chainId: 8453, tokenId: 1, accountKey: "acc9" }];

    const latest = await fetchPositionLatest(fake, positions);
    const byAccount = new Map(latest!.map((r) => [r.accountKey, r]));
    expect(byAccount.get("acc1")).toEqual({ chainId: 8453, accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.3, holdValueUsd: 125 });
    expect(byAccount.get("acc9")).toEqual({ chainId: 8453, accountKey: "acc9", tokenId: 1, valueUsd: 999, accruedUsdClose: 0.9, holdValueUsd: 1 });

    const collected = await fetchPositionLifetimeCollected(fake, positions);
    expect(collected!.get("8453:acc1:1")).toBeCloseTo(0.5, 6); // acc1's own two seed rows, unaffected by acc9
    expect(collected!.get("8453:acc9:1")).toBeCloseTo(0.7, 6); // acc9's own row only
  });

  test("missing table reads as null for both", async () => {
    const db = memoryDb(false);
    expect(await fetchPositionLatest(db, [position])).toBeNull();
    expect(await fetchPositionLifetimeCollected(db, [position])).toBeNull();
  });
});
