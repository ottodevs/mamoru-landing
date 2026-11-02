/** Loads every chain's registry reading for /ops/money/registry, with a short per-isolate cache (a page reload is not a log scan). */

import { rpcUrls } from "./chain-addresses";
import { monadRpcList } from "./monad-holdings";
import { REGISTRY_CHAINS, type RegistryChain } from "./registry-config";
import { type ChainReading, readRegistry } from "./registry-read";
import { hourRotation, ownRpcs } from "./rpc-pool";

export interface RegistryEnv {
  BASE_RPC_URL?: string;
  MONAD_RPC_URLS?: string;
}

const TTL_MS = 30_000;
const PUBLIC_PER_READ = 6;
const cache = new Map<string, { at: number; reading: ChainReading }>();

function urlsFor(chainId: number, env: RegistryEnv): { urls: string[]; secret: string | undefined } {
  if (chainId === 8453) return { urls: rpcUrls(env.BASE_RPC_URL), secret: env.BASE_RPC_URL };
  const own = ownRpcs(env.MONAD_RPC_URLS).length;
  return { urls: monadRpcList(env.MONAD_RPC_URLS, hourRotation()).slice(0, own + PUBLIC_PER_READ), secret: env.MONAD_RPC_URLS };
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
      const { urls, secret } = urlsFor(cfg.chain.chainId, env);
      const reading = await readRegistry(cfg, urls, secret, opts.fetchFn);
      // A failed read is not kept: the next load tries again.
      if (reading.state === "ok") cache.set(key, { at: now, reading });
      return reading;
    }),
  );
}

export const clearRegistryCache = (): void => cache.clear();
