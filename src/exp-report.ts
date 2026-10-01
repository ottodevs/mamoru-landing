/** Builds the /ops/experiments model from D1 counts plus the registry. The build step is pure; loadExperimentReports() is the only I/O. */

import {
  absoluteLift,
  type Interval,
  type Proportion,
  relativeLift,
  twoProportionDiffInterval,
  type Verdict,
  verdict,
  verdictSentence,
  wilsonInterval,
  srmCheck,
  type SrmResult,
} from "./exp-analysis";
import { EXPERIMENTS, type ExperimentDef } from "./experiments";
import { type ExpCounts, readExpCounts } from "./exp-store";
import type { D1Db } from "./d1-infra";

export interface VariantReport {
  id: string;
  label: string;
  weight: number;
  exposures: number;
  conversions: Record<string, number>;
  rate: Record<string, number>;
  interval: Record<string, Interval>;
}

export interface GoalVerdict {
  goal: string;
  variantId: string;
  variantLabel: string;
  verdict: Verdict;
  sentence: string;
  absLift: number | null;
  relLift: number | null;
  diffInterval: Interval | null;
}

export interface ExperimentReport {
  def: ExperimentDef;
  /** False when exp_events is missing or unreadable: the section says so instead of a zeroed ledger. */
  connected: boolean;
  variants: VariantReport[];
  verdicts: GoalVerdict[];
  srm: SrmResult;
}

function zeroVariants(def: ExperimentDef): VariantReport[] {
  return def.variants.map((v) => ({
    id: v.id,
    label: v.label ?? v.id,
    weight: v.weight,
    exposures: 0,
    conversions: Object.fromEntries(def.goals.map((g) => [g, 0])),
    rate: Object.fromEntries(def.goals.map((g) => [g, 0])),
    interval: Object.fromEntries(def.goals.map((g) => [g, { low: 0, high: 0 }])),
  }));
}

export function buildExperimentReport(def: ExperimentDef, counts: ExpCounts | null): ExperimentReport {
  const df = Math.max(1, def.variants.length - 1);
  if (!counts) {
    return { def, connected: false, variants: zeroVariants(def), verdicts: [], srm: { chiSquare: 0, df, pValue: 1, mismatched: false } };
  }
  const variants: VariantReport[] = def.variants.map((v) => {
    const exposures = counts.exposures.get(v.id) ?? 0;
    const conversions: Record<string, number> = {};
    const rate: Record<string, number> = {};
    const interval: Record<string, Interval> = {};
    for (const goal of def.goals) {
      const n = counts.conversions.get(goal)?.get(v.id) ?? 0;
      conversions[goal] = n;
      rate[goal] = exposures > 0 ? n / exposures : 0;
      interval[goal] = wilsonInterval(n, exposures);
    }
    return { id: v.id, label: v.label ?? v.id, weight: v.weight, exposures, conversions, rate, interval };
  });

  const control = variants[0];
  const verdicts: GoalVerdict[] = [];
  if (control) {
    for (const goal of def.goals) {
      for (const v of variants.slice(1)) {
        const c: Proportion = { n: control.exposures, x: control.conversions[goal] ?? 0 };
        const x: Proportion = { n: v.exposures, x: v.conversions[goal] ?? 0 };
        const vr = verdict(c, x);
        verdicts.push({
          goal,
          variantId: v.id,
          variantLabel: v.label,
          verdict: vr,
          sentence: verdictSentence(vr, v.label),
          absLift: c.n > 0 || x.n > 0 ? absoluteLift(c, x) : null,
          relLift: relativeLift(c, x),
          diffInterval: twoProportionDiffInterval(c, x),
        });
      }
    }
  }

  const srm = srmCheck(
    variants.map((v) => ({ variant: v.id, n: v.exposures })),
    def.variants.map((v) => ({ variant: v.id, weight: v.weight })),
  );

  return { def, connected: true, variants, verdicts, srm };
}

/** One report per registered experiment. A missing or unreadable exp_events table degrades every experiment to `connected: false`, never an error. */
export async function loadExperimentReports(db: D1Db | undefined): Promise<ExperimentReport[]> {
  const reports: ExperimentReport[] = [];
  for (const def of EXPERIMENTS) {
    const counts = db ? await readExpCounts(db, def.id, def.goals) : null;
    reports.push(buildExperimentReport(def, counts));
  }
  return reports;
}
