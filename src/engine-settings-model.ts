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
  /** otto/mamoru#195: the smallest entry also covers this many times its swap and mint gas. Absent = off. */
  minEntry?: { gasMultiple: number };
  /**
   * otto/mamoru#218: how the engine re-ranges (mode and lazy parameters stay the operator's business here: /ops edits
   * only `maxPerWeek`, at most this many re-ranges per pool in 7 days; absent = no cap). Otherwise carried as it runs.
   */
  rerange?: { mode: string; maxPerWeek?: number; [k: string]: unknown };
  /** Move to Base for USDC found on Ethereum (#133). No field: carried as it runs. */
  bridgeOut?: { enabled: boolean };
  /**
   * otto/mamoru#245: minutes a CCTP burn to Monad may stay 'sending' or 'burned' before the operator flags it stuck and
   * pages ops once. A flag only. Absent = the operator's defaults (DEFAULT_BRIDGE_STUCK_AFTER_MIN). /ops edits it
   * through a field (otto/mamoru-astro#48); a version never gains or loses the key unless that field was edited.
   */
  bridge?: { stuckAfterMin: BridgeStuckAfterMin };
};

/** otto/mamoru#245: per journal state, minutes until a burn to Monad is flagged stuck. */
export type BridgeStuckAfterMin = { sending: number; burned: number };

/** The deadlines the operator runs when the setting is absent (DEFAULT_BRIDGE_STUCK_AFTER_MIN in packages/policy). */
export const DEFAULT_BRIDGE_STUCK_AFTER_MIN: BridgeStuckAfterMin = { sending: 30, burned: 45 };

export const DEFAULT_CAP_USDC = 100;

export const BOUNDS = {
  impactBps: { min: 1, max: 500 },
  shareBps: { min: 1, max: 5000 },
  stablesImpactBps: { min: 1, max: 500 },
  capUsdc: { min: 1, max: 1_000_000 },
  fallBps: { min: 100, max: 3000 },
  volBps: { min: 1000, max: 50_000 },
  gasMultiple: { min: 1, max: 50 },
  // otto/mamoru#172/#218 and the live wait rule: the re-range setting /ops carries as it runs, checked as the operator does.
  edgeBufferTicks: { min: 0, max: 1000 },
  minDwellSeconds: { min: 0, max: 86_400 },
  horizonSeconds: { min: 3_600, max: 604_800 },
  lvrWeightBps: { min: 0, max: 20_000 },
  maxPerWeek: { min: 1, max: 50 },
  edgeBufferBps: { min: 0, max: 10_000 },
  maxWaitSeconds: { min: 1_800, max: 604_800 },
  // otto/mamoru#245: minutes before a burn to Monad is flagged stuck, per state.
  stuckAfterMin: { min: 20, max: 1440 },
} as const;

const LAZY_KEYS = ["edgeBufferTicks", "minDwellSeconds", "horizonSeconds", "lvrWeightBps"] as const;
const LAZY_OPTIONAL = ["edgeBufferBps", "maxWaitSeconds"] as const;

/** otto/mamoru#101 D13: the Packaging rule, at most 2 rebalances a week per pool. What the form proposes when it is off. */
export const RECOMMENDED_MAX_PER_WEEK = 2;

export const DEFAULT_SETTINGS: EngineSettings = {
  depth: null,
  capUsdc: null,
  guard: { enabled: false, btc: { fallBps: 700, volBps: 8000 }, eth: { fallBps: 900, volBps: 10_000 } },
};

/**
 * What the form proposes when a field has no better reference: the set Ot approved on 20 Oct (versions v1 beta, v2
 * prod): cap 1,000 with depth sizing 30/500/5, the fall guard as it ran, and the smallest entry at 5 times its gas
 * (the proposal of otto/mamoru#195). The cap stays at 1,000 until otto/mamoru#184 lets depth see every account.
 */
export const RECOMMENDED_SETTINGS: EngineSettings = {
  depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 },
  capUsdc: 1000,
  guard: DEFAULT_SETTINGS.guard,
  minEntry: { gasMultiple: 5 },
};

/** Basis points as the percent a person reads and types: 30 → "0.3", 500 → "5", 8000 → "80". */
export const pctOf = (bps: number): string => String(bps / 100);

/** Whole USDC grouped for reading: 1000000 → "1,000,000". */
export const usdcOf = (n: number): string => n.toLocaleString("en-US");

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

function inRange(errors: string[], field: string, v: unknown, b: { min: number; max: number }): void {
  if (!isInt(v) || v < b.min || v > b.max) errors.push(`${field} must be a whole number from ${b.min} to ${b.max}`);
}

/**
 * The deadlines in force under these settings, as the operator reads them: per field, a value that is not a whole
 * number within the bounds is that field's default.
 */
export function bridgeStuckAfterOf(s: EngineSettings): BridgeStuckAfterMin {
  const m = s.bridge?.stuckAfterMin as Record<string, unknown> | undefined;
  const { min, max } = BOUNDS.stuckAfterMin;
  const pick = (k: keyof BridgeStuckAfterMin): number => {
    const v = m && typeof m === "object" ? m[k] : undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : DEFAULT_BRIDGE_STUCK_AFTER_MIN[k];
  };
  return { sending: pick("sending"), burned: pick("burned") };
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
  if (s.minEntry !== undefined) {
    if (!s.minEntry || typeof s.minEntry !== "object") errors.push("minEntry must be { gasMultiple }");
    else inRange(errors, "minEntry.gasMultiple", s.minEntry.gasMultiple, BOUNDS.gasMultiple);
  }
  // The same checks as the operator's validateEngineSettings, so /ops never writes a re-range it would refuse.
  if (s.rerange !== undefined) {
    if (!s.rerange || typeof s.rerange !== "object" || Array.isArray(s.rerange)) errors.push("rerange must be an object");
    else {
      const r = s.rerange as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!["mode", "maxPerWeek", "costTest", ...LAZY_KEYS, ...LAZY_OPTIONAL].includes(k)) errors.push(`unknown rerange setting ${k}`);
      if (r.mode !== "eager" && r.mode !== "lazy") errors.push("rerange.mode must be 'eager' or 'lazy'");
      for (const k of LAZY_KEYS) if (r.mode === "lazy" || r[k] !== undefined) inRange(errors, `rerange.${k}`, r[k], BOUNDS[k]);
      if (r.maxPerWeek !== undefined) inRange(errors, "rerange.maxPerWeek", r.maxPerWeek, BOUNDS.maxPerWeek);
      for (const k of LAZY_OPTIONAL) if (r[k] !== undefined) inRange(errors, `rerange.${k}`, r[k], BOUNDS[k]);
      if (r.costTest !== undefined && r.costTest !== "veto" && r.costTest !== "off") errors.push("rerange.costTest must be 'veto' or 'off'");
      if (isInt(r.maxWaitSeconds) && isInt(r.minDwellSeconds) && r.maxWaitSeconds < r.minDwellSeconds) errors.push("rerange.maxWaitSeconds must be at least rerange.minDwellSeconds");
    }
  }
  if (s.bridgeOut !== undefined) {
    const b = s.bridgeOut as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "enabled") || typeof b.enabled !== "boolean") errors.push("bridgeOut must be { enabled: true | false }");
  }
  // The same checks as the operator: a version that already holds `bridge` passes, unknown keys inside it do not.
  if (s.bridge !== undefined) {
    const b = s.bridge as Record<string, unknown> | null;
    const m = b && typeof b === "object" && !Array.isArray(b) ? (b.stuckAfterMin as Record<string, unknown> | null) : null;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "stuckAfterMin") || !m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).some((k) => k !== "sending" && k !== "burned"))
      errors.push("bridge must be { stuckAfterMin: { sending, burned } }");
    else {
      inRange(errors, "bridge.stuckAfterMin.sending", m.sending, BOUNDS.stuckAfterMin);
      inRange(errors, "bridge.stuckAfterMin.burned", m.burned, BOUNDS.stuckAfterMin);
    }
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
  if (from.minEntry && (!to.minEntry || to.minEntry.gasMultiple < from.minEntry.gasMultiple)) out.push("smaller entries go through, where gas is a larger share of what they place");
  // As the operator: a higher cap, or none, lets more re-ranges through. `to` is the set as it will be written
  // (the worker fills what the form does not carry before it asks).
  const cf = from.rerange?.maxPerWeek;
  const ct = to.rerange?.maxPerWeek;
  if (cf !== undefined && (ct === undefined || ct > cf)) out.push("more re-ranges per week are allowed");
  // otto/mamoru#245: a later deadline pages ops later about a stuck bridge (absent counts as the defaults).
  const sf = bridgeStuckAfterOf(from);
  const st = bridgeStuckAfterOf(to);
  if (st.sending > sf.sending || st.burned > sf.burned) out.push("a stuck bridge to Monad is flagged and paged later");
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

/**
 * Reads whole USDC, plain or grouped in threes with one separator ("1000000", "1,000,000", "1 000 000",
 * "1.000.000"); blank is null. A decimal, a mixed or misplaced separator ("1,00,000", "1,000.000") or anything else
 * is NaN (refused by validate): a typo in the cap is never read as some other cap.
 */
function usdc(form: FormData, name: string): number | null {
  const raw = String(form.get(name) ?? "").trim();
  if (raw === "") return null;
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  return /^[0-9]{1,3}(?:([,. '_])[0-9]{3})(?:\1[0-9]{3})*$/.test(raw) ? Number(raw.replace(/[^0-9]/g, "")) : Number.NaN;
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

/**
 * The settings a submitted form describes. Field names match ops-settings.ts. Percents arrive in `*_pct` fields, so
 * a page rendered before they existed sends names this reads as blank, which validate refuses: an old page can never
 * write basis points read as percent.
 */
export function settingsFromForm(form: FormData): EngineSettings {
  return { ...fieldsFromForm(form), ...carriedFromForm(form) };
}

function fieldsFromForm(form: FormData): EngineSettings {
  const depthOn = form.get("depth_on") === "1";
  const stables = pct(form, "depth_stables_pct");
  // Off is its own switch, so a multiple typed while it is off is not applied.
  const gas = form.get("min_entry_on") === "1" ? (int(form, "min_entry_gas") ?? Number.NaN) : null;
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
    // Off is left out of the JSON so the stored set (and its hash) stays as before #195.
    ...(gas === null ? {} : { minEntry: { gasMultiple: gas } }),
  };
}

/**
 * otto/mamoru#218: the weekly re-range cap the form asks for. `undefined` when the page has no such field (rendered
 * before it existed): then nothing about re-ranging changes. `null` is off; a typo is NaN (refused by validate).
 */
/**
 * The settings /ops has no full field for (rerange, bridgeOut), as the confirm screen carries them: exactly the set
 * that was checked, so confirming never merges anything again. Empty or absent: none carried. Unreadable JSON gives a
 * re-range that validate refuses.
 */
export function carriedFromForm(form: FormData): Pick<EngineSettings, "rerange" | "bridgeOut" | "bridge"> {
  const raw = String(form.get("kept_json") ?? "").trim();
  if (form.get("kept_carried") !== "1" || raw === "") return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "rerange" && k !== "bridgeOut" && k !== "bridge")) return { rerange: { mode: "" } };
    return o as Pick<EngineSettings, "rerange" | "bridgeOut" | "bridge">;
  } catch {
    return { rerange: { mode: "" } };
  }
}

export function maxPerWeekFromForm(form: FormData): number | null | undefined {
  // The confirm screen carries the whole re-range as checked (kept_json): nothing to merge into it again.
  if (form.get("rerange_field") !== "1" || form.get("kept_carried") === "1") return undefined;
  return form.get("rerange_cap_on") === "1" ? (int(form, "rerange_max_week") ?? Number.NaN) : null;
}

/**
 * Puts the weekly cap into what the accounts run now (`base`, see keptFrom): the mode and lazy parameters stay as they
 * are; with no re-range setting running, the cap goes on the eager default. Off removes only the cap.
 */
export function withMaxPerWeek(s: EngineSettings, cap: number | null | undefined, base: EngineSettings["rerange"]): EngineSettings {
  if (cap === undefined) return s;
  const { maxPerWeek: _, ...kept } = base ?? { mode: "eager" };
  if (cap === null) return base ? { ...s, rerange: kept as EngineSettings["rerange"] & object } : s;
  return { ...s, rerange: { ...kept, maxPerWeek: cap } as EngineSettings["rerange"] & object };
}

/**
 * otto/mamoru-astro#48: the bridge deadlines the form asks for, `{ sending, burned }` in minutes (null = blank, NaN =
 * a typo, refused by validate). `undefined` when nothing is to change: the page has no such group (rendered before it
 * existed), the confirm screen carries the set as checked, or the fields still hold exactly what ran when the page was
 * rendered (`bridge_init`): then `bridge` is carried as it runs, absent included, and a page left open can never
 * overwrite a deadline someone set meanwhile.
 */
export function bridgeFromForm(form: FormData): { sending: number | null; burned: number | null } | undefined {
  if (form.get("bridge_field") !== "1" || form.get("kept_carried") === "1") return undefined;
  const sending = String(form.get("bridge_sending") ?? "").trim();
  const burned = String(form.get("bridge_burned") ?? "").trim();
  if (form.get("bridge_init") !== null && `${sending},${burned}` === String(form.get("bridge_init"))) return undefined;
  return { sending: int(form, "bridge_sending"), burned: int(form, "bridge_burned") };
}

/**
 * Puts the deadlines the form asked for into the set. Both blank leaves `bridge` absent when nothing runs it (never
 * invented); when something does run it, blank means the default, written as the default (a form cannot express
 * removing a key; a rollback to a version without it does). One blank field takes the default: the operator needs both.
 */
export function withBridge(s: EngineSettings, input: ReturnType<typeof bridgeFromForm>, base: EngineSettings | null): EngineSettings {
  if (input === undefined) return s;
  if (input.sending === null && input.burned === null && base?.bridge === undefined) return s;
  const d = DEFAULT_BRIDGE_STUCK_AFTER_MIN;
  return { ...s, bridge: { stuckAfterMin: { sending: input.sending ?? d.sending, burned: input.burned ?? d.burned } } };
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
