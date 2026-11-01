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
  test("the list is the configured RPCs, then six public ones", () => {
    expect(monadRpcList("https://own.example/k", 0)).toEqual(["https://own.example/k", ...MONAD_PUBLIC_RPCS.slice(0, 6)]);
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
