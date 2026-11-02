/**
 * MamoruRegistry (ottodevs/mamoru contracts/action-policy/src/MamoruRegistry.sol, spec 010) as /ops reads it:
 * the ABI fragments, event decoding, the fold of events into pending and finished changes, entry parameters in
 * words, and the exact calldata a signer needs for `execute` and `cancel`. Pure: no network, no clock but `now`.
 */

import { DEPLOYMENTS } from "./deployments";
import { decodeAbiParameters, decodeEventLog, encodeFunctionData, parseAbi, toEventSelector } from "viem";

export const registryAbi = parseAbi([
  "event Queued(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta)",
  "event Executed(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params)",
  "event Cancelled(bytes32 indexed id, address indexed by)",
  "event Removed(uint8 indexed kind, bytes32 indexed key)",
  "event Tightened(uint8 indexed kind, bytes32 indexed key, bytes params)",
  "function ADMIN() view returns (address)",
  "function GUARDIAN() view returns (address)",
  "function DELAY() view returns (uint256)",
  "function etaOf(bytes32 id) view returns (uint256)",
  "function routeOn(uint32 domain) view returns (bool)",
  "function activePools() view returns (address[])",
  "function activeVaults() view returns (address[])",
  "function poolOf(address pool) view returns ((uint32 twapWindow, uint32 twapShortWindow, uint24 bandTicks, int24 anchorTick, uint24 anchorBand, uint16 ratioBps, bool active))",
  "function vaultOf(address vault) view returns ((uint16 ratioBps, bool active))",
  "function execute(uint8 kind, bytes32 key, bytes params, uint256 n)",
  "function cancel(bytes32 id)",
]);

export const EVENT_TOPICS: readonly `0x${string}`[] = (["Queued", "Executed", "Cancelled", "Removed", "Tightened"] as const).map(
  (name) => toEventSelector(registryAbi.find((i) => i.type === "event" && i.name === name)!),
);

export type Kind = "pool" | "vault" | "route";
const KINDS: readonly Kind[] = ["pool", "vault", "route"];
const kindOf = (n: unknown): Kind | null => (typeof n === "number" || typeof n === "bigint" ? (KINDS[Number(n)] ?? null) : null);

/** A raw eth_getLogs entry, the fields we use. */
export interface RawLog {
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
}

export type RegistryEvent =
  | { type: "queued"; id: string; kind: Kind; key: string; params: `0x${string}`; nonce: bigint; eta: number; at: Pos }
  | { type: "executed"; id: string; kind: Kind; key: string; params: `0x${string}`; at: Pos }
  | { type: "cancelled"; id: string; by: string; at: Pos }
  | { type: "removed"; kind: Kind; key: string; at: Pos }
  | { type: "tightened"; kind: Kind; key: string; params: `0x${string}`; at: Pos };

export interface Pos {
  block: number;
  index: number;
  tx: string;
}

/** One log as an event; null when it is not one of ours or does not decode (never a guess). */
export function decodeRegistryLog(log: RawLog): RegistryEvent | null {
  try {
    const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
    const at: Pos = { block: Number(BigInt(log.blockNumber)), index: Number(BigInt(log.logIndex)), tx: log.transactionHash };
    const a = ev.args as Record<string, unknown>;
    if (ev.eventName === "Cancelled") return { type: "cancelled", id: String(a.id), by: String(a.by), at };
    const kind = kindOf(a.kind);
    if (!kind) return null;
    const key = String(a.key);
    switch (ev.eventName) {
      case "Queued":
        return { type: "queued", id: String(a.id), kind, key, params: a.params as `0x${string}`, nonce: a.nonce as bigint, eta: Number(a.eta as bigint), at };
      case "Executed":
        return { type: "executed", id: String(a.id), kind, key, params: a.params as `0x${string}`, at };
      case "Removed":
        return { type: "removed", kind, key, at };
      case "Tightened":
        return { type: "tightened", kind, key, params: a.params as `0x${string}`, at };
    }
  } catch {
    return null;
  }
  return null;
}

const before = (a: RegistryEvent, b: RegistryEvent) => a.at.block - b.at.block || a.at.index - b.at.index;

export interface QueuedChange {
  id: string;
  kind: Kind;
  key: string;
  params: `0x${string}`;
  nonce: bigint;
  /** Earliest execution time, unix seconds (from the Queued event). */
  eta: number;
  at: Pos;
}

/** A change that is over: executed, or cancelled (by whom). */
export interface Finished {
  how: "executed" | "cancelled";
  id: string;
  kind: Kind | null;
  key: string | null;
  params: `0x${string}` | null;
  by: string | null;
  at: Pos;
}

export interface Folded {
  /** Queued and neither executed nor cancelled, oldest first. */
  pending: QueuedChange[];
  /** Newest first. */
  finished: Finished[];
  /** Pool, vault and route keys that ever had an entry event: what to ask the chain about. */
  routeDomains: number[];
}

/** Events in, pending and finished out. The chain's `etaOf` has the last word on a pending id (see registry-read). */
export function foldEvents(events: readonly RegistryEvent[]): Folded {
  const sorted = [...events].sort(before);
  const queued = new Map<string, QueuedChange>();
  const finished: Finished[] = [];
  const domains = new Set<number>();
  for (const e of sorted) {
    if (e.type === "queued") queued.set(e.id, e);
    else if (e.type === "executed") {
      queued.delete(e.id);
      finished.push({ how: "executed", id: e.id, kind: e.kind, key: e.key, params: e.params, by: null, at: e.at });
    } else if (e.type === "cancelled") {
      const q = queued.get(e.id);
      queued.delete(e.id);
      finished.push({ how: "cancelled", id: e.id, kind: q?.kind ?? null, key: q?.key ?? null, params: q?.params ?? null, by: e.by, at: e.at });
    }
    if ((e.type === "queued" || e.type === "executed" || e.type === "removed" || e.type === "tightened") && e.kind === "route") {
      const d = Number(BigInt(e.key));
      if (Number.isSafeInteger(d)) domains.add(d);
    }
  }
  return { pending: [...queued.values()], finished: finished.reverse(), routeDomains: [...domains].sort((a, b) => a - b) };
}

// ---- entries in words ----

export interface PoolParams {
  twapWindow: number;
  twapShortWindow: number;
  bandTicks: number;
  anchorTick: number;
  anchorBand: number;
  ratioBps: number;
}

export type Params = { kind: "pool"; v: PoolParams } | { kind: "vault"; ratioBps: number } | { kind: "route" };

/** The parameters a Queued/Executed event carries; null when they are malformed. */
export function decodeParams(kind: Kind, params: `0x${string}`): Params | null {
  try {
    if (kind === "route") return { kind: "route" };
    if (kind === "vault") {
      const [r] = decodeAbiParameters([{ type: "uint16" }], params);
      return { kind: "vault", ratioBps: Number(r) };
    }
    const [w, ws, band, at, ab, ratio] = decodeAbiParameters(
      [{ type: "uint32" }, { type: "uint32" }, { type: "uint24" }, { type: "int24" }, { type: "uint24" }, { type: "uint16" }],
      params,
    );
    return { kind: "pool", v: { twapWindow: Number(w), twapShortWindow: Number(ws), bandTicks: Number(band), anchorTick: Number(at), anchorBand: Number(ab), ratioBps: Number(ratio) } };
  } catch {
    return null;
  }
}

/** A key as the address (pools, vaults) or the CCTP domain (routes) it stands for; null when it is neither. */
export function keyAddress(key: string): string | null {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(key) ? `0x${key.slice(26)}` : null;
}
export function keyDomain(key: string): number | null {
  try {
    const n = BigInt(key);
    return n <= 0xffffffffn ? Number(n) : null;
  } catch {
    return null;
  }
}

export const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)} %`;

export function fmtSeconds(s: number): string {
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** "Takes effect in 61 h": whole hours rounded up from a day on, then minutes; "now" once the wait is over. */
export function timeLeft(eta: number, now: number): { text: string; ready: boolean; seconds: number } {
  const left = eta - now;
  if (left <= 0) return { text: "Waited out: it can be executed now", ready: true, seconds: 0 };
  if (left >= 3600) return { text: `Takes effect in ${Math.ceil(left / 3600)} h`, ready: false, seconds: left };
  return { text: `Takes effect in ${Math.max(1, Math.ceil(left / 60))} min`, ready: false, seconds: left };
}

// ---- calldata a signer needs ----

/** execute(kind, key, params, nonce) of a pending change. */
export function executeCalldata(q: Pick<QueuedChange, "kind" | "key" | "params" | "nonce">): `0x${string}` {
  return encodeFunctionData({ abi: registryAbi, functionName: "execute", args: [KINDS.indexOf(q.kind), q.key as `0x${string}`, q.params, q.nonce] });
}

/** cancel(id) of a pending change. */
export function cancelCalldata(id: string): `0x${string}` {
  return encodeFunctionData({ abi: registryAbi, functionName: "cancel", args: [id as `0x${string}`] });
}

/** "WETH/USDC 0.3%" for a pool the deployments table knows on this chain; null otherwise. */
export function poolLabel(chainId: number, address: string): string | null {
  const d = DEPLOYMENTS.find((x) => x.chainId === chainId)?.contracts.find((c) => c.address.toLowerCase() === address.toLowerCase());
  return d && d.name.startsWith("Pool ") ? d.name.slice(5) : null;
}
