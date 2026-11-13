import { describe, expect, test } from "bun:test";
import { WAR_POOLS, changePct, edgeDistancePct, fallBpsOf, guardVerdict, marketOf, priceOfTick, type CumulativePoint } from "../src/war-room-math";
import { closeTo, cumulativeFrom, isEmptied, readSpan, poolDisplay, exposureOf, guardMetric, renderWarRoom, warRoomSection } from "../src/war-room";
import { OPS_SECTIONS } from "../src/ops";
import { warRoomFixture } from "./war-room-fixture";

const W = 1800;
const NOW = 1_800_000_000;

/** 50 grid points (now - 49 windows .. now) whose mean ticks are `means` (49 of them), exactly on the grid. */
function grid(means: number[]): CumulativePoint[] {
  const pts: CumulativePoint[] = [];
  let cum = 0n;
  for (let k = 0; k <= 49; k++) {
    if (k > 0) cum += BigInt(Math.round(means[k - 1]! * W));
    pts.push({ time: NOW - (49 - k) * W, tickCumulative: cum });
  }
  return pts;
}

describe("war room math", () => {
  test("prices follow the registry token order and decimals", () => {
    const [eth, btc] = WAR_POOLS;
    // WETH (18) is token0, USDC (6) token1: price = 1.0001^tick * 1e12.
    expect(priceOfTick(eth!, Math.log(2000e-12) / Math.log(1.0001))).toBeCloseTo(2000, 6);
    // USDC (6) is token0, cbBTC (8) token1: BTC price = 100 / 1.0001^tick.
    expect(priceOfTick(btc!, Math.log(100 / 70000) / Math.log(1.0001))).toBeCloseTo(70000, 4);
  });

  test("hand-computed fall and volatility: flat day, then a last window at mean tick -1000", () => {
    const means = Array<number>(49).fill(0);
    means[48] = -1000;
    const pts = grid(means);
    const m = marketOf(NOW, W, cumulativeFrom(pts));
    expect(m.twap24hAgoTick).toBe(0);
    // sqrt((((-1000 * ln 1.0001)^2) / 48) * (365 * 86400 / 1800)) = 1.9104 -> 19104 bps
    expect(m.realizedVol24hBps).toBe(19104);
    // WETH is token0: 1 - 1.0001^-1000 = 0.0952 -> 952 bps fall. cbBTC is token1: the same move is a rise, -1052.
    expect(fallBpsOf(true, 0, -1000)).toBe(952);
    expect(fallBpsOf(false, 0, -1000)).toBe(-1052);
    const [eth, btc] = WAR_POOLS;
    expect(guardMetric(eth!, NOW, pts)).toEqual({ fallBps: 952, volBps: 19104 });
    expect(guardMetric(btc!, NOW, pts)).toEqual({ fallBps: -1052, volBps: 19104 });
  });

  test("a missing or stale point makes the rule abstain", () => {
    const pts = grid(Array<number>(49).fill(5));
    expect(guardMetric(WAR_POOLS[0]!, NOW, pts.slice(5))).toBeNull();
    const late = pts.map((p, i) => (i === 10 ? { ...p, time: p.time - W / 2 } : p));
    expect(marketOf(NOW, W, cumulativeFrom(late))).toEqual({ twap24hAgoTick: null, realizedVol24hBps: null });
  });

  test("verdict needs both thresholds", () => {
    const t = { fallBps: 900, volBps: 10000 };
    expect(guardVerdict({ fallBps: 900, volBps: 10000 }, t).wouldTrigger).toBe(true);
    expect(guardVerdict({ fallBps: 950, volBps: 9999 }, t).wouldTrigger).toBe(false);
    expect(guardVerdict(null, t)).toEqual({ metric: null, wouldTrigger: false });
  });

  test("change and edge distance", () => {
    expect(changePct(1951, 2045)).toBeCloseTo(-4.596, 2);
    expect(changePct(null, 1)).toBeNull();
    expect(edgeDistancePct(0, -100, 200)).toBeCloseTo((1 - 1.0001 ** -100) * 100, 9);
  });
});

describe("war room page", () => {
  test("exposure sums snapshots per chain and pool", () => {
    const row = (chain: number, v: string, inRange: boolean) => ({
      chain_id: chain, read_at: "2026-11-13T10:00:00Z", idle_usdc: 1_000_000, lp_usdc: 2_000_000, fees_usdc: 500_000,
      positions_json: JSON.stringify([{ pool: "0x6c561B446416E1A00E8E93E221854d6eA4171372", inRange, valueUsdc: v }]),
    });
    const [base] = exposureOf([row(8453, "1500000", true), row(8453, "500000", false)]);
    expect(base).toMatchObject({ chainId: 8453, accounts: 2, idleUsd: 2, lpUsd: 4, feesUsd: 1 });
    expect(base!.pools).toEqual([{ pool: "pool:WETH/USDC/3000", positions: 2, inRange: 1, valueUsd: 2 }]);
  });

  test("renders the fixture: figures, guard state, Monad price note, no emoji or secrets", () => {
    const html = renderWarRoom(warRoomFixture());
    for (const s of ["$1,951.00", "$69,324", "disabled for production", "Would freeze", "Price not measured: no Monad pool snapshots.", "−$6.66", "101.75", "486.69", "11 of 11", "not shown", "48 h"]) {
      if (s === "Would freeze") expect(html).not.toContain(s);
      else expect(html).toContain(s);
    }
    expect(html).not.toMatch(/https?:\/\/|@|0x[0-9a-f]{6}/i);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test("a triggering metric and missing data read plainly", () => {
    const d = warRoomFixture();
    d.guard[0] = { ...d.guard[0]!, verdict: { metric: { fallBps: 950, volBps: 12000 }, wouldTrigger: true }, fallBps: 950, volBps: 12000 };
    d.guard[1] = { ...d.guard[1]!, fallBps: null, volBps: null, verdict: { metric: null, wouldTrigger: false } };
    const html = renderWarRoom(d);
    expect(html).toContain("Would freeze entries");
    expect(html).toContain("Data insufficient");
  });

  test("the section is in the rail, not a primary tab", () => {
    const s = OPS_SECTIONS.find((x) => x.id === "war-room")!;
    expect(s).toMatchObject({ href: "/ops/war-room", group: "Grow" });
    expect(s.tab).toBeUndefined();
    expect(warRoomSection(warRoomFixture()).section).toBe("war-room");
  });
});

describe("war room: block bounds and emptied pools", () => {
  test("a reference snapshot stands for its time only when close enough", () => {
    expect(closeTo({ block_time: 1000 - 600 }, 1000, 3600)).not.toBeNull();
    expect(closeTo({ block_time: 1000 - 2000 }, 1000, 3600)).toBeNull();
    expect(closeTo({ block_time: 1000 - 10_000 }, 1000, 7 * 86_400)).not.toBeNull();
    expect(closeTo(null, 1000, 3600)).toBeNull();
  });
  test("exposure reads name the oldest read once it is over an hour old", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(readSpan({ readAt: "2026-11-13T11:58:00Z", oldestReadAt: "2026-11-13T11:30:00Z" }, now)).not.toContain("oldest");
    expect(readSpan({ readAt: "2026-11-13T11:58:00Z", oldestReadAt: "2026-11-12T11:00:00Z" }, now)).toContain("oldest");
  });
  test("a stopped feed never reads Clear", () => {
    const d = warRoomFixture();
    d.guard = d.guard.map((g) => ({ ...g, stale: true }));
    const html = renderWarRoom(d);
    expect(html).toContain("Feed stopped");
    expect(html).not.toContain(">Clear<");
  });
  test("a pool under 10% of entry still shows its loss figure", () => {
    const html = renderWarRoom(warRoomFixture());
    expect(html).toContain("−$78.26");
    expect(html).toContain("emptied exit or a real loss");
  });
  test("a pool holding under 10% of its entry value is emptied, not a loss", () => {
    expect(isEmptied({ valueUsd: 0.27, holdUsd: 78.53 })).toBe(true);
    expect(isEmptied({ valueUsd: 2322.75, holdUsd: 2329.41 })).toBe(false);
    expect(isEmptied({ valueUsd: 0, holdUsd: 0 })).toBe(false);
  });
});

test("pool labels drop the prefix and show the fee tier", () => {
  expect(poolDisplay("pool:WETH/USDC/3000")).toBe("WETH/USDC 0.3%");
  expect(poolDisplay("pool:USDC/USDT/100")).toBe("USDC/USDT 0.01%");
  expect(poolDisplay("0xabc")).toBe("0xabc");
});
