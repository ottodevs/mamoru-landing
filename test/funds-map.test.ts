import { describe, expect, test } from "bun:test";
import { buildFundsMap } from "../src/funds-map";
import { renderFundsMap } from "../src/funds-map";

const row = (o: Partial<Parameters<typeof buildFundsMap>[1][number]> = {}) => ({
  chainId: 8453,
  usdcIdle: 0,
  lpUsd: 0,
  ethBalance: 0,
  positions: 0,
  ...o,
});
const snap = (o: Partial<Parameters<typeof buildFundsMap>[0]> = {}) => ({
  ethUsd: 2000,
  relayer: { address: "0x1", basescanUrl: "", ethBalance: 0.01, usd: 20, status: "ok" as const },
  funding: [
    { id: "relayer-base", balanceWei: "10000000000000000" },
    { id: "relayer-ethereum", balanceWei: "3000000000000000" },
    { id: "relayer-monad", balanceWei: "109800000000000000000" },
  ],
  ...o,
});
const find = (m: ReturnType<typeof buildFundsMap>, chain: string, id: string) =>
  m.chains.find((c) => c.name === chain)?.buckets.find((b) => b.id === id);

describe("buildFundsMap", () => {
  test("outside ETH (c9d4179b-like) is not working and never joins the working total", () => {
    const rows = [
      row({ lpUsd: 40, usdcIdle: 2, ethBalance: 0.001, positions: 1, outside: { eth: 0, usdc: 0, usd: 0 } }),
      row({ outside: { eth: 0.05537835, usdc: 0, usd: 127.277 } }),
    ];
    const m = buildFundsMap(snap(), rows);
    expect(m.working).toBe(42);
    expect(m.notWorking).toBeCloseTo(127.277, 3);
    const out = find(m, "Ethereum", "outside")!;
    expect(out.kind).toBe("outside");
    expect(out.accounts).toBe(1);
    expect(out.note).toContain("0.0554 ETH");
    expect(m.total).toBeCloseTo(m.working + m.reserve + m.notWorking, 6);
    expect(find(m, "Base", "gas")!.usd).toBeCloseTo(2, 6);
    expect(find(m, "Base", "relayer")!.usd).toBe(20);
    expect(find(m, "Ethereum", "relayer")!.usd).toBeCloseTo(6, 6);
  });

  test("unread outside is a floor and shows as not read, never zero", () => {
    const m = buildFundsMap(snap(), [row({ outside: { eth: 0, usdc: 10, usd: 10 } }), row()]);
    const out = find(m, "Ethereum", "outside")!;
    expect(out.atLeast).toBe(true);
    expect(out.note).toContain("1 not read");
    expect(m.partial).toBe(true);
    const none = buildFundsMap(snap(), [row()]);
    const o2 = find(none, "Ethereum", "outside")!;
    expect(o2.usd).toBeNull();
    expect(o2.note).toBe("not read");
  });

  test("zero case: no rows, no snapshot wallets", () => {
    const m = buildFundsMap({ ethUsd: null, relayer: null }, []);
    expect(m.total).toBe(0);
    expect(m.chains.map((c) => c.name)).toEqual(["Base"]);
    expect(() => renderFundsMap(m)).not.toThrow();
  });

  test("Monad relayer is shown in native units and not priced", () => {
    const m = buildFundsMap(snap(), [row()]);
    const mon = find(m, "Monad", "relayer")!;
    expect(mon.usd).toBeNull();
    expect(mon.note).toContain("109.80 MON");
    expect(mon.note).toContain("not priced");
    expect(m.partial).toBe(true);
  });

  test("monad mainnet (143) rows land on Monad", () => {
    const m = buildFundsMap(snap(), [row({ chainId: 143, usdcIdle: 5 })]);
    expect(find(m, "Monad", "idle")!.usd).toBe(5);
  });

  test("testnets and unknown chains never enter the map, and are counted apart", () => {
    const rows = [row({ usdcIdle: 3 }), row({ chainId: 10143, usdcIdle: 50 }), row({ chainId: 84532, lpUsd: 60 }), row({ chainId: 11155111, usdcIdle: 70 }), row({ chainId: 999, usdcIdle: 80 })];
    const m = buildFundsMap(snap(), rows);
    expect(m.excluded).toBe(4);
    expect(m.working).toBe(3);
    expect(m.chains.map((c) => c.name)).not.toContain("Chain 10143");
    expect(find(m, "Monad", "idle")).toBeUndefined();
    expect(renderFundsMap(m)).toContain("4 accounts on test networks, not counted.");
    expect(renderFundsMap(buildFundsMap(snap(), [row()]))).not.toContain("test networks");
  });

  test("unread outside never renders as $0 anywhere", () => {
    const html = renderFundsMap(buildFundsMap(snap(), [row({ lpUsd: 10 })]));
    const nw = html.split('class="fm-x"><dt>')[1].split("</div>")[0];
    expect(nw).toContain("not read");
    expect(nw).not.toContain("$0");
    const eth = html.split('<h3>Ethereum')[1].split("</h3>")[0];
    expect(eth).toContain("not read");
    expect(eth).not.toContain("$0");
    const some = renderFundsMap(buildFundsMap(snap(), [row({ outside: { eth: 0, usdc: 10, usd: 10 } }), row()]));
    expect(some).toContain("≥ $10.00");
    expect(some).toContain("1 not read");
  });

  test("unpriced Safe gas shows the ETH and not priced, never $0", () => {
    const html = renderFundsMap(buildFundsMap(snap({ ethUsd: null }), [row({ ethBalance: 0.0025, outside: { eth: 0, usdc: 0, usd: 0 } })]));
    const gas = html.split('class="fm-r"><dt>')[1].split("</div>")[0];
    expect(gas).toContain("not priced");
    expect(gas).toContain("0.0025 ETH");
    expect(gas).not.toContain("$0");
  });

  test("a floor total prints no exact shares", () => {
    const rows = [row({ lpUsd: 10, outside: { eth: 0, usdc: 5, usd: 5 } }), row()];
    const m = buildFundsMap(snap(), rows);
    expect(m.partial).toBe(true);
    const html = renderFundsMap(m);
    expect(html).not.toMatch(/\d+\.\d%/);
    expect(html).toContain("≥ $15.00");
    expect(html).toContain("Shares are not shown");
    const exact = renderFundsMap(buildFundsMap(snap(), [row({ lpUsd: 10, outside: { eth: 0, usdc: 10, usd: 10 } })]));
    expect(exact).toMatch(/50\.0%/);
  });

  test("render escapes, links buckets, marks not working", () => {
    const html = renderFundsMap(buildFundsMap(snap(), [row({ outside: { eth: 1, usdc: 0, usd: 2000 } })]));
    expect(html).toContain('id="funds-map"');
    expect(html).toContain("Total including not working");
    expect(html).toContain('href="/ops/accounts"');
    expect(html).toContain("Not working</span>");
  });

  test("operator relayers never enter totals, chain totals, shares or bars", () => {
    const rows = [row({ lpUsd: 10, usdcIdle: 5, ethBalance: 0.001 })];
    const withRelayers = buildFundsMap(snap(), rows);
    const without = buildFundsMap({ ethUsd: 2000, relayer: null }, rows);
    expect(withRelayers.operator).toBeGreaterThan(0);
    expect(withRelayers.total).toBeCloseTo(without.total, 9);
    expect(withRelayers.total).toBeCloseTo(17, 6);
    for (const name of ["Base", "Ethereum"]) {
      expect(withRelayers.chains.find((c) => c.name === name)!.usd).toBeCloseTo(without.chains.find((c) => c.name === name)?.usd ?? 0, 9);
    }
    const html = renderFundsMap(withRelayers);
    const team = html.split('class="fm-team"')[1].split("</tbody>")[0];
    expect(team).not.toMatch(/\d+\.\d%/);
    expect(html.split("fm-team")[0]).not.toContain("Operator (team gas)</td>");
    expect(html).toContain("team gas");
  });
});
