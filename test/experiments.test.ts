import { describe, expect, test } from "bun:test";
import {
  assignVariant,
  controlVariantId,
  EXPERIMENTS,
  experimentById,
  experimentsForPath,
  type ExperimentDef,
  variantById,
  variesPerVisitor,
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
    goals: ["open_app_click"],
    ...over,
  };
}

describe("experiments.ts registry", () => {
  test("hero_cta is registered in draft, control first, one goal", () => {
    const hero = experimentById("hero_cta");
    expect(hero?.status).toBe("draft");
    expect(hero?.variants[0]?.id).toBe("control");
    expect(hero?.goals).toEqual(["open_app_click"]);
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
