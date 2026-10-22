/**
 * otto/mamoru-astro#25: a cap per account (`account_cap_overrides`, ottodevs/mamoru#109 / otto/mamoru#26). A copy of
 * `validateAccountCapOverride` in ottodevs/mamoru `packages/policy/src/engine-settings.ts`, kept here because this repo
 * does not share packages with it (same reason as engine-settings-model.ts). The app Worker validates every row again
 * before it hands it to the operator and skips one it refuses, so a drift here can never put an out-of-bounds cap into
 * effect. Keep the bounds in step; test/account-caps.test.ts pins them.
 */

import { BOUNDS, DEFAULT_CAP_USDC } from "./engine-settings-model";

export { DEFAULT_CAP_USDC };

const ACCOUNT_KEY = /^[0-9A-Za-z_-]{1,128}$/;

/** The 8-character key the console and the operator's /metrics show for an account. */
export const SHORT_KEY = /^[0-9A-Za-z_-]{8}$/;

/** Every reason the override is not valid, empty when it is. Whole USDC 1..1,000,000, or null (back to the general cap). */
export function validateAccountCapOverride(o: { accountKey: unknown; capUsdc: unknown }): string[] {
  const errors: string[] = [];
  if (typeof o.accountKey !== "string" || !ACCOUNT_KEY.test(o.accountKey)) errors.push("accountKey must be 1 to 128 letters, digits, - or _");
  if (o.capUsdc !== null) {
    const v = o.capUsdc;
    const b = BOUNDS.capUsdc;
    if (typeof v !== "number" || !Number.isInteger(v) || v < b.min || v > b.max) errors.push(`capUsdc must be a whole number from ${b.min} to ${b.max}`);
  }
  return errors;
}

/**
 * The amount typed in the form, as whole USDC: digits with optional thousands separators ("2,000", "2 000"). Anything
 * else (decimals, signs, letters, empty) is null, and the route refuses it with the bounds in words.
 */
export function parseCapInput(raw: string): number | null {
  const s = raw.trim().replace(/[,\s_]/g, "");
  if (!/^[0-9]{1,9}$/.test(s)) return null;
  const n = Number(s);
  return validateAccountCapOverride({ accountKey: "x", capUsdc: n }).length ? null : n;
}

export type CapSource = "override" | "canary" | "env" | "default" | "emergency";

export const CAP_SOURCES: readonly CapSource[] = ["override", "canary", "env", "default", "emergency"];

/** Where the cap in effect comes from, in the words the console uses. */
export function capSourceWords(s: CapSource): string {
  switch (s) {
    case "override":
      return "its own cap";
    case "canary":
      return "general cap (canary)";
    case "env":
      return "general cap";
    case "default":
      return "code default";
    case "emergency":
      return "emergency override";
  }
}

/** Whole USDC with thousands separators: 2,000 USDC. */
export function usdc(n: number): string {
  return `${n.toLocaleString("en-US")} USDC`;
}
