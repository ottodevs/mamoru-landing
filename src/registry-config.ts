/**
 * Where the MamoruRegistry lives, per chain, for /ops/money/registry (otto/mamoru#296, spec 010 T7).
 * The registry is not deployed yet: `address` is null on both chains and the panel says so without reading anything.
 * T7 sets the address (the same on every chain: CREATE2 with the same init code) and `fromBlock` (its deployment
 * block, so the event scan starts there) in a pull request here. Addresses and block numbers only, no secrets.
 */

import { BASE, MONAD, type FundingChain } from "./funding";

export interface RegistryChain {
  chain: FundingChain;
  /** The MamoruRegistry on this chain; null until T7 deploys it. */
  address: string | null;
  /** Block the registry was deployed at: the event scan starts here. */
  fromBlock: number;
  /** Blocks per eth_getLogs request (public RPCs cap the range). */
  logChunk: number;
}

export const REGISTRY_CHAINS: readonly RegistryChain[] = [
  { chain: BASE, address: null, fromBlock: 0, logChunk: 50_000 },
  { chain: MONAD, address: null, fromBlock: 0, logChunk: 100_000 },
];

/** CCTP domains the registry's routes are keyed by (spec 010: Base 6, Monad 15). */
export const CCTP_DOMAINS: Readonly<Record<number, string>> = { 0: "Ethereum", 6: "Base", 15: "Monad" };

export const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
