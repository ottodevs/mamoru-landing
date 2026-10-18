import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER } from "../src/account-filter";
import type { AccountAggregates, AccountSnapshotRow, DayAggregate, GasRow, PositionLatest } from "../src/yield-store";
import { buildYieldOverview, parseYieldPeriod, type YieldInputs } from "../src/yield-overview";

const NOW = new Date("2026-10-18T10:00:00Z");

describe("parseYieldPeriod", () => {
  test("only the four known values parse; anything else defaults to 7d", () => {
    expect(parseYieldPeriod("24h")).toBe("24h");
    expect(parseYieldPeriod("30d")).toBe("30d");
    expect(parseYieldPeriod("all")).toBe("all");
    expect(parseYieldPeriod("7d")).toBe("7d");
    expect(parseYieldPeriod("whatever")).toBe("7d");
    expect(parseYieldPeriod(null)).toBe("7d");
    expect(parseYieldPeriod(undefined)).toBe("7d");
  });
});

const EMPTY_INPUTS: YieldInputs = { snapshots: null, accountAggregates: null, gasRows: null, dailyAggregates: null, earliestDay: null, positionLatest: null, positionCollected: null };

describe("buildYieldOverview: empty states", () => {
  test("missing 0009 (snapshots or account aggregates unreadable) wins over everything else", () => {
    const o = buildYieldOverview(EMPTY_INPUTS, DEFAULT_FILTER, "7d", NOW, 2000, true);
    expect(o.missing0009).toBe(true);
    expect(o.accounts).toEqual([]);
    expect(o.noRows).toBe(false);
  });

  test("flag off: shown even when rows happen to exist", () => {
    const snap: AccountSnapshotRow = {
      chainId: 8453, address: "0xabc", accountKey: "acc1", env: "prod", isTest: false,
      readAt: "2026-10-18T09:00:00Z", idleUsd: 0, lpUsd: 10, feesUsd: 1, totalUsd: 11, positions: [],
    };
    const o = buildYieldOverview(
      { snapshots: [snap], accountAggregates: new Map(), gasRows: [], dailyAggregates: [], earliestDay: null, positionLatest: [], positionCollected: new Map() },
      DEFAULT_FILTER, "7d", NOW, 2000, false,
    );
    expect(o.missing0009).toBe(false);
    expect(o.flagOn).toBe(false);
    expect(o.noRows).toBe(false);
    expect(o.accounts).toEqual([]);
  });

  test("flag on, zero accounts matched: waiting for the first snapshot", () => {
    const o = buildYieldOverview(
      { snapshots: [], accountAggregates: new Map(), gasRows: [], dailyAggregates: [], earliestDay: null, positionLatest: [], positionCollected: new Map() },
      DEFAULT_FILTER, "7d", NOW, 2000, true,
    );
    expect(o.missing0009).toBe(false);
    expect(o.flagOn).toBe(true);
    expect(o.noRows).toBe(true);
  });

  test("migration 0010 missing degrades vs-hold/collected but does not block the page", () => {
    const snap: AccountSnapshotRow = {
      chainId: 8453, address: "0xabc", accountKey: "acc1", env: "prod", isTest: false,
      readAt: "2026-10-18T09:00:00Z", idleUsd: 0, lpUsd: 10, feesUsd: 1, totalUsd: 11,
      positions: [{ tokenId: 1, pool: "pool:USDC/ETH/500", inRange: true, valueUsd: 10, feesUsd: 1 }],
    };
    const o = buildYieldOverview(
      { snapshots: [snap], accountAggregates: new Map(), gasRows: [], dailyAggregates: [], earliestDay: null, positionLatest: null, positionCollected: null },
      DEFAULT_FILTER, "7d", NOW, 2000, true,
    );
    expect(o.missing0009).toBe(false);
    expect(o.missing0010).toBe(true);
    expect(o.noRows).toBe(false);
    expect(o.accounts[0]!.vsHoldUsd).toBeNull();
    expect(o.accounts[0]!.positions[0]!.collectedUsd).toBeNull();
    expect(o.accounts[0]!.positions[0]!.vsHoldUsd).toBeNull();
  });
});

describe("buildYieldOverview: full scenario, matches loadYieldLedger's formulas", () => {
  const acc1: AccountSnapshotRow = {
    chainId: 8453, address: "0xacc1", accountKey: "acc1", env: "prod", isTest: false,
    readAt: "2026-10-18T09:00:00Z", idleUsd: 0, lpUsd: 130, feesUsd: 0.3, totalUsd: 130.3,
    positions: [{ tokenId: 1, pool: "pool:USDC/ETH/500", inRange: true, valueUsd: 130, feesUsd: 0.3 }],
  };
  const acc2: AccountSnapshotRow = {
    chainId: 8453, address: "0xacc2", accountKey: "acc2", env: "prod", isTest: false,
    readAt: "2026-10-17T12:00:00Z", idleUsd: 0, lpUsd: 10, feesUsd: 0.05, totalUsd: 10.05,
    positions: [{ tokenId: 2, pool: "pool:USDC/WBTC/3000", inRange: false, valueUsd: 10, feesUsd: 0.05 }],
  };
  const accountAggregates = new Map<string, AccountAggregates>([
    ["acc1", { accountKey: "acc1", collectedToDateUsd: 0.5, feesEarnedPeriodUsd: 2.5, avgLpPeriodUsd: (100 + 120 + 130) / 3 }],
    // acc2 has no entry at all: it has never had an account_daily row.
  ]);
  const gasRows: GasRow[] = [{ accountKey: "acc1", day: "2026-10-17", gasPaidWei: "2000000000000000" }];
  const dailyAggregates: DayAggregate[] = [
    { day: "2026-10-16", feesUsd: 1, lpUsdSum: 100 },
    { day: "2026-10-17", feesUsd: 1, lpUsdSum: 120 },
    { day: "2026-10-18", feesUsd: 0.5, lpUsdSum: 130 },
  ];
  const positionLatest: PositionLatest[] = [{ chainId: 8453, accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.3, holdValueUsd: 125 }];
  const positionCollected = new Map<string, number>([["8453:acc1:1", 0.5]]);
  const inputs: YieldInputs = { snapshots: [acc1, acc2], accountAggregates, gasRows, dailyAggregates, earliestDay: "2026-10-16", positionLatest, positionCollected };

  test("per-account figures: earned so far = accrued + lifetime collected (loadYieldLedger's rule)", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    const a2 = o.accounts.find((a) => a.accountKey === "acc2")!;
    expect(a1.collectedToDateUsd).toBeCloseTo(0.5, 6);
    expect(a1.earnedToDateUsd).toBeCloseTo(0.3 + 0.5, 6);
    expect(a1.gasRecorded).toBe(true);
    expect(a1.gasToDateUsd).toBeCloseTo(4, 6); // 0.002 ETH * $2000
    expect(a1.earnedToDateUsd - (a1.netToDateUsd ?? 0)).toBeCloseTo(4, 6);
    // acc2 never had a daily row: no period fees, no APR, earned so far is just its current accrued.
    expect(a2.collectedToDateUsd).toBe(0);
    expect(a2.earnedToDateUsd).toBeCloseTo(0.05, 6);
    expect(a2.gasRecorded).toBe(false);
    expect(a2.aprPeriodPct).toBeNull();
  });

  test("earned to date has exactly one source: a divergent position-level accrued never leaks into it", () => {
    // Position-daily's own accrued_usd_close (0.9, via positionLatest) deliberately differs from the
    // snapshot's accrued (acc1.feesUsd = 0.3): earnedToDateUsd must still read 0.3 + 0.5, never touch the
    // position-level number (code review, otto/mamoru-astro#20 PR #10).
    const divergentPositionLatest: PositionLatest[] = [{ chainId: 8453, accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.9, holdValueUsd: 125 }];
    const o = buildYieldOverview({ ...inputs, positionLatest: divergentPositionLatest }, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.earnedToDateUsd).toBeCloseTo(0.3 + 0.5, 6);
    expect(a1.collectedToDateUsd).toBeCloseTo(0.5, 6);
    // The divergent number does show up where it belongs: vs-hold and the position drill-down.
    expect(a1.vsHoldUsd).toBeCloseTo(130 + 0.9 - 125, 6);
    expect(a1.positions[0]!.vsHoldUsd).toBeCloseTo(130 + 0.9 - 125, 6);
  });

  test("fees earned in the period: sum(fees_close - fees_open + collected) over the account_daily rows in range", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.feesEarnedPeriodUsd).toBeCloseTo(2.5, 6);
  });

  test("value vs hold: this account's open positions on their own latest day, value + accrued - hold", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.vsHoldUsd).toBeCloseTo(130 + 0.3 - 125, 6);
    const p1 = a1.positions.find((p) => p.tokenId === 1)!;
    expect(p1.vsHoldUsd).toBeCloseTo(130 + 0.3 - 125, 6);
    expect(p1.collectedUsd).toBeCloseTo(0.5, 6);
  });

  test("the same account key, token id and value map keep two distinct vs-hold values on two different chains (code review, PR #10 round 2)", () => {
    // Same accountKey ("multi") and the same tokenId (7) on two chains: a token id is only unique within
    // its own chain, so a map keyed by account+token alone would collide these into one. positionKey()
    // must key by (chainId, accountKey, tokenId) so neither chain's figure overwrites the other's.
    const onBase: AccountSnapshotRow = {
      chainId: 8453, address: "0xmulti-base", accountKey: "multi", env: "prod", isTest: false,
      readAt: "2026-10-18T09:00:00Z", idleUsd: 0, lpUsd: 50, feesUsd: 0.1, totalUsd: 50.1,
      positions: [{ tokenId: 7, pool: "pool:base", inRange: true, valueUsd: 50, feesUsd: 0.1 }],
    };
    const onOtherChain: AccountSnapshotRow = {
      chainId: 10, address: "0xmulti-other", accountKey: "multi", env: "prod", isTest: false,
      readAt: "2026-10-18T09:00:00Z", idleUsd: 0, lpUsd: 60, feesUsd: 0.2, totalUsd: 60.2,
      positions: [{ tokenId: 7, pool: "pool:other", inRange: true, valueUsd: 60, feesUsd: 0.2 }],
    };
    const multiPositionLatest: PositionLatest[] = [
      { chainId: 8453, accountKey: "multi", tokenId: 7, valueUsd: 50, accruedUsdClose: 0.1, holdValueUsd: 40 }, // vsHold = 10.1
      { chainId: 10, accountKey: "multi", tokenId: 7, valueUsd: 60, accruedUsdClose: 0.2, holdValueUsd: 45 }, // vsHold = 15.2
    ];
    const o = buildYieldOverview(
      { snapshots: [onBase, onOtherChain], accountAggregates: new Map(), gasRows: [], dailyAggregates: [], earliestDay: null, positionLatest: multiPositionLatest, positionCollected: new Map() },
      DEFAULT_FILTER, "7d", NOW, 2000, true,
    );
    const base = o.accounts.find((a) => a.chainId === 8453)!;
    const other = o.accounts.find((a) => a.chainId === 10)!;
    expect(base.vsHoldUsd).toBeCloseTo(50 + 0.1 - 40, 6);
    expect(other.vsHoldUsd).toBeCloseTo(60 + 0.2 - 45, 6);
    expect(base.vsHoldUsd).not.toBeCloseTo(other.vsHoldUsd!, 6);
  });

  test("page-level aggregates: capital, fees to date, projected fee, sorted by fees earned desc", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    expect(o.capitalInPositionsUsd).toBeCloseTo(130 + 10, 6);
    expect(o.feesEarnedToDateUsd).toBeCloseTo(0.8 + 0.05, 6);
    expect(o.projectedFeeCollectedUsd).toBeCloseTo(0.5 * 0.1, 6);
    expect(o.projectedFeeUncollectedUsd).toBeCloseTo((0.3 + 0.05) * 0.1, 6);
    expect(o.accounts.map((a) => a.accountKey)).toEqual(["acc1", "acc2"]);
  });

  test("net yield: fees minus gas when gas was recorded anywhere in the period and a price is known", () => {
    const withPrice = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    expect(withPrice.netYieldIsNet).toBe(true);
    expect(withPrice.netYieldUnpriced).toBe(false);
    // Period fees total 2.5 (only acc1 has rows); period gas is 0.002 ETH * $2000 = $4.
    expect(withPrice.netYieldPeriodUsd).toBeCloseTo(2.5 - 4, 6);

    const noGas = buildYieldOverview({ ...inputs, gasRows: [] }, DEFAULT_FILTER, "7d", NOW, 2000, true);
    expect(noGas.netYieldIsNet).toBe(false);
    expect(noGas.netYieldUnpriced).toBe(false);
    expect(noGas.netYieldPeriodUsd).toBeCloseTo(2.5, 6);
  });

  test("gas recorded but no ETH price yet: unpriced, never a fabricated $0 of cost", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, null, true);
    expect(o.netYieldIsNet).toBe(false);
    expect(o.netYieldUnpriced).toBe(true);
    expect(o.netYieldPeriodUsd).toBeNull();
    expect(o.netYieldGasEth).toBeCloseTo(0.002, 9);

    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.gasRecorded).toBe(true);
    expect(a1.gasUnpriced).toBe(true);
    expect(a1.gasToDateEth).toBeCloseTo(0.002, 9);
    expect(a1.gasToDateUsd).toBeNull();
    expect(a1.netToDateUsd).toBeNull();
  });

  test("daily bars span the period and carry gas only on days it was recorded and priced", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const byDay = new Map(o.dailyBars.map((b) => [b.day, b]));
    expect(byDay.get("2026-10-16")?.feesUsd).toBeCloseTo(1, 6);
    expect(byDay.get("2026-10-16")?.gasUsd).toBeNull();
    expect(byDay.get("2026-10-17")?.gasUsd).toBeCloseTo(4, 6);
    expect(o.dailyBars[0]!.day).toBe("2026-10-12");
    expect(o.dailyBars[o.dailyBars.length - 1]!.day).toBe("2026-10-18");

    const unpriced = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, null, true);
    const byDayUnpriced = new Map(unpriced.dailyBars.map((b) => [b.day, b]));
    expect(byDayUnpriced.get("2026-10-17")?.gasUsd).toBeNull();
  });

  test("24h period narrows to the single most recent day", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "24h", NOW, 2000, true);
    expect(o.periodDays).toBe(1);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.feesEarnedPeriodUsd).toBeCloseTo(2.5, 6); // accountAggregates fixture is already period-scoped at the fetch layer
  });

  test("all period spans since the earliest account_daily row", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "all", NOW, 2000, true);
    expect(o.periodDays).toBe(3);
    expect(o.dailyBars[0]!.day).toBe("2026-10-16");
  });
});
