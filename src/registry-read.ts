/**
 * Reads one chain's MamoruRegistry for /ops/money/registry (otto/mamoru#296): its constants, the active pools, vaults
 * and routes, every change still waiting (from the `Queued` events, confirmed by `etaOf`), and the last twenty
 * executed or cancelled. This panel is how the team spots a hostile queued change during the timelock, so it never
 * hides or misstates one:
 *  - Only the configured RPCs are read (no public pool): one, or two that must answer the same, byte for byte, at one
 *    pinned block (hash included), each having proved its chain id first. A block older than the chain's limit is an
 *    error. No agreement, no RPC, a failed read: error, no list. The guardian watcher (#293) alerts independently.
 *  - Every log must come from the registry; every change id is recomputed from kind, key, params and nonce, as
 *    MamoruRegistry.sol derives it, before any calldata is built; a mismatch is an error, not a display.
 *  - A read that fails (etaOf, the entry a change replaces, a block time) fails the whole reading. Nothing is
 *    filled in with a guess; nothing "unknown" is ever cached.
 *  - A queued change the contract could not have accepted is shown as anomalous, never dropped.
 * Plain JSON-RPC. Only the host of a configured URL is ever rendered, never its path or query.
 */

import { decodeFunctionResult, encodeFunctionData } from "viem";
import { isAddress, type RegistryChain } from "./registry-config";
import {
  anomalyOf,
  cancelCalldata,
  changeId,
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

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const HISTORY = 20;
const REQUEST_MS = 4_000;
const BUDGET_MS = 25_000;
/** At most two configured RPCs are used; with two, they must agree, and their heads may differ by this many blocks. */
const MAX_HOSTS = 2;
const MAX_HEAD_GAP = 10;

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
  /** From `etaOf` on chain. */
  eta: number;
  params: Params | null;
  /** The entry it would replace, when the key already has one. */
  current: Params | null;
  /** The time of the block it was queued in, unix seconds. */
  queuedAt: number;
  /** Set when the contract could not have accepted this change: the reason. */
  anomaly: string | null;
  executeData: string;
  cancelData: string;
}
export interface HistoryView {
  f: Finished;
  time: number;
  params: Params | null;
}
export interface Source {
  /** The block every answer was pinned to. */
  block: number;
  hash: string;
  /** The host (never the path) of each configured RPC that answered, and agreed. */
  hosts: string[];
}

export type ReadFailure = "rpc" | "disagree" | "inconsistent" | "stale";
export type ChainReading =
  | { state: "unset"; chain: RegistryChain["chain"] }
  | { state: "error"; chain: RegistryChain["chain"]; address: string; kind: ReadFailure; why: string }
  | {
      state: "ok";
      chain: RegistryChain["chain"];
      address: string;
      /** Chain time of the pinned block, unix seconds. */
      asOf: number;
      source: Source;
      admin: string;
      guardian: string;
      delaySeconds: number;
      pools: PoolView[];
      vaults: VaultView[];
      routes: RouteView[];
      pending: PendingView[];
      history: HistoryView[];
    };

/** What the contract and the log scan disagree about, in a short fixed phrase (never text from an RPC). */
class Inconsistent extends Error {}
const inconsistent = (why: string): never => {
  throw new Inconsistent(why);
};

interface Snap {
  block: number;
  hash: string;
  time: number;
  logs: { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string }[];
  admin: string;
  guardian: string;
  delay: string;
  poolAddrs: string[];
  vaultAddrs: string[];
  pools: Record<string, PoolParams & { active: boolean }>;
  vaults: Record<string, { ratioBps: number; active: boolean }>;
  routes: Record<string, boolean>;
  etas: Record<string, string>;
  times: Record<string, number>;
}

class Host {
  private id = 0;
  private chainOk: Promise<boolean> | null = null;
  constructor(
    readonly url: string,
    readonly name: string,
    private readonly chainId: number,
    private readonly fetchFn: Fetch,
    private readonly deadline: number,
  ) {}
  private async post(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code?: unknown } }> {
    const left = this.deadline - Date.now();
    if (left <= 0) throw Object.assign(new Error("out of time"), { name: "TimeoutError" });
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(Math.min(REQUEST_MS, left)),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("rpc answer is not an object");
    return body as { result?: unknown; error?: { code?: unknown } };
  }
  /** Every host, configured or public, proves it serves this chain before anything it says is used. */
  private serves(): Promise<boolean> {
    this.chainOk ??= this.post("eth_chainId", []).then((b) => b.result === `0x${this.chainId.toString(16)}`, () => false);
    return this.chainOk;
  }
  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!(await this.serves())) throw new Error("wrong chain");
    const body = await this.post(method, params);
    if (body.error) throw new Error(body.error.code === 3 ? "reverted" : "rpc error");
    if (!("result" in body)) throw new Error("rpc answer without a result");
    return body.result;
  }
}

/** JSON with keys sorted at every level: two equal states always compare equal, whatever order the answers came in. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const hex = (n: number) => `0x${n.toString(16)}`;

/** Everything the page needs, read from one host at one block. Throws on any failed read. */
async function readAt(host: Host, block: number, cfg: RegistryChain & { address: string }): Promise<Snap> {
  const at = hex(block);
  const address = cfg.address;
  const view = async (functionName: string, args: readonly unknown[] = []): Promise<unknown> => {
    // biome-ignore lint: viem's overload typing does not carry through a generic helper
    const abi = registryAbi as any;
    const data = encodeFunctionData({ abi, functionName, args } as any);
    const out = (await host.call("eth_call", [{ to: address, data }, at])) as `0x${string}`;
    return decodeFunctionResult({ abi, functionName, data: out } as any);
  };
  const header = async (n: number | string) => {
    const b = (await host.call("eth_getBlockByNumber", [typeof n === "number" ? hex(n) : n, false])) as { hash?: string; timestamp?: string } | null;
    if (!b?.timestamp || !b.hash) throw new Error("no block");
    return { hash: b.hash, time: Number(BigInt(b.timestamp)) };
  };
  const head = await header(block);

  const raw: unknown[] = [];
  for (let from = cfg.fromBlock; from <= block; from += cfg.logChunk) {
    const to = Math.min(block, from + cfg.logChunk - 1);
    const got = await host.call("eth_getLogs", [{ address, topics: [[...EVENT_TOPICS]], fromBlock: hex(from), toBlock: hex(to) }]);
    if (!Array.isArray(got)) throw new Error("logs are not a list");
    raw.push(...got);
  }
  const logs = (raw as (RawLog & { address?: string })[]).map((l) => ({
    address: String(l.address ?? "").toLowerCase(),
    topics: [...l.topics],
    data: l.data,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
    transactionHash: l.transactionHash,
  }));
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  if (logs.some((l) => l.address !== address.toLowerCase())) inconsistent("a log came from an address that is not the registry");
  const events = logs.map((l) => decodeRegistryLog(l as unknown as RawLog));
  if (events.some((e) => e === null)) inconsistent("an event of the registry could not be decoded");
  const folded = foldEvents(events as NonNullable<(typeof events)[number]>[]);
  if (folded.anomalies.length) inconsistent(folded.anomalies[0]!);
  for (const q of folded.pending) if (changeId(q) !== q.id.toLowerCase()) inconsistent("a queued change's id does not match its fields");

  const [admin, guardian, delay, poolAddrs, vaultAddrs] = (await Promise.all([view("ADMIN"), view("GUARDIAN"), view("DELAY"), view("activePools"), view("activeVaults")])) as [string, string, bigint, string[], string[]];

  const etas: Record<string, string> = {};
  await Promise.all(folded.pending.map(async (q) => void (etas[q.id] = String((await view("etaOf", [q.id])) as bigint))));
  const live = folded.pending.filter((q) => etas[q.id] !== "0");

  const pools: Snap["pools"] = {};
  const vaults: Snap["vaults"] = {};
  const poolKeys = new Set(poolAddrs);
  const vaultKeys = new Set(vaultAddrs);
  for (const q of live) {
    const a = keyAddress(q.key);
    if (a && q.kind === "pool") poolKeys.add(a);
    if (a && q.kind === "vault") vaultKeys.add(a);
  }
  await Promise.all([
    ...[...poolKeys].map(async (a) => void (pools[a.toLowerCase()] = pickPool((await view("poolOf", [a])) as PoolParams & { active: boolean }))),
    ...[...vaultKeys].map(async (a) => {
      const v = (await view("vaultOf", [a])) as { ratioBps: number; active: boolean };
      vaults[a.toLowerCase()] = { ratioBps: Number(v.ratioBps), active: Boolean(v.active) };
    }),
  ]);
  const routes: Snap["routes"] = {};
  await Promise.all(folded.routeDomains.map(async (d) => void (routes[String(d)] = Boolean(await view("routeOn", [d])))));

  // Times: the blocks of the live changes and of the last twenty finished ones.
  const blocks = new Set<number>([...live.map((q) => q.at.block), ...folded.finished.slice(0, HISTORY).map((f) => f.at.block)]);
  const times: Record<string, number> = {};
  await Promise.all([...blocks].map(async (b) => void (times[String(b)] = (await header(b)).time)));

  return {
    block,
    hash: head.hash,
    time: head.time,
    logs,
    admin,
    guardian,
    delay: String(delay),
    poolAddrs,
    vaultAddrs,
    pools,
    vaults,
    routes,
    etas,
    times,
  };
}

const pickPool = (p: PoolParams & { active: boolean }): PoolParams & { active: boolean } => ({
  twapWindow: Number(p.twapWindow),
  twapShortWindow: Number(p.twapShortWindow),
  bandTicks: Number(p.bandTicks),
  anchorTick: Number(p.anchorTick),
  anchorBand: Number(p.anchorBand),
  ratioBps: Number(p.ratioBps),
  active: Boolean(p.active),
});
const stripActive = ({ active: _a, ...v }: PoolParams & { active: boolean }): PoolParams => v;

/** The page's model from one agreed snapshot. */
function assemble(snap: Snap, cfg: RegistryChain & { address: string }, hosts: string[]): ChainReading {
  const events = snap.logs.map((l) => decodeRegistryLog(l as unknown as RawLog)!);
  const folded = foldEvents(events);
  const live = folded.pending.filter((q) => snap.etas[q.id] !== "0");
  const pending: PendingView[] = live.map((change) => {
    const a = keyAddress(change.key);
    let current: Params | null = null;
    if (a && change.kind === "pool") {
      const p = snap.pools[a.toLowerCase()];
      if (p?.active) current = { kind: "pool", v: stripActive(p) };
    } else if (a && change.kind === "vault") {
      const v = snap.vaults[a.toLowerCase()];
      if (v?.active) current = { kind: "vault", ratioBps: v.ratioBps };
    }
    return {
      change,
      eta: Number(snap.etas[change.id]),
      params: decodeParams(change.kind, change.params),
      current,
      queuedAt: snap.times[String(change.at.block)]!,
      anomaly: anomalyOf(change),
      executeData: executeCalldata(change),
      cancelData: cancelCalldata(change.id),
    };
  });
  const history: HistoryView[] = folded.finished.slice(0, HISTORY).map((f) => ({ f, time: snap.times[String(f.at.block)]!, params: f.kind && f.params ? decodeParams(f.kind, f.params) : null }));
  return {
    state: "ok",
    chain: cfg.chain,
    address: cfg.address,
    asOf: snap.time,
    source: { block: snap.block, hash: snap.hash, hosts },
    admin: snap.admin,
    guardian: snap.guardian,
    delaySeconds: Number(snap.delay),
    pools: snap.poolAddrs.map((a) => ({ address: a, label: poolLabel(cfg.chain.chainId, a), v: stripActive(snap.pools[a.toLowerCase()]!) })),
    vaults: snap.vaultAddrs.map((a) => ({ address: a, ratioBps: snap.vaults[a.toLowerCase()]!.ratioBps })),
    routes: Object.entries(snap.routes).filter(([, on]) => on).map(([d]) => ({ domain: Number(d) })).sort((a, b) => a.domain - b.domain),
    pending,
    history,
  };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/**
 * Reads one chain from its configured RPCs (`urls`): one or two, two must agree. Never throws. `nowSec` is the clock
 * the staleness check uses.
 */
export async function readRegistry(
  cfg: RegistryChain,
  urls: readonly string[],
  fetchFn: Fetch = fetch,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<ChainReading> {
  const { chain } = cfg;
  if (!cfg.address || !isAddress(cfg.address)) return { state: "unset", chain };
  const c = { ...cfg, address: cfg.address };
  const deadline = Date.now() + BUDGET_MS;
  const fail = (kind: ReadFailure, why: string): ChainReading => ({ state: "error", chain, address: c.address, kind, why });

  // One host per distinct hostname: two URLs on one host are one witness.
  const seen = new Set<string>();
  const hosts: Host[] = [];
  for (const url of urls) {
    const key = hostOf(url);
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push(new Host(url, key, chain.chainId, fetchFn, deadline));
    if (hosts.length >= MAX_HOSTS) break;
  }
  if (hosts.length === 0) return fail("rpc", "no RPC is configured for this chain");

  // Every configured host must answer with a head, and with two they must be within a few blocks of each other.
  let heads: number[];
  try {
    heads = await Promise.all(
      hosts.map(async (h) => {
        const b = (await h.call("eth_getBlockByNumber", ["latest", false])) as { number?: string } | null;
        if (!b?.number) throw new Error("no block");
        return Number(BigInt(b.number));
      }),
    );
  } catch {
    return fail("rpc", hosts.length === 2 ? "a configured RPC did not answer" : "the configured RPC did not answer");
  }
  if (Math.max(...heads) - Math.min(...heads) > MAX_HEAD_GAP) return fail("stale", `the two RPCs are more than ${MAX_HEAD_GAP} blocks apart`);
  const block = Math.min(...heads);

  const snaps: { host: Host; snap: Snap }[] = [];
  let bad: Inconsistent | null = null;
  const settled = await Promise.allSettled(hosts.map((h) => readAt(h, block, c)));
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") snaps.push({ host: hosts[i]!, snap: r.value });
    else if (r.reason instanceof Inconsistent) bad = r.reason;
  });
  if (bad) return fail("inconsistent", (bad as Inconsistent).message);
  if (snaps.length !== hosts.length) return fail("rpc", "a configured RPC could not complete the read");
  const first = canon(snaps[0]!.snap);
  if (snaps.some((x) => canon(x.snap) !== first)) return fail("disagree", "the two RPCs gave different answers for the same block");
  const age = nowSec - snaps[0]!.snap.time;
  if (age > cfg.maxAgeSeconds) return fail("stale", `the latest block is ${age} s old, over the ${cfg.maxAgeSeconds} s limit`);
  try {
    return assemble(snaps[0]!.snap, c, snaps.map((x) => x.host.name));
  } catch {
    return fail("inconsistent", "the registry's answer could not be put together");
  }
}
