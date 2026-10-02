import { describe, expect, test } from "bun:test";
import {
  assignVariant,
  controlVariantId,
  EXPERIMENTS,
  experimentById,
  experimentStatus,
  experimentsForPath,
  type ExperimentDef,
  goalByName,
  ID_PATTERN,
  isRunning,
  validateRegistry,
  variantById,
  variesPerVisitor,
  winnerVariant,
} from "../src/experiments";

function def(over: Partial<ExperimentDef> = {}): ExperimentDef {
  return {
    id: "fixture",
    description: "test fixture",
    status: "running",
    path: "/fixture",
    variants: [
      { id: "control", weight: 1 },
      { id: "b", weight: 1 },
    ],
    goals: [{ name: "open_app_click", source: "client" }],
    ...over,
  };
}

describe("experiments.ts registry", () => {
  test("hero_cta is registered in draft, control first, one goal", () => {
    const hero = experimentById("hero_cta");
    expect(hero?.status).toBe("draft");
    expect(hero?.variants[0]?.id).toBe("control");
    expect(hero?.goals).toEqual([{ name: "open_app_click", source: "client" }]);
    expect(experimentsForPath("/")).toContainEqual(hero);
  });

  test("experimentsForPath only matches the declared surface", () => {
    expect(experimentsForPath("/does-not-exist")).toEqual([]);
  });

  test("variantById finds a variant by id, or not", () => {
    const d = def();
    expect(variantById(d, "b")?.id).toBe("b");
    expect(variantById(d, "nope")).toBeUndefined();
  });

  test("goalByName finds a goal by name, or not", () => {
    const d = def();
    expect(goalByName(d, "open_app_click")).toEqual({ name: "open_app_click", source: "client" });
    expect(goalByName(d, "nope")).toBeUndefined();
  });

  test("winnerVariant resolves the pinned winner's variant object, or undefined", () => {
    expect(winnerVariant(def({ winner: "b" }))?.id).toBe("b");
    expect(winnerVariant(def())).toBeUndefined();
    expect(winnerVariant(def({ winner: "ghost" }))).toBeUndefined();
  });
});

describe("validateRegistry: ids must be safe tokens, thrown at module load", () => {
  test("ID_PATTERN accepts lowercase/digits/underscore only, 1-40 chars", () => {
    expect(ID_PATTERN.test("hero_cta")).toBe(true);
    expect(ID_PATTERN.test("a")).toBe(true);
    expect(ID_PATTERN.test("a".repeat(40))).toBe(true);
    expect(ID_PATTERN.test("a".repeat(41))).toBe(false);
    expect(ID_PATTERN.test("")).toBe(false);
    expect(ID_PATTERN.test("Hero_Cta")).toBe(false);
    expect(ID_PATTERN.test("hero-cta")).toBe(false);
    expect(ID_PATTERN.test("hero cta")).toBe(false);
    expect(ID_PATTERN.test("</script>")).toBe(false);
  });

  test("the real registry validates cleanly (already proven by module load not throwing, asserted again here)", () => {
    expect(() => validateRegistry(EXPERIMENTS)).not.toThrow();
  });

  test("throws on an invalid experiment id", () => {
    expect(() => validateRegistry([def({ id: "bad id!" })])).toThrow(/invalid experiment id/);
  });

  test("throws on a duplicate experiment id", () => {
    expect(() => validateRegistry([def(), def()])).toThrow(/duplicate experiment id/);
  });

  test("throws on an invalid variant id", () => {
    expect(() => validateRegistry([def({ variants: [{ id: "ok", weight: 1 }, { id: "</script>", weight: 1 }] })])).toThrow(
      /invalid variant id/,
    );
  });

  test("throws on a duplicate variant id", () => {
    expect(() => validateRegistry([def({ variants: [{ id: "x", weight: 1 }, { id: "x", weight: 1 }] })])).toThrow(/duplicate variant id/);
  });

  test("throws on a winner that names a variant that does not exist", () => {
    expect(() => validateRegistry([def({ winner: "ghost" })])).toThrow(/not one of its variants/);
  });

  test("throws on an invalid goal name", () => {
    expect(() => validateRegistry([def({ goals: [{ name: "<script>", source: "client" }] })])).toThrow(/invalid goal name/);
  });

  test("throws on a duplicate goal name", () => {
    expect(() =>
      validateRegistry([
        def({ goals: [{ name: "g", source: "client" }, { name: "g", source: "server" }] }),
      ]),
    ).toThrow(/duplicate goal/);
  });

  test("throws on an experiment with no variants", () => {
    expect(() => validateRegistry([def({ variants: [] })])).toThrow(/no variants/);
  });
});

describe("assignVariant: determinism and weight distribution", () => {
  test("same visitor, same experiment: identical bucket on repeat calls", () => {
    const d = def();
    for (const id of ["visitor-a", "visitor-b", "a-very-different-id-123"]) {
      const first = assignVariant(d, id);
      for (let i = 0; i < 20; i++) expect(assignVariant(d, id)).toBe(first);
    }
  });

  test("a draft experiment serves control to every visitor, regardless of id", () => {
    const d = def({ status: "draft" });
    for (let i = 0; i < 500; i++) {
      expect(assignVariant(d, `visitor-${i}`)).toBe("control");
    }
  });

  test("a stopped experiment serves control to every visitor", () => {
    const d = def({ status: "stopped" });
    for (let i = 0; i < 200; i++) {
      expect(assignVariant(d, `visitor-${i}`)).toBe("control");
    }
  });

  test("a winner is pinned for everyone, even while still running", () => {
    const d = def({ winner: "b" });
    for (let i = 0; i < 200; i++) {
      expect(assignVariant(d, `visitor-${i}`)).toBe("b");
    }
  });

  test("an unknown winner id is ignored, falling back to normal assignment", () => {
    const d = def({ winner: "ghost" });
    expect(assignVariant(d, "visitor-x")).not.toBe("ghost");
  });

  test("over 10k ids, a 50/50 split lands within 2 percentage points", () => {
    const d = def();
    let control = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      if (assignVariant(d, `v${i}`) === "control") control += 1;
    }
    const share = control / n;
    expect(share).toBeGreaterThan(0.48);
    expect(share).toBeLessThan(0.52);
  });

  test("over 10k ids, an uneven 90/10 split is honored within a few points", () => {
    const d = def({ variants: [{ id: "control", weight: 9 }, { id: "b", weight: 1 }] });
    let control = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      if (assignVariant(d, `v${i}`) === "control") control += 1;
    }
    const share = control / n;
    expect(share).toBeGreaterThan(0.87);
    expect(share).toBeLessThan(0.93);
  });

  test("three variants split roughly evenly", () => {
    const d = def({
      variants: [
        { id: "control", weight: 1 },
        { id: "b", weight: 1 },
        { id: "c", weight: 1 },
      ],
    });
    const counts = { control: 0, b: 0, c: 0 } as Record<string, number>;
    const n = 9000;
    for (let i = 0; i < n; i++) counts[assignVariant(d, `v${i}`)] += 1;
    for (const id of ["control", "b", "c"]) {
      expect(counts[id] / n).toBeGreaterThan(0.3);
      expect(counts[id] / n).toBeLessThan(0.37);
    }
  });

  test("different experiment ids rebucket the same visitor independently", () => {
    const a = def({ id: "exp-a" });
    const b = def({ id: "exp-b" });
    // Not every visitor lands the same way in both; at least one of a sample differs.
    const differs = Array.from({ length: 50 }, (_, i) => `v${i}`).some(
      (id) => assignVariant(a, id) !== assignVariant(b, id),
    );
    expect(differs).toBe(true);
  });

  test("zero total weight falls back to control", () => {
    const d = def({ variants: [{ id: "control", weight: 0 }, { id: "b", weight: 0 }] });
    expect(assignVariant(d, "visitor-x")).toBe("control");
  });

  test("controlVariantId is always the first declared variant", () => {
    expect(controlVariantId(def())).toBe("control");
  });
});

describe("variesPerVisitor", () => {
  test("true only for a running experiment with no winner and more than one weighted variant", () => {
    expect(variesPerVisitor(def())).toBe(true);
    expect(variesPerVisitor(def({ status: "draft" }))).toBe(false);
    expect(variesPerVisitor(def({ status: "stopped" }))).toBe(false);
    expect(variesPerVisitor(def({ winner: "b" }))).toBe(false);
    expect(variesPerVisitor(def({ variants: [{ id: "control", weight: 1 }, { id: "b", weight: 0 }] }))).toBe(false);
  });
});

describe("endedAt: an expired experiment behaves as stopped even if status still says running", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  test("experimentStatus/isRunning read 'stopped' once endedAt has passed", () => {
    const expired = def({ endedAt: "2026-06-01" });
    expect(experimentStatus(expired, now)).toBe("stopped");
    expect(isRunning(expired, now)).toBe(false);
  });

  test("not yet expired still reads as running", () => {
    const notYet = def({ endedAt: "2026-06-30" });
    expect(experimentStatus(notYet, now)).toBe("running");
    expect(isRunning(notYet, now)).toBe(true);
  });

  test("expired on the end day itself (before 23:59:59 UTC) is still running; the day after is not", () => {
    const d = def({ endedAt: "2026-06-15" });
    expect(isRunning(d, new Date("2026-06-15T23:00:00Z"))).toBe(true);
    expect(isRunning(d, new Date("2026-06-16T00:00:01Z"))).toBe(false);
  });

  test("assignVariant serves control to every visitor once expired", () => {
    const expired = def({ endedAt: "2026-06-01" });
    for (let i = 0; i < 100; i++) expect(assignVariant(expired, `v${i}`, now)).toBe("control");
  });

  test("assignVariant still serves the winner once expired, if one was pinned", () => {
    const expired = def({ endedAt: "2026-06-01", winner: "b" });
    for (let i = 0; i < 50; i++) expect(assignVariant(expired, `v${i}`, now)).toBe("b");
  });

  test("variesPerVisitor is false once expired, even with multiple weighted variants", () => {
    expect(variesPerVisitor(def({ endedAt: "2026-06-01" }), now)).toBe(false);
  });

  test("status 'draft' or 'stopped' with an endedAt in the future is unaffected (endedAt only matters for 'running')", () => {
    expect(experimentStatus(def({ status: "draft", endedAt: "2099-01-01" }), now)).toBe("draft");
    expect(experimentStatus(def({ status: "stopped", endedAt: "2099-01-01" }), now)).toBe("stopped");
  });

  test("no endedAt at all: running stays running indefinitely", () => {
    expect(experimentStatus(def(), now)).toBe("running");
  });
});

describe("EXPERIMENTS registry shape", () => {
  test("every experiment id is a safe selector token", () => {
    for (const e of EXPERIMENTS) expect(e.id).toMatch(/^[a-z0-9_]+$/);
  });

  test("every experiment's variants start with a control-like first entry and unique ids", () => {
    for (const e of EXPERIMENTS) {
      const ids = e.variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBeTruthy();
    }
  });
});
