import { type Address, type Chain, createPublicClient, fallback, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { MULTICALL3_ADDRESS, rpcUrls } from "./chain-addresses";

// Widened to the generic `Chain`: pinning this to `typeof base`'s literal formatter
// types makes some viem action return types blow up for tsc (known upstream issue).
export type BaseClient = PublicClient<ReturnType<typeof fallback>, Chain>;

/**
 * A read client that tries the secret RPC (if set) then the public fallbacks in order.
 * The URLs never leave this function: nothing here is logged or rendered.
 */
export function buildClient(secretRpcUrl?: string): BaseClient {
  const transports = rpcUrls(secretRpcUrl).map((url) => http(url, { timeout: 8_000 }));
  return createPublicClient({
    chain: base as Chain,
    transport: fallback(transports, { rank: false }),
  });
}

export type ContractCall = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

/** Big chunks on purpose: fewer parallel eth_calls, so a rate-limited RPC drops fewer of them. */
const MULTICALL_BATCH_BYTES = 16_384;
const RETRY_DELAY_MS = 150;

async function runMulticall(client: BaseClient, contracts: readonly ContractCall[]): Promise<unknown[]> {
  // biome-ignore lint: viem's contract-tuple typing does not infer well through a shared helper
  const results = await client.multicall({
    contracts: contracts as any,
    allowFailure: true,
    batchSize: MULTICALL_BATCH_BYTES,
    multicallAddress: MULTICALL3_ADDRESS as Address,
  });
  return results.map((r) => (r.status === "success" ? r.result : undefined));
}

/**
 * Multicall3 with allowFailure. Calls that fail are retried once, together, after a
 * short pause. What still fails comes back as `undefined` at the same index: callers
 * must treat that as "not read", never as zero.
 */
export async function multi(
  client: BaseClient,
  contracts: readonly ContractCall[],
  retryDelayMs = RETRY_DELAY_MS,
): Promise<unknown[]> {
  if (contracts.length === 0) return [];
  let results: unknown[];
  try {
    results = await runMulticall(client, contracts);
  } catch {
    results = contracts.map(() => undefined);
  }
  const failed = results.flatMap((r, i) => (r === undefined ? [i] : []));
  if (failed.length === 0) return results;
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  try {
    const again = await runMulticall(client, failed.map((i) => contracts[i]));
    failed.forEach((index, k) => {
      results[index] = again[k];
    });
  } catch {
    // Second failure: the gaps stay undefined and the caller reports them.
  }
  return results;
}
