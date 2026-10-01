/**
 * Pure statistics for experiment analysis. No I/O, no Workers globals — every
 * function here takes plain numbers and returns plain numbers, so it is
 * testable against hand-computed values and reusable from the ops section.
 */

const Z95 = 1.959963984540054; // two-sided 95% normal critical value

export interface Proportion {
  n: number;
  x: number;
}

function rate(p: Proportion): number {
  return p.n > 0 ? p.x / p.n : 0;
}

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for a single proportion x/n. Stable at small n and near 0 or 1, unlike the normal approximation. */
export function wilsonInterval(x: number, n: number, z = Z95): Interval {
  if (n <= 0) return { low: 0, high: 0 };
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

/** Normal-approximation interval for the difference of two proportions (variant − control). null with no data on either side. */
export function twoProportionDiffInterval(control: Proportion, variant: Proportion, z = Z95): Interval | null {
  if (control.n <= 0 || variant.n <= 0) return null;
  const pc = rate(control);
  const pv = rate(variant);
  const diff = pv - pc;
  const se = Math.sqrt((pc * (1 - pc)) / control.n + (pv * (1 - pv)) / variant.n);
  return { low: diff - z * se, high: diff + z * se };
}

/** Relative lift of variant over control. null when control has no conversions to compare against (division by zero). */
export function relativeLift(control: Proportion, variant: Proportion): number | null {
  const pc = rate(control);
  if (pc <= 0) return null;
  return (rate(variant) - pc) / pc;
}

export function absoluteLift(control: Proportion, variant: Proportion): number {
  return rate(variant) - rate(control);
}

export const DEFAULT_MIN_SAMPLE_PER_VARIANT = 100;

export type Verdict =
  | { kind: "insufficient"; needPerVariant: number }
  | { kind: "no-difference" }
  | { kind: "ahead" }
  | { kind: "behind" };

/** Rounds a "needs ~N more" figure up to a readable step so it reads as an estimate, not false precision. */
function roundNeed(n: number): number {
  if (n <= 0) return 0;
  const step = n < 50 ? 5 : n < 500 ? 25 : 100;
  return Math.ceil(n / step) * step;
}

/**
 * The plain-language call for one variant against control on one goal.
 * Below the sample guard, no interval is trusted yet. At or above it, the
 * two-proportion interval decides: excludes zero and on top = ahead, excludes
 * zero and below = behind, straddles zero = no detectable difference.
 */
export function verdict(control: Proportion, variant: Proportion, minSample = DEFAULT_MIN_SAMPLE_PER_VARIANT): Verdict {
  if (control.n < minSample || variant.n < minSample) {
    const short = Math.max(minSample - control.n, minSample - variant.n, 0);
    return { kind: "insufficient", needPerVariant: roundNeed(short) };
  }
  const interval = twoProportionDiffInterval(control, variant);
  if (!interval) return { kind: "insufficient", needPerVariant: roundNeed(minSample) };
  if (interval.low <= 0 && interval.high >= 0) return { kind: "no-difference" };
  return interval.low > 0 ? { kind: "ahead" } : { kind: "behind" };
}

/** The sentence the ops section shows next to a variant. `label` is the variant's display name. */
export function verdictSentence(v: Verdict, label: string): string {
  switch (v.kind) {
    case "insufficient":
      return v.needPerVariant > 0
        ? `Not enough data yet (needs ~${v.needPerVariant} more per variant).`
        : "Not enough data yet.";
    case "no-difference":
      return "No detectable difference.";
    case "ahead":
      return `${label} is ahead: 95% interval excludes zero.`;
    case "behind":
      return `${label} is behind: 95% interval excludes zero.`;
  }
}

// ---- chi-square p-value, for the sample-ratio-mismatch check ----
// Regularized incomplete gamma via the classic series + continued-fraction
// split (Numerical Recipes §6.2), with a Lanczos ln-Gamma. Good to ~1e-10 for
// the small degrees of freedom and chi-square values a variant split ever needs.

function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xm1 = x - 1;
  let a = c[0];
  const t = xm1 + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xm1 + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Lower regularized incomplete gamma P(a, x), series form. Valid for x < a + 1. */
function gammaPSeries(a: number, x: number): number {
  if (x <= 0) return 0;
  let sum = 1 / a;
  let term = sum;
  let n = a;
  for (let i = 0; i < 300; i++) {
    n += 1;
    term *= x / n;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Upper regularized incomplete gamma Q(a, x), continued-fraction form (Lentz). Valid for x >= a + 1. */
function gammaQContinuedFraction(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** P(X > chiSquare) for a chi-square distribution with `df` degrees of freedom. */
export function chiSquarePValue(chiSquare: number, df: number): number {
  if (df <= 0) return 1;
  if (chiSquare <= 0) return 1;
  const a = df / 2;
  const x = chiSquare / 2;
  const q = x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
  return Math.max(0, Math.min(1, q));
}

export interface SrmResult {
  chiSquare: number;
  df: number;
  pValue: number;
  /** True when the observed split is implausible under the declared weights (p below `alpha`). */
  mismatched: boolean;
}

/**
 * Sample-ratio-mismatch check: a chi-square goodness-of-fit test of the
 * observed assignment counts against the declared weights. A low p-value
 * (default alpha 0.001, the conventional SRM threshold — strict on purpose
 * so normal sampling noise never cries wolf) flags a broken or biased split.
 */
export function srmCheck(
  observed: readonly { variant: string; n: number }[],
  weights: readonly { variant: string; weight: number }[],
  alpha = 0.001,
): SrmResult {
  const total = observed.reduce((sum, o) => sum + o.n, 0);
  const weightTotal = weights.reduce((sum, w) => sum + Math.max(0, w.weight), 0);
  const df = Math.max(1, observed.length - 1);
  if (total <= 0 || weightTotal <= 0) return { chiSquare: 0, df, pValue: 1, mismatched: false };
  let chiSquare = 0;
  for (const o of observed) {
    const w = weights.find((w) => w.variant === o.variant)?.weight ?? 0;
    const expected = total * (Math.max(0, w) / weightTotal);
    if (expected > 0) chiSquare += (o.n - expected) ** 2 / expected;
  }
  const pValue = chiSquarePValue(chiSquare, df);
  return { chiSquare, df, pValue, mismatched: pValue < alpha };
}
