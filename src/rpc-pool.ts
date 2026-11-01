/**
 * Public RPC pools per chain (otto/mamoru-astro#42). A read never depends on two RPCs: the configured ones (secrets,
 * keyed) go first, then a wide pool of public ones from chainlist. Every entry answered a JSON-RPC batch of eth_chainId,
 * eth_getBalance and a Multicall3 eth_call with the right chain id (probed 2026-11-01). URLs that carry a key or a demo
 * key were left out, and so were variants of the same host.
 *
 * The public order is rotated per run, so load spreads and a dead host is not always first; within a run, an RPC that
 * failed is skipped for the rest of it (`RunHealth`).
 */

export const PUBLIC_RPCS = {
  ethereum: [
    "https://rpc.mevblocker.io",
    "https://ethereum-rpc.publicnode.com",
    "https://public.1rpc.io/eth",
    "https://xrpc.cl/eth",
    "https://eth.api.pocket.network",
    "https://ethereum-json-rpc.stakely.io",
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://ethereum-public.nodies.app",
    "https://eth-mainnet.public.blastapi.io",
    "https://api.blockvectra.com/v1/eth_mainnet/public",
    "https://gateway.tenderly.co/public/mainnet",
    "https://rpc-eth.blockmachine.io",
    "https://eth.meowrpc.com",
    "https://eth.drpc.org",
    "https://ethereum-rpc.blockreq.com/v1/rpc/public",
    "https://1.rpc.thirdweb.com",
    "https://mainnet.rpc.sentio.xyz",
    "https://0xrpc.io/eth",
    "https://eth.rpc.blxrbdn.com",
  ],
  base: [
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
    "https://base.drpc.org",
    "https://base-rpc.blockreq.com/v1/rpc/public",
    "https://base.rpc.sentio.xyz",
    "https://base-mainnet.public.blastapi.io",
    "https://base.meowrpc.com",
    "https://base.daybreak-rpc.network",
    "https://rpc-base.blockmachine.io",
    "https://api.blockvectra.com/v1/base_mainnet/public",
    "https://base.public.blockpi.network/v1/rpc/public",
    "https://base-public.nodies.app",
    "https://public.1rpc.io/base",
    "https://base.api.pocket.network",
    "https://xrpc.cl/base",
    "https://gateway.tenderly.co/public/base",
    "https://8453.rpc.thirdweb.com",
  ],
  monad: [
    "https://rpc.monad.xyz",
    "https://rpc2.monad.xyz",
    "https://rpc3.monad.xyz",
    "https://rpc4.monad.xyz",
    "https://monad-mainnet.rpc.sentio.xyz",
    "https://infra.originstake.com/monad/evm",
    "https://monad-mainnet-rpc.spidernode.net",
    "https://monad-rpc.huginn.tech",
    "https://gm.monad.at.htw.tech",
    "https://143.rpc.thirdweb.com",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PoolChain = keyof typeof PUBLIC_RPCS;

/** The https URLs of a comma separated secret, in its order, without duplicates. */
export function ownRpcs(secret?: string): string[] {
  return [...new Set((secret ?? "").split(",").map((s) => s.trim()).filter((s) => /^https:\/\//.test(s)))];
}

/** This run's rotation: changes every hour, the snapshot's cadence, so consecutive runs start on different hosts. */
export const hourRotation = (now = Date.now()): number => Math.floor(now / 3_600_000);

/** `list` started at position `by` (mod length), order kept. */
export function rotated<T>(list: readonly T[], by: number): T[] {
  if (list.length === 0) return [];
  const k = ((by % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/** The public pool of a chain for this run, rotated, without any URL already configured. */
export function publicPool(chain: PoolChain, rotation: number, exclude: readonly string[] = []): string[] {
  return rotated(PUBLIC_RPCS[chain], rotation).filter((u) => !exclude.includes(u));
}

/** RPCs that failed during one run: skipped for the rest of it, so one dead host costs one timeout, not one per chunk. */
export class RunHealth {
  private readonly bad = new Set<string>();
  fail(url: string): void {
    this.bad.add(url);
  }
  ok(url: string): boolean {
    return !this.bad.has(url);
  }
  healthy(urls: readonly string[]): string[] {
    return urls.filter((u) => this.ok(u));
  }
}
