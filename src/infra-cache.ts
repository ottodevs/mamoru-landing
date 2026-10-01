/** Caches the computed Infra snapshot in the WAITLIST KV so /ops/infra is not an RPC-on-every-click page. */

import type { D1Db } from "./d1-infra";
import { computeInfraSnapshot, type InfraSnapshot } from "./infra-snapshot";
import type { WaitlistKv } from "./list";

const CACHE_KEY = "ops:infra:v1";
const CACHE_TTL_SECONDS = 120;

async function readCached(kv: WaitlistKv): Promise<InfraSnapshot | null> {
  try {
    const raw = await kv.get(CACHE_KEY);
    return raw ? (JSON.parse(raw) as InfraSnapshot) : null;
  } catch {
    return null;
  }
}

async function writeCached(kv: WaitlistKv, snapshot: InfraSnapshot): Promise<void> {
  try {
    await kv.put(CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Best effort: a cache-write failure should not take the page down.
  }
}

export interface InfraSources {
  rpcUrl?: string;
  db?: D1Db;
  kv?: WaitlistKv;
}

/** Cached read, or a fresh compute when `fresh` is set, the cache is cold, or there is no KV. */
export async function loadInfraSnapshot(sources: InfraSources, fresh: boolean): Promise<InfraSnapshot> {
  if (!fresh && sources.kv) {
    const cached = await readCached(sources.kv);
    if (cached) return cached;
  }
  const snapshot = await computeInfraSnapshot({ BASE_RPC_URL: sources.rpcUrl, MAMORU_DB: sources.db });
  if (sources.kv) await writeCached(sources.kv, snapshot);
  return snapshot;
}
