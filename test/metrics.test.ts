import { describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import type { AccountView, InfraSnapshot } from "../src/infra-snapshot";
import { renderBars, renderFunnel, renderTally, renderTimeChart } from "../src/metrics-charts";
import {
  addDays,
  atOrBefore,
  cumulativeGrowth,
  dauAverage,
  dauSlots,
  dayRange,
  delta,
  fmtUsd,
  funnel,
  niceCeil,
  niceCeilInt,
  shortDay,
} from "../src/metrics-math";
import { accountScopeSql, DEFAULT_FILTER, filterQuery, isFullyUnscoped, parseAccountFilter } from "../src/account-filter";
import { fetchInfraCounts } from "../src/d1-infra";
import { matchesFilter } from "../src/infra-snapshot";
import { buildOverview, loadOverview } from "../src/metrics-overview";
import {
  BACKFILL_MARK,
  backfillRows,
  captureDaily,
  collapseDailyV2,
  type DailyRow,
  type DailyRowV2,
  hasChainData,
  PARTIAL_MARK,
  readActivity,
  readDaily,
  readSignupDays,
  rowFromSnapshot,
  rowsFromSnapshotByGroup,
  upsertSql,
} from "../src/metrics-store";
import { sealSession } from "../src/ops";
import { changeLine, renderOverview } from "../src/ops-metrics";
import worker, { type Env } from "../src/worker";

const NOW = new Date("2026-10-01T14:05:00Z");
const TODAY = "2026-10-01";

function acct(i: number, usdcIdle: number, lpUsd: number, positions: number, inRange: number, over: Partial<AccountView> = {}): AccountView {
  return {
    accountKey: `acc${i}`,
    key: `key-${i}`,
    userId: `user-${i}`,
    address: `0x${String(i).padStart(40, "0")}`,
    basescanUrl: "#",
    ethBalance: 0,
    usdcIdle,
    lpUsd,
    positions,
    inRange,
    env: "prod",
    chainId: 8453,
    isTest: false,
    ...over,
  };
}

const ROWS = [acct(1, 2, 21.4, 2, 2), acct(2, 0.5, 14.1, 1, 1), acct(3, 0, 9.18, 1, 0), acct(4, 5, 0, 0, 0), acct(5, 0, 0, 0, 0)];

function snap(over: Partial<InfraSnapshot> = {}): InfraSnapshot {
  const idle = ROWS.reduce((s, r) => s + r.usdcIdle, 0);
  const lp = ROWS.reduce((s, r) => s + r.lpUsd, 0);
  return {
    asOf: NOW.toISOString(),
    ethUsd: 2500,
    btcUsd: 60000,
    relayer: { address: "0xrelayer", basescanUrl: "#", ethBalance: 0.0112, usd: 28, status: "ok" },
    cost: {
      gasPriceGwei: 0.01,
      deployEth: 0,
      deployUsd: 0,
      activationEth: 0,
      activationUsd: 0,
      reserveEth: 0.0005,
      reserveUsd: 1.25,
      totalEth: 0.00065,
      totalUsd: 1.6,
      accountsFunded: 17,
    },
    accounts: { totalUsers: 39, totalAccounts: 39, last7d: 39, rows: ROWS, tvlUsd: idle + lp, idleUsdcUsd: idle, lpUsd: lp, gasReservesEth: 0 },
    ...over,
  };
}

const SIGNUPS = {
  users: [{ day: "2026-09-26", n: 30 }, { day: "2026-09-27", n: 7 }, { day: "2026-09-28", n: 1 }, { day: "2026-09-29", n: 1 }],
  accounts: [{ day: "2026-09-26", n: 30 }, { day: "2026-09-27", n: 7 }, { day: "2026-09-28", n: 1 }, { day: "2026-09-29", n: 1 }],
};

function daily(day: string, over: Partial<DailyRow> = {}): DailyRow {
  return {
    day,
    users: 30,
    accounts: 30,
    funded_accounts: 2,
    active_accounts: 1,
    dau: 1,
    tvl_usd: 40,
    idle_usdc_usd: 10,
    lp_usd: 30,
    positions: 2,
    in_range: 1,
    relayer_eth: 0.01,
    eth_usd: 2500,
    captured_at: `${day}T00:05:00Z`,
    ...over,
  };
}

type Call = { sql: string; args: unknown[]; kind: "first" | "all" | "run" };

/** Scripted D1: `missing` tables throw like SQLite does; writes are recorded, never executed. */
function fakeDb(opts: { missing?: string[]; tables?: Record<string, unknown[]>; first?: (sql: string) => unknown } = {}) {
  const calls: Call[] = [];
  const check = (sql: string) => {
    for (const name of opts.missing ?? []) {
      if (sql.includes(name)) throw new Error(`D1_ERROR: no such table: ${name}`);
    }
  };
  const db: D1Db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async first<T>() {
          calls.push({ sql, args, kind: "first" });
          check(sql);
          return (opts.first?.(sql) ?? null) as T | null;
        },
        async all<T>() {
          calls.push({ sql, args, kind: "all" });
          check(sql);
          const table = Object.keys(opts.tables ?? {}).find((name) => sql.includes(`FROM ${name}`));
          return { results: ((table ? opts.tables?.[table] : []) ?? []) as T[], success: true };
        },
        async run() {
          calls.push({ sql, args, kind: "run" });
          check(sql);
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, calls };
}

/** Every tag opened is closed, and no number leaked through as NaN, Infinity or undefined. */
function expectSoundMarkup(html: string) {
  expect(html).not.toMatch(/NaN|Infinity|undefined|null/);
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, tag, rest] = m;
    if (rest.trimEnd().endsWith("/")) continue;
    if (close) expect(stack.pop()).toBe(tag);
    else stack.push(tag);
  }
  expect(stack).toEqual([]);
}

describe("metrics-math.ts", () => {
  test("days: range, shifting across a month, short labels", () => {
    expect(addDays("2026-10-01", -7)).toBe("2026-09-24");
    expect(dayRange("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(dayRange("2026-10-02", "2026-10-01")).toEqual([]);
    expect(shortDay("2026-09-26")).toBe("26 Sep");
  });

  test("delta: sign, percentage, and no past means no delta", () => {
    expect(delta(52, 40)).toEqual({ abs: 12, pct: 30, dir: "up" });
    expect(delta(30, 40)).toEqual({ abs: -10, pct: -25, dir: "down" });
    expect(delta(5, 5)?.dir).toBe("flat");
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null, dir: "up" });
    expect(delta(5, null)).toBeNull();
    expect(delta(5, undefined)).toBeNull();
    expect(delta(5, Number.NaN)).toBeNull();
  });

  test("funnel: share of the top step and conversion from the step above", () => {
    const steps = funnel([
      { id: "a", label: "Signed up", count: 39 },
      { id: "b", label: "Funded", count: 5 },
      { id: "c", label: "Activated", count: 3 },
      { id: "d", label: "In range", count: 2 },
    ]);
    expect(steps[0]).toMatchObject({ share: 1, rate: null });
    expect(steps[1].share).toBeCloseTo(5 / 39, 6);
    expect(steps[1].rate).toBeCloseTo((5 / 39) * 100, 6);
    expect(steps[2].rate).toBeCloseTo(60, 6);
    expect(steps[3].rate).toBeCloseTo((2 / 3) * 100, 6);
  });

  test("funnel: empty and broken counts never divide by zero", () => {
    const steps = funnel([
      { id: "a", label: "A", count: 0 },
      { id: "b", label: "B", count: Number.NaN },
      { id: "c", label: "C", count: -4 },
    ]);
    expect(steps.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(steps.map((s) => s.share)).toEqual([0, 0, 0]);
    expect(steps.map((s) => s.rate)).toEqual([null, null, null]);
    expect(funnel([])).toEqual([]);
  });

  test("cumulativeGrowth fills quiet days and runs through today", () => {
    const growth = cumulativeGrowth(SIGNUPS.users, SIGNUPS.accounts, TODAY);
    expect(growth.map((g) => g.users)).toEqual([30, 37, 38, 39, 39, 39]);
    expect(growth[0].day).toBe("2026-09-26");
    expect(growth[growth.length - 1].day).toBe(TODAY);
    expect(cumulativeGrowth([], [], TODAY)).toEqual([]);
    expect(atOrBefore(growth, "2026-09-27")?.users).toBe(37);
    expect(atOrBefore(growth, "2026-09-24")).toBeNull();
  });

  test("dauSlots keeps days before tracking as null, and the average only counts tracked days", () => {
    const slots = dauSlots(new Map([["2026-09-30", 1], [TODAY, 2]]), "2026-09-30", TODAY, 14);
    expect(slots).toHaveLength(14);
    expect(slots[11].n).toBeNull();
    expect(slots[12].n).toBe(1);
    expect(slots[13].n).toBe(2);
    expect(dauAverage(slots, 7)).toEqual({ avg: 1.5, days: 2 });
    expect(dauAverage(dauSlots(new Map(), null, TODAY, 14), 7)).toBeNull();
  });

  test("axis ceilings are round, and whole for counts", () => {
    expect(niceCeil(52.2)).toBe(100);
    expect(niceCeil(14600)).toBe(20000);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeilInt(39)).toBe(40);
    expect(niceCeilInt(1)).toBe(2);
    expect(niceCeilInt(273)).toBe(400);
    expect(fmtUsd(52.2)).toBe("$52.20");
    expect(fmtUsd(1284)).toBe("$1,284");
    expect(fmtUsd(14600)).toBe("$14.6K");
  });
});

describe("metrics-store.ts", () => {
  test("missing tables degrade to null instead of throwing", async () => {
    const { db } = fakeDb({ missing: ["metrics_daily", "account_activity"] });
    expect(await readDaily(db, "2026-09-01")).toBeNull();
    expect(await readActivity(db, "2026-09-18")).toBeNull();
    expect(await readSignupDays(db)).toEqual({ users: [], accounts: [] });
  });

  test("loadOverview still renders from created_at when both metrics tables are missing", async () => {
    const { db } = fakeDb({
      missing: ["metrics_daily", "account_activity"],
      tables: { users: SIGNUPS.users, accounts: SIGNUPS.accounts },
    });
    const overview = await loadOverview(db, snap(), NOW);
    expect(overview.dau).toBeNull();
    expect(overview.dauToday).toBeNull();
    expect(overview.value).toEqual([{ day: TODAY, idle: 7.5, lp: expect.closeTo(44.68, 5) }]);
    expect(overview.growth).toHaveLength(6);
    expect(overview.changes.tvl).toBeNull();
    expectSoundMarkup(renderOverview({ overview, csrf: "c", nonce: "n" }).split('<main id="ops-main"')[1].split("</main>")[0].replace(/^[^>]*>/, ""));
  });

  test("rowFromSnapshot: funded, active, positions and totals", () => {
    const row = rowFromSnapshot(snap(), TODAY, 2);
    expect(row).toMatchObject({
      day: TODAY,
      users: 39,
      accounts: 39,
      funded_accounts: 4,
      active_accounts: 3,
      dau: 2,
      positions: 4,
      in_range: 3,
      relayer_eth: 0.0112,
      eth_usd: 2500,
      captured_at: NOW.toISOString(),
    });
    expect(row.idle_usdc_usd).toBeCloseTo(7.5, 6);
    expect(row.lp_usd).toBeCloseTo(44.68, 6);
    expect(row.tvl_usd).toBeCloseTo(52.18, 6);
    expect(hasChainData(row)).toBe(true);
  });

  test("a snapshot without Base keeps the counts and marks the row partial", () => {
    const row = rowFromSnapshot(
      snap({
        rpcError: "Base RPC is unreachable right now.",
        relayer: null,
        cost: null,
        ethUsd: null,
        accounts: { totalUsers: 39, totalAccounts: 39, last7d: 39, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "x" },
      }),
      TODAY,
      1,
    );
    expect(row).toMatchObject({ users: 39, accounts: 39, dau: 1, tvl_usd: 0, captured_at: PARTIAL_MARK });
    expect(hasChainData(row)).toBe(false);
    // A partial write must not overwrite value fields captured earlier that day.
    expect(upsertSql(row)).not.toContain("tvl_usd = excluded.tvl_usd");
    expect(upsertSql(rowFromSnapshot(snap(), TODAY, 1))).toContain("tvl_usd = excluded.tvl_usd");
  });

  test("backfillRows: one counts-only row per past day, never today", () => {
    const rows = backfillRows(SIGNUPS, TODAY);
    expect(rows.map((r) => r.day)).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(rows.map((r) => r.users)).toEqual([30, 37, 38, 39, 39]);
    expect(rows.every((r) => r.captured_at === BACKFILL_MARK && r.tvl_usd === 0)).toBe(true);
  });

  test("captureDaily: backfills an empty table, then upserts today's row, then its per-(chain,env) breakdown", async () => {
    const { db, calls } = fakeDb({
      tables: { users: SIGNUPS.users, accounts: SIGNUPS.accounts },
      first: (sql) => (sql.includes("FROM metrics_daily") ? { n: 0 } : sql.includes("account_activity") ? { n: 2 } : null),
    });
    const outcome = await captureDaily({ db }, { now: NOW, settleYesterday: true, load: async () => ({ snapshot: snap() }) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backfilled).toBe(5);
    expect(outcome.row).toMatchObject({ day: TODAY, dau: 2, active_accounts: 3 });
    const writes = calls.filter((c) => c.kind === "run");
    // 5 backfill rows, the metrics_daily upsert, one metrics_daily_v2 row (every ROWS account is 8453/prod),
    // one metrics_daily_chain row, then settleYesterday's metrics_daily UPDATE and its metrics_daily_v2 sibling.
    expect(writes).toHaveLength(10);
    expect(writes.every((c) => /^(INSERT( OR IGNORE)? INTO|UPDATE) metrics_daily(_v2|_chain)?\b/.test(c.sql))).toBe(true);
    const upsert = writes[5];
    expect(upsert.sql).toContain("ON CONFLICT(day) DO UPDATE");
    expect(upsert.args[0]).toBe(TODAY);
    expect(upsert.args).toHaveLength(14);
    const upsertV2 = writes[6];
    expect(upsertV2.sql).toContain("metrics_daily_v2");
    expect(upsertV2.sql).toContain("ON CONFLICT(day, chain_id, env) DO UPDATE");
    expect(upsertV2.args.slice(0, 3)).toEqual([TODAY, 8453, "prod"]);
    // relayer_eth/eth_usd are not on this row at all (otto/mamoru#130): chain-level, written once below instead.
    expect(upsertV2.sql).not.toContain("relayer_eth");
    const upsertChain = writes[7];
    expect(upsertChain.sql).toContain("metrics_daily_chain");
    expect(upsertChain.args.slice(0, 2)).toEqual([TODAY, 8453]);
    expect(writes[8].args).toEqual([2, "2026-09-30"]);
    const settleV2 = writes[9];
    expect(settleV2.sql).toContain("UPDATE metrics_daily_v2 SET dau");
    expect(settleV2.args).toEqual([0, "2026-09-30", 8453, "prod"]);
  });

  test("captureDaily: a table with rows is not backfilled again", async () => {
    const { db, calls } = fakeDb({ first: (sql) => (sql.includes("FROM metrics_daily") ? { n: 12 } : { n: 0 }) });
    const outcome = await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: snap() }) });
    expect(outcome.ok && outcome.backfilled).toBe(0);
    // the metrics_daily upsert, one metrics_daily_v2 row, one metrics_daily_chain row; no settle (not asked for).
    expect(calls.filter((c) => c.kind === "run")).toHaveLength(3);
  });

  test("captureDaily reports instead of throwing: no D1, unreadable counts, missing table", async () => {
    expect(await captureDaily({}, { now: NOW })).toMatchObject({ ok: false, reason: "no-db" });
    const { db } = fakeDb({ missing: ["metrics_daily"] });
    expect(await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: snap() }) })).toMatchObject({ ok: false, reason: "write-failed" });
    const blind = snap({ accounts: { totalUsers: 0, totalAccounts: 0, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "Could not read the accounts database." } });
    expect(await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: blind }) })).toMatchObject({ ok: false, reason: "no-counts" });
  });
});

describe("metrics-overview.ts", () => {
  test("deltas compare with the row seven days back, and say so when it is not exact", () => {
    const overview = buildOverview(
      snap(),
      {
        daily: [daily("2026-09-22", { tvl_usd: 30, active_accounts: 1 }), daily("2026-09-30", { tvl_usd: 48 })],
        activity: null,
        signups: { users: [{ day: "2026-09-20", n: 30 }, { day: "2026-09-27", n: 9 }], accounts: [{ day: "2026-09-20", n: 30 }, { day: "2026-09-27", n: 9 }] },
      },
      NOW,
    );
    expect(overview.changes.tvl).toMatchObject({ since: "2026-09-22", exact: false });
    expect(overview.changes.tvl?.delta.abs).toBeCloseTo(22.18, 6);
    expect(overview.changes.activated?.delta.abs).toBe(2);
    expect(overview.changes.users).toMatchObject({ since: "2026-09-24", exact: true });
    // otto/mamoru#130: without `inputs.counts`, "users" falls back to the uncapped growth series (39 today,
    // the same series its 7-days-ago comparison already read) — not the live, on-chain `rows` (5 in ROWS),
    // which would mix a capped/filtered snapshot into a delta computed against an unrelated, unfiltered history.
    expect(overview.changes.users?.delta.abs).toBe(9);
    expect(changeLine(overview.changes.users, "int")).toBe("+9 in 7 days");
    expect(changeLine(overview.changes.tvl, "usd")).toBe("+$22.18 (+74%) since 22 Sep");
    expect(changeLine(null, "int")).toBe("");
  });

  test("backfilled rows never feed the value chart or the value delta", () => {
    const overview = buildOverview(
      snap(),
      { daily: [daily("2026-09-24", { captured_at: BACKFILL_MARK, tvl_usd: 0 }), daily("2026-09-30")], activity: null, signups: SIGNUPS },
      NOW,
    );
    expect(overview.value.map((p) => p.day)).toEqual(["2026-09-30", TODAY]);
    expect(overview.changes.tvl).toBeNull();
  });

  test("funnel counts accounts, and Base being down falls back to the last capture", () => {
    const live = buildOverview(snap(), { daily: null, activity: null, signups: SIGNUPS }, NOW);
    // otto/mamoru#130: without `inputs.counts`, "signed up" (= `users`) falls back to the uncapped growth
    // series (39, from SIGNUPS), not the live, on-chain row count (5 in ROWS).
    expect(live.funnel.map((s) => s.count)).toEqual([39, 4, 3, 2]);
    expect(live.positionsInRange).toBe(3);
    expect(live.positions).toBe(4);

    const down = buildOverview(
      snap({ rpcError: "Base RPC is unreachable right now.", relayer: null, cost: null, accounts: { totalUsers: 39, totalAccounts: 39, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "x" } }),
      { daily: [daily("2026-09-30", { tvl_usd: 48, idle_usdc_usd: 8, lp_usd: 40, active_accounts: 3, funded_accounts: 4 })], activity: null, signups: SIGNUPS },
      NOW,
    );
    expect(down.chainOk).toBe(false);
    expect(down.tvl).toBe(48);
    expect(down.activated).toBe(3);
    expect(down.relayer).toBeNull();
    expect(down.notes.join(" ")).toContain("last capture");
    expectSoundMarkup(renderOverview({ overview: down, csrf: "c", nonce: "n" }).split('<main id="ops-main"')[1].split("</main>")[0].replace(/^[^>]*>/, ""));
  });

  test("?account= scopes the headline users/accounts and the funnel's 'Signed up' step the same way it scopes everything else (otto/mamoru#130)", () => {
    const overview = buildOverview(
      snap(),
      { daily: null, activity: null, signups: SIGNUPS, counts: { totalUsers: 999, totalAccounts: 999, last7d: 999 } },
      NOW,
      undefined,
      { ...DEFAULT_FILTER, account: "key-2" },
    );
    // Without the account filter, `inputs.counts` (999) would win; with it, the match (one account) does.
    expect(overview.users).toBe(1);
    expect(overview.accounts).toBe(1);
    expect(overview.funnel[0]).toMatchObject({ label: "Signed up", count: 1 });
  });
});

describe("account-filter.ts / otto/mamoru#130", () => {
  test("matchesFilter: 'all' excludes nothing, test accounts included", () => {
    const test = acct(9, 1, 1, 1, 1, { isTest: true, env: "beta" });
    expect(matchesFilter(test, { ...DEFAULT_FILTER, env: "all" })).toBe(true);
    expect(matchesFilter(test, { ...DEFAULT_FILTER, env: "prod" })).toBe(false);
    expect(matchesFilter(test, { ...DEFAULT_FILTER, env: "beta" })).toBe(false);
    expect(matchesFilter(test, { ...DEFAULT_FILTER, env: "test" })).toBe(true);
    const beta = acct(10, 1, 1, 1, 1, { env: "beta" });
    expect(matchesFilter(beta, { ...DEFAULT_FILTER, env: "test" })).toBe(false);
    expect(matchesFilter(beta, { ...DEFAULT_FILTER, env: "beta" })).toBe(true);
    expect(matchesFilter(beta, { ...DEFAULT_FILTER, env: "prod" })).toBe(false);
  });

  test("matchesFilter: chain and account narrow further, on top of env", () => {
    const row = acct(11, 1, 1, 1, 1, { chainId: 8453, key: "key-eleven", address: "0xabc" });
    expect(matchesFilter(row, { ...DEFAULT_FILTER, chainId: 8453 })).toBe(true);
    expect(matchesFilter(row, { ...DEFAULT_FILTER, chainId: 1 })).toBe(false);
    expect(matchesFilter(row, { ...DEFAULT_FILTER, account: "eleven" })).toBe(true);
    expect(matchesFilter(row, { ...DEFAULT_FILTER, account: "0xABC" })).toBe(true);
    expect(matchesFilter(row, { ...DEFAULT_FILTER, account: "nope" })).toBe(false);
  });

  test("accountScopeSql: 'all' adds no predicate; 'test' ignores env; 'prod'/'beta' pin both columns", () => {
    expect(accountScopeSql({ env: "all", chainId: "all" }, "a")).toEqual({ sql: "", params: [] });
    expect(accountScopeSql({ env: "test", chainId: "all" }, "a")).toEqual({ sql: "a.is_test = 1", params: [] });
    expect(accountScopeSql({ env: "prod", chainId: "all" }, "a")).toEqual({ sql: "a.is_test = 0 AND a.env = ?", params: ["prod"] });
    expect(accountScopeSql({ env: "all", chainId: 8453 }, "a")).toEqual({ sql: "a.chain_id = ?", params: [8453] });
    expect(accountScopeSql({ env: "beta", chainId: 8453 }, "a")).toEqual({ sql: "a.is_test = 0 AND a.env = ? AND a.chain_id = ?", params: ["beta", 8453] });
  });

  test("isFullyUnscoped: true only for env=all with chain=all", () => {
    expect(isFullyUnscoped({ env: "all", chainId: "all" })).toBe(true);
    expect(isFullyUnscoped({ env: "all", chainId: 8453 })).toBe(false);
    expect(isFullyUnscoped({ env: "prod", chainId: "all" })).toBe(false);
    expect(isFullyUnscoped({ env: "test", chainId: "all" })).toBe(false);
  });

  test("filterQuery round-trips through parseAccountFilter; the default filter needs no query at all", () => {
    expect(filterQuery(DEFAULT_FILTER)).toBe("");
    const filter = { env: "beta" as const, chainId: 8453, account: "0xabc", group: "env" as const };
    const query = filterQuery(filter);
    expect(query).toBe("?env=beta&chain=8453&account=0xabc&group=env");
    expect(parseAccountFilter(new URLSearchParams(query.slice(1)))).toEqual(filter);
  });

  test("readSignupDays/readActivity fall back to the unfiltered query when is_test is not a column yet", async () => {
    const { db: scopedDb } = fakeDb({ missing: ["is_test"], tables: { users: SIGNUPS.users, accounts: SIGNUPS.accounts } });
    expect(await readSignupDays(scopedDb, { env: "prod", chainId: "all" })).toEqual({ users: SIGNUPS.users, accounts: SIGNUPS.accounts });
    const { db: activityDb } = fakeDb({ missing: ["is_test"], first: () => ({ first_day: "2026-09-26" }) });
    const activity = await readActivity(activityDb, "2026-09-18", { env: "prod", chainId: "all" });
    expect(activity?.firstDay).toBe("2026-09-26");
  });

  test("fetchInfraCounts: filtered reads scope the count; a missing column falls back to the global total for prod, to zero for beta/test", async () => {
    const { db } = fakeDb({ first: () => ({ total_users: 7, total_accounts: 8, last7d: 1 }) });
    expect(await fetchInfraCounts(db, { env: "prod", chainId: "all" })).toEqual({ totalUsers: 7, totalAccounts: 8, last7d: 1 });
    const { db: missing } = fakeDb({ missing: ["is_test"], first: () => ({ total_users: 7, total_accounts: 8, last7d: 1 }) });
    expect(await fetchInfraCounts(missing, { env: "prod", chainId: "all" })).toEqual({ totalUsers: 7, totalAccounts: 8, last7d: 1 });
    expect(await fetchInfraCounts(missing, { env: "beta", chainId: "all" })).toEqual({ totalUsers: 0, totalAccounts: 0, last7d: 0 });
    expect(await fetchInfraCounts(missing, { env: "test", chainId: "all" })).toEqual({ totalUsers: 0, totalAccounts: 0, last7d: 0 });
  });

  test("fetchInfraCounts: env=all with chain=all reads from `users` (a user without an account still counts); any narrower scope reads `accounts` instead", async () => {
    const { db } = fakeDb({
      first: (sql) => (sql.includes("FROM users") ? { total_users: 10, total_accounts: 9, last7d: 2 } : { total_users: 999, total_accounts: 999, last7d: 999 }),
    });
    expect(await fetchInfraCounts(db, { env: "all", chainId: "all" })).toEqual({ totalUsers: 10, totalAccounts: 9, last7d: 2 });
    expect(await fetchInfraCounts(db, { env: "all", chainId: 8453 })).toEqual({ totalUsers: 999, totalAccounts: 999, last7d: 999 });
    expect(await fetchInfraCounts(db, { env: "prod", chainId: "all" })).toEqual({ totalUsers: 999, totalAccounts: 999, last7d: 999 });
  });

  test("readSignupDays: env=all with chain=all reads the unfiltered users/accounts series; a narrower scope reads accounts only", async () => {
    const UNFILTERED = { users: [{ day: "2026-09-01", n: 5 }], accounts: [{ day: "2026-09-01", n: 4 }] };
    const { db } = fakeDb({ tables: { users: UNFILTERED.users, accounts: UNFILTERED.accounts } });
    expect(await readSignupDays(db, { env: "all", chainId: "all" })).toEqual(UNFILTERED);
    // A specific chain with env: "all" is necessarily accounts-based: both series come back as the `accounts`
    // fixture (readSignupDays' scoped query reads only one table), unlike the fully unscoped case above.
    const scoped = await readSignupDays(db, { env: "all", chainId: 8453 });
    expect(scoped?.accounts).toEqual(UNFILTERED.accounts);
  });

  test("rowsFromSnapshotByGroup: one row per (chain, env), test accounts excluded; collapseDailyV2 sums them back by filter", () => {
    const snapshot = snap({
      accounts: {
        totalUsers: 3,
        totalAccounts: 3,
        last7d: 0,
        rows: [acct(1, 2, 0, 0, 0, { env: "prod" }), acct(2, 3, 0, 0, 0, { env: "beta" }), acct(3, 100, 0, 0, 0, { env: "prod", isTest: true })],
        tvlUsd: 105,
        idleUsdcUsd: 105,
        lpUsd: 0,
        gasReservesEth: 0,
      },
    });
    const rows = rowsFromSnapshotByGroup(snapshot, TODAY, () => 0);
    expect(rows).toHaveLength(2);
    const prod = rows.find((r) => r.env === "prod")!;
    const beta = rows.find((r) => r.env === "beta")!;
    expect(prod).toMatchObject({ day: TODAY, chain_id: 8453, accounts: 1, idle_usdc_usd: 2 });
    expect(beta).toMatchObject({ day: TODAY, chain_id: 8453, accounts: 1, idle_usdc_usd: 3 });

    // DailyRowV2 carries no relayer_eth/eth_usd (otto/mamoru#130: those are chain-level, in metrics_daily_chain).
    const asV2 = (r: DailyRow, env: string): DailyRowV2 => {
      const { relayer_eth: _relayerEth, eth_usd: _ethUsd, ...rest } = r;
      return { ...rest, chain_id: 8453, env };
    };
    const both = [asV2(daily("2026-09-30"), "prod"), asV2(daily("2026-09-30", { tvl_usd: 8, users: 2 }), "beta")];
    expect(collapseDailyV2(both, { env: "all", chainId: "all" })[0]).toMatchObject({ tvl_usd: 48, users: 32, relayer_eth: 0, eth_usd: 0 });
    expect(collapseDailyV2(both, { env: "prod", chainId: "all" })[0]).toMatchObject({ tvl_usd: 40, users: 30 });
    expect(collapseDailyV2(both, { env: "test", chainId: "all" })).toEqual([]);
  });

  test("rowsFromSnapshotByGroup: groupCounts (otto/mamoru#130) overrides the capped on-chain users/accounts, and adds a group the on-chain cap left out entirely", () => {
    const snapshot = snap({
      accounts: {
        totalUsers: 1,
        totalAccounts: 1,
        last7d: 0,
        rows: [acct(1, 2, 0, 0, 0, { env: "prod" })],
        tvlUsd: 2,
        idleUsdcUsd: 2,
        lpUsd: 0,
        gasReservesEth: 0,
      },
    });
    const groupCounts = new Map([
      ["8453:prod", { users: 900, accounts: 900 }],
      ["8453:beta", { users: 40, accounts: 40 }],
    ]);
    const rows = rowsFromSnapshotByGroup(snapshot, TODAY, () => 0, groupCounts);
    expect(rows).toHaveLength(2);
    const prod = rows.find((r) => r.env === "prod")!;
    const beta = rows.find((r) => r.env === "beta")!;
    // The capped on-chain sample only had 1 prod row, but the uncapped grouped count wins.
    expect(prod).toMatchObject({ accounts: 900, users: 900, idle_usdc_usd: 2 });
    // A group fetchChainAccounts' cap left out of the on-chain sample entirely still gets a row.
    expect(beta).toMatchObject({ accounts: 40, users: 40, idle_usdc_usd: 0, funded_accounts: 0 });
  });
});

describe("metrics-charts.ts", () => {
  function chart(n: number, stacked: boolean) {
    const days = Array.from({ length: n }, (_, i) => addDays(TODAY, i - (n - 1)));
    return renderTimeChart({
      id: "t",
      title: "Value <held>",
      days,
      series: [
        { label: "Idle", tone: "stone", values: days.map((_, i) => 5 + i) },
        { label: "LP", tone: "emerald", values: days.map((_, i) => 20 + i * 3), dashed: !stacked },
      ],
      stacked,
      format: stacked ? "usd" : "int",
      emptyNote: "Nothing yet.",
      singleNote: "History starts today.",
    });
  }

  for (const stacked of [true, false]) {
    test(`time chart (${stacked ? "stacked" : "lines"}) is sound for 0, 1 and 30 points`, () => {
      for (const n of [0, 1, 2, 30]) {
        const html = chart(n, stacked);
        expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
        expect(html).toContain("<title");
        expect(html).toContain("Value &lt;held&gt;");
        const data = JSON.parse(html.match(/data-chart="([^"]*)"/)![1].replaceAll("&quot;", '"'));
        expect(data.p).toHaveLength(n);
        for (const p of data.p) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(100);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(100);
        }
      }
    });
  }

  test("zero points says so, one point stands alone, many points draw paths", () => {
    expect(chart(0, true)).toContain("Nothing yet.");
    expect(chart(0, true)).not.toContain("<path");
    const single = chart(1, true);
    expect(single).toContain("History starts today.");
    expect(single).toContain('class="stem s-emerald"');
    expect(single).not.toContain("<path");
    const many = chart(30, true);
    expect(many).not.toContain("History starts today.");
    expect(many.match(/<path /g)?.length).toBe(4);
    expect(many).toMatch(/d="M0,[\d.]+ L[\d.]+,/);
    expect(many.match(/class="dot /g)?.length).toBe(1);
  });

  test("all-zero values still draw on the baseline", () => {
    const html = renderTimeChart({
      id: "z",
      title: "Zero",
      days: ["2026-09-30", TODAY],
      series: [{ label: "A", tone: "ink", values: [0, 0] }],
      format: "usd",
      emptyNote: "",
      singleNote: "",
    });
    expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
    expect(html).toContain('d="M0,100 L100,100"');
  });

  test("bars: tracked, zero and untracked days; an empty set shows the note", () => {
    const html = renderBars({
      id: "d",
      title: "Active",
      slots: dauSlots(new Map([["2026-09-30", 0], [TODAY, 2]]), "2026-09-30", TODAY, 14),
      emptyNote: "Not recorded.",
    });
    expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
    expect(html.match(/class="bar rest"/g)?.length).toBe(12);
    expect(html).toContain('class="bar zero"');
    expect(html).toContain('class="bar today"');
    expect(html).not.toContain("Not recorded.");
    const empty = renderBars({ id: "d", title: "Active", slots: dauSlots(new Map(), null, TODAY, 14), emptyNote: "Not recorded." });
    expectSoundMarkup(empty.replace(/data-chart="[^"]*"/, ""));
    expect(empty).toContain("Not recorded.");
    expect(empty).not.toContain("tabindex");
  });

  test("funnel and tally render for empty and full inputs", () => {
    const html = renderFunnel(funnel([{ id: "a", label: "Signed up", count: 39 }, { id: "b", label: "Funded", count: 5 }, { id: "c", label: "In range", count: 0 }]));
    expectSoundMarkup(html);
    expect(html).toContain("13% of signed up");
    expect(html).toContain("0% of funded");
    expect(html).toContain("width:0%");
    expectSoundMarkup(renderFunnel(funnel([])));
    expect(renderTally(0)).toBe("");
    expect(renderTally(3).match(/class="tick/g)?.length).toBe(3);
    expect(renderTally(128)).toContain("and 78 more");
  });
});

describe("ops-metrics.ts render", () => {
  test("the page carries real text values, the nonce on both scripts, and the CSRF token", () => {
    const overview = buildOverview(snap(), { daily: null, activity: null, signups: SIGNUPS }, NOW);
    const html = renderOverview({ overview, csrf: "tok<en", nonce: "abc123", who: "ot@example.com" });
    expect(html).toContain('data-section="overview" aria-current="page">Pulse</a>');
    expect(html).toContain('<a class="minor" href="/ops/mails" data-section="mails">Waitlist and mail</a>');
    expect(html).toContain(">$52.18<");
    expect(html).toContain("History starts today");
    expect(html).toContain("Activity is not being recorded yet.");
    expect(html).toContain('action="/ops/metrics/snapshot"');
    expect(html).toContain('value="tok&lt;en"');
    expect(html).toContain('href="/ops/infra"');
    expect(html.match(/<script nonce="abc123">/g)?.length).toBe(4);
    expect(html.match(/<script/g)?.length).toBe(4);
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org|basescan\.org)/);
  });

  test("the refresh form carries the current filter on its action, so refreshing a non-default view does not silently repaint the default one (otto/mamoru#130)", () => {
    const overview = buildOverview(snap(), { daily: null, activity: null, signups: SIGNUPS }, NOW, undefined, {
      env: "beta",
      chainId: 8453,
      account: "key-2",
      group: "env",
    });
    const html = renderOverview({ overview, csrf: "c", nonce: "n" });
    expect(html).toContain('action="/ops/metrics/snapshot?env=beta&amp;chain=8453&amp;account=key-2&amp;group=env"');
  });
});

describe("worker.ts gate for the overview", () => {
  function opsEnv(extra: Partial<Env> = {}): Env {
    return {
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      OPS_SESSION_SECRET: "k1",
      ...extra,
    };
  }

  test("no session: sections go to Google, the snapshot POST does not exist", async () => {
    const env = opsEnv();
    const overview = await worker.fetch(new Request("https://mamoru.lol/ops"), env);
    expect(overview.status).toBe(302);
    expect(overview.headers.get("location") ?? "").toContain("https://accounts.google.com/");
    const mails = await worker.fetch(new Request("https://mamoru.lol/ops/mails"), env);
    expect(mails.status).toBe(302);
    expect(mails.headers.get("location") ?? "").toContain("https://accounts.google.com/");
    expect(await mails.text()).not.toContain("On the list");
    const post = await worker.fetch(new Request("https://mamoru.lol/ops/metrics/snapshot", { method: "POST" }), env);
    expect(post.status).toBe(404);
  });

  test("a session removed from the allowlist is denied on all three", async () => {
    const env = opsEnv();
    const cookie = `mamoru_list=${await sealSession("k1", "someone@example.com")}`;
    for (const [path, method] of [["/ops", "GET"], ["/ops/mails", "GET"], ["/ops/metrics/snapshot", "POST"]] as const) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`, { method, headers: { cookie } }), env);
      expect(res.status).toBe(404);
    }
  });

  test("the snapshot POST needs the CSRF token and writes nothing without it", async () => {
    const { db, calls } = fakeDb();
    const env = opsEnv({ MAMORU_DB: db });
    const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/metrics/snapshot", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "csrf=wrong",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ops");
    expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_flash=bad");
    expect(calls).toHaveLength(0);
  });

  test("mail actions land back on /ops/mails, and the list is served there", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    };
    const env = opsEnv({ WAITLIST: kv });
    const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
    const page = await worker.fetch(new Request("https://mamoru.lol/ops/mails", { headers: { cookie } }), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("On the list");
    expect(html).toContain('data-section="mails" aria-current="page">Waitlist and mail</a>');
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const removed = await worker.fetch(
      new Request("https://mamoru.lol/ops/remove", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `csrf=${encodeURIComponent(csrf)}&email=a%40b.co`,
      }),
      env,
    );
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/ops/mails");
  });
});
