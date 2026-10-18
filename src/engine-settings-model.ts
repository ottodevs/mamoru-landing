/**
 * Spec 006 (otto/mamoru#147): engine settings as /ops edits them. A copy of the model and bounds in ottodevs/mamoru
 * `packages/policy/src/engine-settings.ts`, kept here because this repo does not share packages with it. This copy
 * only drives the form and refuses obvious mistakes before a row is written; the operator validates every version
 * again against the code there and refuses anything out of bounds, so a drift here can never put an out-of-bounds
 * setting into effect. Keep the two in step; test/engine-settings.test.ts pins the values.
 */

export type EngineSettings = {
  depth: { impactBps: number; shareBps: number; stablesImpactBps?: number } | null;
  capUsdc: number | null;
  guard: { enabled: boolean; btc: { fallBps: number; volBps: number }; eth: { fallBps: number; volBps: number } };
};

export const DEFAULT_CAP_USDC = 100;

export const BOUNDS = {
  impactBps: { min: 1, max: 500 },
  shareBps: { min: 1, max: 5000 },
  stablesImpactBps: { min: 1, max: 500 },
  capUsdc: { min: 1, max: 1_000_000 },
  fallBps: { min: 100, max: 3000 },
  volBps: { min: 1000, max: 50_000 },
} as const;

export const DEFAULT_SETTINGS: EngineSettings = {
  depth: null,
  capUsdc: null,
  guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10_000 } },
};

/**
 * The opinionated starting point when an environment has no version yet: Ot's decision of 17 Oct (otto/mamoru#127),
 * cap lifted to the bound with depth sizing 30/500/5 doing the limiting. The fall guard stays as it ran: no decision
 * turned it on. A code preset, not a D1 template, so the form has it even before any template row exists.
 */
export const RECOMMENDED_TEMPLATE = "recommended: cap 1,000,000, depth 30/500/5";
export const RECOMMENDED_SETTINGS: EngineSettings = {
  depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 },
  capUsdc: 1_000_000,
  guard: DEFAULT_SETTINGS.guard,
};

/** Basis points as the percent a person reads and types: 30 → "0.3", 500 → "5", 8000 → "80". */
export const pctOf = (bps: number): string => String(bps / 100);

/** Whole USDC grouped for reading: 1000000 → "1,000,000". */
export const usdcOf = (n: number): string => n.toLocaleString("en-US");

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

function inRange(errors: string[], field: string, v: unknown, b: { min: number; max: number }): void {
  if (!isInt(v) || v < b.min || v > b.max) errors.push(`${field} must be a whole number from ${b.min} to ${b.max}`);
}

export function validateSettings(s: EngineSettings): string[] {
  const errors: string[] = [];
  if (!s || typeof s !== "object") return ["settings must be an object"];
  if (s.depth !== null && (typeof s.depth !== "object" || Array.isArray(s.depth))) errors.push("depth must be an object or null");
  if (s.capUsdc !== null && typeof s.capUsdc !== "number") errors.push("capUsdc must be a number or null");
  if (!s.guard || typeof s.guard !== "object" || typeof s.guard.enabled !== "boolean" || !s.guard.btc || !s.guard.eth) return [...errors, "guard must have enabled, btc and eth"];
  if (s.depth) {
    inRange(errors, "depth.impactBps", s.depth.impactBps, BOUNDS.impactBps);
    inRange(errors, "depth.shareBps", s.depth.shareBps, BOUNDS.shareBps);
    if (s.depth.stablesImpactBps !== undefined) inRange(errors, "depth.stablesImpactBps", s.depth.stablesImpactBps, BOUNDS.stablesImpactBps);
  }
  if (s.capUsdc !== null) {
    inRange(errors, "capUsdc", s.capUsdc, BOUNDS.capUsdc);
    if (isInt(s.capUsdc) && s.capUsdc > DEFAULT_CAP_USDC && !s.depth) errors.push(`capUsdc above ${DEFAULT_CAP_USDC} needs depth sizing`);
  }
  for (const side of ["btc", "eth"] as const) {
    inRange(errors, `guard.${side}.fallBps`, s.guard[side].fallBps, BOUNDS.fallBps);
    inRange(errors, `guard.${side}.volBps`, s.guard[side].volBps, BOUNDS.volBps);
  }
  return errors;
}

/** The same plain lines as the operator's riskyChanges: what the change does, for the confirm screen. */
export function riskyChanges(from: EngineSettings, to: EngineSettings): string[] {
  const out: string[] = [];
  const cap = (s: EngineSettings) => s.capUsdc ?? DEFAULT_CAP_USDC;
  if (cap(to) > cap(from)) out.push(`cap per account rises from ${cap(from)} to ${cap(to)} USDC`);
  if (from.guard.enabled && !to.guard.enabled) out.push("the fall guard turns off");
  if (to.guard.enabled) {
    for (const side of ["btc", "eth"] as const) {
      if (to.guard[side].fallBps > from.guard[side].fallBps) out.push(`the ${side} guard needs a bigger fall before it pauses entries`);
      if (to.guard[side].volBps > from.guard[side].volBps) out.push(`the ${side} guard needs more volatility before it pauses entries`);
    }
  }
  if (from.depth && !to.depth) out.push("depth sizing turns off");
  if (from.depth && to.depth) {
    if (to.depth.impactBps > from.depth.impactBps) out.push("entries may move the pool price more");
    if (to.depth.shareBps > from.depth.shareBps) out.push("entries may take a bigger share of a pool");
    // Without its own value the stables pool uses the general impact limit: compare what each side really allows.
    if ((to.depth.stablesImpactBps ?? to.depth.impactBps) > (from.depth.stablesImpactBps ?? from.depth.impactBps)) out.push("stables entries may move the pool price more");
  }
  return out;
}

export function canonicalJson(s: EngineSettings): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
      : v;
  return JSON.stringify(sort(s));
}

export async function settingsHash(s: EngineSettings): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(s)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads whole USDC from a form field, grouped or not ("1000000", "1,000,000", "1 000 000", "1.000.000"); blank is
 * null. A decimal or anything else is NaN (refused by validate).
 */
function usdc(form: FormData, name: string): number | null {
  let raw = String(form.get(name) ?? "").trim().replace(/[\s,_']/g, "");
  if (raw === "") return null;
  if (/^[0-9]{1,3}(\.[0-9]{3})+$/.test(raw)) raw = raw.replace(/\./g, "");
  return /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * Reads a percent and returns basis points: "0.3" → 30, "0,05 %" → 5. Blank is null. More than two decimals (finer
 * than one basis point) or anything that is not a number is NaN (refused by validate).
 */
function pct(form: FormData, name: string): number | null {
  const raw = String(form.get(name) ?? "").trim().replace(/\s*%$/, "").replace(",", ".");
  if (raw === "") return null;
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(raw)) return Number.NaN;
  const [whole, frac = ""] = raw.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** The settings a submitted form describes. Field names match ops-settings.ts; percents arrive in `*_pct` fields. */
export function settingsFromForm(form: FormData): EngineSettings {
  const depthOn = form.get("depth_on") === "1";
  const stables = pct(form, "depth_stables_pct");
  return {
    depth: depthOn
      ? { impactBps: pct(form, "depth_impact_pct") ?? Number.NaN, shareBps: pct(form, "depth_share_pct") ?? Number.NaN, ...(stables === null ? {} : { stablesImpactBps: stables }) }
      : null,
    capUsdc: usdc(form, "cap"),
    guard: {
      enabled: form.get("guard_on") === "1",
      btc: { fallBps: pct(form, "btc_fall_pct") ?? Number.NaN, volBps: pct(form, "btc_vol_pct") ?? Number.NaN },
      eth: { fallBps: pct(form, "eth_fall_pct") ?? Number.NaN, volBps: pct(form, "eth_vol_pct") ?? Number.NaN },
    },
  };
}

/** Parses a stored settings_json; null when the row is unreadable. */
export function parseStored(json: string): EngineSettings | null {
  try {
    const s = JSON.parse(json) as EngineSettings;
    if (!s || typeof s !== "object" || !s.guard) return null;
    return validateSettings(s).length ? null : s;
  } catch {
    return null;
  }
}
