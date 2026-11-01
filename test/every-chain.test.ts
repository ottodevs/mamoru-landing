import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeFunctionResult, parseAbi } from "viem";
import { heldElsewhere, loadConsole } from "../src/console-data";
import { accountsView, pulseSection } from "../src/console-views";
import type { D1Db } from "../src/d1-infra";
import { buildFundsMap } from "../src/funds-map";
import type { AccountView, InfraSnapshot } from "../src/infra-snapshot";
import { monUsdFromSqrt, parseMonadAggregate, readMonadHoldings, toMonadHolding } from "../src/monad-holdings";

// otto/mamoru-astro#39: every balance of every Safe on every chain counts in /ops.

const view = (o: Partial<AccountView> = {}): AccountView => ({
  accountKey: "c9d4179b…",
  key: "c9d4179b-3a2d-4ca6-9704-d1cc6caefbff",
  userId: "u1",
  address: "0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D",
  basescanUrl: "",
  chainId: 8453,
  env: "prod",
  isTest: false,
  usdcIdle: 0,
  lpUsd: 0,
  ethBalance: 0,
  positions: 0,
  inRange: 0,
  outside: { eth: 0, usdc: 0, usd: 0 },
  monad: { mon: 0, usdc: 0, positions: 0, usd: 0 },
  ...o,
});

const snapOf = (rows: AccountView[], ethUsd: number | null = 2265): InfraSnapshot =>
  ({
    asOf: "2026-11-01T05:00:00Z",
    ethUsd,
    btcUsd: null,
    relayer: { address: "0x1", basescanUrl: "", ethBalance: 0.01, usd: 22.65, status: "ok" },
    cost: null,
    funding: [],
    accounts: { totalUsers: rows.length, totalAccounts: rows.length, last7d: 0, rows, tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0 },
  }) as unknown as InfraSnapshot;

describe("Monad reader", () => {
  const abi = parseAbi(["struct Result { bool success; bytes returnData; }", "function aggregate3((address,bool,bytes)[] calls) returns (Result[] returnData)"]);
  const w = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
  const enc = (words: (bigint | null)[]) =>
    encodeFunctionResult({ abi, functionName: "aggregate3", result: words.map((x) => ({ success: x !== null, returnData: x === null ? "0x" : w(x) })) });

  test("four sub-calls per address; any failed one leaves that address not read", () => {
    const out = parseMonadAggregate(["0xa", "0xb"], enc([10n ** 18n, 5_000_000n, 0n, 1n, 1n, null, 0n, 0n]));
    expect(out[0]).toEqual({ monWei: 10n ** 18n, usdcRaw: 5_000_000n, wmonWei: 0n, nfts: 1n });
    expect(out[1]).toBeNull();
  });

  test("a held position or unpriced MON is never a number; plain USDC is", () => {
    expect(toMonadHolding({ monWei: 0n, usdcRaw: 7_500_000n, wmonWei: 0n, nfts: 0n }, null).usd).toBe(7.5);
    expect(toMonadHolding({ monWei: 10n ** 18n, usdcRaw: 0n, wmonWei: 0n, nfts: 0n }, null).usd).toBeNull();
    expect(toMonadHolding({ monWei: 10n ** 18n, usdcRaw: 0n, wmonWei: 10n ** 18n, nfts: 0n }, 0.05)).toEqual({ mon: 2, usdc: 0, positions: 0, usd: 0.1 });
    expect(toMonadHolding({ monWei: 0n, usdcRaw: 1n, wmonWei: 0n, nfts: 2n }, 0.05)).toMatchObject({ positions: 2, usd: null });
  });

  test("MON price from the pool's sqrtPriceX96 (WMON 18 decimals, USDC 6)", () => {
    // 0.04 USDC per MON: price1/0 = 0.04e-12; sqrt = 2e-7; times 2^96.
    const sqrt = BigInt(Math.round(2e-7 * 2 ** 96));
    expect(monUsdFromSqrt(sqrt)!).toBeCloseTo(0.04, 6);
    expect(monUsdFromSqrt(0n)).toBeNull();
  });

  test("every RPC down: nothing read, nothing invented, no throw", async () => {
    const m = await readMonadHoldings(["0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D"], { fetchFn: async () => new Response("no", { status: 502 }) });
    expect(m.size).toBe(0);
  });
});

describe("every Safe balance counts", () => {
  test("a Safe with nothing on Base and ETH on Ethereum counts in full, named where it sits", () => {
    const e = heldElsewhere([view({ outside: { eth: 0.05537835, usdc: 0, usd: 125.42 } })], 2265);
    expect(e).toEqual({ usd: 125.42, floor: false, away: ["0.0554 ETH on Ethereum"] });
  });

  test("Safe gas on Base counts; an unread chain makes the figure a floor, never a zero", () => {
    const e = heldElsewhere([view({ ethBalance: 0.001, monad: undefined })], 2000);
    expect(e.usd).toBeCloseTo(2, 6);
    expect(e.floor).toBe(true);
  });

  test("Value held on the map is working + Safe gas + Ethereum + Monad", () => {
    const f = buildFundsMap(snapOf([]), [
      view({ lpUsd: 68, usdcIdle: 0.69, ethBalance: 0.001 }),
      view({ key: "k2", address: "0x2222222222222222222222222222222222222222", outside: { eth: 0.05537835, usdc: 0, usd: 125.42 }, monad: { mon: 0, usdc: 3, positions: 0, usd: 3 } }),
    ]);
    expect(f.partial).toBe(false);
    expect(f.total).toBeCloseTo(68.69 + 2.265 + 125.42 + 3, 6);
    expect(f.chains.map((c) => c.name)).toEqual(["Base", "Ethereum", "Monad"]);
  });

  test("a position on Monad is shown and makes the total a floor until it is priced", () => {
    const f = buildFundsMap(snapOf([]), [view({ monad: { mon: 0, usdc: 0, positions: 1, usd: null } })]);
    expect(f.partial).toBe(true);
    expect(f.chains.find((c) => c.name === "Monad")!.buckets.map((b) => b.id)).toContain("monad-positions");
  });
});

const SCHEMA = `
CREATE TABLE accounts (account_key TEXT PRIMARY KEY, user_id TEXT, chain_id INTEGER, address TEXT, created_at TEXT, env TEXT, is_test INTEGER);
CREATE TABLE account_snapshot_latest (chain_id INTEGER, address TEXT, account_key TEXT, env TEXT, block INTEGER, read_at TEXT, ok INTEGER, idle_usdc INTEGER, lp_usdc INTEGER, fees_usdc INTEGER, owed_usdc INTEGER, total_usdc INTEGER, positions_json TEXT, written_at TEXT);
INSERT INTO accounts VALUES ('c9d4179b-3a2d-4ca6-9704-d1cc6caefbff', 'u1', 8453, '0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D', '2026-10-20T00:00:00Z', 'prod', 0);
INSERT INTO accounts VALUES ('aaaa1111-0000-0000-0000-000000000000', 'u2', 8453, '0x2222222222222222222222222222222222222222', '2026-10-01T00:00:00Z', 'prod', 0);
INSERT INTO account_snapshot_latest VALUES (8453, '0xaf3f151b0b19f556c2f97c6225a1fd22cb9f703d', 'c9d4179b-3a2d-4ca6-9704-d1cc6caefbff', 'prod', 1, '2026-11-01T05:00:00Z', 1, 0, 0, 0, 0, 0, '[]', '2026-11-01T05:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0x2222222222222222222222222222222222222222', 'aaaa1111-0000-0000-0000-000000000000', 'prod', 1, '2026-11-01T05:00:00Z', 1, 690000, 68000000, 0, 0, 68690000, '[]', '2026-11-01T05:00:05Z');
`;

function db(): D1Db {
  const d = new Database(":memory:");
  d.exec(SCHEMA);
  const stmt = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    all: async <T,>() => {
      try {
        return { results: d.query(sql).all(...(binds as never[])) as T[] };
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    first: async <T,>() => (d.query(sql).get(...(binds as never[])) as T) ?? null,
    run: async () => d.query(sql).run(...(binds as never[])),
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Db;
}

describe("console views", () => {
  const rows = [
    view({ outside: { eth: 0.05537835, usdc: 0, usd: 125.42 } }),
    view({ key: "aaaa1111-0000-0000-0000-000000000000", accountKey: "aaaa1111…", address: "0x2222222222222222222222222222222222222222", lpUsd: 68, usdcIdle: 0.69 }),
  ];
  const now = new Date("2026-11-01T06:00:00Z");

  test("Pulse leads with Value held on every chain and carries the map", async () => {
    const m = await loadConsole(db(), "prod", now, snapOf(rows));
    const html = pulseSection(m, now).html;
    expect(html).toContain("Value held, every chain");
    expect(html).toContain("$194");
    expect(html).toContain('id="funds-map"');
    expect(html).toContain("At the Safes, not working");
    expect(html).not.toContain("<style");
  });

  test("Accounts lists a Safe with $0 on Base and ETH on Ethereum, at its full value", async () => {
    const m = await loadConsole(db(), "prod", now, snapOf(rows));
    const html = accountsView(m, now).html;
    expect(html).toContain("c9d4179b");
    expect(html).toContain("0.0554 ETH on Ethereum");
    expect(html).toContain("$125");
    expect(html.indexOf("c9d4179b")).toBeLessThan(html.indexOf("aaaa1111"));
  });
});
