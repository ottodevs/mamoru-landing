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
  /** Move to Base for USDC found on Ethereum (otto/mamoru#133). Absent = off, so versions stored before it keep their hash. */
  bridgeOut?: { enabled: boolean };
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
  if (s.bridgeOut !== undefined && (!s.bridgeOut || typeof s.bridgeOut !== "object" || typeof s.bridgeOut.enabled !== "boolean" || Object.keys(s.bridgeOut).some((k) => k !== "enabled"))) errors.push("bridgeOut must be { enabled: true | false }");
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
  if (!from.bridgeOut?.enabled && to.bridgeOut?.enabled) out.push("owners can move USDC from Ethereum to Base, and the relayer pays the Ethereum gas");
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

/** Reads a whole number from a form field; blank is null. Anything else that is not a whole number is NaN (refused by validate). */
function int(form: FormData, name: string): number | null {
  const raw = String(form.get(name) ?? "").trim();
  if (raw === "") return null;
  return /^-?[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

/** The settings a submitted form describes. Field names match ops-settings.ts. */
export function settingsFromForm(form: FormData): EngineSettings {
  const depthOn = form.get("depth_on") === "1";
  const stables = int(form, "depth_stables");
  return {
    depth: depthOn
      ? { impactBps: int(form, "depth_impact") ?? Number.NaN, shareBps: int(form, "depth_share") ?? Number.NaN, ...(stables === null ? {} : { stablesImpactBps: stables }) }
      : null,
    capUsdc: int(form, "cap"),
    guard: {
      enabled: form.get("guard_on") === "1",
      btc: { fallBps: int(form, "btc_fall") ?? Number.NaN, volBps: int(form, "btc_vol") ?? Number.NaN },
      eth: { fallBps: int(form, "eth_fall") ?? Number.NaN, volBps: int(form, "eth_vol") ?? Number.NaN },
    },
    // Off is written as no key at all: a set saved before this field existed hashes the same.
    ...(form.get("bridge_out_on") === "1" ? { bridgeOut: { enabled: true } } : {}),
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
