import { type Address, createPublicClient, fallback, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { MULTICALL3_ADDRESS, rpcUrls } from "./chain-addresses";

export type BaseClient = PublicClient;

/**
 * A read client that tries the secret RPC (if set) then the public fallbacks in order.
 * The URLs never leave this function: nothing here is logged or rendered.
 */
export function buildClient(secretRpcUrl?: string): BaseClient {
  const transports = rpcUrls(secretRpcUrl).map((url) => http(url, { timeout: 8_000 }));
  return createPublicClient({
    chain: base,
    transport: fallback(transports, { rank: false }),
  });
}

export type ContractCall = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

/**
 * Thin multicall wrapper: always allowFailure, always through Multicall3.
 * Each failed call becomes `undefined` in the returned array, same index as the input.
 */
export async function multi(
  client: BaseClient,
  contracts: readonly ContractCall[],
): Promise<unknown[]> {
  if (contracts.length === 0) return [];
  // biome-ignore lint: viem's contract-tuple typing does not infer well through a shared helper
  const results = await client.multicall({
    contracts: contracts as any,
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS as Address,
  });
  return results.map((r) => (r.status === "success" ? r.result : undefined));
}
