import { describe, expect, test } from "bun:test";
import { FUNDING_TARGETS, fundingStatus, readBalance, readFunding, widgetTarget, MONAD } from "../src/funding";
import { topupLogic } from "../src/topup-logic";

const fakeFetch = (result: unknown, ok = true) => async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: ok ? 200 : 502 });

describe("funding targets", () => {
  test("every target has a chain the widget can switch to, and presets", () => {
    for (const t of FUNDING_TARGETS) {
      expect(t.chain.hex).toMatch(/^0x[0-9a-f]+$/);
      expect(Number(t.chain.hex)).toBe(t.chain.chainId);
      expect(t.presets.length).toBeGreaterThan(0);
    }
    expect(new Set(FUNDING_TARGETS.map((t) => t.id)).size).toBe(FUNDING_TARGETS.length);
  });

  test("Monad funds its own relayer, not Base's", () => {
    const mon = FUNDING_TARGETS.find((t) => t.id === "relayer-monad")!;
    const base = FUNDING_TARGETS.find((t) => t.id === "relayer-base")!;
    expect(mon.address).toBe("0xE41175b9CEBD25b9F45B745C922002BC052B5C88");
    expect(mon.address).not.toBe(base.address);
  });

  test("status: empty, low, ok, unknown", () => {
    expect(fundingStatus(null, 5n)).toBe("unknown");
    expect(fundingStatus(0n, 5n)).toBe("empty");
    expect(fundingStatus(4n, 5n)).toBe("low");
    expect(fundingStatus(5n, 5n)).toBe("ok");
  });

  test("a balance read: hex result, bad answers are null, never throws", async () => {
    expect(await readBalance(MONAD, "0x0", fakeFetch("0x10"))).toBe(16n);
    expect(await readBalance(MONAD, "0x0", fakeFetch("nope"))).toBeNull();
    expect(await readBalance(MONAD, "0x0", fakeFetch("0x1", false))).toBeNull();
    expect(await readBalance(MONAD, "0x0", async () => { throw new Error("down"); })).toBeNull();
  });

  test("known balances are not read again; the others are", async () => {
    let calls = 0;
    const rows = await readFunding({ "relayer-base": 7n }, async () => { calls++; return new Response(JSON.stringify({ result: "0x0" })); });
    expect(rows.find((r) => r.target.id === "relayer-base")!.balanceWei).toBe(7n);
    expect(calls).toBe(FUNDING_TARGETS.length - 1);
    expect(rows.find((r) => r.target.id === "relayer-monad")!.status).toBe("empty");
  });

  test("Ethereum carries no RPC to the page; chains a wallet may not know do", () => {
    const eth = widgetTarget({ target: FUNDING_TARGETS.find((t) => t.id === "relayer-ethereum")!, balanceWei: 0n, status: "empty" });
    const mon = widgetTarget({ target: FUNDING_TARGETS.find((t) => t.id === "relayer-monad")!, balanceWei: 0n, status: "empty" });
    expect("rpc" in eth.chain).toBe(false);
    expect(mon.chain.rpc).toBe("https://rpc.monad.xyz");
  });
});

describe("the widget speaks the target's chain", () => {
  const L = topupLogic();
  const base = { phase: "ready", account: "0xb343880dc01517dcfcbb528864d567e3389753e1", balance: 10n ** 19n, fee: 10n ** 15n, amountText: "5", hash: null, error: "", slow: false, failedTo: "idle" } as const;
  const mon = widgetTarget({ target: FUNDING_TARGETS.find((t) => t.id === "relayer-monad")!, balanceWei: 0n, status: "empty" });
  const ctx = { relayer: mon.address, costWei: null, ethUsd: null, chain: mon.chain, recipientName: mon.recipientName };

  test("amounts, network and recipient in MON on Monad", () => {
    const v = L.view({ ...base }, ctx);
    expect(v.line).toBe("Ready to send 5 MON to the relayer on Monad.");
    expect(v.wallet).toContain("MON on Monad");
    const c = L.view({ ...base, phase: "confirm" }, ctx);
    expect(c.line).toBe("Send 5 MON to the relayer on Monad?");
    expect(L.view({ ...base, phase: "wrongnet" }, ctx).primary!.label).toBe("Switch to Monad");
    expect(L.view({ ...base, phase: "sent", hash: "0xabc" }, ctx).link!.href).toBe("https://monadscan.com/tx/0xabc");
  });

  test("no L1 data fee margin outside Base", () => {
    expect(L.estimateFee(1n, ctx.chain)).toBe(42000n);
    expect(L.estimateFee(1n)).toBe(42000n + 2000000000000n);
  });
});
