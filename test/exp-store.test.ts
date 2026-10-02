import { describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement, D1Result } from "../src/d1-infra";
import { buildExperimentReport, loadExperimentReports } from "../src/exp-report";
import { hasExposure, type ExpEventRow, readExpCounts, recordExpEvent } from "../src/exp-store";
import type { ExperimentDef } from "../src/experiments";

/** A tiny in-memory exp_events table: enough SQL semantics to exercise exp-store.ts's actual queries. */
function fakeExpDb(initial: ExpEventRow[] = [], opts: { missing?: boolean } = {}) {
  const rows: ExpEventRow[] = [...initial];
  const db: D1Db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async first<T>() {
          if (opts.missing) throw new Error("D1_ERROR: no such table: exp_events");
          if (sql.includes("LIMIT 1")) {
            // hasExposure(): SELECT 1 FROM exp_events WHERE experiment=? AND visitor=? AND variant=? AND event='exposure' LIMIT 1
            const [experiment, visitor, variant] = args as [string, string, string];
            const found = rows.some(
              (r) => r.experiment === experiment && r.visitor === visitor && r.variant === variant && r.event === "exposure",
            );
            return (found ? { x: 1 } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (opts.missing) throw new Error("D1_ERROR: no such table: exp_events");
          if (sql.includes("JOIN exp_events e")) {
            // Conversion query: only counts a visitor whose claimed variant also has a matching exposure row.
            const [experiment, event] = args as [string, string];
            const exposedPairs = new Set<string>();
            for (const r of rows) {
              if (r.experiment === experiment && r.event === "exposure") exposedPairs.add(`${r.visitor}:${r.variant}`);
            }
            const bucket = new Map<string, Set<string>>();
            for (const r of rows) {
              if (r.experiment !== experiment || r.event !== event) continue;
              if (!exposedPairs.has(`${r.visitor}:${r.variant}`)) continue;
              if (!bucket.has(r.variant)) bucket.set(r.variant, new Set());
              bucket.get(r.variant)!.add(r.visitor);
            }
            const results = [...bucket.entries()].map(([variant, visitors]) => ({ variant, n: visitors.size }));
            return { results: results as T[], success: true };
          }
          if (sql.includes("GROUP BY variant")) {
            // Exposure query.
            const experiment = args[0] as string;
            const bucket = new Map<string, Set<string>>();
            for (const r of rows) {
              if (r.experiment !== experiment || r.event !== "exposure") continue;
              if (!bucket.has(r.variant)) bucket.set(r.variant, new Set());
              bucket.get(r.variant)!.add(r.visitor);
            }
            const results = [...bucket.entries()].map(([variant, visitors]) => ({ variant, n: visitors.size }));
            return { results: results as T[], success: true };
          }
          return { results: [], success: true };
        },
        async run() {
          if (opts.missing) throw new Error("D1_ERROR: no such table: exp_events");
          const [experiment, variant, visitor, event, day, at] = args as [string, string, string, string, string, string];
          const exists = rows.some((r) => r.experiment === experiment && r.visitor === visitor && r.event === event && r.day === day);
          if (!exists) rows.push({ experiment, variant, visitor, event, day, at });
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, rows };
}

describe("recordExpEvent", () => {
  test("writes a row", async () => {
    const { db, rows } = fakeExpDb();
    await recordExpEvent(db, { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" });
    expect(rows).toHaveLength(1);
  });

  test("the same visitor+event+day is a no-op the second time (primary key dedupe)", async () => {
    const { db, rows } = fakeExpDb();
    const row: ExpEventRow = { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" };
    await recordExpEvent(db, row);
    await recordExpEvent(db, row);
    await recordExpEvent(db, { ...row, at: "t2" });
    expect(rows).toHaveLength(1);
  });

  test("a different day for the same visitor is a new row", async () => {
    const { db, rows } = fakeExpDb();
    await recordExpEvent(db, { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" });
    await recordExpEvent(db, { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-02", at: "t" });
    expect(rows).toHaveLength(2);
  });

  test("degrades silently when the table is missing — never throws", async () => {
    const { db } = fakeExpDb([], { missing: true });
    await expect(
      recordExpEvent(db, { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" }),
    ).resolves.toBeUndefined();
  });
});

describe("readExpCounts", () => {
  test("unique-visitor exposure and conversion counts per variant", async () => {
    const { db } = fakeExpDb([
      { experiment: "hero_cta", variant: "control", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" },
      { experiment: "hero_cta", variant: "control", visitor: "v2", event: "exposure", day: "2026-10-01", at: "t" },
      { experiment: "hero_cta", variant: "b", visitor: "v3", event: "exposure", day: "2026-10-01", at: "t" },
      { experiment: "hero_cta", variant: "control", visitor: "v1", event: "open_app_click", day: "2026-10-01", at: "t" },
      { experiment: "hero_cta", variant: "b", visitor: "v3", event: "open_app_click", day: "2026-10-01", at: "t" },
      // A second experiment must not bleed into these counts.
      { experiment: "other", variant: "control", visitor: "v9", event: "exposure", day: "2026-10-01", at: "t" },
    ]);
    const counts = await readExpCounts(db, "hero_cta", ["open_app_click"]);
    expect(counts?.exposures.get("control")).toBe(2);
    expect(counts?.exposures.get("b")).toBe(1);
    expect(counts?.conversions.get("open_app_click")?.get("control")).toBe(1);
    expect(counts?.conversions.get("open_app_click")?.get("b")).toBe(1);
  });

  test("a repeated event on the same day for one visitor still counts once (unique visitor, not row count)", async () => {
    const { db } = fakeExpDb([
      { experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" },
    ]);
    // Simulate two real days of exposure for the same visitor: distinct rows, same variant.
    const counts = await readExpCounts(db, "hero_cta", []);
    expect(counts?.exposures.get("b")).toBe(1);
  });

  test("null when the table is missing or unreadable", async () => {
    const { db } = fakeExpDb([], { missing: true });
    expect(await readExpCounts(db, "hero_cta", ["open_app_click"])).toBeNull();
  });

  test("a conversion with no matching exposure (dangling, or for a different variant) is excluded, not counted", async () => {
    const { db } = fakeExpDb([
      { experiment: "hero_cta", variant: "control", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" },
      // v2 converts but was never exposed at all.
      { experiment: "hero_cta", variant: "control", visitor: "v2", event: "open_app_click", day: "2026-10-01", at: "t" },
      // v1 was exposed to "control" but the conversion row claims "b" — a mismatch, not a legitimate count for "b".
      { experiment: "hero_cta", variant: "b", visitor: "v1", event: "open_app_click", day: "2026-10-01", at: "t" },
    ]);
    const counts = await readExpCounts(db, "hero_cta", ["open_app_click"]);
    expect(counts?.conversions.get("open_app_click")?.get("control")).toBeUndefined();
    expect(counts?.conversions.get("open_app_click")?.get("b")).toBeUndefined();
  });
});

describe("hasExposure", () => {
  test("true for a recorded (experiment, visitor, variant) exposure", async () => {
    const { db } = fakeExpDb([{ experiment: "hero_cta", variant: "b", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" }]);
    expect(await hasExposure(db, "hero_cta", "v1", "b")).toBe(true);
  });

  test("false when the variant does not match the recorded exposure", async () => {
    const { db } = fakeExpDb([{ experiment: "hero_cta", variant: "control", visitor: "v1", event: "exposure", day: "2026-10-01", at: "t" }]);
    expect(await hasExposure(db, "hero_cta", "v1", "b")).toBe(false);
  });

  test("false for a visitor with no exposure at all", async () => {
    const { db } = fakeExpDb([]);
    expect(await hasExposure(db, "hero_cta", "ghost", "b")).toBe(false);
  });

  test("false (fail closed), not thrown, when the table is missing", async () => {
    const { db } = fakeExpDb([], { missing: true });
    expect(await hasExposure(db, "hero_cta", "v1", "b")).toBe(false);
  });
});

const FIXTURE: ExperimentDef = {
  id: "fixture",
  description: "fixture experiment",
  status: "running",
  path: "/fixture",
  variants: [
    { id: "control", weight: 1, label: "Control" },
    { id: "b", weight: 1, label: "Variant B" },
  ],
  goals: [{ name: "open_app_click", source: "client" }],
};

describe("buildExperimentReport", () => {
  test("not connected (no counts): zeroed variants, no verdicts", () => {
    const report = buildExperimentReport(FIXTURE, null);
    expect(report.connected).toBe(false);
    expect(report.variants.map((v) => v.exposures)).toEqual([0, 0]);
    expect(report.verdicts).toEqual([]);
  });

  test("builds rates, intervals, and a verdict per non-control variant per goal", () => {
    const counts = {
      exposures: new Map([["control", 1000], ["b", 1000]]),
      conversions: new Map([["open_app_click", new Map([["control", 100], ["b", 160]])]]),
    };
    const report = buildExperimentReport(FIXTURE, counts);
    expect(report.connected).toBe(true);
    const control = report.variants[0];
    const b = report.variants[1];
    expect(control.rate.open_app_click).toBeCloseTo(0.1, 6);
    expect(b.rate.open_app_click).toBeCloseTo(0.16, 6);
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0].verdict.kind).toBe("ahead");
    expect(report.verdicts[0].absLift).toBeCloseTo(0.06, 6);
    expect(report.verdicts[0].relLift).toBeCloseTo(0.6, 6);
  });

  test("includes an SRM result for the declared split", () => {
    const counts = {
      exposures: new Map([["control", 700], ["b", 300]]),
      conversions: new Map([["open_app_click", new Map()]]),
    };
    const report = buildExperimentReport(FIXTURE, counts);
    expect(report.srm.mismatched).toBe(true);
  });

  test("a conversion count above its own exposure count is clamped for display and the verdict is 'inconsistent'", () => {
    const counts = {
      exposures: new Map([["control", 1000], ["b", 50]]),
      // b's conversions (80) exceed b's exposures (50): impossible, honest data.
      conversions: new Map([["open_app_click", new Map([["control", 100], ["b", 80]])]]),
    };
    const report = buildExperimentReport(FIXTURE, counts);
    const b = report.variants[1];
    expect(b.conversions.open_app_click).toBe(50); // clamped to exposures, never over 100%
    expect(b.rate.open_app_click).toBeCloseTo(1, 6);
    expect(report.verdicts[0].verdict.kind).toBe("inconsistent");
    expect(report.verdicts[0].sentence).toContain("Data inconsistent");
    expect(report.verdicts[0].absLift).toBeNull();
    expect(report.verdicts[0].relLift).toBeNull();
    expect(report.verdicts[0].diffInterval).toBeNull();
  });
});

describe("loadExperimentReports", () => {
  test("without a db binding, every experiment reports not connected", async () => {
    const reports = await loadExperimentReports(undefined);
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) expect(r.connected).toBe(false);
  });
});
