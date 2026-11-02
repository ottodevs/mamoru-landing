import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { REGISTRY_CHAINS } from "../src/registry-config";
import { clearRegistryCache, loadRegistry } from "../src/registry-load";
import { cancelCalldata, decodeParams, decodeRegistryLog, executeCalldata, foldEvents, registryAbi, timeLeft, type RawLog } from "../src/registry-model";
import { readRegistry, type ChainReading } from "../src/registry-read";
import { REGISTRY_STYLE } from "../src/registry-style";
import { parseChain, registrySection } from "../src/ops-registry";
import {
  ADMIN,
  GUARDIAN,
  POOL_CBBTC,
  POOL_NEW,
  POOL_WETH,
  REGISTRY,
  type Calls,
  fixtureChain,
  fixtureFetch,
  monadChain,
  standardFixture,
} from "./registry-fixture";

const NOW = 1_800_000_000;
const URLS = ["https://rpc.example/one"];
const read = (f = standardFixture(NOW), over: Parameters<typeof fixtureChain>[0] = {}, calls?: Calls, opts?: Parameters<typeof fixtureFetch>[2]) =>
  readRegistry(fixtureChain(over), URLS, undefined, fixtureFetch(f, calls, opts));
const ok = (r: ChainReading) => {
  if (r.state !== "ok") throw new Error(`expected ok, got ${r.state}`);
  return r;
};

describe("registry config", () => {
  test("no registry is deployed yet: both chains are unset", () => {
    expect(REGISTRY_CHAINS.map((c) => c.address)).toEqual([null, null]);
  });
});

describe("time left", () => {
  test("hours rounded up, minutes under an hour, ready once the wait is over", () => {
    expect(timeLeft(NOW + 61 * 3600, NOW).text).toBe("Takes effect in 61 h");
    expect(timeLeft(NOW + 60 * 3600 + 1, NOW).text).toBe("Takes effect in 61 h");
    expect(timeLeft(NOW + 1800, NOW).text).toBe("Takes effect in 30 min");
    expect(timeLeft(NOW, NOW)).toMatchObject({ ready: true, seconds: 0 });
    expect(timeLeft(NOW - 5, NOW).ready).toBe(true);
  });
});

describe("calldata a signer needs", () => {
  test("execute and cancel decode back to exactly the queued change", async () => {
    const r = ok(await read());
    const p = r.pending.find((x) => x.change.key.endsWith(POOL_NEW.slice(2).toLowerCase()))!;
    const ex = decodeFunctionData({ abi: registryAbi, data: p.executeData as `0x${string}` });
    expect(ex.functionName).toBe("execute");
    expect(ex.args).toEqual([0, p.change.key, p.change.params, p.change.nonce]);
    expect(p.executeData).toBe(executeCalldata(p.change));
    const ca = decodeFunctionData({ abi: registryAbi, data: p.cancelData as `0x${string}` });
    expect(ca).toMatchObject({ functionName: "cancel", args: [p.change.id] });
    expect(p.cancelData).toBe(cancelCalldata(p.change.id));
  });
});

describe("events", () => {
  test("a log that is not ours, or is malformed, decodes to null", () => {
    const bad: RawLog = { topics: ["0x" + "11".repeat(32)] as `0x${string}`[], data: "0x", blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x00" };
    expect(decodeRegistryLog(bad)).toBeNull();
  });
  test("malformed parameters decode to null, never to a guess", () => {
    expect(decodeParams("pool", "0x1234")).toBeNull();
    expect(decodeParams("vault", "0x")).toBeNull();
  });
  test("fold: executed and cancelled leave pending; history is newest first", async () => {
    const f = standardFixture(NOW);
    const calls: Calls = { methods: [], logRanges: [] };
    const fetchFn = fixtureFetch(f, calls);
    const logs = (await (await fetchFn("u", { method: "POST", body: JSON.stringify({ id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0xfffffff" }] }) })).json()) as { result: RawLog[] };
    const folded = foldEvents(logs.result.map((l) => decodeRegistryLog(l)!));
    expect(folded.pending.map((q) => Number(q.nonce))).toEqual([6, 5]);
    expect(folded.finished.map((x) => x.how)).toEqual(["cancelled", "executed", "executed", "executed", "executed"]);
    expect(folded.finished[0]!.by).toBe(GUARDIAN);
    expect(folded.routeDomains).toEqual([15]);
  });
});

describe("reading a registry", () => {
  test("unset: says so and makes no request at all", async () => {
    const calls: Calls = { methods: [], logRanges: [] };
    const r = await readRegistry(fixtureChain({ address: null }), URLS, undefined, fixtureFetch(standardFixture(NOW), calls));
    expect(r.state).toBe("unset");
    expect(calls.methods).toEqual([]);
  });

  test("a value that is not an address is unset too", async () => {
    expect((await readRegistry(fixtureChain({ address: "0x1234" }), URLS, undefined, fixtureFetch(standardFixture(NOW)))).state).toBe("unset");
  });

  test("the standard fixture: 2 active pools, 1 vault, 1 route, 2 pending, history", async () => {
    const r = ok(await read());
    expect(r.admin.toLowerCase()).toBe(ADMIN);
    expect(r.guardian).toBe(GUARDIAN);
    expect(r.delaySeconds).toBe(72 * 3600);
    expect(r.pools.map((p) => p.address.toLowerCase()).sort()).toEqual([POOL_CBBTC, POOL_WETH].map((a) => a.toLowerCase()).sort());
    expect(r.pools.find((p) => p.address === POOL_WETH)).toMatchObject({ label: "WETH/USDC 0.3%", v: { bandTicks: 60, ratioBps: 4000, twapWindow: 1800, twapShortWindow: 300 } });
    expect(r.vaults).toHaveLength(1);
    expect(r.vaults[0]!.ratioBps).toBe(2500);
    expect(r.routes).toEqual([{ domain: 15 }]);
    expect(r.pending).toHaveLength(2);
    expect(r.history.map((h) => h.f.how)).toEqual(["cancelled", "executed", "executed", "executed", "executed"]);
    expect(r.history[0]!.time).not.toBeNull();
    // Queued by the admin, at the block's time; the wider-band change replaces the WETH entry in force.
    const wider = r.pending.find((p) => p.current)!;
    expect(wider.current).toMatchObject({ kind: "pool", v: { bandTicks: 60 } });
    expect(wider.params).toMatchObject({ kind: "pool", v: { bandTicks: 120 } });
    expect(wider.queuedAt).toBe(NOW - 63 * 3600);
  });

  test("a change the chain no longer has an ETA for is not pending, whatever the log scan says", async () => {
    const f = standardFixture(NOW);
    delete f.eta[6];
    const r = ok(await read(f));
    expect(r.pending).toHaveLength(1);
  });

  test("history is the last 20", async () => {
    const f = standardFixture(NOW);
    const extra = Array.from({ length: 30 }, (_, i) => [
      { t: "queued" as const, block: 100 + i * 2, id: 100 + i, kind: "route" as const, key: `0x${"0".repeat(63)}6` as `0x${string}`, params: f.events[6]!.t === "queued" ? (f.events[6] as any).params : "0x", nonce: 100 + i, eta: NOW },
      { t: "cancelled" as const, block: 101 + i * 2, id: 100 + i, by: GUARDIAN },
    ]).flat();
    f.events.push(...extra);
    expect(ok(await read(f)).history).toHaveLength(20);
  });

  test("logs are read in chunks of the configured size", async () => {
    const calls: Calls = { methods: [], logRanges: [] };
    ok(await read(standardFixture(NOW), { fromBlock: 990_000, logChunk: 4_000 }, calls));
    expect(calls.logRanges).toEqual([[990_000, 993_999], [994_000, 997_999], [998_000, 1_000_000]]);
  });

  test("fails closed: logs that cannot be read show an error and no list", async () => {
    const r = await read(standardFixture(NOW), {}, undefined, { failLogs: true });
    expect(r.state).toBe("error");
    expect(JSON.stringify(r)).not.toContain("rpc.example");
    const html = registrySection([r], NOW).html;
    expect(html).toContain("could not be read just now");
    expect(html).not.toContain("In force");
  });

  test("a public host that serves another chain is not believed", async () => {
    const calls: Calls = { methods: [], logRanges: [] };
    const r = await readRegistry(
      fixtureChain(),
      ["https://wrong.example", "https://right.example"],
      undefined,
      fixtureFetch(standardFixture(NOW), calls, { chainIdOf: (u) => (u.includes("wrong") ? 1 : 8453) }),
    );
    expect(r.state).toBe("ok");
  });

  test("only the right chain answering for no host: error", async () => {
    const r = await readRegistry(fixtureChain(), ["https://wrong.example"], undefined, fixtureFetch(standardFixture(NOW), undefined, { chainIdOf: () => 1 }));
    expect(r.state).toBe("error");
  });

  test("the loader reads each chain once per half minute", async () => {
    clearRegistryCache();
    const calls: Calls = { methods: [], logRanges: [] };
    const fetchFn = fixtureFetch(standardFixture(NOW), calls);
    const opts = { chains: [fixtureChain(), monadChain()], fetchFn, now: 1_000 };
    const first = await loadRegistry({}, opts);
    expect(first.map((r) => r.state)).toEqual(["ok", "unset"]);
    const n = calls.methods.length;
    await loadRegistry({}, { ...opts, now: 20_000 });
    expect(calls.methods.length).toBe(n);
    await loadRegistry({}, { ...opts, now: 40_000 });
    expect(calls.methods.length).toBeGreaterThan(n);
    clearRegistryCache();
  });
});

describe("the Registry page", () => {
  const page = async (chain: "all" | "base" | "monad" = "all") => {
    const r = ok(await read());
    return registrySection([r, { state: "unset", chain: monadChain().chain }], NOW, chain).html;
  };

  test("pending changes are highlighted with the time left, the author and what they change", async () => {
    const html = await page();
    expect(html).toContain("Takes effect in 61 h");
    expect(html).toContain("Takes effect in 9 h");
    expect(html.indexOf("Takes effect in 9 h")).toBeLessThan(html.indexOf("Takes effect in 61 h"));
    expect(html).toContain("Waiting to take effect (2)");
    expect(html).toContain("the admin Safe");
    expect(html).toContain("band 60 ticks → 120 ticks");
    expect(html).toContain("share 40 % → 50 %");
    expect(html).toContain("Adds pool USDC/USDT 0.01%");
  });

  test("calldata is on the page as copyable text with a button, a feedback place and the target", async () => {
    const r = ok(await read());
    const html = registrySection([r], NOW).html;
    for (const p of r.pending) {
      expect(html).toContain(`<code class="rg-data">${p.executeData}</code>`);
      expect(html).toContain(`data-copy="${p.cancelData}"`);
    }
    expect(html.match(/class="rg-copy"/g)!.length).toBe(5);
    expect(html.match(/class="rg-fb" role="status"/g)!.length).toBe(5);
    expect(html).toContain(REGISTRY);
  });

  test("in force and history show the parameters", async () => {
    const html = await page();
    expect(html).toContain("WETH/USDC 0.3%");
    expect(html).toContain("30 min / 5 min");
    expect(html).toContain("Monad <span class=\"soft\">(CCTP domain 15)</span>");
    expect(html).toContain("25 %");
    expect(html).toContain("Cancelled");
    expect(html).toContain("the guardian");
  });

  test("an unset chain says it is not deployed, with no error", async () => {
    const html = await page();
    expect(html).toContain("Registry not deployed yet.");
    expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  test("the chain selector filters, and an unknown value is all chains", async () => {
    expect(await page("monad")).not.toContain("Waiting to take effect");
    expect(await page("base")).not.toContain("Registry not deployed yet");
    expect(parseChain("bogus")).toBe("all");
    expect(parseChain("monad")).toBe("monad");
  });

  test("controls are plain buttons and selectors: nothing underlined, no wallet connect", async () => {
    const html = await page();
    expect(html).not.toContain('class="link"');
    expect(REGISTRY_STYLE).not.toMatch(/underline/);
    expect(html).not.toMatch(/connect|ethereum\.request|data-topup/i);
    expect(html).toContain("<select name=\"chain\">");
  });

  test("a hostile key or address cannot break out of the markup", async () => {
    const r = ok(await read());
    const evil: ChainReading = { ...r, pools: [{ address: '"><script>x</script>', label: "<b>x</b>", v: r.pools[0]!.v }] };
    const html = registrySection([evil], NOW).html;
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("the copy button in the shipped console script", () => {
  test("a button with data-copy copies its text and says Copied beside itself", async () => {
    const { renderDocument } = await import("../src/ops");
    const html = renderDocument({ section: "registry", title: "Registry", html: "<h1>x</h1>" }, { csrf: "c", nonce: "n" });
    expect(html).toContain('closest("button[data-copy]")');
    expect(html).toContain("navigator.clipboard.writeText(text)");
    expect(html).toContain("Copied ✓");
    expect(html).toContain("Selected, now copy");
  });
});
