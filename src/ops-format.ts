/**
 * Formatting for /ops/yield and /ops/functions (otto/mamoru-astro#20). Kept out of metrics-math.ts on
 * purpose: these rules (capital at 2 decimals, fee/gas amounts at 4 significant digits below $1, APR,
 * the "18 Oct 09:02 UTC" / "3 min ago" clocks) are specific to the yield figures these two pages show and
 * are not meant to replace metrics-math's existing fmtUsd (whole-dollar headline figures) anywhere else.
 */

import { fmtUsd } from "./metrics-math";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Capital/position-size figures: always 2 decimals under $10,000, compact K/M at and above it: "$12.9K". */
export function fmtCapitalUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Yield/fee/gas figures: at or above $1, the same shape as metrics-math's fmtUsd (2 decimals under $1,000,
 * whole dollars to $10,000, compact K/M past that). Below $1, 4 significant digits with no trailing zero,
 * so a fee of seven hundredths of a cent still reads as a real number instead of rounding to "$0.00":
 * $0.0712, $0.00009999.
 */
export function fmtMoneyUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 1) return fmtUsd(value);
  const sign = value < 0 ? "-" : "";
  const decimals = Math.max(0, 4 - Math.floor(Math.log10(abs)) - 1);
  const digits = abs.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}$${digits}`;
}

/** "12.3%", one decimal. `value` is already a percentage (12.34, not 0.1234). */
export function fmtApr(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

/**
 * A raw ETH (or other native gas token) amount, for when there is no USD price to show it with instead
 * (otto/mamoru-astro#20 code review, PR #10: a recorded gas figure with no price yet must still be visible,
 * never silently dropped to "$0"). Six decimals, trailing zeros trimmed: "0.000412 ETH", "0 ETH" for a
 * genuine zero.
 */
export function fmtEth(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0 ETH";
  const sign = value < 0 ? "-" : "";
  const trimmed = Math.abs(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}${trimmed === "" ? "0" : trimmed} ETH`;
}

/** The account key as every other /ops table shows it: full below 10 characters, else the first 8 and an ellipsis. */
export function fmtAccountKey(key: string): string {
  return key.length <= 10 ? key : `${key.slice(0, 8)}…`;
}

/** "18 Oct 09:02 UTC": day (no leading zero), short month, hour:minute, always UTC. */
export function fmtDateUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "3 min ago", "2 h ago", "5 d ago". Under a minute reads as "just now"; never negative (a clock skew floors at 0). */
export function fmtRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
