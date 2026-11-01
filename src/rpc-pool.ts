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

/**
 * RPCs that failed during one run: skipped for the rest of it, so one dead host costs one timeout, not one per chunk or
 * request. A configured (keyed) RPC passed as `lenient` is skipped only after two failures in a row: one 429 from the
 * provider the run trusts most should not hand the rest of the run to the public pool.
 */
export class RunHealth {
  private readonly fails = new Map<string, number>();
  private readonly lenient: ReadonlySet<string>;
  constructor(lenient: readonly string[] = []) {
    this.lenient = new Set(lenient);
  }
  fail(url: string): void {
    this.fails.set(url, (this.fails.get(url) ?? 0) + 1);
  }
  /** An answer clears the strikes: only failures in a row, not scattered ones, drop a configured RPC. */
  succeed(url: string): void {
    this.fails.delete(url);
  }
  ok(url: string): boolean {
    return (this.fails.get(url) ?? 0) < (this.lenient.has(url) ? 2 : 1);
  }
  healthy(urls: readonly string[]): string[] {
    return urls.filter((u) => this.ok(u));
  }
}

/** The host of a URL, "?" when it does not parse: two URLs on one host are one witness. */
const hostKey = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/**
 * Per position, the answer that at least `need` different public hosts gave identically (by `key`); null otherwise.
 * A public RPC is not trusted alone: one that lies, or serves another chain, cannot set a figure by itself.
 */
export function agreed<T>(n: number, votes: readonly { url: string; answers: readonly (T | null)[] }[], key: (t: T) => string, need = 2): (T | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const hosts = new Map<string, Set<string>>();
    const first = new Map<string, T>();
    for (const v of votes) {
      const a = v.answers[i];
      if (a == null) continue;
      const k = key(a);
      if (!hosts.has(k)) hosts.set(k, new Set());
      hosts.get(k)!.add(hostKey(v.url));
      if (!first.has(k)) first.set(k, a);
    }
    for (const [k, h] of hosts) if (h.size >= need) return first.get(k)!;
    return null;
  });
}

/**
 * Each promise's value if it settled within `ms`, else undefined (a rejection is undefined too). Resolves early once
 * every promise settled or `enough` says what came in suffices. Never rejects.
 */
export function settleWithin<T>(asks: readonly Promise<T>[], ms: number, enough?: (got: readonly (T | undefined)[]) => boolean): Promise<(T | undefined)[]> {
  return new Promise((resolve) => {
    const got: (T | undefined)[] = asks.map(() => undefined);
    let settled = 0;
    const timer = setTimeout(() => resolve([...got]), ms);
    const done = () => {
      settled += 1;
      if (settled === asks.length || enough?.(got)) {
        clearTimeout(timer);
        resolve([...got]);
      }
    };
    if (asks.length === 0) {
      clearTimeout(timer);
      return resolve([]);
    }
    asks.forEach((a, k) => {
      a.then((v) => void (got[k] = v)).catch(() => undefined).finally(done);
    });
  });
}

export interface PooledRead<T> {
  /** One RPC's answers for these addresses, null where it had none; throws when the RPC failed. */
  ask(url: string, addresses: readonly string[]): Promise<(T | null)[]>;
  /** Identity of an answer, for agreement between hosts. */
  key(t: T): string;
  /** Told why an RPC gave nothing ("host: kind"); must never carry a URL path or query. */
  failed?(url: string, e: unknown): void;
}

export interface PoolPlan {
  own: readonly string[];
  public: readonly string[];
  /** Per phase: the configured tier's wait for all its RPCs, and each public wave's. */
  phaseMs: number;
  wave: number;
  /** Different public hosts one run may ask at most, across every chunk. */
  publicHosts: number;
}

/**
 * Reads every chunk over a pool (otto/mamoru-astro#42) and writes each answer into `out` as soon as it is settled, so
 * a caller's deadline keeps what came in. The configured RPCs first, all at once per chunk, merged per address in their
 * list order: a healthy configured RPC is the only one that sees the addresses it answers. Then, for what they left,
 * the public pool in waves shared by every chunk: a value counts only when two different hosts gave it identically,
 * so one public RPC cannot set a figure by itself. An RPC that failed or gave nothing is skipped for the rest of the
 * run (`health`). An address with no settled answer stays absent: never zero.
 */
export async function readPooled<T>(chunks: readonly (readonly string[])[], plan: PoolPlan, r: PooledRead<T>, health: RunHealth, out: Map<string, T>): Promise<void> {
  const asked = (url: string, addresses: readonly string[]): Promise<(T | null)[]> =>
    r.ask(url, addresses).then(
      (got) => {
        if (got.some((x) => x != null)) health.succeed(url);
        if (got.every((x) => x == null)) {
          health.fail(url);
          r.failed?.(url, new Error("no balance answered"));
        }
        return got;
      },
      (e: unknown) => {
        health.fail(url);
        r.failed?.(url, e);
        throw e;
      },
    );
  if (plan.own.length) {
    await Promise.all(
      chunks.map(async (chunk) => {
        const urls = health.healthy(plan.own);
        const got = await settleWithin(urls.map((u) => asked(u, chunk)), plan.phaseMs);
        chunk.forEach((a, i) => {
          const hit = got.find((g) => g?.[i] != null)?.[i];
          if (hit != null) out.set(a, hit);
        });
      }),
    );
  }
  const left = chunks.map((c) => c.filter((a) => !out.has(a))).filter((c) => c.length > 0);
  if (!left.length) return;
  const votes = left.map(() => [] as { url: string; answers: (T | null)[] }[]);
  let next = 0;
  let hosts = 0;
  for (;;) {
    const open = left.some((c, j) => agreed(c.length, votes[j], r.key).some((x) => x === null));
    if (!open) return;
    const wave: string[] = [];
    while (wave.length < plan.wave && next < plan.public.length && hosts < plan.publicHosts) {
      const u = plan.public[next++];
      if (!health.ok(u)) continue;
      wave.push(u);
      hosts += 1;
    }
    if (!wave.length) return;
    await Promise.all(
      left.map(async (c, j) => {
        // A wave ends as soon as every address of the chunk has two agreeing hosts: one hung RPC never holds it back.
        const prior = votes[j];
        const asVotes = (got: readonly ((T | null)[] | undefined)[]) => [...prior, ...wave.map((url, k) => ({ url, answers: got[k] ?? c.map(() => null) }))];
        const got = await settleWithin(wave.map((u) => asked(u, c)), plan.phaseMs, (g) => agreed(c.length, asVotes(g), r.key).every((x) => x !== null));
        votes[j] = asVotes(got);
        agreed(c.length, votes[j], r.key).forEach((x, i) => {
          if (x != null) out.set(c[i], x);
        });
      }),
    );
  }
}
