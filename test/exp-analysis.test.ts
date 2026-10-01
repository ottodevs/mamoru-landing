import { describe, expect, test } from "bun:test";
import {
  absoluteLift,
  chiSquarePValue,
  DEFAULT_MIN_SAMPLE_PER_VARIANT,
  relativeLift,
  srmCheck,
  twoProportionDiffInterval,
  verdict,
  verdictSentence,
  wilsonInterval,
} from "../src/exp-analysis";

describe("wilsonInterval: known values", () => {
  test("50/100 is centered near 0.5 with a textbook-width interval", () => {
    const { low, high } = wilsonInterval(50, 100);
    // Textbook Wilson 95% CI for 50/100 is approximately [0.404, 0.596].
    expect(low).toBeCloseTo(0.4038, 3);
    expect(high).toBeCloseTo(0.5962, 3);
  });

  test("0/50 stays within [0, 1] and does not go negative", () => {
    const { low, high } = wilsonInterval(0, 50);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(0.1);
  });

  test("n = 0 is a degenerate zero-width interval at zero, not NaN", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  test("a larger n narrows the interval around the same rate", () => {
    const small = wilsonInterval(30, 100);
    const large = wilsonInterval(300, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
});

describe("twoProportionDiffInterval", () => {
  test("identical proportions center the interval on zero", () => {
    const i = twoProportionDiffInterval({ n: 1000, x: 100 }, { n: 1000, x: 100 })!;
    expect(i.low + i.high).toBeCloseTo(0, 6);
  });

  test("a clearly higher variant rate gives an interval entirely above zero", () => {
    // control 10% of 2000, variant 16% of 2000 — a large, clean gap.
    const i = twoProportionDiffInterval({ n: 2000, x: 200 }, { n: 2000, x: 320 })!;
    expect(i.low).toBeGreaterThan(0);
  });

  test("no data on either side returns null", () => {
    expect(twoProportionDiffInterval({ n: 0, x: 0 }, { n: 100, x: 10 })).toBeNull();
    expect(twoProportionDiffInterval({ n: 100, x: 10 }, { n: 0, x: 0 })).toBeNull();
  });
});

describe("lift", () => {
  test("absolute lift is variant rate minus control rate", () => {
    expect(absoluteLift({ n: 1000, x: 100 }, { n: 1000, x: 150 })).toBeCloseTo(0.05, 6);
  });

  test("relative lift of +50% when variant converts half again as often", () => {
    expect(relativeLift({ n: 1000, x: 100 }, { n: 1000, x: 150 })).toBeCloseTo(0.5, 6);
  });

  test("relative lift is null when control has zero conversions", () => {
    expect(relativeLift({ n: 1000, x: 0 }, { n: 1000, x: 10 })).toBeNull();
  });
});

describe("verdict", () => {
  test("below the sample guard: insufficient data, regardless of the rates", () => {
    const v = verdict({ n: 10, x: 5 }, { n: 10, x: 1 });
    expect(v.kind).toBe("insufficient");
    expect(verdictSentence(v, "B")).toContain("Not enough data yet");
  });

  test("large n, same rate: no detectable difference", () => {
    const v = verdict({ n: 5000, x: 500 }, { n: 5000, x: 505 }, 100);
    expect(v.kind).toBe("no-difference");
    expect(verdictSentence(v, "B")).toBe("No detectable difference.");
  });

  test("large n, a clearly higher variant rate: ahead", () => {
    const v = verdict({ n: 3000, x: 300 }, { n: 3000, x: 480 }, 100);
    expect(v.kind).toBe("ahead");
    expect(verdictSentence(v, "B")).toContain("is ahead");
    expect(verdictSentence(v, "B")).toContain("excludes zero");
  });

  test("large n, a clearly lower variant rate: behind", () => {
    const v = verdict({ n: 3000, x: 480 }, { n: 3000, x: 300 }, 100);
    expect(v.kind).toBe("behind");
    expect(verdictSentence(v, "B")).toContain("is behind");
  });

  test("the default minimum sample guard is used when none is given", () => {
    const v = verdict({ n: DEFAULT_MIN_SAMPLE_PER_VARIANT - 1, x: 10 }, { n: DEFAULT_MIN_SAMPLE_PER_VARIANT - 1, x: 10 });
    expect(v.kind).toBe("insufficient");
  });
});

describe("chiSquarePValue: textbook critical values", () => {
  test.each([
    [3.841, 1, 0.05],
    [6.635, 1, 0.01],
    [10.828, 1, 0.001],
    [5.991, 2, 0.05],
    [7.815, 3, 0.05],
    [9.488, 4, 0.05],
  ])("chi-square %p at df %p ~ p %p", (chiSquare, df, expected) => {
    expect(chiSquarePValue(chiSquare, df)).toBeCloseTo(expected as number, 2);
  });

  test("chi-square of 0 is p = 1", () => {
    expect(chiSquarePValue(0, 1)).toBe(1);
  });
});

describe("srmCheck: sample ratio mismatch", () => {
  test("a clean 50/50 split at a large n is not mismatched", () => {
    const r = srmCheck(
      [{ variant: "control", n: 5012 }, { variant: "b", n: 4988 }],
      [{ variant: "control", weight: 1 }, { variant: "b", weight: 1 }],
    );
    expect(r.mismatched).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.001);
  });

  test("a badly broken split (70/30 against a declared 50/50) is flagged", () => {
    const r = srmCheck(
      [{ variant: "control", n: 7000 }, { variant: "b", n: 3000 }],
      [{ variant: "control", weight: 1 }, { variant: "b", weight: 1 }],
    );
    expect(r.mismatched).toBe(true);
    expect(r.pValue).toBeLessThan(0.001);
  });

  test("an uneven declared weight (90/10) matched by an uneven observed split is not flagged", () => {
    const r = srmCheck(
      [{ variant: "control", n: 9020 }, { variant: "b", n: 980 }],
      [{ variant: "control", weight: 9 }, { variant: "b", weight: 1 }],
    );
    expect(r.mismatched).toBe(false);
  });

  test("no data yet: not mismatched, p = 1", () => {
    const r = srmCheck(
      [{ variant: "control", n: 0 }, { variant: "b", n: 0 }],
      [{ variant: "control", weight: 1 }, { variant: "b", weight: 1 }],
    );
    expect(r.mismatched).toBe(false);
    expect(r.pValue).toBe(1);
  });
});
