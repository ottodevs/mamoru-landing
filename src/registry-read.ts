/**
 * Reads one chain's MamoruRegistry for /ops/money/registry (otto/mamoru#296): its constants, the active pools, vaults
 * and routes, and every change still waiting (from the `Queued` events, checked against `etaOf`), plus the last
 * twenty executed or cancelled. Plain JSON-RPC over the configured RPCs, then a slice of the public pool; a public
 * host is used only after it answered the right chain id. Fails closed: a registry that is not set, or a read that
 * does not complete, never shows a partial list. No URL is ever logged or rendered.
 */

import { decodeFunctionResult, encodeFunctionData } from "viem";
import { isAddress, type RegistryChain } from "./registry-config";
import {
  cancelCalldata,
  decodeParams,
  decodeRegistryLog,
  EVENT_TOPICS,
  executeCalldata,
  foldEvents,
  keyAddress,
  poolLabel,
  type Finished,
  type Params,
  type PoolParams,
  type QueuedChange,
  type RawLog,
  registryAbi,
} from "./registry-model";
import { RunHealth, isHardFailure, ownRpcs } from "./rpc-pool";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const HISTORY = 20;
const REQUEST_MS = 4_000;
const BUDGET_MS = 20_000;
const MAX_CHUNKS = 60;

export interface PoolView {
  address: string;
  /** Name from the deployments table when the pool is a known one. */
  label: string | null;
  v: PoolParams;
}
export interface VaultView {
  address: string;
  ratioBps: number;
}
export interface RouteView {
  domain: number;
}
export interface PendingView {
  change: QueuedChange;
  /** From `etaOf` on chain (the Queued event's value when the call failed). */
  eta: number;
  params: Params | null;
  /** The entry it would replace, when the key already has one. */
  current: Params | null;
  /** The block's time the change was queued at, unix seconds; null when not read. */
  queuedAt: number | null;
  executeData: string;
  cancelData: string;
}
export interface HistoryView {
  f: Finished;
  time: number | null;
  params: Params | null;
}

export type ChainReading =
  | { state: "unset"; chain: RegistryChain["chain"] }
  | { state: "error"; chain: RegistryChain["chain"]; address: string; why: string }
  | {
      state: "ok";
      chain: RegistryChain["chain"];
      address: string;
      /** Chain time of the latest block, unix seconds. */
      asOf: number;
      admin: string;
      guardian: string;
      delaySeconds: number;
      pools: PoolView[];
      vaults: VaultView[];
      routes: RouteView[];
      pending: PendingView[];
      history: HistoryView[];
    };

class Rpc {
  private readonly health: RunHealth;
  private readonly onChain = new Map<string, Promise<boolean>>();
  private id = 0;
  constructor(
    private readonly urls: readonly string[],
    private readonly own: readonly string[],
    private readonly chainId: number,
    private readonly fetchFn: Fetch,
    private readonly deadline: number,
  ) {
    this.health = new RunHealth(own);
  }
  private async post(url: string, method: string, params: unknown[], ms: number): Promise<{ result?: unknown; error?: { code?: unknown } }> {
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("rpc answer is not an object");
    return body as { result?: unknown; error?: { code?: unknown } };
  }
  private serves(url: string): Promise<boolean> {
    if (this.own.includes(url)) return Promise.resolve(true);
    let p = this.onChain.get(url);
    if (!p) {
      p = this.post(url, "eth_chainId", [], REQUEST_MS).then((b) => b.result === `0x${this.chainId.toString(16)}`, () => false);
      this.onChain.set(url, p);
    }
    return p;
  }
  /** The result, or a throw. A revert is the chain's answer and is not retried elsewhere. */
  async call(method: string, params: unknown[]): Promise<unknown> {
    let last: unknown = new Error("no RPC answered");
    for (const url of this.health.healthy(this.urls)) {
      const left = this.deadline - Date.now();
      if (left <= 0) break;
      let body: { result?: unknown; error?: { code?: unknown } };
      try {
        if (!(await this.serves(url))) throw new Error("wrong chain");
        body = await this.post(url, method, params, Math.min(REQUEST_MS, left));
      } catch (e) {
        this.health.fail(url, isHardFailure(e));
        last = e;
        continue;
      }
      if (body.error) {
        if (body.error.code === 3) throw new Error("reverted");
        this.health.fail(url);
        last = new Error("rpc error");
        continue;
      }
      if (!("result" in body)) {
        this.health.fail(url);
        continue;
      }
      this.health.succeed(url);
      return body.result;
    }
    throw last;
  }
}

/** Reads one chain. `urls` are tried in order; `own` are the configured (secret) ones among them. Never throws. */
export async function readRegistry(
  cfg: RegistryChain,
  urls: readonly string[],
  secret: string | undefined,
  fetchFn: Fetch = fetch,
): Promise<ChainReading> {
  const { chain } = cfg;
  if (!cfg.address || !isAddress(cfg.address)) return { state: "unset", chain };
  const address = cfg.address;
  const rpc = new Rpc(urls, ownRpcs(secret), chain.chainId, fetchFn, Date.now() + BUDGET_MS);
  const eth = async (data: `0x${string}`): Promise<`0x${string}`> => (await rpc.call("eth_call", [{ to: address, data }, "latest"])) as `0x${string}`;
  const view = async <N extends string>(functionName: N, args: readonly unknown[] = []): Promise<unknown> => {
    // biome-ignore lint: viem's overload typing does not carry through a generic helper
    const abi = registryAbi as any;
    const data = encodeFunctionData({ abi, functionName, args } as any);
    return decodeFunctionResult({ abi, functionName, data: await eth(data) } as any);
  };
  const blockTime = async (n: number | "latest"): Promise<number> => {
    const b = (await rpc.call("eth_getBlockByNumber", [n === "latest" ? "latest" : `0x${n.toString(16)}`, false])) as { timestamp?: string; number?: string } | null;
    if (!b?.timestamp) throw new Error("no block");
    return Number(BigInt(b.timestamp));
  };
  try {
    const [head, headBlock] = await Promise.all([rpc.call("eth_blockNumber", []), rpc.call("eth_getBlockByNumber", ["latest", false])]);
    const latest = Number(BigInt(head as string));
    const asOf = Number(BigInt((headBlock as { timestamp: string }).timestamp));

    // Every event, from the deployment block to the head, in chunks the RPCs accept.
    const logs: RawLog[] = [];
    let chunks = 0;
    for (let from = cfg.fromBlock; from <= latest; from += cfg.logChunk) {
      if (++chunks > MAX_CHUNKS) throw new Error("the scan is too long: set a later start block");
      const to = Math.min(latest, from + cfg.logChunk - 1);
      const got = (await rpc.call("eth_getLogs", [{ address, topics: [[...EVENT_TOPICS]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])) as RawLog[];
      if (!Array.isArray(got)) throw new Error("logs are not a list");
      logs.push(...got);
    }
    const events = logs.map(decodeRegistryLog).filter((e): e is NonNullable<typeof e> => e !== null);
    if (events.length !== logs.length) throw new Error("an event could not be decoded");
    const folded = foldEvents(events);

    const [admin, guardian, delay, poolAddrs, vaultAddrs] = (await Promise.all([
      view("ADMIN"),
      view("GUARDIAN"),
      view("DELAY"),
      view("activePools"),
      view("activeVaults"),
    ])) as [string, string, bigint, string[], string[]];

    const poolOf = async (a: string): Promise<PoolParams & { active: boolean }> => (await view("poolOf", [a])) as PoolParams & { active: boolean };
    const vaultOf = async (a: string): Promise<{ ratioBps: number; active: boolean }> => (await view("vaultOf", [a])) as { ratioBps: number; active: boolean };

    // A pending change is one the chain still has an ETA for; a log scan that missed an Executed cannot show a ghost.
    const etas = await Promise.all(folded.pending.map((q) => view("etaOf", [q.id]).then((v) => Number(v as bigint), () => q.eta)));
    const live = folded.pending.map((change, i) => ({ change, eta: etas[i] })).filter((p) => p.eta !== 0);

    const [pools, vaults, routeFlags] = await Promise.all([
      Promise.all(poolAddrs.map(async (a) => ({ address: a, label: poolLabel(chain.chainId, a), v: pick(await poolOf(a)) }))),
      Promise.all(vaultAddrs.map(async (a) => ({ address: a, ratioBps: Number((await vaultOf(a)).ratioBps) }))),
      Promise.all(folded.routeDomains.map(async (d) => ((await view("routeOn", [d])) as boolean) && { domain: d })),
    ]);

    // What each pending change would replace, and when it was queued.
    const current = async (q: QueuedChange): Promise<Params | null> => {
      const a = keyAddress(q.key);
      if (q.kind === "pool" && a) {
        const p = await poolOf(a);
        return p.active ? { kind: "pool", v: pick(p) } : null;
      }
      if (q.kind === "vault" && a) {
        const v = await vaultOf(a);
        return v.active ? { kind: "vault", ratioBps: Number(v.ratioBps) } : null;
      }
      return null;
    };
    const pending: PendingView[] = await Promise.all(
      live.map(async ({ change, eta }) => ({
        change,
        eta,
        params: decodeParams(change.kind, change.params),
        current: await current(change).catch(() => null),
        queuedAt: await blockTime(change.at.block).catch(() => null),
        executeData: executeCalldata(change),
        cancelData: cancelCalldata(change.id),
      })),
    );

    const recent = folded.finished.slice(0, HISTORY);
    const blocks = [...new Set(recent.map((f) => f.at.block))];
    const times = new Map<number, number | null>(await Promise.all(blocks.map(async (b) => [b, await blockTime(b).catch(() => null)] as const)));
    const history: HistoryView[] = recent.map((f) => ({ f, time: times.get(f.at.block) ?? null, params: f.kind && f.params ? decodeParams(f.kind, f.params) : null }));

    return {
      state: "ok",
      chain,
      address,
      asOf,
      admin,
      guardian,
      delaySeconds: Number(delay),
      pools,
      vaults,
      routes: routeFlags.filter((r): r is RouteView => r !== false),
      pending,
      history,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // Only our own short reasons are shown; whatever else threw is "not read", never text from an RPC.
    const why = /^(the scan is too long: set a later start block|an event could not be decoded|no RPC answered)$/.test(msg) ? msg : "no RPC answered in time";
    return { state: "error", chain, address, why };
  }
}

const pick = (p: PoolParams): PoolParams => ({
  twapWindow: Number(p.twapWindow),
  twapShortWindow: Number(p.twapShortWindow),
  bandTicks: Number(p.bandTicks),
  anchorTick: Number(p.anchorTick),
  anchorBand: Number(p.anchorBand),
  ratioBps: Number(p.ratioBps),
});
