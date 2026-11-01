import { describe, expect, test } from "bun:test";
import { encodeAbiParameters } from "viem";
import { rpcUrls } from "../src/chain-addresses";
import { MONAD_PUBLIC_RPCS, monadRpcList, readMonadHoldings } from "../src/monad-holdings";
import { ETHEREUM_PUBLIC_RPCS, readOutsideBase } from "../src/outside-base";
import { hourRotation, ownRpcs, PUBLIC_RPCS, publicPool, rotated, RunHealth } from "../src/rpc-pool";

const A = "0xAF3F151b0B19f556c2f97C6225a1fd22Cb9f703D";

describe("rpc pool (otto/mamoru-astro#42)", () => {
  test("every chain has a wide pool of distinct https URLs with no key in them", () => {
    for (const [chain, list] of Object.entries(PUBLIC_RPCS)) {
      expect(list.length).toBeGreaterThanOrEqual(chain === "monad" ? 8 : 15);
      expect(new Set(list).size).toBe(list.length);
      for (const u of list) {
        expect(u.startsWith("https://")).toBe(true);
        expect(u).not.toMatch(/key|token|demo/i);
      }
    }
  });

  test("rotation moves the start, keeps every URL once, and changes every hour", () => {
    expect(rotated([1, 2, 3], 1)).toEqual([2, 3, 1]);
    expect(rotated([1, 2, 3], -1)).toEqual([3, 1, 2]);
    expect(rotated([], 5)).toEqual([]);
    const p = publicPool("ethereum", 4);
    expect(p[0]).toBe(PUBLIC_RPCS.ethereum[4]);
    expect(new Set(p)).toEqual(new Set(PUBLIC_RPCS.ethereum));
    expect(hourRotation(3_600_000 * 7 + 5)).toBe(7);
  });

  test("own RPCs keep their order, drop non-https and duplicates, and are not repeated in the public pool", () => {
    expect(ownRpcs(" https://a.example/k ,http://b.example, https://a.example/k,https://c.example")).toEqual(["https://a.example/k", "https://c.example"]);
    const own = [PUBLIC_RPCS.monad[0]];
    expect(publicPool("monad", 0, own)).not.toContain(own[0]);
  });

  test("RunHealth skips what failed", () => {
    const h = new RunHealth();
    h.fail("https://x");
    expect(h.ok("https://x")).toBe(false);
    expect(h.healthy(["https://x", "https://y"])).toEqual(["https://y"]);
  });

  test("Base: the secrets first, then six public RPCs from the rotated pool", () => {
    const l = rpcUrls("https://own.example/k,https://own2.example/k", 2);
    expect(l.slice(0, 2)).toEqual(["https://own.example/k", "https://own2.example/k"]);
    expect(l.slice(2)).toEqual(publicPool("base", 2).slice(0, 6));
    expect(rpcUrls(undefined, 0).length).toBe(6);
  });
});

describe("Ethereum read over the pool", () => {
  test("the first public wave all refuses: the next wave answers, and nothing that refused is asked again", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push(url);
      if (ETHEREUM_PUBLIC_RPCS.slice(0, 3).includes(url)) return new Response("slow down", { status: 429 });
      const body = JSON.parse(String(init?.body));
      if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }));
      return new Response(JSON.stringify(body.map((c: { id: number; method: string }) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getBalance" ? "0xc4be50dfff4c00" : "0x0" }))));
    };
    const m = await readOutsideBase([A], { baseEthUsd: 2000, fetchFn, rotation: 0 });
    expect(m.get(A.toLowerCase())!.eth).toBeCloseTo(0.05537835, 8);
    for (const u of ETHEREUM_PUBLIC_RPCS.slice(0, 3)) expect(seen.filter((s) => s === u).length).toBe(1);
  });

  test("a healthy configured RPC is the only one asked", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      return url.startsWith("https://own") ? okAggregate() : new Response("down", { status: 503 });
    };
    const m = await readOutsideBase([A], { baseEthUsd: 1, rpcUrls: "https://own.example/k", fetchFn, rotation: 0 });
    expect(m.get(A.toLowerCase())!.eth).toBe(1);
    expect(seen).toEqual(["https://own.example/k"]);
  });
});

/** aggregate3 answer for one address: 1 ETH, 0 USDC. */
function okAggregate(): Response {
  const w = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  const result = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
    [[{ success: true, returnData: w(10n ** 18n) }, { success: true, returnData: w(0n) }]],
  );
  return Response.json({ jsonrpc: "2.0", id: 1, result });
}

describe("Monad read over the pool", () => {
  test("the list is the configured RPCs, then the rotated public pool", () => {
    expect(monadRpcList("https://own.example/k", 0)).toEqual(["https://own.example/k", ...MONAD_PUBLIC_RPCS]);
  });

  test("a public RPC is never asked while a configured one is answering, and a dead wave moves to the next", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      return new Response("down", { status: 503 });
    };
    const m = await readMonadHoldings([A], { rpcUrls: "https://own.example/k", fetchFn, rotation: 0, deadlineMs: 2_000 });
    expect(m.size).toBe(0);
    expect(seen[0]).toBe("https://own.example/k");
    // The configured wave alone, then the public pool in waves of three, each RPC once.
    expect(seen.slice(1)).toEqual(MONAD_PUBLIC_RPCS.slice(0, 6));
  });
});

describe("review r1 of #42", () => {
  const addrs = (n: number) => Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const hostOf = (u: string) => new URL(u).host;

  test("Ethereum: the public budget is per run and shared by every chunk", async () => {
    const seen: string[] = [];
    await readOutsideBase(addrs(250), { baseEthUsd: 1, rotation: 0, fetchFn: async (u) => (seen.push(u), new Response("down", { status: 503 })) });
    const hosts = new Set(seen.map(hostOf));
    expect(hosts.size).toBe(9);
    // Every chunk was asked by the same hosts: none was starved by the others.
    for (const h of hosts) expect(seen.filter((u) => hostOf(u) === h).length).toBe(3);
  });

  test("Monad: at most six public hosts per run, however many chunks", async () => {
    const seen: string[] = [];
    await readMonadHoldings(addrs(950), { rotation: 0, deadlineMs: 3_000, fetchFn: async (u) => (seen.push(u), new Response("down", { status: 503 })) });
    expect(new Set(seen.map(hostOf)).size).toBe(6);
    expect(seen.length).toBe(6 * 10);
  });

  test("Monad: a fast answer with every sub-call failed does not hide the full answers that follow", async () => {
    const { encodeFunctionResult, parseAbi } = await import("viem");
    const abi = parseAbi(["struct Result { bool success; bytes returnData; }", "function aggregate3((address,bool,bytes)[] calls) returns (Result[] returnData)"]);
    const w = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
    const answer = (ok: boolean) => Response.json({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi, functionName: "aggregate3", result: Array.from({ length: 4 }, (_, k) => (ok ? { success: true, returnData: w(k === 1 ? 7_000_000n : 0n) } : { success: false, returnData: "0x" as const })) }) });
    const m = await readMonadHoldings([A], {
      rotation: 0,
      fetchFn: async (u) => (u === MONAD_PUBLIC_RPCS[0] ? answer(false) : (await new Promise((r) => setTimeout(r, 50)), answer(true))),
    });
    expect(m.get(A.toLowerCase())?.usdc).toBe(7);
  });

  test("Monad: the price read stays inside the deadline", async () => {
    const { encodeFunctionResult, parseAbi } = await import("viem");
    const abi = parseAbi(["struct Result { bool success; bytes returnData; }", "function aggregate3((address,bool,bytes)[] calls) returns (Result[] returnData)"]);
    const w = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
    const holds = Response.json({ jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi, functionName: "aggregate3", result: Array.from({ length: 4 }, (_, k) => ({ success: true, returnData: w(k === 0 ? 10n ** 18n : 0n) })) }) });
    const t = Date.now();
    const m = await readMonadHoldings([A], {
      rotation: 0,
      deadlineMs: 1_500,
      fetchFn: async (_u, init) => (String(init?.body).includes("0x3850c7bd") ? new Promise<Response>(() => {}) : holds.clone()),
    });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(m.get(A.toLowerCase())?.monUnpriced).toBe(true);
  });

  test("Ethereum: a configured RPC answering a JSON-RPC error both ways is dropped after its second strike", async () => {
    const seen: string[] = [];
    await readOutsideBase(addrs(350), {
      baseEthUsd: 1,
      rotation: 0,
      rpcUrls: "https://own.example/k",
      fetchFn: async (u) => (seen.push(u), u.startsWith("https://own") ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit" } })) : new Response("down", { status: 503 })),
    });
    // Four chunks; each ask is aggregate3 then the plain batch. The configured RPC was asked by every chunk at once
    // (the own tier runs in parallel), never again in the public waves.
    expect(seen.filter((u) => u.startsWith("https://own")).length).toBe(8);
  });

  test("Ethereum: a configured RPC answering at 2.8 s is kept over a quicker public answer", async () => {
    const own = async () => (await new Promise((r) => setTimeout(r, 2_800)), okAggregate());
    const m = await readOutsideBase([A], {
      baseEthUsd: 1,
      rotation: 0,
      rpcUrls: "https://own.example/k",
      fetchFn: async (u) => (u.startsWith("https://own") ? own() : new Response("down", { status: 503 })),
    });
    expect(m.get(A.toLowerCase())?.eth).toBe(1);
  });

  test("Base: a dead RPC costs one try per client, a host on another chain is never used, a revert is not retried elsewhere", async () => {
    const { buildClient } = await import("../src/chain-client");
    const seen: string[] = [];
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      seen.push(url);
      if (url.startsWith("https://own")) return new Response("down", { status: 502 });
      const { method } = JSON.parse(String(init?.body));
      // The first public host serves another chain: it is never used.
      if (method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: 1, result: url === publicPool("base", 0)[0] ? "0x1" : "0x2105" });
      return Response.json({ jsonrpc: "2.0", id: 1, result: url === publicPool("base", 0)[0] ? "0x99" : "0x10" });
    }) as typeof fetch;
    const c = buildClient("https://own.example/k", fetchFn);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    // The configured one gets two strikes, then the run goes on without it.
    expect(seen.filter((u) => u.startsWith("https://own")).length).toBe(2);
    const calls: string[] = [];
    const reverts = buildClient(undefined, (async (u: string | URL | Request, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body));
      if (method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2105" });
      calls.push(String(u));
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
    }) as typeof fetch);
    await expect(reverts.request({ method: "eth_call", params: [{ to: A, data: "0x" }, "latest"] } as never)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
});
