/**
 * Caches Infra readings in the WAITLIST KV so /ops pages are not RPC-on-every-click.
 * Two keys: the current reading (short TTL) and the last complete one (long TTL).
 * A failed or partial read never replaces a complete one: the page falls back to it.
 */

import type { D1Db } from "./d1-infra";
import { computeInfraSnapshot, type InfraSnapshot } from "./infra-snapshot";
import type { WaitlistKv } from "./list";

const CURRENT_KEY = "ops:infra:v2";
const GOOD_KEY = "ops:infra:v1:good";
const CURRENT_TTL_SECONDS = 120;
/** While reads are failing, look again sooner. KV's minimum TTL is 60 s. */
const FAILING_TTL_SECONDS = 60;
const GOOD_TTL_SECONDS = 60 * 60 * 24 * 30;

export type StaleReason = "unreachable" | "partial";

export interface InfraReading {
  /** What the page should show. */
  snapshot: InfraSnapshot;
  /** Set when `snapshot` is the last complete reading because a newer read failed. */
  stale?: { failedAt: string; reason: StaleReason };
  /** The snapshot computed during this call, complete or not. Absent on a cache hit. */
  computed?: InfraSnapshot;
}

export interface InfraSources {
  rpcUrl?: string;
  db?: D1Db;
  kv?: WaitlistKv;
}

/** Complete = Base answered and every read the totals depend on succeeded. */
export function isComplete(snapshot: InfraSnapshot): boolean {
  return !snapshot.rpcError && !snapshot.partial && !snapshot.accounts?.error;
}

/** Which reading to show: the fresh one when complete, else the last complete one, else the fresh one as it is. */
export function chooseReading(computed: InfraSnapshot, lastGood: InfraSnapshot | null): InfraReading {
  if (isComplete(computed) || !lastGood) return { snapshot: computed, computed };
  return {
    snapshot: lastGood,
    stale: { failedAt: computed.asOf, reason: computed.rpcError ? "unreachable" : "partial" },
    computed,
  };
}

async function readJson<T>(kv: WaitlistKv, key: string): Promise<T | null> {
  try {
    const raw = await kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(kv: WaitlistKv, key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // Best effort: a cache-write failure should not take the page down.
  }
}

/**
 * Cached reading, or a fresh compute when `fresh` is set, the cache is cold, or there is no KV.
 * `compute` is injectable so tests never touch the network.
 */
export async function loadInfraReading(
  sources: InfraSources,
  fresh: boolean,
  compute: (sources: InfraSources) => Promise<InfraSnapshot> = (s) =>
    computeInfraSnapshot({ BASE_RPC_URL: s.rpcUrl, MAMORU_DB: s.db }),
): Promise<InfraReading> {
  const kv = sources.kv;
  if (!fresh && kv) {
    const cached = await readJson<InfraReading>(kv, CURRENT_KEY);
    if (cached?.snapshot) return { snapshot: cached.snapshot, ...(cached.stale ? { stale: cached.stale } : {}) };
  }
  const computed = await compute(sources);
  if (!kv) return { snapshot: computed, computed };
  if (isComplete(computed)) {
    await Promise.all([
      writeJson(kv, CURRENT_KEY, { snapshot: computed }, CURRENT_TTL_SECONDS),
      writeJson(kv, GOOD_KEY, computed, GOOD_TTL_SECONDS),
    ]);
    return { snapshot: computed, computed };
  }
  const reading = chooseReading(computed, await readJson<InfraSnapshot>(kv, GOOD_KEY));
  await writeJson(kv, CURRENT_KEY, { snapshot: reading.snapshot, stale: reading.stale }, FAILING_TTL_SECONDS);
  return reading;
}

/** The snapshot to show. Callers that need to know about a fallback use loadInfraReading. */
export async function loadInfraSnapshot(sources: InfraSources, fresh: boolean): Promise<InfraSnapshot> {
  return (await loadInfraReading(sources, fresh)).snapshot;
}
