import { describe, expect, test } from "bun:test";
import {
  ACTIVATION_GAS,
  DEPLOY_GAS,
  RESERVE_WEI,
  accountsFunded,
  costPerAccount,
  relayerStatus,
  weiToEth,
} from "../src/cost";
import {
  positionAmounts,
  priceOfBaseInQuote,
  sqrtPriceX96ToPrice,
  valuePosition,
} from "../src/uniswap-math";
import { CBBTC_ADDRESS as CBBTC, USDC_ADDRESS, WETH_ADDRESS } from "../src/chain-addresses";
import { OPS_SECTIONS, renderNav, sealSession } from "../src/ops";
import { noticeFor, renderInfra } from "../src/ops-infra";
import { chooseReading, type InfraReading, isComplete, loadInfraReading } from "../src/infra-cache";
import { captureDaily, PARTIAL_MARK, rowFromSnapshot, snapshotHasChain, upsertSql } from "../src/metrics-store";
import type { D1Db, D1PreparedStatement, AccountRow } from "../src/d1-infra";
import type { BaseClient } from "../src/chain-client";
import {
  computeInfraSnapshot,
  decimalsOf,
  priceUsdOf,
  type InfraSnapshot,
} from "../src/infra-snapshot";
import worker, { type Env } from "../src/worker";

const Q96 = 2 ** 96;

function sqrtPriceX96For(token1PerToken0: number, decimals0: number, decimals1: number): bigint {
  const rawPrice = token1PerToken0 / 10 ** (decimals0 - decimals1);
  return BigInt(Math.round(Math.sqrt(rawPrice) * Q96));
}

describe("cost.ts", () => {
  test("costPerAccount: deploy + activation + fixed reserve", () => {
    const b = costPerAccount(1_000_000_000n); // 1 gwei
    expect(b.deployWei).toBe(DEPLOY_GAS * 1_000_000_000n);
    expect(b.activationWei).toBe(ACTIVATION_GAS * 1_000_000_000n);
    expect(b.reserveWei).toBe(RESERVE_WEI);
    expect(b.sunkWei).toBe(b.deployWei + b.activationWei);
    expect(b.totalWei).toBe(b.sunkWei + RESERVE_WEI);
    expect(weiToEth(b.totalWei)).toBeCloseTo(0.0148, 10);
  });

  test("costPerAccount clamps a negative gas price to zero", () => {
    const b = costPerAccount(-5n);
    expect(b.gasPriceWei).toBe(0n);
    expect(b.deployWei).toBe(0n);
  });

  test("accountsFunded floors and never goes negative", () => {
    const total = 10n;
    expect(accountsFunded(0n, total)).toBe(0);
    expect(accountsFunded(9n, total)).toBe(0);
    expect(accountsFunded(10n, total)).toBe(1);
    expect(accountsFunded(25n, total)).toBe(2);
    expect(accountsFunded(100n, 0n)).toBe(0);
  });

  test("relayerStatus thresholds", () => {
    expect(relayerStatus(3_000_000_000_000_000n)).toBe("ok");
    expect(relayerStatus(2_999_999_999_999_999n)).toBe("low");
    expect(relayerStatus(600_000_000_000_000n)).toBe("low");
    expect(relayerStatus(599_999_999_999_999n)).toBe("empty");
    expect(relayerStatus(0n)).toBe("empty");
    // The sanity-check number from the brief: ~0.0001 ETH is EMPTY.
    expect(relayerStatus(100_000_000_000_000n)).toBe("empty");
  });
});

describe("uniswap-math.ts", () => {
  test("sqrtPriceX96ToPrice: price 1 at sqrtPriceX96 = 2^96 with equal decimals", () => {
    expect(sqrtPriceX96ToPrice(BigInt(Q96), 18, 18)).toBeCloseTo(1, 9);
  });

  test("priceOfBaseInQuote is consistent regardless of token order", () => {
    const sqrtPriceX96 = sqrtPriceX96For(2500, 18, 6); // token0=WETH(18dec), token1=USDC(6dec)
    const decimalsOfToken = (addr: string) => (addr === WETH_ADDRESS ? 18 : 6);
    const ethInUsdc = priceOfBaseInQuote({
      sqrtPriceX96,
      base: WETH_ADDRESS,
      quote: USDC_ADDRESS,
      decimalsOf: decimalsOfToken,
    });
    expect(ethInUsdc).toBeCloseTo(2500, 6);
    const usdcInEth = priceOfBaseInQuote({
      sqrtPriceX96,
      base: USDC_ADDRESS,
      quote: WETH_ADDRESS,
      decimalsOf: decimalsOfToken,
    });
    expect(usdcInEth).toBeCloseTo(1 / 2500, 9);
  });

  test("positionAmounts: below range, above range, and in range", () => {
    const sqrtPriceX96AtTick0 = BigInt(Q96); // tick 0 => sqrtPrice = 1
    const below = positionAmounts({
      liquidity: 1_000_000n,
      tickLower: 100,
      tickUpper: 200,
      currentTick: 0,
      sqrtPriceX96: sqrtPriceX96AtTick0,
    });
    expect(below.inRange).toBe(false);
    expect(below.amount1Raw).toBe(0);
    expect(below.amount0Raw).toBeGreaterThan(0);

    const above = positionAmounts({
      liquidity: 1_000_000n,
      tickLower: -200,
      tickUpper: -100,
      currentTick: 0,
      sqrtPriceX96: sqrtPriceX96AtTick0,
    });
    expect(above.inRange).toBe(false);
    expect(above.amount0Raw).toBe(0);
    expect(above.amount1Raw).toBeGreaterThan(0);

    const inRange = positionAmounts({
      liquidity: 1_000_000n,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 0,
      sqrtPriceX96: sqrtPriceX96AtTick0,
    });
    expect(inRange.inRange).toBe(true);
    expect(inRange.amount0Raw).toBeGreaterThan(0);
    expect(inRange.amount1Raw).toBeGreaterThan(0);
  });

  test("valuePosition prices stables at $1, adds tokensOwed, and returns null usd for an unpriced token", () => {
    const pool = { sqrtPriceX96: BigInt(Q96), tick: 0 };
    const stableOnly = (t: string) => (t === USDC_ADDRESS ? 1 : null);
    const value = valuePosition(
      {
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        tickLower: -100,
        tickUpper: 100,
        liquidity: 1_000_000n,
        tokensOwed0: 0n,
        tokensOwed1: 1_000_000n, // 1 USDC of uncollected fees
      },
      pool,
      stableOnly,
      (t) => (t === WETH_ADDRESS ? 18 : 6),
    );
    // token0 (WETH) has no price here, so the position cannot be fully valued.
    expect(value.usd).toBeNull();
    expect(value.amount1).toBeGreaterThan(1); // includes the 1 USDC owed

    const bothPriced = valuePosition(
      {
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        tickLower: -100,
        tickUpper: 100,
        liquidity: 1_000_000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      },
      pool,
      (t) => (t === WETH_ADDRESS ? 2500 : 1),
      (t) => (t === WETH_ADDRESS ? 18 : 6),
    );
    expect(bothPriced.usd).not.toBeNull();
    expect(bothPriced.usd as number).toBeGreaterThan(0);
  });
});

describe("ops.ts nav", () => {
  test("OPS_SECTIONS is extensible and includes Overview + Mails + Infra", () => {
    expect(OPS_SECTIONS.map((s) => s.id)).toEqual(["overview", "mails", "infra", "experiments", "preview"]);
    expect(OPS_SECTIONS.find((s) => s.id === "overview")?.href).toBe("/ops");
    expect(OPS_SECTIONS.find((s) => s.id === "mails")?.href).toBe("/ops/mails");
    expect(OPS_SECTIONS.find((s) => s.id === "infra")?.href).toBe("/ops/infra");
  });

  test("renderNav marks the active section, links every section, and sends Preview out", () => {
    const nav = renderNav("infra");
    expect(nav).toContain('<a href="/ops/infra" data-section="infra" aria-current="page">Infra</a>');
    expect(nav).toContain('<a href="/ops" data-section="overview">Overview</a>');
    expect(nav).toContain('<a href="/ops/mails" data-section="mails">Mails</a>');
    expect(nav.match(/aria-current/g)?.length).toBe(1);
    // Preview is the staged site: it leaves the console, so the router must not take it.
    expect(nav).toMatch(/<a class="out" href="\/ops\/preview" target="_blank" rel="noopener" data-ops-full/);
  });
});

function fakeD1(counts: { total_users: number; total_accounts: number; last7d: number }, accounts: AccountRow[]): D1Db {
  return {
    prepare(sql: string): D1PreparedStatement {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      const stmt: D1PreparedStatement = {
        bind: () => stmt,
        first: async <T>() => counts as unknown as T,
        all: async <T>() => ({ results: accounts as unknown as T[], success: true }),
      };
      return stmt;
    },
  };
}

type Canned = { address: string; functionName: string; args?: readonly unknown[]; result: unknown };

function callKey(address: string, functionName: string, args?: readonly unknown[]): string {
  return [
    address.toLowerCase(),
    functionName,
    JSON.stringify(args ?? [], (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  ].join("::");
}

function fakeClient(opts: {
  gasPriceWei?: bigint;
  gasPriceThrows?: boolean;
  balances?: Record<string, bigint>;
  canned?: Canned[];
  seenCalls?: { address: string; functionName: string; args?: readonly unknown[] }[];
  /** Calls to these function names fail the first time they are asked, then answer. */
  failOnce?: string[];
  /** Calls to these function names for this address argument always fail. */
  alwaysFail?: { functionName: string; arg0: string }[];
}): BaseClient {
  const failedOnce = new Set<string>();
  const table = new Map((opts.canned ?? []).map((c) => [callKey(c.address, c.functionName, c.args), c.result]));
  return {
    async getGasPrice() {
      if (opts.gasPriceThrows) throw new Error("rpc down");
      return opts.gasPriceWei ?? 0n;
    },
    async getBalance({ address }: { address: string }) {
      return opts.balances?.[address.toLowerCase()] ?? 0n;
    },
    async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) {
      return contracts.map((c) => {
        opts.seenCalls?.push(c);
        const key = callKey(c.address, c.functionName, c.args);
        if (opts.alwaysFail?.some((f) => f.functionName === c.functionName && c.args?.[0] === f.arg0)) {
          return { status: "failure", error: new Error("rate limited") };
        }
        if (opts.failOnce?.includes(c.functionName) && !failedOnce.has(key)) {
          failedOnce.add(key);
          return { status: "failure", error: new Error("rate limited") };
        }
        if (!table.has(key)) return { status: "failure", error: new Error(`no canned result: ${key}`) };
        return { status: "success", result: table.get(key) };
      });
    },
    // biome-ignore lint: fake only implements what computeInfraSnapshot calls
  } as unknown as BaseClient;
}

const RELAYER = "0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0";
const FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const NPM = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WETH_POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372";

const ACC_IDLE = "0x1111111111111111111111111111111111111A";
const ACC_ZERO = "0x2222222222222222222222222222222222222B";
const ACC_LP = "0x3333333333333333333333333333333333333C";

describe("infra-snapshot.ts", () => {
  test("RPC unreachable: relayer/cost are null with an error note, but D1 counts still load", async () => {
    const client = fakeClient({ gasPriceThrows: true });
    const db = fakeD1({ total_users: 39, total_accounts: 39, last7d: 39 }, []);
    const snapshot: InfraSnapshot = await computeInfraSnapshot({ MAMORU_DB: db }, client);
    expect(snapshot.rpcError).toBeTruthy();
    expect(snapshot.relayer).toBeNull();
    expect(snapshot.cost).toBeNull();
    expect(snapshot.accounts?.totalAccounts).toBe(39);
    expect(snapshot.accounts?.rows).toEqual([]);
    expect(snapshot.accounts?.error).toContain("unreachable");
  });

  test("full happy path: relayer status, cost, and per-account LP aggregation", async () => {
    const sqrtPriceX96 = sqrtPriceX96For(2500, 18, 6); // WETH(token0)/USDC(token1) @ $2500
    const seenCalls: { address: string; functionName: string; args?: readonly unknown[] }[] = [];
    const client = fakeClient({
      gasPriceWei: 1_000_000_000n, // 1 gwei
      balances: { [RELAYER.toLowerCase()]: 1_000_000_000_000_000n }, // 0.001 ETH -> LOW
      seenCalls,
      canned: [
        { address: FACTORY, functionName: "getPool", args: [USDC_ADDRESS, WETH_ADDRESS, 500], result: WETH_POOL },
        { address: WETH_POOL, functionName: "slot0", result: [sqrtPriceX96, 0] },
        // ACC_IDLE: eth + usdc only, no LP NFTs.
        { address: MULTICALL3, functionName: "getEthBalance", args: [ACC_IDLE], result: 2_000_000_000_000_000n },
        { address: USDC_ADDRESS, functionName: "balanceOf", args: [ACC_IDLE], result: 20_000_000n },
        { address: NPM, functionName: "balanceOf", args: [ACC_IDLE], result: 0n },
        // ACC_ZERO: nothing at all.
        { address: MULTICALL3, functionName: "getEthBalance", args: [ACC_ZERO], result: 0n },
        { address: USDC_ADDRESS, functionName: "balanceOf", args: [ACC_ZERO], result: 0n },
        { address: NPM, functionName: "balanceOf", args: [ACC_ZERO], result: 0n },
        // ACC_LP: two LP NFTs, one in range, one out of range.
        { address: MULTICALL3, functionName: "getEthBalance", args: [ACC_LP], result: 500_000_000_000_000n },
        { address: USDC_ADDRESS, functionName: "balanceOf", args: [ACC_LP], result: 0n },
        { address: NPM, functionName: "balanceOf", args: [ACC_LP], result: 2n },
        { address: NPM, functionName: "tokenOfOwnerByIndex", args: [ACC_LP, 0n], result: 10n },
        { address: NPM, functionName: "tokenOfOwnerByIndex", args: [ACC_LP, 1n], result: 11n },
        {
          address: NPM,
          functionName: "positions",
          args: [10n],
          result: [0n, "0x0", WETH_ADDRESS, USDC_ADDRESS, 500, -1000, 1000, 5_000_000_000n, 0n, 0n, 0n, 0n],
        },
        {
          address: NPM,
          functionName: "positions",
          args: [11n],
          result: [0n, "0x0", WETH_ADDRESS, USDC_ADDRESS, 500, 1000, 2000, 1_000_000_000n, 0n, 0n, 0n, 0n],
        },
        // Position pool lookup uses (token0, token1, fee) as returned by positions(), i.e. (WETH, USDC, 500).
        { address: FACTORY, functionName: "getPool", args: [WETH_ADDRESS, USDC_ADDRESS, 500], result: WETH_POOL },
      ],
    });
    const accounts: AccountRow[] = [
      { account_key: "key-idle-0001", user_id: "u1", address: ACC_IDLE, created_at: "2026-09-20T00:00:00Z" },
      { account_key: "key-zero-0002", user_id: "u2", address: ACC_ZERO, created_at: "2026-09-21T00:00:00Z" },
      { account_key: "key-lp-00003", user_id: "u3", address: ACC_LP, created_at: "2026-09-22T00:00:00Z" },
    ];
    const db = fakeD1({ total_users: 3, total_accounts: 3, last7d: 1 }, accounts);

    const snapshot = await computeInfraSnapshot({ MAMORU_DB: db }, client);

    expect(snapshot.rpcError).toBeUndefined();
    expect(snapshot.ethUsd).toBeCloseTo(2500, 4);
    expect(snapshot.btcUsd).toBeNull(); // no cbBTC pool canned -> gracefully unpriced

    expect(snapshot.relayer?.status).toBe("low");
    expect(snapshot.relayer?.ethBalance).toBeCloseTo(0.001, 9);
    expect(snapshot.cost?.accountsFunded).toBe(0); // 0.001 ETH < ~0.0148 ETH per account
    expect(snapshot.cost?.totalUsd).toBeCloseTo(37, 0); // 0.0148 ETH * $2500

    const rows = snapshot.accounts?.rows ?? [];
    const idleRow = rows.find((r) => r.address === ACC_IDLE)!;
    expect(idleRow.usdcIdle).toBeCloseTo(20, 9);
    expect(idleRow.ethBalance).toBeCloseTo(0.002, 9);
    expect(idleRow.positions).toBe(0);

    const zeroRow = rows.find((r) => r.address === ACC_ZERO)!;
    expect(zeroRow.ethBalance).toBe(0);
    expect(zeroRow.positions).toBe(0);
    // The zero-balance, zero-LP account never triggers the NFT-enumeration rounds.
    expect(seenCalls.some((c) => c.functionName === "tokenOfOwnerByIndex" && c.args?.[0] === ACC_ZERO)).toBe(false);

    const lpRow = rows.find((r) => r.address === ACC_LP)!;
    expect(lpRow.positions).toBe(2);
    expect(lpRow.inRange).toBe(1); // only the -1000..1000 position covers tick 0

    const priceUsd = (t: string) => priceUsdOf({ ethUsd: snapshot.ethUsd, btcUsd: snapshot.btcUsd }, t);
    const pool = { sqrtPriceX96, tick: 0 };
    const expectedLp =
      valuePosition(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, tickLower: -1000, tickUpper: 1000, liquidity: 5_000_000_000n, tokensOwed0: 0n, tokensOwed1: 0n },
        pool,
        priceUsd,
        decimalsOf,
      ).usd! +
      valuePosition(
        { token0: WETH_ADDRESS, token1: USDC_ADDRESS, tickLower: 1000, tickUpper: 2000, liquidity: 1_000_000_000n, tokensOwed0: 0n, tokensOwed1: 0n },
        pool,
        priceUsd,
        decimalsOf,
      ).usd!;
    expect(lpRow.lpUsd).toBeCloseTo(expectedLp, 9);

    expect(snapshot.accounts?.idleUsdcUsd).toBeCloseTo(20, 9);
    expect(snapshot.accounts?.lpUsd).toBeCloseTo(expectedLp, 9);
    expect(snapshot.accounts?.tvlUsd).toBeCloseTo(20 + expectedLp, 9);
    expect(snapshot.accounts?.gasReservesEth).toBeCloseTo(0.002 + 0 + 0.0005, 9);
  });
});

function partialFixture(opts: { failOnce?: string[]; alwaysFail?: { functionName: string; arg0: string }[] }) {
  const sqrtPriceX96 = sqrtPriceX96For(2500, 18, 6);
  const client = fakeClient({
    gasPriceWei: 10_000_000n,
    balances: { [RELAYER.toLowerCase()]: 5_000_000_000_000_000n },
    ...opts,
    canned: [
      { address: FACTORY, functionName: "getPool", args: [USDC_ADDRESS, WETH_ADDRESS, 500], result: WETH_POOL },
      { address: FACTORY, functionName: "getPool", args: [USDC_ADDRESS, CBBTC, 500], result: "0x0000000000000000000000000000000000000000" },
      { address: WETH_POOL, functionName: "slot0", result: [sqrtPriceX96, 0] },
      { address: MULTICALL3, functionName: "getEthBalance", args: [ACC_IDLE], result: 500_000_000_000_000n },
      { address: USDC_ADDRESS, functionName: "balanceOf", args: [ACC_IDLE], result: 47_000_000n },
      { address: NPM, functionName: "balanceOf", args: [ACC_IDLE], result: 0n },
      { address: MULTICALL3, functionName: "getEthBalance", args: [ACC_LP], result: 500_000_000_000_000n },
      { address: USDC_ADDRESS, functionName: "balanceOf", args: [ACC_LP], result: 1_000_000n },
      { address: NPM, functionName: "balanceOf", args: [ACC_LP], result: 1n },
      { address: NPM, functionName: "tokenOfOwnerByIndex", args: [ACC_LP, 0n], result: 10n },
      {
        address: NPM,
        functionName: "positions",
        args: [10n],
        result: [0n, "0x0", WETH_ADDRESS, USDC_ADDRESS, 500, -1000, 1000, 5_000_000_000n, 0n, 0n, 0n, 0n],
      },
      { address: FACTORY, functionName: "getPool", args: [WETH_ADDRESS, USDC_ADDRESS, 500], result: WETH_POOL },
    ],
  });
  const accounts: AccountRow[] = [
    { account_key: "key-idle-0001", user_id: "u1", address: ACC_IDLE, created_at: "2026-09-20T00:00:00Z" },
    { account_key: "key-lp-00003", user_id: "u3", address: ACC_LP, created_at: "2026-09-22T00:00:00Z" },
  ];
  return { client, db: fakeD1({ total_users: 2, total_accounts: 2, last7d: 2 }, accounts) };
}

describe("partial reads", () => {
  test("a clean read is complete: no partial flag, nothing marked unread", async () => {
    const { client, db } = partialFixture({});
    const snapshot = await computeInfraSnapshot({ MAMORU_DB: db }, client);
    expect(snapshot.partial).toBeUndefined();
    expect(snapshot.accounts?.unreadAccounts).toBeUndefined();
    expect(snapshot.accounts?.rows.some((r) => r.unread)).toBe(false);
    expect(snapshot.accounts?.idleUsdcUsd).toBeCloseTo(48, 9);
    expect(isComplete(snapshot)).toBe(true);
  });

  test("calls that fail once are retried and the snapshot comes back complete", async () => {
    const { client, db } = partialFixture({ failOnce: ["balanceOf", "getEthBalance", "positions", "slot0", "getPool"] });
    const snapshot = await computeInfraSnapshot({ MAMORU_DB: db }, client);
    expect(snapshot.partial).toBeUndefined();
    expect(snapshot.ethUsd).toBeCloseTo(2500, 4);
    expect(snapshot.accounts?.idleUsdcUsd).toBeCloseTo(48, 9);
    expect(snapshot.accounts?.rows.find((r) => r.address === ACC_LP)?.positions).toBe(1);
  });

  test("a balance that keeps failing marks the account unread and the snapshot partial; it is never a silent zero", async () => {
    const { client, db } = partialFixture({ alwaysFail: [{ functionName: "balanceOf", arg0: ACC_IDLE }] });
    const snapshot = await computeInfraSnapshot({ MAMORU_DB: db }, client);
    expect(snapshot.partial).toEqual({ unreadAccounts: 1, parts: expect.arrayContaining(["balances", "positions"]) });
    expect(snapshot.accounts?.unreadAccounts).toBe(1);
    const idle = snapshot.accounts?.rows.find((r) => r.address === ACC_IDLE);
    expect(idle?.unread).toBe(true);
    expect(snapshot.accounts?.rows.find((r) => r.address === ACC_LP)?.unread).toBeUndefined();
    expect(isComplete(snapshot)).toBe(false);
    // The Overview's daily capture treats the day as partial: counts only, value fields untouched.
    expect(snapshotHasChain(snapshot)).toBe(false);
    const row = rowFromSnapshot(snapshot, "2026-10-02", 0);
    expect(row.captured_at).toBe(PARTIAL_MARK);
    expect(row.tvl_usd).toBe(0);
    expect(upsertSql(row)).not.toContain("tvl_usd = excluded.tvl_usd");
  });

  test("a position that cannot be read marks its account, and a missing ETH price marks prices", async () => {
    const lost = partialFixture({ alwaysFail: [{ functionName: "positions", arg0: 10n as unknown as string }] });
    const snapshot = await computeInfraSnapshot({ MAMORU_DB: lost.db }, lost.client);
    expect(snapshot.partial?.unreadAccounts).toBe(1);
    expect(snapshot.partial?.parts).toContain("positions");
    expect(snapshot.accounts?.rows.find((r) => r.address === ACC_LP)?.unread).toBe(true);

    const blind = partialFixture({ alwaysFail: [{ functionName: "getPool", arg0: USDC_ADDRESS }] });
    const unpriced = await computeInfraSnapshot({ MAMORU_DB: blind.db }, blind.client);
    expect(unpriced.ethUsd).toBeNull();
    expect(unpriced.partial?.parts).toContain("prices");
    expect(unpriced.relayer?.usd).toBeNull();
  });
});

describe("infra-cache.ts last good reading", () => {
  const good = (asOf: string): InfraSnapshot => ({ asOf, ethUsd: 2500, btcUsd: null, relayer: null, cost: null, accounts: null });
  const down = (asOf: string): InfraSnapshot => ({ ...good(asOf), rpcError: "Base RPC is unreachable right now.", ethUsd: null });
  const partial = (asOf: string): InfraSnapshot => ({ ...good(asOf), partial: { unreadAccounts: 3, parts: ["balances"] } });

  function memoryKv() {
    const store = new Map<string, string>();
    const ttl = new Map<string, number | undefined>();
    return {
      store,
      ttl,
      kv: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
          store.set(key, value);
          ttl.set(key, opts?.expirationTtl);
        },
        delete: async (key: string) => void store.delete(key),
        list: async () => ({ keys: [], list_complete: true }),
      },
    };
  }

  test("chooseReading: complete wins, else the last good one, else what there is", () => {
    expect(chooseReading(good("t2"), good("t1"))).toMatchObject({ snapshot: { asOf: "t2" } });
    expect(chooseReading(good("t2"), good("t1")).stale).toBeUndefined();
    expect(chooseReading(down("t2"), good("t1"))).toMatchObject({ snapshot: { asOf: "t1" }, stale: { failedAt: "t2", reason: "unreachable" }, computed: { asOf: "t2" } });
    expect(chooseReading(partial("t2"), good("t1")).stale).toEqual({ failedAt: "t2", reason: "partial" });
    const never = chooseReading(down("t2"), null);
    expect(never.snapshot.rpcError).toBeTruthy();
    expect(never.stale).toBeUndefined();
  });

  test("a failed or partial read never replaces the last complete one", async () => {
    const { kv, store, ttl } = memoryKv();
    const first = await loadInfraReading({ kv }, true, async () => good("t1"));
    expect(first.stale).toBeUndefined();
    expect(JSON.parse(store.get("ops:infra:v1:good")!).asOf).toBe("t1");
    expect(ttl.get("ops:infra:v1:good")).toBeGreaterThan(60 * 60 * 24);

    const second = await loadInfraReading({ kv }, true, async () => partial("t2"));
    expect(second.snapshot.asOf).toBe("t1");
    expect(second.stale).toEqual({ failedAt: "t2", reason: "partial" });
    expect(second.computed?.asOf).toBe("t2");
    expect(JSON.parse(store.get("ops:infra:v1:good")!).asOf).toBe("t1");

    // A cache hit keeps saying it is the fallback, without recomputing.
    const third = await loadInfraReading({ kv }, false, async () => {
      throw new Error("must not recompute");
    });
    expect(third.snapshot.asOf).toBe("t1");
    expect(third.stale?.reason).toBe("partial");

    const fourth = await loadInfraReading({ kv }, true, async () => down("t3"));
    expect(fourth.snapshot.asOf).toBe("t1");
    expect(fourth.stale?.reason).toBe("unreachable");

    const fifth = await loadInfraReading({ kv }, true, async () => good("t4"));
    expect(fifth.snapshot.asOf).toBe("t4");
    expect(fifth.stale).toBeUndefined();
    expect(JSON.parse(store.get("ops:infra:v1:good")!).asOf).toBe("t4");
  });

  test("with no good reading ever, the failed one is shown as it is", async () => {
    const { kv, store } = memoryKv();
    const reading = await loadInfraReading({ kv }, true, async () => down("t1"));
    expect(reading.snapshot.rpcError).toBeTruthy();
    expect(reading.stale).toBeUndefined();
    expect(store.has("ops:infra:v1:good")).toBe(false);
  });

  test("the daily capture records what was read now, not the fallback shown on the page", async () => {
    const outcome = await captureDaily(
      { db: fakeD1({ total_users: 1, total_accounts: 1, last7d: 1 }, []) },
      { now: new Date("2026-10-02T10:00:00Z"), load: async () => chooseReading(down("t2"), good("t1")) },
    );
    expect(outcome.snapshot?.asOf).toBe("t2");
  });
});

const HEALTHY: InfraSnapshot = {
  asOf: "2026-10-01T12:00:00.000Z",
  ethUsd: 2500,
  btcUsd: 60000,
  relayer: { address: RELAYER, basescanUrl: "https://basescan.org/address/" + RELAYER, ethBalance: 0.0251, usd: 62.75, status: "ok" },
  cost: {
    gasPriceGwei: 0.01,
    deployEth: 0.000004,
    deployUsd: 0.01,
    activationEth: 0.000139,
    activationUsd: 0.35,
    reserveEth: 0.0005,
    reserveUsd: 1.25,
    totalEth: 0.000643,
    totalUsd: 1.6,
    totalWei: "643000000000000",
    accountsFunded: 39,
  },
  accounts: {
    totalUsers: 39,
    totalAccounts: 39,
    last7d: 2,
    rows: [
      { accountKey: "k1", address: ACC_IDLE, basescanUrl: "#", ethBalance: 0.0005, usdcIdle: 46.9, lpUsd: 0, positions: 0, inRange: 0 },
      { accountKey: "k2", address: ACC_LP, basescanUrl: "#", ethBalance: 0.0005, usdcIdle: 0, lpUsd: 3.1, positions: 2, inRange: 2 },
      { accountKey: "k3", address: ACC_ZERO, basescanUrl: "#", ethBalance: 0, usdcIdle: 0, lpUsd: 0, positions: 0, inRange: 0 },
    ],
    tvlUsd: 50,
    idleUsdcUsd: 46.9,
    lpUsd: 3.1,
    gasReservesEth: 0.001,
  },
};
const NEVER: InfraSnapshot = {
  asOf: "2026-10-01T12:00:00.000Z",
  rpcError: "Base RPC is unreachable right now.",
  ethUsd: null,
  btcUsd: null,
  relayer: null,
  cost: null,
  accounts: null,
};

describe("ops-infra.ts render", () => {
  const render = (reading: InfraReading) => renderInfra({ reading, csrf: "csrf-token", nonce: "nonce-abc", who: "ot@example.com" });

  test("healthy: the relayer leads, status in words, cost ledger, accounts, and no leftovers", () => {
    const html = render({ snapshot: HEALTHY });
    expect(html).toContain("Infra and costs");
    expect(html).toContain("Relayer balance");
    expect(html).toContain(">0.0251<");
    expect(html).toContain("Healthy");
    expect(html).toContain("More accounts at today");
    expect(html).toContain("The reserve is not burned.");
    expect(html).toContain('data-section="infra" aria-current="page">Infra</a>');
    expect(html).toContain("39 users");
    expect(html).toContain("1 more account has never been funded.");
    expect(html).not.toContain('class="notice"');
    expect(html).not.toContain("Coming next");
    expect(html).not.toContain(">The list<");
    expect(html.match(/<script nonce="nonce-abc">/g)?.length).toBe(2);
    expect(html.match(/<script/g)?.length).toBe(2);
    expect(noticeFor({ snapshot: HEALTHY })).toBeNull();
  });

  test("relayer empty: says so in words and funds zero accounts", () => {
    const empty = { ...HEALTHY, relayer: { ...HEALTHY.relayer!, ethBalance: 0.000102, usd: 0.27, status: "empty" as const }, cost: { ...HEALTHY.cost!, accountsFunded: 0 } };
    const html = render({ snapshot: empty });
    expect(html).toContain('<b class="status-empty">Empty</b>');
    expect(html).toContain(">0.000102<");
    expect(html).toMatch(/Can fund<\/dt><dd class="fig-n"><span data-n="0"/);
  });

  test("last good fallback: says which reading is shown and offers Retry", () => {
    const html = render({ snapshot: HEALTHY, stale: { failedAt: "2026-10-01T13:00:00.000Z", reason: "unreachable" } });
    expect(html).toContain("Showing the last complete reading from 2026-10-01 12:00 UTC; a fresh read failed just now.");
    expect(html).toContain(">Retry</button>");
    expect(html).toContain(">0.0251<");
    expect(render({ snapshot: HEALTHY, stale: { failedAt: "x", reason: "partial" } })).toContain("a fresh read came back incomplete just now");
  });

  test("partial with nothing to fall back on: counts the unread accounts and marks them", () => {
    const rows = HEALTHY.accounts!.rows.map((r, i) => (i === 0 ? { ...r, unread: true } : r));
    const partial: InfraSnapshot = {
      ...HEALTHY,
      partial: { unreadAccounts: 1, parts: ["balances"] },
      accounts: { ...HEALTHY.accounts!, rows, unreadAccounts: 1 },
    };
    const html = render({ snapshot: partial });
    expect(html).toContain("Some balances could not be read: 1 of 3 accounts.");
    expect(html).toContain("not fully read");
    expect(html).toContain("At least $50.00 held");
    expect(html).toContain("none were counted as zero");
  });

  test("never read: the bare unreachable state, and the top-up widget still works", () => {
    const html = render({ snapshot: NEVER });
    expect(html).toContain("Base could not be read, and there is no earlier reading to show.");
    expect(html).toContain("Not read yet");
    expect(html).toContain("Not available until Base can be read.");
    // The relayer address is a public server-side constant; sending to it must not depend on our own RPC read.
    expect(html).toContain(RELAYER);
    expect(html).toContain("&quot;costWei&quot;:null");
    const markup = html.split('<main id="ops-main"')[1].split("<script")[0];
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("[object Object]");
  });

  test("a long ledger stops at the largest accounts and sums the rest; unread ones are never folded away", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      accountKey: `k${i}`,
      address: `0x${String(i).padStart(40, "0")}`,
      basescanUrl: "#",
      ethBalance: 0.0005,
      usdcIdle: 100 - i,
      lpUsd: 0,
      positions: 0,
      inRange: 0,
      ...(i === 39 ? { unread: true } : {}),
    }));
    const html = render({ snapshot: { ...HEALTHY, accounts: { ...HEALTHY.accounts!, rows, unreadAccounts: 1 } } });
    expect(html.match(/<td class="a-key wide-only">/g)?.length).toBe(26);
    expect(html).toContain(">k39<");
    expect(html).not.toContain(">k30<");
    // k25..k38 are folded: 14 accounts holding 75 + 74 + ... + 62.
    expect(html).toContain("14 more funded accounts hold $959.00 between them.");
  });

  test("the page never carries an RPC URL", () => {
    const html = render({ snapshot: HEALTHY });
    expect(html).not.toMatch(/alchemy|publicnode|drpc/i);
    // The only RPC URL is the public one used for the wallet's "add Base" prompt.
    expect(html.match(/https:\/\/[a-z.]*base\.org/g)).toEqual(["https://mainnet.base.org"]);
  });
});

describe("worker.ts auth gate for /ops/infra", () => {
  function opsEnv(): Env {
    return {
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      OPS_SESSION_SECRET: "k1",
    };
  }

  test("no session: /ops/infra never computes or leaks a snapshot, it only starts the sign-in", async () => {
    const env = opsEnv();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/infra"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
    const body = await res.text();
    expect(body).not.toContain(RELAYER);
    expect(body).not.toContain("Infra");
  });

  test("a session removed from the allowlist is also denied", async () => {
    const env = opsEnv();
    const token = await sealSession("k1", "someone@example.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/infra", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("POST /ops/infra/refresh without a session is denied the same way", async () => {
    const env = opsEnv();
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/infra/refresh", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
