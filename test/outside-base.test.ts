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
  ETHEREUM_PUBLIC_RPCS,
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
      rotation: 0,
    });
    const h = m.get(USER.toLowerCase())!;
    expect(h.eth).toBeCloseTo(0.05537835, 10);
    expect(h.usdc).toBe(1.5);
    expect(h.usd).toBeCloseTo(0.05537835 * 2300 + 1.5, 6);
    expect(m.get(EMPTY)).toEqual({ eth: 0, usdc: 0, usd: 0 });
    expect(seen.some((u) => u.includes("coinbase"))).toBe(false);
    expect(seen[0]).toBe(ETHEREUM_PUBLIC_RPCS[0]);
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
    const m = await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://secret.example/key, http://insecure.example", fetchFn: ethFetch({}, { fail: true, seen }), rotation: 0 });
    expect(m.size).toBe(0);
    expect(seen[0]).toBe("https://secret.example/key");
    expect(seen).not.toContain("http://insecure.example");
    // otto/mamoru-astro#42: an RPC that answers 503 is not asked again this run (no plain batch either): the secret
    // once, then the run's public budget of nine, in waves of three.
    expect(seen.length).toBe(10);
    expect(seen.slice(1)).toEqual(ETHEREUM_PUBLIC_RPCS.slice(0, 9));
  });

  test("aggregate3 refused everywhere: the plain batch reads the balances; errors name hosts, never URL paths", async () => {
    const notes: string[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "refused" } }));
      const word = (n: bigint) => `0x${n.toString(16)}`;
      return new Response(JSON.stringify(body.map((c: { id: number; method: string }) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getBalance" ? word(55_378_350_000_000_000n) : word(0n) }))));
    };
    const m = await readOutsideBase([USER], { baseEthUsd: 2000, rpcUrls: "https://secret.example/key123", fetchFn, onError: (x) => notes.push(x) });
    expect(m.get(USER.toLowerCase())).toEqual({ eth: 0.05537835, usdc: 0, usd: 0.05537835 * 2000 });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).not.toContain("key123");
    expect(notes[0]).toBe("secret.example: JSON-RPC error -32000");
  });

  test("a healthy configured RPC is the only one asked: public hosts never see the addresses (otto/mamoru-astro#41)", async () => {
    const seen: string[] = [];
    const fast = ethFetch({ [USER.toLowerCase()]: [1n, 0n] }, { seen });
    const m = await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://own.example/k", fetchFn: fast });
    expect(m.size).toBe(1);
    expect(seen).toEqual(["https://own.example/k"]);
  });

  test("a public answer never overrules the configured RPC, whatever arrives first; public hosts get only what it missed", async () => {
    const OTHER = "0x00000000000000000000000000000000000000e2";
    const asked: string[] = [];
    const own = ethFetch({ [USER.toLowerCase()]: [7n, 0n] });
    const pub = ethFetch({ [USER.toLowerCase()]: [999n, 0n], [OTHER]: [5n, 0n] });
    const fetchFn = async (u: string, i?: RequestInit) => {
      asked.push(`${u} ${String(i?.body).toLowerCase().includes(USER.toLowerCase().slice(2)) ? "user" : ""}`);
      if (u.includes("own.example")) {
        await new Promise((r) => setTimeout(r, 30));
        // The configured RPC answers USER only.
        const res = await own(u, i);
        return res;
      }
      return pub(u, i);
    };
    const m = await readOutsideBase([USER, OTHER], { baseEthUsd: 1, rpcUrls: "https://own.example/k", fetchFn });
    expect(m.get(USER.toLowerCase())?.eth).toBe(7 / 1e18);
    expect(m.get(OTHER)?.eth).toBe(5 / 1e18);
    expect(asked.filter((x) => !x.startsWith("https://own.example")).every((x) => !x.endsWith("user"))).toBe(true);
  });

  test("within the configured tier list order wins, even when a later RPC answers first", async () => {
    const first = ethFetch({ [USER.toLowerCase()]: [7n, 0n] });
    const second = ethFetch({ [USER.toLowerCase()]: [999n, 0n] });
    const fetchFn = async (u: string, i?: RequestInit) => {
      if (u.includes("one.example")) {
        await new Promise((r) => setTimeout(r, 40));
        return first(u, i);
      }
      return second(u, i);
    };
    const m = await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://one.example/a,https://two.example/b", fetchFn });
    expect(m.get(USER.toLowerCase())?.eth).toBe(7 / 1e18);
  });

  test("a configured RPC that hangs past its budget hands the read to the public tier", async () => {
    const pub = ethFetch({ [USER.toLowerCase()]: [5n, 0n] });
    const fetchFn = (u: string, i?: RequestInit) => (u.includes("own.example") ? new Promise<Response>(() => {}) : pub(u, i));
    const m = await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://own.example/k", fetchFn, deadlineMs: 9_000 });
    expect(m.get(USER.toLowerCase())?.eth).toBe(5 / 1e18);
  }, 10_000);

  test("on the configured tier's budget, answers already in are kept and only the rest goes public", async () => {
    const OTHER = "0x00000000000000000000000000000000000000e2";
    const own = ethFetch({ [USER.toLowerCase()]: [7n, 0n] });
    const pub = ethFetch({ [USER.toLowerCase()]: [999n, 0n], [OTHER]: [5n, 0n] });
    const publicAskedForUser: boolean[] = [];
    const fetchFn = (u: string, i?: RequestInit) => {
      const body = String(i?.body);
      if (u.includes("own.example")) return Array.isArray(JSON.parse(body)) ? new Promise<Response>(() => {}) : own(u, i);
      publicAskedForUser.push(body.toLowerCase().includes(USER.toLowerCase().slice(2)));
      return pub(u, i);
    };
    const m = await readOutsideBase([USER, OTHER], { baseEthUsd: 1, rpcUrls: "https://own.example/k", fetchFn, deadlineMs: 9_000 });
    expect(m.get(USER.toLowerCase())?.eth).toBe(7 / 1e18);
    expect(m.get(OTHER)?.eth).toBe(5 / 1e18);
    expect(publicAskedForUser.some(Boolean)).toBe(false);
  }, 10_000);

  test("notes are host and category only: no error text, so a key echoed in any form never gets in", async () => {
    const notes: string[] = [];
    const fetchFn = async (url: string) => {
      if (url.includes("secret")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "invalid apiKey=abc" } }));
      throw new Error("invalid apiKey=abc");
    };
    await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://secret.example/?apiKey=abc", fetchFn, onError: (x) => notes.push(x), rotation: 0 });
    expect(notes.join(" ")).not.toContain("abc");
    expect(notes).toContain("secret.example: JSON-RPC error -32001");
    expect(notes).toContain("rpc.mevblocker.io: network error");
  });

  test("an error text that repeats the secret URL, with or without its scheme, keeps only the host", async () => {
    const notes: string[] = [];
    const fetchFn = async () => {
      throw new Error("connect failed: https://secret.example/key123?token=abc and secret.example/key123?token=abc");
    };
    await readOutsideBase([USER], { baseEthUsd: 1, rpcUrls: "https://secret.example/key123?token=abc", fetchFn, onError: (x) => notes.push(x) });
    const all = notes.join(" ");
    expect(all).not.toContain("key123");
    expect(all).not.toContain("token=abc");
    expect(all).toContain("secret.example");
  });

  test("a decoded aggregate where every sub-call failed falls through to the batch; one RPC per address is enough", async () => {
    const fetchFn = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!Array.isArray(body)) {
        // aggregate3 answering with every sub-call failed.
        const { encodeFunctionResult, parseAbi } = await import("viem");
        const abi = parseAbi(["struct Result { bool success; bytes returnData; }", "function aggregate3((address,bool,bytes)[] calls) returns (Result[] returnData)"]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi, functionName: "aggregate3", result: [{ success: false, returnData: "0x" }, { success: false, returnData: "0x" }, { success: false, returnData: "0x" }, { success: false, returnData: "0x" }] }) }));
      }
      // Only one host answers the batch, and only for EMPTY.
      if (!url.includes("blastapi")) return new Response("[]");
      return new Response(JSON.stringify(body.map((c: { id: number; params: unknown[] }) => ({ jsonrpc: "2.0", id: c.id, result: JSON.stringify(c.params).toLowerCase().includes(EMPTY.toLowerCase().slice(2)) ? "0x0" : null }))));
    };
    const m = await readOutsideBase([USER, EMPTY], { baseEthUsd: 1, fetchFn });
    expect(m.has(EMPTY.toLowerCase())).toBe(true);
    expect(m.has(USER.toLowerCase())).toBe(false);
  });

  test("an address whose sub-call failed is not read; the others are", async () => {
    const m = await readOutsideBase([USER, EMPTY], { baseEthUsd: 1, fetchFn: ethFetch({ [USER.toLowerCase()]: [1n, 1n] }) });
    expect(m.has(USER.toLowerCase())).toBe(true);
    expect(m.has(EMPTY)).toBe(false);
  });

  test("at the deadline, chunks already read are kept and the slow one is not read", async () => {
    const addrs = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const fast = ethFetch(Object.fromEntries(addrs.map((a) => [a, [1n, 1n] as [bigint, bigint]])));
    // Every RPC hangs for the second chunk (the 101st address alone, so the short request): only it is lost.
    const m = await readOutsideBase(addrs, {
      baseEthUsd: 1, deadlineMs: 50,
      fetchFn: (u, i) => (String(i?.body).length < 2_000 ? new Promise<Response>(() => {}) : fast(u, i)),
    });
    expect(m.size).toBe(100);
    expect(m.has(addrs[100]!)).toBe(false);
  });

  test("one hung RPC never holds back the answer the others gave", async () => {
    const fast = ethFetch({ [USER.toLowerCase()]: [1n, 0n] });
    let n = 0;
    const t = Date.now();
    const m = await readOutsideBase([USER], { baseEthUsd: 1, deadlineMs: 2_000, fetchFn: (u, i) => (++n === 1 ? new Promise<Response>(() => {}) : fast(u, i)) });
    expect(m.size).toBe(1);
    expect(Date.now() - t).toBeLessThan(1_000);
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
    expect(ethereumRpcList()[0]).toBe(ETHEREUM_PUBLIC_RPCS[0]);
    expect(ethereumRpcList(undefined, 1)[0]).toBe(ETHEREUM_PUBLIC_RPCS[1]);
    expect(ethereumRpcList("https://a.example").length).toBe(ETHEREUM_PUBLIC_RPCS.length + 1);
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
    expect(html).toContain("Counted in Value held; it earns nothing until it moves to Base");
    // Funding no longer carries the per-account table.
    expect(renderInfra({ reading: { snapshot: snap(rows) }, csrf: "c", nonce: "n" })).not.toContain("On Ethereum");
  });
});
