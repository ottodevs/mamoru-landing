import type { WarRoomData } from "../src/war-room";

/** Realistic numbers for the preview and the render test: guard off at 900/10000, 11 WETH positions, Monad idle. */
export function warRoomFixture(nowIso = "2026-11-13T14:30:00.000Z"): WarRoomData {
  const now = Date.parse(nowIso) / 1000;
  return {
    asOf: nowIso,
    market: [
      { pool: "pool:WETH/USDC/3000", asset: "ETH", price: 1951.0, snapshotTime: now - 70, chg1h: -0.4, chg24h: (1951 / 2045 - 1) * 100, chg7d: -8.1, low24h: 1938.2, high24h: 2049.7 },
      { pool: "pool:USDC/cbBTC/500", asset: "BTC", price: 69324, snapshotTime: now - 70, chg1h: -0.3, chg24h: (69324 / 73302 - 1) * 100, chg7d: -6.2, low24h: 69010, high24h: 73410 },
    ],
    settings: {
      wide: {
        id: 7,
        createdAt: "2026-10-20T09:00:00.000Z",
        guardEnabled: false,
        eth: { fallBps: 900, volBps: 10000 },
        btc: { fallBps: 700, volBps: 8000 },
        rerange: { mode: "lazy", maxPerWeek: 2, maxWaitSeconds: 172800, edgeBufferBps: 50, costTest: "veto" },
        accounts: null,
      },
      canary: null,
    },
    guard: [
      { pool: "pool:WETH/USDC/3000", asset: "ETH", fallBps: 462, volBps: 5210, threshold: { fallBps: 900, volBps: 10000 }, verdict: { metric: { fallBps: 462, volBps: 5210 }, wouldTrigger: false } },
      { pool: "pool:USDC/cbBTC/500", asset: "BTC", fallBps: 543, volBps: 4380, threshold: { fallBps: 700, volBps: 8000 }, verdict: { metric: { fallBps: 543, volBps: 4380 }, wouldTrigger: false } },
    ],
    exposure: [
      {
        chainId: 8453,
        accounts: 4,
        idleUsd: 101.75,
        lpUsd: 2322.75,
        feesUsd: 3.41,
        readAt: new Date((now - 130) * 1000).toISOString(),
        pools: [{ pool: "pool:WETH/USDC/3000", positions: 11, inRange: 11, valueUsd: 2322.75 }],
      },
      {
        chainId: 143,
        accounts: 3,
        idleUsd: 486.69,
        lpUsd: 614,
        feesUsd: 0.9,
        readAt: new Date((now - 150) * 1000).toISOString(),
        pools: [{ pool: "pool:WMON/USDC", positions: 7, inRange: 7, valueUsd: 614 }],
      },
    ],
    yieldToday: { day: nowIso.slice(0, 10), rows: [{ chainId: 8453, valueUsd: 2322.75, holdUsd: 2329.41, feesUsd: 1.84 }] },
  };
}
