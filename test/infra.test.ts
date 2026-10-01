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
import { USDC_ADDRESS, WETH_ADDRESS } from "../src/chain-addresses";
import { OPS_SECTIONS, renderNav, sealSession } from "../src/ops";
import { renderInfra } from "../src/ops-infra";
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
  test("OPS_SECTIONS is extensible and includes Mails + Infra", () => {
    expect(OPS_SECTIONS.map((s) => s.id)).toEqual(["mails", "infra"]);
    expect(OPS_SECTIONS.find((s) => s.id === "mails")?.href).toBe("/ops");
    expect(OPS_SECTIONS.find((s) => s.id === "infra")?.href).toBe("/ops/infra");
  });

  test("renderNav marks the active section without a link, links the rest", () => {
    const nav = renderNav("infra");
    expect(nav).toContain("<strong>Infra</strong>");
    expect(nav).toContain('<a href="/ops">Mails</a>');
    expect(nav).not.toContain('<a href="/ops/infra">');
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
}): BaseClient {
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

describe("ops-infra.ts render", () => {
  test("renderInfra shows the relayer, status, cost table, and the script nonce", () => {
    const snapshot: InfraSnapshot = {
      asOf: "2026-10-01T12:00:00.000Z",
      ethUsd: 2500,
      btcUsd: 60000,
      relayer: {
        address: RELAYER,
        basescanUrl: "https://basescan.org/address/" + RELAYER,
        ethBalance: 0.0001,
        usd: 0.25,
        status: "empty",
      },
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
        accountsFunded: 0,
      },
      accounts: {
        totalUsers: 39,
        totalAccounts: 39,
        last7d: 2,
        rows: [],
        tvlUsd: 50,
        idleUsdcUsd: 46.9,
        lpUsd: 3.1,
        gasReservesEth: 0.01,
      },
    };
    const html = renderInfra({ snapshot, csrf: "csrf-token", nonce: "nonce-abc" });
    expect(html).toContain("Infra &amp; costs");
    expect(html).toContain("EMPTY");
    expect(html).toContain(RELAYER.slice(0, 6));
    expect(html).toContain('<script nonce="nonce-abc">');
    expect(html).toContain("<strong>Infra</strong>");
    expect(html).toContain("39 users");
  });

  test("renderInfra shows an error note instead of crashing when RPC is down", () => {
    const snapshot: InfraSnapshot = {
      asOf: "2026-10-01T12:00:00.000Z",
      rpcError: "Base RPC is unreachable right now.",
      ethUsd: null,
      btcUsd: null,
      relayer: null,
      cost: null,
      accounts: null,
    };
    const html = renderInfra({ snapshot, csrf: "csrf-token", nonce: "nonce-abc" });
    expect(html).toContain("Base RPC is unreachable right now.");
    // The relayer address is public (it's a server-side constant, shown on BaseScan too),
    // and the top-up widget must still work even when our own RPC read failed.
    expect(html).toContain(RELAYER);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
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

  test("no session: /ops/infra never computes or leaks a snapshot", async () => {
    const env = opsEnv();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/infra"), env);
    expect(res.status).toBe(404);
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
