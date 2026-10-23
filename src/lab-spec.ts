/**
 * otto/mamoru-astro#28 (spec 008 phase 1, B-01): the shape and bounds of a bench run spec, shared by the
 * screen API (validates a "Run scenario" request before it ever becomes a job) and the runner HTTP handlers
 * (validates again on claim/result/publish, since the runner is a separate process with its own copy of this
 * file in ottodevs/mamoru — this copy only needs to agree on the wire shape and the bounds, not share code).
 *
 * Nothing here touches D1 or the network: pure validation and formatting, so it is cheap to unit test and to
 * reuse from the client bundle (ops-lab-logic.ts) without pulling in Worker-only globals.
 */

export type LabBase = "live" | "guard";

export interface LabSpec {
  windowId: string;
  base: LabBase;
  widthTicks: number;
  deposit: number;
}

export const WIDTH_MIN = 500;
export const WIDTH_MAX = 8000;
export const WIDTH_STEP = 500;
export const DEPOSIT_MIN = 100;
export const DEPOSIT_MAX = 10000;

/** New reason codes from spec 008, the subset the screen/runner HTTP layer in this repo can produce. */
export const LAB_SPEC_INVALID = "LAB_SPEC_INVALID";
export const LAB_DATASET_MISSING = "LAB_DATASET_MISSING";
export const LAB_JOB_LEASE_LOST = "LAB_JOB_LEASE_LOST";

export type SpecValidation = { ok: true; spec: LabSpec } | { ok: false; error: typeof LAB_SPEC_INVALID };

const WINDOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isWidthValid(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= WIDTH_MIN && n <= WIDTH_MAX && n % WIDTH_STEP === 0;
}

function isDepositValid(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= DEPOSIT_MIN && n <= DEPOSIT_MAX;
}

/** B-01: `{windowId, base: 'live' | 'guard', widthTicks, deposit}`, bounds checked again at every boundary. */
export function validateSpec(input: unknown): SpecValidation {
  if (!input || typeof input !== "object") return { ok: false, error: LAB_SPEC_INVALID };
  const v = input as Record<string, unknown>;
  const windowId = typeof v.windowId === "string" ? v.windowId : "";
  if (!WINDOW_ID_RE.test(windowId)) return { ok: false, error: LAB_SPEC_INVALID };
  if (v.base !== "live" && v.base !== "guard") return { ok: false, error: LAB_SPEC_INVALID };
  if (!isWidthValid(v.widthTicks)) return { ok: false, error: LAB_SPEC_INVALID };
  if (!isDepositValid(v.deposit)) return { ok: false, error: LAB_SPEC_INVALID };
  return { ok: true, spec: { windowId, base: v.base, widthTicks: v.widthTicks as number, deposit: v.deposit as number } };
}

/** `${windowId}|${base}|${widthTicks}|${deposit}`: the same spec always gives the same key (B-04 dedupe, LAB-AL-09). */
export function specKey(spec: LabSpec): string {
  return `${spec.windowId}|${spec.base}|${spec.widthTicks}|${spec.deposit}`;
}

export const MAX_JOBS_PER_DAY = 20;
export const MAX_QUEUED_JOBS = 3;

/** AL-02: a claimed job's lease window and the retry budget before a stuck job is given up on. */
export const LEASE_SECONDS = 120;
export const MAX_LEASE_ATTEMPTS = 2;
