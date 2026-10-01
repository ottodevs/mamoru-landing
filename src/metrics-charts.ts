/**
 * Chart renderers for the /ops overview. Strings only: inline SVG for lines and
 * washes, plain elements for bars, labels and dots so text never scales with the plot.
 * Plots use a 0..100 square stretched to the box; every stroke is non-scaling.
 */

import {
  type DauSlot,
  daysBetween,
  fmtInt,
  fmtUsd,
  type FunnelStep,
  niceCeil,
  niceCeilInt,
  shortDay,
} from "./metrics-math";
import { esc } from "./text";

export type Tone = "ink" | "emerald" | "stone";

export interface TimeSeries {
  label: string;
  tone: Tone;
  values: number[];
  /** Drawn dashed so it stays readable where it runs on top of another line. */
  dashed?: boolean;
}

export interface TimeChartOpts {
  id: string;
  /** Read by screen readers as the plot's name. */
  title: string;
  days: string[];
  series: TimeSeries[];
  /** Series are stacked bottom to top as washes, with an ink line tracing the total. */
  stacked?: boolean;
  totalLabel?: string;
  format: "usd" | "int";
  /** Shown inside the plot when there is nothing to draw. */
  emptyNote: string;
  /** Shown inside the plot when there is exactly one day. */
  singleNote: string;
}

interface TipPoint {
  x: number;
  y: number;
  t: string;
  l: [string, string][];
}

function r2(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function fmt(format: "usd" | "int", value: number): string {
  return format === "usd" ? fmtUsd(value) : fmtInt(value);
}

function tickLabel(format: "usd" | "int", value: number, max: number): string {
  if (format === "int") return fmtInt(value);
  if (max < 10 && value !== 0) return `$${value.toFixed(2)}`;
  if (value >= 1_000_000) return `$${r2(value / 1_000_000)}M`;
  return value >= 1000 ? `$${r2(value / 1000)}K` : `$${Math.round(value)}`;
}

function chartData(points: TipPoint[]): string {
  return esc(JSON.stringify({ p: points }));
}

function yTicks(format: "usd" | "int", max: number): string {
  return [0, 0.5, 1]
    .map((f) => `<span class="yt" style="top:${r2(100 - f * 100)}%">${esc(tickLabel(format, max * f, max))}</span>`)
    .join("");
}

function grid(): string {
  return `<svg class="layer base" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><line class="rule" x1="0" y1="0" x2="100" y2="0"/><line class="rule" x1="0" y1="50" x2="100" y2="50"/><line class="axis" x1="0" y1="100" x2="100" y2="100"/></svg>`;
}

function xTicks(days: string[], xOf: (day: string) => number): string {
  if (!days.length) return "";
  const picks = new Set<string>([days[0], days[days.length - 1]]);
  if (days.length >= 5) picks.add(days[Math.floor((days.length - 1) / 2)]);
  return [...picks]
    .map((day) => {
      const x = xOf(day);
      const edge = x <= 0.01 ? " first" : x >= 99.99 ? " last" : "";
      return `<span class="xt${edge}" style="left:${r2(x)}%">${esc(shortDay(day))}</span>`;
    })
    .join("");
}

function path(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${r2(x)},${r2(ys[i])}`).join(" ");
}

/**
 * Lines or stacked washes over days. Zero days draws an empty frame with a note,
 * one day draws that single point at today's edge, two or more draw the lines.
 */
export function renderTimeChart(opts: TimeChartOpts): string {
  const n = opts.days.length;
  const titleId = `${opts.id}-t`;
  const totals = opts.days.map((_, i) => opts.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const peak = opts.stacked
    ? Math.max(0, ...totals)
    : Math.max(0, ...opts.series.flatMap((s) => s.values.slice(0, n)));
  const max = opts.format === "int" ? niceCeilInt(peak) : niceCeil(peak);
  const span = n > 1 ? daysBetween(opts.days[0], opts.days[n - 1]) : 0;
  const xOf = (day: string) => (span > 0 ? (daysBetween(opts.days[0], day) / span) * 100 : 100);
  const yOf = (value: number) => 100 - (Math.max(0, value) / max) * 100;
  const xs = opts.days.map(xOf);
  const title = `<title id="${esc(titleId)}">${esc(opts.title)}</title>`;

  const tips: TipPoint[] = opts.days.map((day, i) => {
    const lines: [string, string][] = [];
    if (opts.stacked) lines.push([opts.totalLabel ?? "Total", fmt(opts.format, totals[i])]);
    for (const s of [...opts.series].reverse()) lines.push([s.label, fmt(opts.format, s.values[i] ?? 0)]);
    const top = opts.stacked ? totals[i] : Math.max(...opts.series.map((s) => s.values[i] ?? 0));
    return { x: Number(r2(xs[i])), y: Number(r2(yOf(top))), t: shortDay(day), l: lines };
  });

  let body = "";
  let note = "";
  if (n === 0) {
    note = `<p class="plot-note">${esc(opts.emptyNote)}</p>`;
    body = `<svg class="layer" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${esc(titleId)}">${title}</svg>`;
  } else if (n === 1) {
    // A single day: a thin standing mark at today's edge, split like the washes would be.
    note = `<p class="plot-note">${esc(opts.singleNote)}</p>`;
    let stem = "";
    if (opts.stacked) {
      let base = 0;
      for (const s of opts.series) {
        const value = Math.max(0, s.values[0] ?? 0);
        const h = (value / max) * 100;
        if (h > 0) stem += `<span class="stem s-${s.tone}" style="bottom:${r2((base / max) * 100)}%;height:${r2(h)}%"></span>`;
        base += value;
      }
      stem += `<span class="dot d-ink" style="left:100%;top:${r2(yOf(totals[0]))}%"></span>`;
    } else {
      stem = opts.series
        .map((s) => `<span class="dot d-${s.tone}" style="left:100%;top:${r2(yOf(s.values[0] ?? 0))}%"></span>`)
        .join("");
    }
    body = `<svg class="layer" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${esc(titleId)}">${title}</svg>${stem}`;
  } else {
    let wash = "";
    let ink = "";
    let over = "";
    let dots = "";
    const sparse = n <= 8;
    if (opts.stacked) {
      let lower = opts.days.map(() => 0);
      opts.series.forEach((s, si) => {
        const upper = lower.map((v, i) => v + Math.max(0, s.values[i] ?? 0));
        const top = path(xs, upper.map(yOf));
        const back = [...xs].reverse().map((x, i) => `L${r2(x)},${r2(yOf(lower[n - 1 - i]))}`).join(" ");
        wash += `<path class="area a-${s.tone}" d="${top} ${back} Z"/>`;
        if (si < opts.series.length - 1) wash += `<path class="edge" d="${top}"/>`;
        lower = upper;
      });
      const total = totals.map(yOf);
      ink = `<path class="line l-ink" d="${path(xs, total)}"/>`;
      dots = (sparse ? xs.map((_, i) => i) : [n - 1])
        .map((i) => `<span class="dot d-ink" style="left:${r2(xs[i])}%;top:${r2(total[i])}%"></span>`)
        .join("");
    } else {
      for (const s of opts.series) {
        const ys = s.values.slice(0, n).map(yOf);
        const d = path(xs, ys);
        if (s.dashed) over += `<path class="line dashed l-${s.tone}" d="${d}"/>`;
        else ink += `<path class="line l-${s.tone}" d="${d}"/>`;
        // Prepended so the first series' end dot sits on top where the ends meet.
        dots = `<span class="dot d-${s.tone}" style="left:${r2(xs[n - 1])}%;top:${r2(ys[n - 1])}%"></span>${dots}`;
      }
    }
    body = `<svg class="layer wash" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${wash}</svg><svg class="layer ink" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby="${esc(titleId)}">${title}${ink}</svg>${over ? `<svg class="layer over" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${over}</svg>` : ""}${dots}`;
  }

  return `<div class="chart" data-chart="${chartData(tips)}">
  <div class="plot${n === 1 ? " single" : ""}"${n ? ' tabindex="0"' : ""} role="group" aria-label="${esc(opts.title)}">
    ${grid()}${body}${yTicks(opts.format, max)}${xTicks(opts.days, xOf)}${note}
  </div>
</div>`;
}

/** Daily bars. null slots are days before tracking began: a resting tick, not a zero. */
export function renderBars(opts: { id: string; title: string; slots: DauSlot[]; emptyNote: string }): string {
  const tracked = opts.slots.filter((s) => s.n !== null);
  const max = niceCeilInt(Math.max(0, ...tracked.map((s) => s.n ?? 0)));
  const count = opts.slots.length || 1;
  const tips: TipPoint[] = [];
  const bars = opts.slots
    .map((slot, i) => {
      const x = ((i + 0.5) / count) * 100;
      if (slot.n === null) return `<span class="slot"><span class="bar rest"></span></span>`;
      const h = (slot.n / max) * 100;
      tips.push({ x: Number(r2(x)), y: Number(r2(100 - h)), t: shortDay(slot.day), l: [["Active", fmtInt(slot.n)]] });
      const today = i === opts.slots.length - 1 ? " today" : "";
      return `<span class="slot" data-i="${tips.length - 1}"><span class="bar${today}${slot.n === 0 ? " zero" : ""}" style="height:${r2(h)}%;--i:${i}"></span></span>`;
    })
    .join("");
  const summary = tracked.length
    ? `${opts.title}: ${tracked.map((s) => `${shortDay(s.day)} ${s.n}`).join(", ")}.`
    : `${opts.title}: ${opts.emptyNote}`;
  const note = tracked.length ? "" : `<p class="plot-note">${esc(opts.emptyNote)}</p>`;
  const days = opts.slots.map((s) => s.day);
  const ticks = days.length
    ? `<span class="xt first" style="left:0%">${esc(shortDay(days[0]))}</span><span class="xt last" style="left:100%">${esc(shortDay(days[days.length - 1]))}</span>`
    : "";
  return `<div class="chart bars" data-chart="${chartData(tips)}">
  <div class="plot${tracked.length ? "" : " idle"}"${tips.length ? ' tabindex="0"' : ""} role="group" aria-label="${esc(opts.title)}">
    ${grid()}<div class="bar-row" role="img" aria-label="${esc(summary)}">${bars}</div>${tracked.length ? yTicks("int", max) : ""}${ticks}${note}
  </div>
</div>`;
}

const POUR_MS = 1000;
const POUR_START_MS = 220;

/** Horizontal steps that fill one after another, like the allocation pour in the app. */
export function renderFunnel(steps: FunnelStep[]): string {
  let at = POUR_START_MS;
  const items = steps
    .map((step, i) => {
      const ms = Math.max(180, POUR_MS * step.share * 0.6);
      const ease = i === 0 ? "first" : i === steps.length - 1 ? "last" : "mid";
      const delay = at;
      at += ms;
      const rate =
        step.rate === null
          ? ""
          : `<span class="step-rate">${step.rate >= 10 || step.rate === 0 ? Math.round(step.rate) : step.rate.toFixed(1)}% of ${esc(steps[i - 1].label.toLowerCase())}</span>`;
      const width = step.count > 0 ? Math.max(0.6, step.share * 100) : 0;
      return `<li class="step">
        <span class="step-name">${esc(step.label)}${rate}</span>
        <span class="step-n">${fmtInt(step.count)}</span>
        <span class="step-track"><span class="step-bar pour-${ease}" style="width:${r2(width)}%;--d:${Math.round(delay)}ms;--ms:${Math.round(ms)}ms"></span></span>
      </li>`;
    })
    .join("");
  return `<ol class="funnel">${items}</ol>`;
}

/** One stroke per account the relayer can still fund, in fives. Capped so it never runs away. */
export function renderTally(count: number, cap = 50): string {
  const shown = Math.max(0, Math.min(Math.floor(count), cap));
  if (shown === 0) return "";
  let marks = "";
  for (let i = 0; i < shown; i++) {
    marks += `<span class="tick${i % 5 === 4 ? " fifth" : ""}" style="--i:${i}"></span>`;
  }
  const more = count > cap ? `<span class="tally-more">and ${fmtInt(count - cap)} more</span>` : "";
  return `<div class="tally" role="img" aria-label="${fmtInt(count)} accounts">${marks}${more}</div>`;
}
