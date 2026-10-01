/** Renders /ops/experiments. Pure string building over ExperimentReport models. Read-only: no forms, no actions. */

import type { ExperimentReport, GoalVerdict, VariantReport } from "./exp-report";
import type { Interval } from "./exp-analysis";
import { pageHead, renderDocument, type SectionView } from "./ops";
import { esc } from "./text";

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${(Math.abs(value) * 100).toFixed(digits)}%`;
}

const STATUS_LABEL: Record<string, string> = { draft: "Draft", running: "Running", stopped: "Stopped" };

function splitLabel(variants: VariantReport[]): string {
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (total <= 0) return variants.map(() => "0%").join(" / ");
  return variants.map((v) => `${Math.round((Math.max(0, v.weight) / total) * 100)}%`).join(" / ");
}

/** A thin ink range mark for a lift interval, centered on zero. No fill, no box: a line and two ticks. */
function rangeMark(interval: Interval | null, verdictKind: string): string {
  if (!interval) return `<div class="exp-range exp-range-empty" role="img" aria-label="Not enough data to draw an interval"></div>`;
  const span = Math.max(Math.abs(interval.low), Math.abs(interval.high), 0.01) * 1.2;
  const at = (v: number) => Math.max(0, Math.min(100, 50 + (v / span) * 50));
  const left = at(interval.low);
  const right = at(interval.high);
  const tone = verdictKind === "ahead" ? "ahead" : verdictKind === "behind" ? "behind" : "flat";
  const label = `Interval ${signedPct(interval.low)} to ${signedPct(interval.high)}`;
  return `<div class="exp-range" role="img" aria-label="${esc(label)}">
    <span class="exp-range-axis"></span>
    <span class="exp-range-zero"></span>
    <span class="exp-range-bar ${tone}" style="left:${left.toFixed(2)}%;width:${Math.max(0.6, right - left).toFixed(2)}%"></span>
  </div>`;
}

function variantRow(v: VariantReport, goals: readonly string[], isControl: boolean, href: string): string {
  const cells = goals
    .map((g) => `<td>${v.conversions[g] ?? 0}</td><td>${v.exposures > 0 ? pct(v.rate[g] ?? 0) : "—"}</td>`)
    .join("");
  return `<tr>
    <td>${esc(v.label)}${isControl ? ' <span class="dim">(control)</span>' : ""}</td>
    <td>${v.weight}</td>
    <td>${v.exposures}</td>
    ${cells}
    <td class="act"><a href="${esc(href)}" data-ops-full target="_blank" rel="noopener">Preview</a></td>
  </tr>`;
}

function goalBlock(goal: string, verdicts: GoalVerdict[]): string {
  if (!verdicts.length) return "";
  const rows = verdicts
    .map(
      (v) => `<div class="exp-verdict">
        <p class="exp-verdict-head">${esc(v.variantLabel)} vs control, <span class="dim">${esc(goal)}</span></p>
        ${rangeMark(v.diffInterval, v.verdict.kind)}
        <p class="soft">${esc(v.sentence)}${
          v.relLift !== null && v.verdict.kind !== "insufficient" ? ` Relative lift ${esc(signedPct(v.relLift))}.` : ""
        }</p>
      </div>`,
    )
    .join("");
  return rows;
}

function experimentBlock(report: ExperimentReport, delayMs: number): string {
  const def = report.def;
  const status = STATUS_LABEL[def.status] ?? def.status;
  const winner = def.winner ? ` · winner pinned: ${esc(def.winner)}` : "";
  if (!report.connected) {
    return `<section class="sec full" style="--s:${delayMs}ms">
      <div class="sec-head"><h2>${esc(def.id)}</h2><span class="soft">${esc(status)}${winner}</span></div>
      <p class="soft" style="margin-top:.6rem">${esc(def.description)}</p>
      <p class="empty">Event data is not connected on this deployment, so there is nothing to show yet.</p>
    </section>`;
  }
  const byGoal = new Map<string, GoalVerdict[]>();
  for (const v of report.verdicts) {
    const list = byGoal.get(v.goal) ?? [];
    list.push(v);
    byGoal.set(v.goal, list);
  }
  const head = def.goals
    .map((g) => `<th colspan="2">${esc(g)}</th>`)
    .join("");
  const subHead = def.goals.map(() => `<th>N</th><th>Rate</th>`).join("");
  const rows = report.variants
    .map((v, i) =>
      variantRow(v, def.goals, i === 0, `${def.path}${def.path.includes("?") ? "&" : "?"}exp=${encodeURIComponent(def.id)}:${encodeURIComponent(v.id)}`),
    )
    .join("");
  const goalsHtml = def.goals.map((g) => goalBlock(g, byGoal.get(g) ?? [])).join("");
  const srmNote = report.srm.mismatched
    ? `<p class="notice bad" role="status" style="border-top:1px solid var(--ink);padding-top:.6rem;margin-top:1rem">The observed split does not match the declared weights (chi-square ${report.srm.chiSquare.toFixed(2)}, p ${report.srm.pValue < 0.001 ? "&lt; 0.001" : report.srm.pValue.toFixed(3)}). Something upstream of assignment is probably broken.</p>`
    : "";
  return `<section class="sec full" style="--s:${delayMs}ms">
    <div class="sec-head"><h2>${esc(def.id)}</h2><span class="soft">${esc(status)}${winner}</span></div>
    <p class="soft" style="margin-top:.6rem">${esc(def.description)}</p>
    <div class="exp-ledger-wrap">
      <table class="ledger exp-ledger">
        <thead>
          <tr><th>Variant</th><th>Split</th><th>Exposed</th>${head}<th><span class="sr-only">Preview</span></th></tr>
          <tr><th></th><th></th><th></th>${subHead}<th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="ledger-note">Split declared ${esc(splitLabel(report.variants))}.</p>
    ${goalsHtml}
    ${srmNote}
  </section>`;
}

/** The experiments overview as a section body. */
export function experimentsSection(reports: readonly ExperimentReport[]): SectionView {
  const head = pageHead({ title: "Experiments" });
  const blocks = reports.map((r, i) => experimentBlock(r, i * 60)).join("");
  const empty = reports.length
    ? ""
    : `<p class="empty">Nothing is registered yet. Experiments are declared in src/experiments.ts.</p>`;
  return {
    section: "experiments",
    title: "Experiments",
    html: `${head}
    <p class="lede">Assignment, variants, and winners are set in code and shipped by deploy. This page reads the ledger; it does not change anything.</p>
    <div class="cols" style="grid-template-columns:1fr">
      ${blocks}
    </div>
    ${empty}`,
  };
}

export function renderExperiments(opts: { reports: ExperimentReport[]; csrf: string; nonce: string; who?: string }): string {
  return renderDocument(experimentsSection(opts.reports), { csrf: opts.csrf, who: opts.who, nonce: opts.nonce });
}
