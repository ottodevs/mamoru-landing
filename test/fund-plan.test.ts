import { describe, expect, test } from "bun:test";
import { fundPlanLogic } from "../src/fund-plan-logic";
import { FUNDING_TARGETS, shortfallWei, usesLeft } from "../src/funding";
import { fundingSection } from "../src/ops-funding";
import type { InfraSnapshot } from "../src/infra-snapshot";

const P = fundPlanLogic();
const E18 = 10n ** 18n;
const t = (id: string) => FUNDING_TARGETS.find((x) => x.id === id)!;

describe("shortfall and runway (otto/mamoru-astro#32)", () => {
  test("tops up to the healthy level, rounded up to the step; within 10% is enough; unread is null", () => {
    const base = t("relayer-base");
    expect(shortfallWei(null, base)).toBeNull();
    expect(shortfallWei(0n, base)).toBe(base.targetWei);
    expect(shortfallWei((base.targetWei * 95n) / 100n, base)).toBe(0n);
    expect(shortfallWei(base.targetWei / 2n + 1n, base)).toBe(base.targetWei / 2n);
  });

  test("Monad: activations left over its 10 MON floor", () => {
    const mon = t("relayer-monad");
    expect(usesLeft(109n * E18, mon)).toBe(16);
    expect(usesLeft(9n * E18, mon)).toBe(0);
    expect(usesLeft(null, mon)).toBeNull();
    expect(usesLeft(E18, t("relayer-base"))).toBeNull();
  });

  test("the guardian is a funding line on Base", () => {
    const g = t("guardian-base");
    expect(g.address).toBe("0xA8E6EF87e612fA5c54668Cc1fF0aC809e1321FdD");
    expect(g.chain.chainId).toBe(8453);
    expect(g.kind).toBe("safety");
  });
});

describe("fundPlanLogic", () => {
  test("split follows what each lacks and always adds up to the total", () => {
    const parts = P.split(10n ** 16n, [3n * 10n ** 15n, 10n ** 15n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(10n ** 16n);
    expect(parts[0]).toBe(75n * 10n ** 14n);
    const odd = P.split(10n ** 16n + 7n, [1n, 1n, 1n]);
    expect(odd.reduce((a, b) => a + b, 0n)).toBe(10n ** 16n + 7n);
  });

  test("with nothing lacking, split is even; zero total gives zeros", () => {
    expect(P.split(6n * 10n ** 15n, [0n, 0n, 0n])).toEqual([2n * 10n ** 15n, 2n * 10n ** 15n, 2n * 10n ** 15n]);
    expect(P.split(0n, [1n, 2n])).toEqual([0n, 0n]);
  });

  test("order groups by chain, drops zero amounts; switches counts network changes", () => {
    const rows = [
      { id: "a", chain: "0x2105", amount: 1n },
      { id: "b", chain: "0x1", amount: 1n },
      { id: "c", chain: "0x2105", amount: 1n },
      { id: "d", chain: "0x8f", amount: 0n },
    ];
    expect(P.order(rows).map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(P.switches(rows, "0x2105")).toBe(1);
    expect(P.switches(rows, null)).toBe(2);
  });

  test("summary in words", () => {
    expect(P.summary(["confirmed", "confirmed"]).text).toBe("All 2 transfers arrived.");
    expect(P.summary(["failed", "skipped"]).text).toBe("Nothing was sent.");
    expect(P.summary(["confirmed", "failed", "skipped"]).tone).toBe("warn");
    expect(P.summary(["confirmed", "signing"]).done).toBe(false);
    // Sent without a receipt is never "nothing was sent".
    expect(P.summary(["unknown"]).text).toBe("1 sent but not confirmed yet.");
    expect(P.summary(["unknown", "failed"]).text).not.toContain("Nothing");
  });
});

describe("Funding section", () => {
  const snap = (funding: InfraSnapshot["funding"]): InfraSnapshot =>
    ({ asOf: "2026-10-27T08:00:00Z", ethUsd: 2300, btcUsd: null, relayer: null, cost: null, accounts: null, funding }) as InfraSnapshot;

  test("every wallet per chain, what is deployed, the plan prefilled with what each lacks", () => {
    const html = fundingSection(snap([
      { id: "relayer-base", balanceWei: (2n * 10n ** 16n).toString() },
      { id: "relayer-monad", balanceWei: (109n * E18).toString() },
      { id: "relayer-ethereum", balanceWei: "0" },
      { id: "guardian-base", balanceWei: "0" },
    ]));
    expect(html).toContain("2 of 4 wallets are below where they should be");
    expect(html).toContain("MamoruActionPolicy v2");
    expect(html).toContain('value="0.006"');
    expect(html).toContain('value="0.0005"');
    expect(html).toContain("16 more activations");
    expect(html).toContain('id="fd-one" role="tabpanel" aria-labelledby="fd-tab-one" hidden');
  });

  test("one unread wallet never makes the lead an all-clear", () => {
    const html = fundingSection(snap([
      { id: "relayer-base", balanceWei: (2n * 10n ** 16n).toString() },
      { id: "relayer-monad", balanceWei: (109n * E18).toString() },
      { id: "relayer-ethereum", balanceWei: (6n * 10n ** 15n).toString() },
    ]));
    expect(html).not.toContain("Every wallet holds what it should.");
    expect(html).toContain("1 could not be read just now");
  });

  test("an unread wallet is never shown as zero or planned", () => {
    const html = fundingSection(snap([]));
    expect(html).toContain("No wallet could be read just now.");
    expect(html).not.toContain('value="0.006"');
    expect(html).toContain("not read");
  });
});
