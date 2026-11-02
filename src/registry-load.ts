/** Loads every chain's registry reading for /ops/money/registry, with a short per-isolate cache (a page reload is not a log scan). */

import { REGISTRY_CHAINS, type RegistryChain } from "./registry-config";
import { type ChainReading, readRegistry } from "./registry-read";
import { ownRpcs } from "./rpc-pool";

export interface RegistryEnv {
  BASE_RPC_URL?: string;
  MONAD_RPC_URLS?: string;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; reading: ChainReading }>();

/** The configured RPCs of a chain: the same server-side env /ops uses for its other chain reads. No public pool. */
function urlsFor(chainId: number, env: RegistryEnv): string[] {
  return ownRpcs(chainId === 8453 ? env.BASE_RPC_URL : env.MONAD_RPC_URLS);
}

export async function loadRegistry(
  env: RegistryEnv,
  opts: { chains?: readonly RegistryChain[]; fetchFn?: typeof fetch; now?: number; fresh?: boolean } = {},
): Promise<ChainReading[]> {
  const now = opts.now ?? Date.now();
  return Promise.all(
    (opts.chains ?? REGISTRY_CHAINS).map(async (cfg) => {
      const key = `${cfg.chain.chainId}:${cfg.address ?? ""}`;
      const hit = cache.get(key);
      if (!opts.fresh && hit && now - hit.at < TTL_MS) return hit.reading;
      const reading = await readRegistry(cfg, urlsFor(cfg.chain.chainId, env), opts.fetchFn, Math.floor(now / 1000));
      // A failed read is not kept: the next load tries again.
      if (reading.state === "ok") cache.set(key, { at: now, reading });
      return reading;
    }),
  );
}

export const clearRegistryCache = (): void => cache.clear();
