import { type Address, type Chain, createPublicClient, custom, type PublicClient } from "viem";
import { base } from "viem/chains";
import { MULTICALL3_ADDRESS, rpcUrls } from "./chain-addresses";
import { ownRpcs, RunHealth } from "./rpc-pool";

export type BaseClient = PublicClient<ReturnType<typeof custom>, Chain>;

/** Per RPC: a hung host costs this much once, then is skipped for the rest of the client's life (one snapshot run). */
const BASE_TIMEOUT_MS = 4_000;
/** One request gives up after this, whatever is left in the list, so a read never eats the run's 30 s. */
const BASE_REQUEST_MS = 10_000;

/** A JSON-RPC error that is the chain's answer (a revert, bad params), not the RPC's failure: never retried elsewhere. */
const isChainAnswer = (code: unknown, message: unknown): boolean =>
  code === 3 || code === -32602 || (typeof message === "string" && /revert/i.test(message));

/**
 * A read client over the secret RPCs (if set) then a rotated slice of the public pool, in order
 * (otto/mamoru-astro#42). A public host is used only after it answered eth_chainId 8453; as before this PR, one
 * public host's answer is taken alone when every configured RPC failed (Base reads are many calls at "latest", where
 * two hosts a block apart legitimately differ, so they are not cross-checked like the Ethereum and Monad balances). An RPC that fails (HTTP status, timeout, network, a JSON-RPC error that is not the chain's
 * answer) is skipped for the rest of this client's life, so it costs one timeout per run, not one per request.
 * The URLs never leave this function: nothing here is logged or rendered.
 */
export function buildClient(secretRpcUrl?: string, fetchFn: typeof fetch = fetch): BaseClient {
  const urls = rpcUrls(secretRpcUrl);
  const own = ownRpcs(secretRpcUrl);
  const health = new RunHealth(own);
  // A public host is used only once it said it serves Base (asked once per client). Configured ones are trusted.
  const onBase = new Map<string, Promise<boolean>>();
  let id = 0;
  const post = async (url: string, method: string, params: unknown, ms: number): Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } }> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("rpc answer is not an object");
    return body as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  };
  const servesBase = (url: string): Promise<boolean> => {
    if (own.includes(url)) return Promise.resolve(true);
    let p = onBase.get(url);
    if (!p) {
      p = post(url, "eth_chainId", [], BASE_TIMEOUT_MS).then((b) => b.result === "0x2105", () => false);
      onBase.set(url, p);
    }
    return p;
  };
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const until = Date.now() + BASE_REQUEST_MS;
    let last: unknown = new Error("no Base RPC answered");
    for (const url of health.healthy(urls)) {
      const left = until - Date.now();
      if (left <= 0) break;
      let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        if (!(await servesBase(url))) throw new Error("not Base");
        body = await post(url, method, params, Math.min(BASE_TIMEOUT_MS, until - Date.now()));
      } catch (e) {
        health.fail(url);
        last = e;
        continue;
      }
      if (body.error) {
        if (isChainAnswer(body.error.code, body.error.message)) throw Object.assign(new Error(String(body.error.message ?? "rpc error")), { code: body.error.code });
        health.fail(url);
        last = new Error("rpc error");
        continue;
      }
      if (!("result" in body)) {
        health.fail(url);
        last = new Error("rpc answer without a result");
        continue;
      }
      health.succeed(url);
      return body.result;
    }
    throw last;
  };
  return createPublicClient({
    chain: base as Chain,
    transport: custom({ request }, { retryCount: 0 }),
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
