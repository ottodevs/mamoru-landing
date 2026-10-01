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
/** How long a reading counts as current. Past this it is still shown, and recomputed behind the response. */
const CURRENT_FRESH_MS = 120_000;
/** While reads are failing, look again sooner. */
const FAILING_FRESH_MS = 60_000;
/** How long the current reading stays in KV at all. */
const CURRENT_TTL_SECONDS = 60 * 60;
/** One background recompute at a time. KV's minimum TTL is 60 s. */
const REFRESHING_KEY = "ops:infra:refreshing";
const REFRESHING_TTL_SECONDS = 60;
const GOOD_TTL_SECONDS = 60 * 60 * 24 * 30;

export type StaleReason = "unreachable" | "partial";

export interface InfraReading {
  /** What the page should show. */
  snapshot: InfraSnapshot;
  /** Set when `snapshot` is the last complete reading because a newer read failed. */
  stale?: { failedAt: string; reason: StaleReason };
  /** The snapshot computed during this call, complete or not. Absent on a cache hit. */
  computed?: InfraSnapshot;
  /** A newer reading is being computed behind this response; the page should look again shortly. */
  refreshing?: boolean;
}

interface StoredReading {
  snapshot: InfraSnapshot;
  stale?: InfraReading["stale"];
  storedAt?: number;
}

export interface LoadOptions {
  /** ctx.waitUntil. With it, an aged reading is served at once and recomputed in the background. */
  waitUntil?: (work: Promise<unknown>) => void;
  now?: number;
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

type Compute = (sources: InfraSources) => Promise<InfraSnapshot>;

const defaultCompute: Compute = (s) => computeInfraSnapshot({ BASE_RPC_URL: s.rpcUrl, MAMORU_DB: s.db });

/** Computes now and stores the outcome: a complete reading in both keys, anything else only as current. */
async function computeAndStore(sources: InfraSources, compute: Compute, now: number): Promise<InfraReading> {
  const kv = sources.kv;
  const computed = await compute(sources);
  if (!kv) return { snapshot: computed, computed };
  if (isComplete(computed)) {
    await Promise.all([
      writeJson(kv, CURRENT_KEY, { snapshot: computed, storedAt: now } satisfies StoredReading, CURRENT_TTL_SECONDS),
      writeJson(kv, GOOD_KEY, computed, GOOD_TTL_SECONDS),
    ]);
    return { snapshot: computed, computed };
  }
  const reading = chooseReading(computed, await readJson<InfraSnapshot>(kv, GOOD_KEY));
  await writeJson(
    kv,
    CURRENT_KEY,
    { snapshot: reading.snapshot, stale: reading.stale, storedAt: now } satisfies StoredReading,
    CURRENT_TTL_SECONDS,
  );
  return reading;
}

/** Starts one recompute behind the response. A marker in KV keeps parallel requests from each starting their own. */
async function refreshBehind(sources: InfraSources, compute: Compute, opts: Required<Pick<LoadOptions, "waitUntil">>, now: number): Promise<void> {
  const kv = sources.kv;
  if (!kv) return;
  if (await kv.get(REFRESHING_KEY).catch(() => null)) return;
  await kv.put(REFRESHING_KEY, "1", { expirationTtl: REFRESHING_TTL_SECONDS }).catch(() => undefined);
  opts.waitUntil(
    computeAndStore(sources, compute, now)
      .catch(() => undefined)
      .then(() => kv.delete(REFRESHING_KEY).catch(() => undefined)),
  );
}

/**
 * The reading a page should show.
 *   fresh           compute now, wait for it (Refresh, cron, after a top-up).
 *   cached, current the stored reading.
 *   cached, aged    the stored reading at once; with `waitUntil` a recompute runs behind it
 *                   and `refreshing` tells the page to look again. Without it, compute now.
 *   nothing stored  the last complete reading if there is one (same background rule), else compute now.
 * `compute` is injectable so tests never touch the network.
 */
export async function loadInfraReading(
  sources: InfraSources,
  fresh: boolean,
  compute: Compute = defaultCompute,
  opts: LoadOptions = {},
): Promise<InfraReading> {
  const kv = sources.kv;
  const now = opts.now ?? Date.now();
  if (fresh || !kv) return computeAndStore(sources, compute, now);

  const cached = await readJson<StoredReading>(kv, CURRENT_KEY);
  const waitUntil = opts.waitUntil;
  if (cached?.snapshot) {
    const shown: InfraReading = { snapshot: cached.snapshot, ...(cached.stale ? { stale: cached.stale } : {}) };
    const age = now - (cached.storedAt ?? now);
    if (age <= (cached.stale ? FAILING_FRESH_MS : CURRENT_FRESH_MS)) return shown;
    if (waitUntil) {
      await refreshBehind(sources, compute, { waitUntil }, now);
      return { ...shown, refreshing: true };
    }
    return computeAndStore(sources, compute, now);
  }
  if (waitUntil) {
    const lastGood = await readJson<InfraSnapshot>(kv, GOOD_KEY);
    if (lastGood) {
      await refreshBehind(sources, compute, { waitUntil }, now);
      return { snapshot: lastGood, refreshing: true };
    }
  }
  return computeAndStore(sources, compute, now);
}

/** The snapshot to show. Callers that need to know about a fallback use loadInfraReading. */
export async function loadInfraSnapshot(sources: InfraSources, fresh: boolean): Promise<InfraSnapshot> {
  return (await loadInfraReading(sources, fresh)).snapshot;
}
