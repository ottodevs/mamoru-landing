/** Pure math for the /ops overview: days, deltas, funnel, growth, scales. No I/O. */

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, delta: number): string {
  return utcDay(new Date(dayToMs(day) + delta * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS);
}

/** Every day from `from` to `to`, inclusive. Empty when the range is backwards or invalid. */
export function dayRange(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (!Number.isFinite(span) || span < 0) return [];
  return Array.from({ length: span + 1 }, (_, i) => addDays(from, i));
}

/** "26 Sep". */
export function shortDay(day: string): string {
  const ms = dayToMs(day);
  if (!Number.isFinite(ms)) return day;
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** $52.18 under a thousand, $1,284 above it, $12.9K and $4.2M past that. */
export function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export interface Delta {
  abs: number;
  /** null when the past value was zero: a percentage of nothing says nothing. */
  pct: number | null;
  dir: "up" | "down" | "flat";
}

/** Change from `past` to `current`. null when there is no past to compare with. */
export function delta(current: number, past: number | null | undefined): Delta | null {
  if (past === null || past === undefined || !Number.isFinite(past) || !Number.isFinite(current)) return null;
  const abs = current - past;
  const dir = Math.abs(abs) < 1e-9 ? "flat" : abs > 0 ? "up" : "down";
  return { abs, pct: past === 0 ? null : (abs / past) * 100, dir };
}

export interface FunnelStep {
  id: string;
  label: string;
  count: number;
  /** Share of the first step, 0..1. Drives the bar length. */
  share: number;
  /** Conversion from the step above, 0..100. null on the first step or when the step above is empty. */
  rate: number | null;
}

/** Steps keep their order; counts are clamped at zero and never NaN. */
export function funnel(steps: readonly { id: string; label: string; count: number }[]): FunnelStep[] {
  const clean = steps.map((s) => ({ ...s, count: Number.isFinite(s.count) && s.count > 0 ? s.count : 0 }));
  const top = clean[0]?.count ?? 0;
  return clean.map((step, i) => {
    const prev = i > 0 ? clean[i - 1].count : 0;
    return {
      ...step,
      share: top > 0 ? Math.min(1, step.count / top) : 0,
      rate: i === 0 || prev <= 0 ? null : (step.count / prev) * 100,
    };
  });
}

export interface DayCount {
  day: string;
  n: number;
}

export interface GrowthPoint {
  day: string;
  users: number;
  accounts: number;
}

/** Running totals for every day from the first signup through `today`. */
export function cumulativeGrowth(
  users: readonly DayCount[],
  accounts: readonly DayCount[],
  today: string,
): GrowthPoint[] {
  const days = [...users, ...accounts].map((d) => d.day).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const first = days[0];
  if (!first || first > today) return [];
  const u = new Map(users.map((d) => [d.day, d.n]));
  const a = new Map(accounts.map((d) => [d.day, d.n]));
  let totalUsers = 0;
  let totalAccounts = 0;
  return dayRange(first, today).map((day) => {
    totalUsers += u.get(day) ?? 0;
    totalAccounts += a.get(day) ?? 0;
    return { day, users: totalUsers, accounts: totalAccounts };
  });
}

/** The newest point on or before `day`. */
export function atOrBefore<T extends { day: string }>(points: readonly T[], day: string): T | null {
  let hit: T | null = null;
  for (const point of points) {
    if (point.day <= day && (!hit || point.day > hit.day)) hit = point;
  }
  return hit;
}

export interface DauSlot {
  day: string;
  /** null = the day is before activity tracking began. */
  n: number | null;
}

/** The last `span` days ending today. Days before tracking began stay null instead of reading as zero. */
export function dauSlots(
  counts: ReadonlyMap<string, number>,
  firstTracked: string | null,
  today: string,
  span = 14,
): DauSlot[] {
  return dayRange(addDays(today, -(span - 1)), today).map((day) => ({
    day,
    n: firstTracked && day >= firstTracked ? (counts.get(day) ?? 0) : null,
  }));
}

/** Mean over the tracked days among the last `span` slots. */
export function dauAverage(slots: readonly DauSlot[], span = 7): { avg: number; days: number } | null {
  const tracked = slots.slice(-span).filter((s): s is { day: string; n: number } => s.n !== null);
  if (!tracked.length) return null;
  return { avg: tracked.reduce((sum, s) => sum + s.n, 0) / tracked.length, days: tracked.length };
}

/** A round axis ceiling at or above `value`: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const unit = value / pow;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return step * pow;
}

/** Whole-number ceiling for counts whose midpoint is whole too: no tick lands on half a person. */
export function niceCeilInt(value: number): number {
  if (!Number.isFinite(value) || value <= 2) return 2;
  const pow = 10 ** Math.floor(Math.log10(value));
  const unit = value / pow;
  const step = [1, 2, 4, 6, 8, 10].find((s) => unit <= s) ?? 10;
  return Math.max(2, step * pow);
}
