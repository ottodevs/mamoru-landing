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

  // GPT-6 Sol review (otto/mamoru-astro#28): base/widthTicks live under `spec` in the real screen-API shape
  // (LabRunSummary), not at the top level — this fixture matches that shape exactly, so a regression back to
  // reading `run.base`/`run.widthTicks` directly makes every row collapse into one "undefined|undefined" key.
  test("compareMatrix: one row per (base, widthTicks) at deposit 1000, one column per window — reads base/widthTicks from spec", () => {
    const windows = [
      {
        windowId: "feb2025",
        label: "Feb 2025",
        runs: [
          { spec: { base: "live", widthTicks: 2000 }, deposit: 1000, variantLabel: "Política actual", metrics: { vsHodl: -16.44 } },
          { spec: { base: "live", widthTicks: 4000 }, deposit: 1000, variantLabel: "Rango ×2", metrics: { vsHodl: -3.26 } },
          { spec: { base: "guard", widthTicks: 2000 }, deposit: 1000, variantLabel: "Con guarda de caídas", metrics: { vsHodl: -12.37 } },
          // a non-1000 deposit run must be excluded from the matrix
          { spec: { base: "live", widthTicks: 2000 }, deposit: 5000, variantLabel: "Política actual", metrics: { vsHodl: -80 } },
        ],
      },
      {
        windowId: "sep2026",
        label: "Sep 2026",
        runs: [
          { spec: { base: "live", widthTicks: 2000 }, deposit: 1000, variantLabel: "Política actual", metrics: { vsHodl: 0.1 } },
          { spec: { base: "guard", widthTicks: 2000 }, deposit: 1000, variantLabel: "Con guarda de caídas", metrics: { vsHodl: 0.4 } },
        ],
      },
    ];
    const rows = LAB.compareMatrix(windows as any);
    // Three distinct strategies (live/2000, live/4000, guard/2000), never collapsed into one.
    expect(rows.length).toBe(3);
    const live2000 = rows.find((r: any) => r.base === "live" && r.widthTicks === 2000)!;
    expect(live2000).toBeTruthy();
    expect(live2000.byWindow.feb2025).toBe(-16.44);
    expect(live2000.byWindow.sep2026).toBe(0.1);
    const live4000 = rows.find((r: any) => r.base === "live" && r.widthTicks === 4000)!;
    expect(live4000).toBeTruthy();
    expect(live4000.byWindow.feb2025).toBe(-3.26);
    expect(live4000.byWindow.sep2026).toBeUndefined();
    const guard2000 = rows.find((r: any) => r.base === "guard" && r.widthTicks === 2000)!;
    expect(guard2000).toBeTruthy();
    expect(guard2000.byWindow.feb2025).toBe(-12.37);
    expect(guard2000.byWindow.sep2026).toBe(0.4);
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
    // feb2025 starts on 29 Jan: with its end, the middle of the window names February.
    expect(LAB.windowShortLabel("crash", "2025-01-29T23:55:47.000Z", "2025-02-05T23:55:47.000Z")).toBe("Caída feb 2025");
    expect(LAB.windowHeadlineLabel("crash", "2025-01-29T23:55:47.000Z", "2025-02-05T23:55:47.000Z")).toBe("Caída de febrero 2025");
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

  // ---- "Ejecutar escenario" feedback (otto/mamoru-astro#28 follow-up, Ot 23 Oct) ----

  test("specWords: the requested spec in words, always on the status card", () => {
    expect(LAB.specWords("Caída feb 2025", "live", 2000, 1000)).toBe("Caída feb 2025 · Política actual · 2.000 ticks · 1.000 USDC");
    expect(LAB.specWords("Caída feb 2025", "guard", 3000, 5000)).toBe("Caída feb 2025 · Con guarda de caídas · 3.000 ticks · 5.000 USDC");
  });

  test("jobStatusText: queued and running show the elapsed seconds", () => {
    expect(LAB.jobStatusText({ status: "queued", elapsedSec: 3, variantLabel: "", windowLabel: "", alreadyExisted: false })).toBe("En cola · 3 s");
    expect(LAB.jobStatusText({ status: "running", elapsedSec: 8, variantLabel: "", windowLabel: "", alreadyExisted: false })).toBe("Calculando con el motor de producción · 8 s");
  });

  test("jobStatusHeadline: the live-region announced text has no number in it, ever", () => {
    expect(LAB.jobStatusHeadline("queued")).toBe("En cola");
    expect(LAB.jobStatusHeadline("running")).toBe("Calculando con el motor de producción");
    expect(LAB.jobStatusHeadline("queued")).not.toMatch(/\d/);
    expect(LAB.jobStatusHeadline("running")).not.toMatch(/\d/);
  });

  test("jobStatusText: done (new) names the strategy and the window it was added to", () => {
    const text = LAB.jobStatusText({ status: "done", elapsedSec: 9, variantLabel: "Rango ×2", windowLabel: "Caída feb 2025", alreadyExisted: false });
    expect(text).toBe("Listo en 9 s: «Rango ×2» añadida a Caída feb 2025.");
  });

  test("jobStatusText: done (already existed) never claims it was just added, and still names where it is", () => {
    const text = LAB.jobStatusText({ status: "done", elapsedSec: 0, variantLabel: "Rango ×2", windowLabel: "Caída feb 2025", alreadyExisted: true });
    expect(text).toBe("Ya estaba calculado: «Rango ×2» en Caída feb 2025. Te lo he seleccionado.");
    expect(text).not.toContain("Listo en");
  });

  test("jobSubText: only queued has a sub-line, and only past 60s does it say the runner hasn't answered", () => {
    expect(LAB.jobSubText("queued", 5)).toBe("El runner de lady lo recoge en unos segundos.");
    expect(LAB.jobSubText("queued", 61)).toBe("El runner de lady lo recoge en unos segundos. El runner no ha respondido todavía.");
    expect(LAB.jobSubText("queued", 60)).not.toContain("todavía"); // boundary: 60 itself is not yet "past" 60
    expect(LAB.jobSubText("running", 90)).toBe("");
    expect(LAB.jobSubText("done", 0)).toBe("");
  });

  test("jobFailedText: the daily/queued limits get their own sentence with the real numbers", () => {
    expect(LAB.jobFailedText("LAB_JOB_LIMIT_DAILY")).toBe("Has llegado a 20 escenarios hoy");
    expect(LAB.jobFailedText("LAB_JOB_LIMIT_QUEUED")).toBe("Ya tienes 3 en cola");
  });

  test("jobFailedText: known codes map to a plain-Spanish reason, unknown codes still say something", () => {
    expect(LAB.jobFailedText("LAB_JOB_LEASE_LOST")).toBe("Falló: el runner perdió el trabajo; vuelve a intentarlo");
    expect(LAB.jobFailedText("LAB_NETWORK")).toBe("Falló: sin conexión con el servidor");
    expect(LAB.jobFailedText("LAB_CSRF_INVALID")).toBe("Falló: la sesión caducó: recarga la página");
    expect(LAB.jobFailedText("LAB_DATASET_MISSING")).toBe("Falló: esta ventana no tiene datos para esa base");
    expect(LAB.jobFailedText("LAB_HOLDOUT_DENIED")).toContain("reserva de prueba");
    expect(LAB.jobFailedText("LAB_RUN_WRITE_FAILED")).toContain("vuelve a intentarlo");
    expect(LAB.jobFailedText("SOMETHING_UNKNOWN")).toBe("Falló: SOMETHING_UNKNOWN");
  });

  test("isCurrentJobGen: only the generation matching the live counter is applied, regardless of arrival order", () => {
    expect(LAB.isCurrentJobGen(1, 1)).toBe(true);
    // A stale completion (older attempt) resolving after a newer one has already started: dropped.
    expect(LAB.isCurrentJobGen(1, 2)).toBe(false);
    // Arrival order does not matter — only the tag vs. the live counter does.
    expect(LAB.isCurrentJobGen(2, 1)).toBe(false);
    expect(LAB.isCurrentJobGen(0, 0)).toBe(true);
  });
});
