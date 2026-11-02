/**
 * A fake chain for the MamoruRegistry (otto/mamoru#296): `fixtureFetch` answers the JSON-RPC calls the reader makes
 * (eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getLogs, eth_call) from a list of events, with ABI encoding by
 * viem, so the tests and the screenshots read the same state through the real reader. 2 s blocks, head at `now`.
 */

import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Hex } from "viem";
import { changeId, registryAbi, type Kind } from "../src/registry-model";
import type { RegistryChain } from "../src/registry-config";
import { BASE, MONAD } from "../src/funding";

export const REGISTRY = "0x3c8f1d5a7b9e2f4a6c0d8e1b3a5c7d9f2e4b6a80";
export const ADMIN = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5af0";
export const GUARDIAN = "0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD";
export const POOL_WETH = "0x6c561B446416E1A00E8E93E221854d6eA4171372";
export const POOL_CBBTC = "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef";
export const POOL_NEW = "0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1";
export const POOL_TRAP = "0x1111111111111111111111111111111111111111";
export const VAULT = "0x2222222222222222222222222222222222222222";
export const DELAY = 72 * 3600;
export const HEAD = 1_000_000;
const KIND: Record<Kind, number> = { pool: 0, vault: 1, route: 2 };

const pad32 = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
export const keyOf = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const fake = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export interface Pool {
  twapWindow: number;
  twapShortWindow: number;
  bandTicks: number;
  anchorTick: number;
  anchorBand: number;
  ratioBps: number;
}
export const poolParams = (p: Pool): Hex =>
  encodeAbiParameters([{ type: "uint32" }, { type: "uint32" }, { type: "uint24" }, { type: "int24" }, { type: "uint24" }, { type: "uint16" }], [p.twapWindow, p.twapShortWindow, p.bandTicks, p.anchorTick, p.anchorBand, p.ratioBps]);
export const vaultParams = (r: number): Hex => encodeAbiParameters([{ type: "uint16" }], [r]);
export const routeParams = (): Hex => encodeAbiParameters([{ type: "bool" }], [true]);

export type Ev =
  | { t: "queued"; block: number; id: number; kind: Kind; key: Hex; params: Hex; nonce: number; eta: number }
  | { t: "executed"; block: number; id: number; kind: Kind; key: Hex; params: Hex }
  | { t: "cancelled"; block: number; id: number; by: string };

/** The real id of the queued change labelled `n` (keccak of kind, key, params, nonce), the way the contract derives it. */
export function idOf(events: readonly Ev[], n: number): Hex {
  const q = events.find((e): e is Extract<Ev, { t: "queued" }> => e.t === "queued" && e.id === n);
  return q ? (changeId({ kind: q.kind, key: q.key, params: q.params, nonce: BigInt(q.nonce) }) as Hex) : fake(n);
}

export interface Fixture {
  now: number;
  events: Ev[];
  pools: Record<string, Pool & { active: boolean }>;
  vaults: Record<string, { ratioBps: number; active: boolean }>;
  routes: Record<number, boolean>;
  eta: Record<number, number>;
  chainId: number;
}

const blockAt = (hoursAgo: number) => HEAD - Math.round((hoursAgo * 3600) / 2);

const WETH: Pool = { twapWindow: 1800, twapShortWindow: 300, bandTicks: 60, anchorTick: -200_000, anchorBand: 120, ratioBps: 4000 };
const CBBTC: Pool = { twapWindow: 3600, twapShortWindow: 600, bandTicks: 40, anchorTick: 70_000, anchorBand: 100, ratioBps: 3000 };
export const NEW_POOL: Pool = { twapWindow: 1800, twapShortWindow: 300, bandTicks: 10, anchorTick: -276_320, anchorBand: 50, ratioBps: 2500 };
export const WIDER_WETH: Pool = { ...WETH, bandTicks: 120, ratioBps: 5000 };

/** 2 active pools, 1 vault, 1 route, 2 pending (one with 61 h left), and a history with an executed and a cancelled change. */
export function standardFixture(now: number): Fixture {
  const events: Ev[] = [
    { t: "queued", block: blockAt(600), id: 1, kind: "pool", key: keyOf(POOL_WETH), params: poolParams(WETH), nonce: 0, eta: now - 528 * 3600 },
    { t: "executed", block: blockAt(528), id: 1, kind: "pool", key: keyOf(POOL_WETH), params: poolParams(WETH) },
    { t: "queued", block: blockAt(599), id: 2, kind: "pool", key: keyOf(POOL_CBBTC), params: poolParams(CBBTC), nonce: 1, eta: now - 527 * 3600 },
    { t: "executed", block: blockAt(527), id: 2, kind: "pool", key: keyOf(POOL_CBBTC), params: poolParams(CBBTC) },
    { t: "queued", block: blockAt(598), id: 3, kind: "vault", key: keyOf(VAULT), params: vaultParams(2500), nonce: 2, eta: now - 526 * 3600 },
    { t: "executed", block: blockAt(526), id: 3, kind: "vault", key: keyOf(VAULT), params: vaultParams(2500) },
    { t: "queued", block: blockAt(597), id: 4, kind: "route", key: pad32(15), params: routeParams(), nonce: 3, eta: now - 525 * 3600 },
    { t: "executed", block: blockAt(525), id: 4, kind: "route", key: pad32(15), params: routeParams() },
    // A trap pool, caught by the guardian before it took effect.
    { t: "queued", block: blockAt(300), id: 5, kind: "pool", key: keyOf(POOL_TRAP), params: poolParams({ ...NEW_POOL, bandTicks: 500, ratioBps: 10_000 }), nonce: 4, eta: now - 228 * 3600 },
    { t: "cancelled", block: blockAt(290), id: 5, by: GUARDIAN },
    // Pending: a new pool (61 h left, queued 11 h ago) and a wider band on the WETH pool (9 h left).
    { t: "queued", block: blockAt(11), id: 6, kind: "pool", key: keyOf(POOL_NEW), params: poolParams(NEW_POOL), nonce: 5, eta: now + 61 * 3600 },
    { t: "queued", block: blockAt(63), id: 7, kind: "pool", key: keyOf(POOL_WETH), params: poolParams(WIDER_WETH), nonce: 6, eta: now + 9 * 3600 },
  ];
  return {
    now,
    events,
    pools: { [POOL_WETH.toLowerCase()]: { ...WETH, active: true }, [POOL_CBBTC.toLowerCase()]: { ...CBBTC, active: true } },
    vaults: { [VAULT.toLowerCase()]: { ratioBps: 2500, active: true } },
    routes: { 15: true },
    eta: { 6: now + 61 * 3600, 7: now + 9 * 3600 },
    chainId: 8453,
  };
}

export const fixtureChain = (over: Partial<RegistryChain> = {}): RegistryChain => ({ chain: BASE, address: REGISTRY, fromBlock: 0, logChunk: 5_000_000, ...over });
export const monadChain = (over: Partial<RegistryChain> = {}): RegistryChain => ({ chain: MONAD, address: null, fromBlock: 0, logChunk: 100_000, ...over });

export interface Calls {
  methods: string[];
  logRanges: [number, number][];
}

export function fixtureFetch(f: Fixture, calls: Calls = { methods: [], logRanges: [] }, opts: { chainIdOf?: (url: string) => number; failLogs?: boolean; logAddress?: string; tamper?: (url: string, method: string, params: any[], result: unknown) => unknown; failCalls?: string[] } = {}) {
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] };
    calls.methods.push(body.method);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: opts.tamper ? opts.tamper(url, body.method, body.params, result) : result }));
    const timeOf = (n: number) => f.now - (HEAD - n) * 2;
    switch (body.method) {
      case "eth_chainId":
        return ok(`0x${(opts.chainIdOf?.(url) ?? f.chainId).toString(16)}`);
      case "eth_blockNumber":
        return ok(`0x${HEAD.toString(16)}`);
      case "eth_getBlockByNumber": {
        const n = body.params[0] === "latest" ? HEAD : Number(BigInt(body.params[0]));
        return ok({ number: `0x${n.toString(16)}`, hash: fake(n + 7), timestamp: `0x${timeOf(n).toString(16)}` });
      }
      case "eth_getLogs": {
        if (opts.failLogs) return new Response("nope", { status: 500 });
        const from = Number(BigInt(body.params[0].fromBlock));
        const to = Number(BigInt(body.params[0].toBlock));
        calls.logRanges.push([from, to]);
        const logs = f.events
          .filter((e) => e.block >= from && e.block <= to)
          .map((e, i) => {
            const common = { blockNumber: `0x${e.block.toString(16)}`, logIndex: `0x${i.toString(16)}`, transactionHash: fake(9000 + e.id), address: opts.logAddress ?? REGISTRY };
            const ev = (name: string, args: Record<string, unknown>, data: Hex) => {
              const topics = encodeEventTopics({ abi: registryAbi, eventName: name as "Queued", args: args as any });
              return { ...common, topics, data };
            };
            if (e.t === "queued")
              return ev("Queued", { id: idOf(f.events, e.id), kind: KIND[e.kind], key: e.key }, encodeAbiParameters([{ type: "bytes" }, { type: "uint256" }, { type: "uint256" }], [e.params, BigInt(e.nonce), BigInt(e.eta)]));
            if (e.t === "executed") return ev("Executed", { id: idOf(f.events, e.id), kind: KIND[e.kind], key: e.key }, encodeAbiParameters([{ type: "bytes" }], [e.params]));
            return ev("Cancelled", { id: idOf(f.events, e.id), by: e.by }, "0x");
          });
        return ok(logs);
      }
      case "eth_call": {
        const data = body.params[0].data as Hex;
        const { functionName, args } = decodeFunctionData({ abi: registryAbi, data }) as { functionName: any; args: any[] | undefined };
        if (opts.failCalls?.includes(functionName)) return new Response("nope", { status: 500 });
        const enc = (result: unknown) => ok(encodeFunctionResult({ abi: registryAbi, functionName, result } as any));
        switch (functionName) {
          case "ADMIN":
            return enc(ADMIN);
          case "GUARDIAN":
            return enc(GUARDIAN);
          case "DELAY":
            return enc(BigInt(DELAY));
          case "activePools":
            return enc(Object.entries(f.pools).filter(([, p]) => p.active).map(([a]) => a));
          case "activeVaults":
            return enc(Object.entries(f.vaults).filter(([, v]) => v.active).map(([a]) => a));
          case "poolOf":
            return enc(f.pools[String(args![0]).toLowerCase()] ?? { twapWindow: 0, twapShortWindow: 0, bandTicks: 0, anchorTick: 0, anchorBand: 0, ratioBps: 0, active: false });
          case "vaultOf":
            return enc(f.vaults[String(args![0]).toLowerCase()] ?? { ratioBps: 0, active: false });
          case "routeOn":
            return enc(Boolean(f.routes[Number(args![0])]));
          case "etaOf":
            return enc(BigInt(f.eta[Object.keys(f.eta).map(Number).find((n) => idOf(f.events, n).toLowerCase() === String(args![0]).toLowerCase()) ?? -1] ?? 0));
        }
        throw new Error(`unexpected call ${functionName}`);
      }
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  return fn as unknown as typeof fetch;
}
