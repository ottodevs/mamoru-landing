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
  /** Clamped to `exposures`: a conversion cannot exceed its own exposure count on this ledger, whatever the raw data says. */
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

function goalNames(def: ExperimentDef): string[] {
  return def.goals.map((g) => g.name);
}

function zeroVariants(def: ExperimentDef): VariantReport[] {
  const names = goalNames(def);
  return def.variants.map((v) => ({
    id: v.id,
    label: v.label ?? v.id,
    weight: v.weight,
    exposures: 0,
    conversions: Object.fromEntries(names.map((g) => [g, 0])),
    rate: Object.fromEntries(names.map((g) => [g, 0])),
    interval: Object.fromEntries(names.map((g) => [g, { low: 0, high: 0 }])),
  }));
}

export function buildExperimentReport(def: ExperimentDef, counts: ExpCounts | null): ExperimentReport {
  const df = Math.max(1, def.variants.length - 1);
  if (!counts) {
    return { def, connected: false, variants: zeroVariants(def), verdicts: [], srm: { chiSquare: 0, df, pValue: 1, mismatched: false } };
  }
  const names = goalNames(def);
  // Verdicts are computed from the raw (unclamped) counts below, so a conversion count that exceeds its own
  // exposure count — impossible, honest data — is still visible to verdict()'s inconsistency check, even
  // though the ledger itself only ever displays the clamped, sane version.
  const rawConversions = new Map<string, Record<string, number>>();
  const variants: VariantReport[] = def.variants.map((v) => {
    const exposures = counts.exposures.get(v.id) ?? 0;
    const conversions: Record<string, number> = {};
    const rate: Record<string, number> = {};
    const interval: Record<string, Interval> = {};
    const raw: Record<string, number> = {};
    for (const goal of names) {
      const rawN = counts.conversions.get(goal)?.get(v.id) ?? 0;
      raw[goal] = rawN;
      const clamped = Math.max(0, Math.min(rawN, exposures));
      conversions[goal] = clamped;
      rate[goal] = exposures > 0 ? clamped / exposures : 0;
      interval[goal] = wilsonInterval(clamped, exposures);
    }
    rawConversions.set(v.id, raw);
    return { id: v.id, label: v.label ?? v.id, weight: v.weight, exposures, conversions, rate, interval };
  });

  const control = variants[0];
  const verdicts: GoalVerdict[] = [];
  if (control) {
    for (const goal of names) {
      for (const v of variants.slice(1)) {
        const c: Proportion = { n: control.exposures, x: rawConversions.get(control.id)?.[goal] ?? 0 };
        const x: Proportion = { n: v.exposures, x: rawConversions.get(v.id)?.[goal] ?? 0 };
        const vr = verdict(c, x);
        const trustworthy = vr.kind !== "inconsistent";
        verdicts.push({
          goal,
          variantId: v.id,
          variantLabel: v.label,
          verdict: vr,
          sentence: verdictSentence(vr, v.label, control.label),
          absLift: trustworthy && (c.n > 0 || x.n > 0) ? absoluteLift(c, x) : null,
          relLift: trustworthy ? relativeLift(c, x) : null,
          diffInterval: trustworthy ? twoProportionDiffInterval(c, x) : null,
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
    const counts = db ? await readExpCounts(db, def.id, goalNames(def)) : null;
    reports.push(buildExperimentReport(def, counts));
  }
  return reports;
}
