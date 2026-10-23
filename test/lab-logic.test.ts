import { describe, expect, test } from "bun:test";
import { labLogic } from "../src/lab-logic";
import { DEPOSIT_MAX, DEPOSIT_MIN, specKey, validateSpec, WIDTH_MAX, WIDTH_MIN, WIDTH_STEP } from "../src/lab-spec";

const LAB = labLogic();

describe("lab-logic.ts (embedded client logic, same function the server-side bounds mirror)", () => {
  test("specKey matches lab-spec.ts's specKey exactly", () => {
    const spec = { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 };
    expect(LAB.specKey(spec)).toBe(specKey(spec as any));
    expect(LAB.specKey(spec)).toBe("feb2025|live|2000|1000");
  });

  test("validSpec mirrors lab-spec.ts's validateSpec bounds", () => {
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 })).toBe(true);
    expect(LAB.validSpec({ windowId: "", base: "live", widthTicks: 2000, deposit: 1000 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "other", widthTicks: 2000, deposit: 1000 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: WIDTH_MIN - WIDTH_STEP, deposit: 1000 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: WIDTH_MAX + WIDTH_STEP, deposit: 1000 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: 2100, deposit: 1000 })).toBe(false); // not a multiple of the step
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: DEPOSIT_MIN - 1 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: DEPOSIT_MAX + 1 })).toBe(false);
    expect(LAB.validSpec({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000.5 })).toBe(false);

    const serverCheck = validateSpec({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 });
    expect(serverCheck.ok).toBe(true);
  });

  test("ticks: nice round values spanning the range, never more than n", () => {
    const t = LAB.ticks(0, 100, 4);
    expect(t.length).toBeLessThanOrEqual(5);
    expect(t[0]).toBeGreaterThanOrEqual(0);
    expect(t[t.length - 1]).toBeLessThanOrEqual(100);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  test("money/sg/pct/cls format with Spanish grouping and a dead zone around zero", () => {
    expect(LAB.money(1234.5)).toBe("1.234,50");
    expect(LAB.sg(5)).toBe("+5,00");
    expect(LAB.sg(-5)).toBe("−5,00");
    expect(LAB.sg(0.001)).toBe("0,00"); // inside the dead zone: no sign
    expect(LAB.cls(5)).toBe("lab-pos");
    expect(LAB.cls(-5)).toBe("lab-neg");
    expect(LAB.cls(0)).toBe("");
    expect(LAB.pct(0.1234, 1)).toBe("+12,3 %");
  });

  test("idxAt / nearestIndex", () => {
    const series = [{ t: 0 }, { t: 10 }, { t: 20 }, { t: 30 }];
    expect(LAB.idxAt(series, 15)).toBe(1);
    expect(LAB.idxAt(series, 25)).toBe(2);
    expect(LAB.nearestIndex(series, 9)).toBe(1);
    expect(LAB.nearestIndex(series, 4)).toBe(0);
  });

  test("keyOps drops swaps, keeps rerange/harvest/enter_mint", () => {
    const ops = [
      { t: 1, kind: "enter_swap" },
      { t: 2, kind: "enter_mint" },
      { t: 3, kind: "harvest" },
      { t: 4, kind: "rerange" },
      { t: 5, kind: "reduce" },
    ];
    expect(LAB.keyOps(ops).map((o: any) => o.kind)).toEqual(["enter_mint", "harvest", "rerange"]);
  });

  test("B-09: canCompareToBaseline only when window, deposit and simVersion all match", () => {
    const run = { spec: { windowId: "feb2025" }, deposit: 1000, simVersion: "sim-1" };
    const baseline = { spec: { windowId: "feb2025" }, deposit: 1000, simVersion: "sim-1" };
    expect(LAB.canCompareToBaseline(run, baseline)).toBe(true);
    expect(LAB.canCompareToBaseline(run, null)).toBe(false);
    expect(LAB.canCompareToBaseline(run, { ...baseline, deposit: 5000 })).toBe(false);
    expect(LAB.canCompareToBaseline(run, { ...baseline, spec: { windowId: "dec2024" } })).toBe(false);
    expect(LAB.canCompareToBaseline(run, { ...baseline, simVersion: "sim-2" })).toBe(false);
  });

  test("compareMatrix: one row per (base, widthTicks) at deposit 1000, one column per window", () => {
    const windows = [
      {
        windowId: "feb2025",
        label: "Feb 2025",
        runs: [
          { base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", metrics: { vsHodl: -16.44 } },
          { base: "live", widthTicks: 4000, deposit: 1000, variantLabel: "Rango ×2", metrics: { vsHodl: -3.26 } },
          // a non-1000 deposit run must be excluded from the matrix
          { base: "live", widthTicks: 2000, deposit: 5000, variantLabel: "Política actual", metrics: { vsHodl: -80 } },
        ],
      },
      {
        windowId: "sep2026",
        label: "Sep 2026",
        runs: [{ base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", metrics: { vsHodl: 0.1 } }],
      },
    ];
    const rows = LAB.compareMatrix(windows as any);
    expect(rows.length).toBe(2);
    const live2000 = rows.find((r: any) => r.base === "live" && r.widthTicks === 2000)!;
    expect(live2000.byWindow.feb2025).toBe(-16.44);
    expect(live2000.byWindow.sep2026).toBe(0.1);
    const live4000 = rows.find((r: any) => r.base === "live" && r.widthTicks === 4000)!;
    expect(live4000.byWindow.feb2025).toBe(-3.26);
    expect(live4000.byWindow.sep2026).toBeUndefined();
  });

  test("pollDelayMs grows then settles, so a fast job is noticed quickly and a slow one does not spam the API", () => {
    expect(LAB.pollDelayMs(0)).toBeLessThan(LAB.pollDelayMs(1));
    expect(LAB.pollDelayMs(1)).toBeLessThanOrEqual(LAB.pollDelayMs(5));
  });

  test("int: grouped whole numbers everywhere a tick/deposit count is shown", () => {
    expect(LAB.int(2000)).toBe("2.000");
    expect(LAB.int(10000)).toBe("10.000");
    expect(LAB.int(500)).toBe("500");
    expect(LAB.int(3500)).toBe("3.500");
  });

  test("windowShortLabel: regime word + short month (no dot) + 4-digit year", () => {
    expect(LAB.windowShortLabel("crash", "2025-01-29T23:55:47.000Z")).toBe("Caída ene 2025");
    expect(LAB.windowShortLabel("crash", "2025-02-02T00:00:00.000Z")).toBe("Caída feb 2025");
    expect(LAB.windowShortLabel("rally", "2024-12-01T00:00:00.000Z")).toBe("Subida dic 2024");
    expect(LAB.windowShortLabel("calm", "2026-09-01T00:00:00.000Z")).toBe("Calma sep 2026");
    expect(LAB.windowShortLabel("stable-stress", "2025-06-01T00:00:00.000Z")).toBe("Estrés USDT jun 2025");
    // no trailing dot on the short month, ever
    expect(LAB.windowShortLabel("crash", "2025-02-02T00:00:00.000Z")).not.toContain(".");
  });

  test("windowHeadlineLabel: regime word + 'de' + long month + 4-digit year", () => {
    expect(LAB.windowHeadlineLabel("crash", "2025-02-02T00:00:00.000Z")).toBe("Caída de febrero 2025");
    expect(LAB.windowHeadlineLabel("rally", "2024-12-01T00:00:00.000Z")).toBe("Subida de diciembre 2024");
  });

  test("strategyNote: a plain sentence per base/width, not the raw policyId", () => {
    expect(LAB.strategyNote("live", 2000)).toBe("Lo que corre hoy en producción");
    expect(LAB.strategyNote("live", 4000)).toBe("Mismo motor, rango de 4.000 ticks");
    expect(LAB.strategyNote("guard", 2000)).toBe("Congela entradas si el precio cae fuerte");
    expect(LAB.strategyNote("guard", 4000)).toBe("Congela entradas si el precio cae fuerte, rango de 4.000 ticks");
  });

  test("initialCursorIndex: the sample where the strategy trails holding the mix the most", () => {
    const series = [
      { v: 1000, h: 1000 }, // diff 0
      { v: 980, h: 1000 }, // diff -20
      { v: 940, h: 1010 }, // diff -70 (most negative)
      { v: 990, h: 1000 }, // diff -10
    ];
    expect(LAB.initialCursorIndex(series)).toBe(2);
    expect(LAB.initialCursorIndex([{ v: 1, h: 0 }])).toBe(0);
  });
});
