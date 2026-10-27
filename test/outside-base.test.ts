import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, parseAbi } from "viem";
import { computeInfraSnapshot, type AccountView, type InfraSnapshot } from "../src/infra-snapshot";
import { buildOverview } from "../src/metrics-overview";
import { DEFAULT_FILTER } from "../src/account-filter";
import { fmtUsd } from "../src/metrics-math";
import { renderOverview } from "../src/ops-metrics";
import { outsideSheet } from "../src/ops-outside";
import { renderInfra } from "../src/ops-infra";
import {
  ETHEREUM_MULTICALL3,
  ETHEREUM_USDC,
  ethereumRpcList,
  outsideLine,
  parseAggregate,
  readOutsideBase,
  summarizeOutside,
  toHolding,
} from "../src/outside-base";

const ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const USER = "0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D";
const EMPTY = "0x00000000000000000000000000000000000000e1";
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

/** A fake Ethereum JSON-RPC: answers eth_call to Multicall3 from a table of address -> [wei, usdc]. */
function ethFetch(balances: Record<string, [bigint, bigint]>, opts: { fail?: boolean; spot?: string | null; seen?: string[] } = {}) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    opts.seen?.push(input);
    if (input.includes("coinbase")) {
      return opts.spot === null || opts.spot === undefined ? new Response("no", { status: 500 }) : Response.json({ data: { amount: opts.spot } });
    }
    if (opts.fail) return new Response("down", { status: 503 });
    const req = JSON.parse(String(init?.body));
    expect(req.method).toBe("eth_call");
    expect(req.params[0].to).toBe(ETHEREUM_MULTICALL3);
    const { args } = decodeFunctionData({ abi: ABI, data: req.params[0].data });
    const calls = args[0] as readonly { target: string; callData: string }[];
    expect(calls.length % 2).toBe(0);
    expect(calls[1].target).toBe(ETHEREUM_USDC);
    const out = calls.map((c, i) => {
      const addr = ("0x" + c.callData.slice(-40)).toLowerCase();
      const b = balances[addr];
      return b ? { success: true, returnData: word(b[i % 2]) } : { success: false, returnData: "0x" as const };
    });
    const result = encodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
      [out],
    );
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
}

describe("readOutsideBase", () => {
  test("reads ETH and USDC for the user, prices ETH with the Base price", async () => {
    const seen: string[] = [];
    const m = await readOutsideBase([USER, EMPTY], {
      baseEthUsd: 2300,
      fetchFn: ethFetch({ [USER.toLowerCase()]: [55378350000000000n, 1_500_000n], [EMPTY]: [0n, 0n] }, { seen }),
    });
    const h = m.get(USER.toLowerCase())!;
    expect(h.eth).toBeCloseTo(0.05537835, 10);
    expect(h.usdc).toBe(1.5);
    expect(h.usd).toBeCloseTo(0.05537835 * 2300 + 1.5, 6);
    expect(m.get(EMPTY)).toEqual({ eth: 0, usdc: 0, usd: 0 });
    expect(seen.some((u) => u.includes("coinbase"))).toBe(false);
    expect(seen[0]).toBe("https://ethereum-rpc.publicnode.com");
  });

  test("falls back to Coinbase spot when there is no Base price, and not at all when no one holds ETH", async () => {
    const seen: string[] = [];
    const m = await readOutsideBase([USER], { baseEthUsd: null, fetchFn: ethFetch({ [USER.toLowerCase()]: [10n ** 18n, 0n] }, { spot: "2315.5", seen }) });
    expect(m.get(USER.toLowerCase())!.usd).toBeCloseTo(2315.5, 6);
    const seen2: string[] = [];
    await readOutsideBase([USER], { baseEthUsd: null, fetchFn: ethFetch({ [USER.toLowerCase()]: [0n, 5_000_000n] }, { seen: seen2 }) });
    expect(seen2.some((u) => u.includes("coinbase"))).toBe(false);
  });

  test("ETH with no price at all is read but unpriced (usd null), not zero", async () => {
    const m = await readOutsideBase([USER], { baseEthUsd: null, fetchFn: ethFetch({ [USER.toLowerCase()]: [10n ** 18n, 0n] }, { spot: null }) });
    expect(m.get(USER.toLowerCase())).toEqual({ eth: 1, usdc: 0, usd: null });
  });

  test("a failing RPC is skipped for the next one; all failing leaves the map empty (never zero)", async () => {
    const seen: string[] = [];
    const m = await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://secret.example/key, http://insecure.example", fetchFn: ethFetch({}, { fail: true, seen }) });
    expect(m.size).toBe(0);
    expect(seen[0]).toBe("https://secret.example/key");
    expect(seen).not.toContain("http://insecure.example");
    expect(seen.length).toBe(3);
  });

  test("an address whose sub-call failed is not read; the others are", async () => {
    const m = await readOutsideBase([USER, EMPTY], { baseEthUsd: 1, fetchFn: ethFetch({ [USER.toLowerCase()]: [1n, 1n] }) });
    expect(m.has(USER.toLowerCase())).toBe(true);
    expect(m.has(EMPTY)).toBe(false);
  });

  test("at the deadline, chunks already read are kept and the slow one is not read", async () => {
    const addrs = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const fast = ethFetch(Object.fromEntries(addrs.map((a) => [a, [1n, 1n] as [bigint, bigint]])));
    let n = 0;
    const m = await readOutsideBase(addrs, {
      baseEthUsd: 1, deadlineMs: 50,
      fetchFn: (u, i) => (++n === 2 ? new Promise<Response>(() => {}) : fast(u, i)),
    });
    expect(m.size).toBe(100);
    expect(m.has(addrs[100])).toBe(false);
  });

  test("a throwing fetch never throws out", async () => {
    const m = await readOutsideBase([USER], { baseEthUsd: 1, fetchFn: async () => { throw new Error("net"); } });
    expect(m.size).toBe(0);
  });

  test("parseAggregate rejects a wrong length and returns null for failed or malformed sub-calls", () => {
    const enc = (rs: { success: boolean; returnData: `0x${string}` }[]) =>
      encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [rs]);
    expect(() => parseAggregate([USER], enc([]))).toThrow();
    const r = parseAggregate([USER], enc([{ success: true, returnData: word(5n) }, { success: true, returnData: "0x" }]));
    expect(r).toEqual([null]);
  });

  test("ethereumRpcList puts the secret first and keeps the public fallbacks", () => {
    expect(ethereumRpcList()[0]).toBe("https://ethereum-rpc.publicnode.com");
    expect(ethereumRpcList("https://a.example")[0]).toBe("https://a.example");
  });
});

describe("summing and wording", () => {
  const h = (eth: number, usdc: number, usd: number | null) => ({ eth, usdc, usd });
  test("sums only read rows and counts the rest as not read", () => {
    const s = summarizeOutside([{ outside: h(0.0554, 0, 128) }, { outside: h(0, 0, 0) }, {}]);
    expect(s).toEqual({ read: 2, unread: 1, eth: 0.0554, usdc: 0, usd: 128, holders: 1 });
  });
  test("one unpriced holder makes the dollar total null", () => {
    expect(summarizeOutside([{ outside: h(1, 0, null) }, { outside: h(0, 3, 3) }]).usd).toBeNull();
  });
  test("toHolding", () => {
    expect(toHolding({ ethWei: 5n * 10n ** 17n, usdcRaw: 2_000_000n }, 2000)).toEqual({ eth: 0.5, usdc: 2, usd: 1002 });
  });
  test("outsideLine", () => {
    expect(outsideLine(summarizeOutside([{ outside: h(0.05537835, 0, 128) }]), fmtUsd)).toBe("$128.00 · 0.0554 ETH on Ethereum · 1 account");
    expect(outsideLine(summarizeOutside([{}]), fmtUsd)).toBe("not read");
    expect(outsideLine(summarizeOutside([{ outside: h(0, 0, 0) }]), fmtUsd)).toBe("$0.00 · nothing on Ethereum · 0 accounts");
    expect(outsideLine(summarizeOutside([{ outside: h(0.05, 0, 128) }, {}]), fmtUsd)).toContain("at least");
  });
});

function acct(i: number, over: Partial<AccountView> = {}): AccountView {
  return {
    accountKey: `acc${i}`, key: `key-${i}`, userId: `user-${i}`, address: `0x${String(i).padStart(40, "0")}`, basescanUrl: "#",
    ethBalance: 0, usdcIdle: 10, lpUsd: 90, positions: 1, inRange: 1, env: "prod", chainId: 8453, isTest: false, ...over,
  };
}
const NOW = new Date("2026-10-01T14:05:00Z");
function snap(rows: AccountView[]): InfraSnapshot {
  return {
    asOf: NOW.toISOString(), ethUsd: 2300, btcUsd: 60000,
    relayer: { address: "0xr", basescanUrl: "#", ethBalance: 0.01, usd: 23, status: "ok" }, cost: null,
    accounts: { totalUsers: 2, totalAccounts: 2, last7d: 2, rows, tvlUsd: rows.length * 100, idleUsdcUsd: rows.length * 10, lpUsd: rows.length * 90, gasReservesEth: 0 },
  };
}
const inputs = { daily: null, dailyV2: null, activity: null, signups: null, counts: null };
const mainOf = (html: string) => html.split('<main id="ops-main"')[1];

describe("pages", () => {
  test("Overview keeps the Base value held as is and shows Outside Base as its own line", () => {
    const rows = [acct(1, { outside: { eth: 0.05537835, usdc: 0, usd: 127.4 } }), acct(2, { outside: { eth: 0, usdc: 0, usd: 0 } })];
    const o = buildOverview(snap(rows), inputs, NOW);
    expect(o.tvl).toBe(200);
    expect(o.outside.usd).toBeCloseTo(127.4, 6);
    const html = mainOf(renderOverview({ overview: o, csrf: "c", nonce: "n" }));
    expect(html).toContain("Outside Base (not working): $127.40 · 0.0554 ETH on Ethereum · 1 account");
    expect(html).toContain("Including outside Base: $327.40");
    expect(html).toContain('<span data-n="200" data-f="usd">$200.00</span>');
  });

  test("Overview says not read when the Ethereum read failed, and never shows a total including it", () => {
    const o = buildOverview(snap([acct(1), acct(2)]), inputs, NOW);
    expect(o.tvl).toBe(200);
    const html = mainOf(renderOverview({ overview: o, csrf: "c", nonce: "n" }));
    expect(html).toContain("Outside Base (not working): not read");
    expect(html).not.toContain("Including outside Base");
  });

  test("Accounts lists the Ethereum holdings per account (moved from Funding, otto/mamoru-astro#35), even with no Base value", () => {
    const rows = [acct(1, { outside: { eth: 0.05537835, usdc: 0, usd: 127.4 } }), acct(2, { usdcIdle: 0, lpUsd: 0, positions: 0, inRange: 0, outside: { eth: 0.02, usdc: 0, usd: 46 } }), acct(3)];
    const html = outsideSheet(snap(rows));
    expect(html).toContain("<th>On Ethereum</th>");
    expect(html).toContain("0.0554 ETH · $127.40");
    expect(html).toContain("0.0200 ETH · $46.00");
    expect(html).toContain('<td class="unread">not read</td>');
    expect(html).toContain("<td>acc3</td>");
    expect(html).toContain("Not working, and not in any Base figure");
    // Funding no longer carries the per-account table.
    expect(renderInfra({ reading: { snapshot: snap(rows) }, csrf: "c", nonce: "n" })).not.toContain("On Ethereum");
  });
});
