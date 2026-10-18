import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER } from "../src/account-filter";
import type { AccountSnapshotRow, DailyLedgerRow, PositionDailyRow } from "../src/yield-store";
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

const EMPTY_INPUTS: YieldInputs = { snapshots: null, daily: null, positionDaily: null };

describe("buildYieldOverview: empty states", () => {
  test("missing 0009 (snapshots or daily unreadable) wins over everything else", () => {
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
    const o = buildYieldOverview({ snapshots: [snap], daily: [], positionDaily: [] }, DEFAULT_FILTER, "7d", NOW, 2000, false);
    expect(o.missing0009).toBe(false);
    expect(o.flagOn).toBe(false);
    expect(o.noRows).toBe(false);
    expect(o.accounts).toEqual([]);
  });

  test("flag on, zero accounts matched: waiting for the first snapshot", () => {
    const o = buildYieldOverview({ snapshots: [], daily: [], positionDaily: [] }, DEFAULT_FILTER, "7d", NOW, 2000, true);
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
    const o = buildYieldOverview({ snapshots: [snap], daily: [], positionDaily: null }, DEFAULT_FILTER, "7d", NOW, 2000, true);
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
  const daily: DailyLedgerRow[] = [
    { day: "2026-10-16", accountKey: "acc1", feesOpenUsd: 0, feesCloseUsd: 1, lpCloseUsd: 100, collectedUsd: null, gasPaidWei: null },
    { day: "2026-10-17", accountKey: "acc1", feesOpenUsd: 1, feesCloseUsd: 1.5, lpCloseUsd: 120, collectedUsd: 0.5, gasPaidWei: "2000000000000000" },
    { day: "2026-10-18", accountKey: "acc1", feesOpenUsd: 1.5, feesCloseUsd: 2, lpCloseUsd: 130, collectedUsd: null, gasPaidWei: null },
  ];
  const positionDaily: PositionDailyRow[] = [
    { day: "2026-10-17", accountKey: "acc1", tokenId: 1, valueUsd: 120, accruedUsdClose: 0.2, holdValueUsd: 118, collectedUsd: 0.5 },
    { day: "2026-10-18", accountKey: "acc1", tokenId: 1, valueUsd: 130, accruedUsdClose: 0.3, holdValueUsd: 125, collectedUsd: null },
  ];
  const inputs: YieldInputs = { snapshots: [acc1, acc2], daily, positionDaily };

  test("per-account figures: earned so far = accrued + lifetime collected (loadYieldLedger's rule)", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    const a2 = o.accounts.find((a) => a.accountKey === "acc2")!;
    expect(a1.collectedToDateUsd).toBeCloseTo(0.5, 6);
    expect(a1.earnedToDateUsd).toBeCloseTo(0.3 + 0.5, 6);
    expect(a1.gasRecorded).toBe(true);
    // gasToDate = earnedToDate - netToDate = 0.002 ETH * $2000 = $4.
    expect(a1.earnedToDateUsd - a1.netToDateUsd).toBeCloseTo(4, 6);
    // acc2 never had a daily row: no period fees, no APR, earned so far is just its current accrued.
    expect(a2.collectedToDateUsd).toBe(0);
    expect(a2.earnedToDateUsd).toBeCloseTo(0.05, 6);
    expect(a2.gasRecorded).toBe(false);
    expect(a2.aprPeriodPct).toBeNull();
  });

  test("fees earned in the period: sum(fees_close - fees_open + collected) over the account_daily rows in range", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    // (1-0+0) + (1.5-1+0.5) + (2-1.5+0) = 1 + 1 + 0.5 = 2.5
    expect(a1.feesEarnedPeriodUsd).toBeCloseTo(2.5, 6);
    expect(a1.gasRecordedInPeriod).toBe(true);
  });

  test("value vs hold: this account's open positions on its own current day, value + accrued - hold", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    // Day 2026-10-18 (acc1's readAt day): 130 + 0.3 - 125 = 5.3
    expect(a1.vsHoldUsd).toBeCloseTo(5.3, 6);
    const p1 = a1.positions.find((p) => p.tokenId === 1)!;
    expect(p1.vsHoldUsd).toBeCloseTo(5.3, 6);
    // Lifetime collected for this position: only the 2026-10-17 row has one.
    expect(p1.collectedUsd).toBeCloseTo(0.5, 6);
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
    // Period fees total 2.5 (only acc1 has rows); period gas is 0.002 ETH * $2000 = $4.
    expect(withPrice.netYieldPeriodUsd).toBeCloseTo(2.5 - 4, 6);

    const noPrice = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, null, true);
    expect(noPrice.netYieldIsNet).toBe(false);
    expect(noPrice.netYieldPeriodUsd).toBeCloseTo(2.5, 6);
  });

  test("daily bars span the period and carry gas only on days it was recorded", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "7d", NOW, 2000, true);
    const byDay = new Map(o.dailyBars.map((b) => [b.day, b]));
    expect(byDay.get("2026-10-16")?.feesUsd).toBeCloseTo(1, 6);
    expect(byDay.get("2026-10-16")?.gasUsd).toBeNull();
    expect(byDay.get("2026-10-17")?.gasUsd).toBeCloseTo(4, 6);
    expect(o.dailyBars[0]!.day).toBe("2026-10-12");
    expect(o.dailyBars[o.dailyBars.length - 1]!.day).toBe("2026-10-18");
  });

  test("24h period narrows to the single most recent day", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "24h", NOW, 2000, true);
    expect(o.periodDays).toBe(1);
    const a1 = o.accounts.find((a) => a.accountKey === "acc1")!;
    expect(a1.feesEarnedPeriodUsd).toBeCloseTo(0.5, 6);
  });

  test("all period spans since the earliest account_daily row", () => {
    const o = buildYieldOverview(inputs, DEFAULT_FILTER, "all", NOW, 2000, true);
    expect(o.periodDays).toBe(3);
    expect(o.dailyBars[0]!.day).toBe("2026-10-16");
  });
});
