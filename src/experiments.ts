/**
 * A/B experiment registry. Edit here, deploy, to start, stop, or pin a winner —
 * the ops console (/ops/experiments) is read-only on purpose. Assignment is a
 * pure function of (visitorId, experimentId): same visitor, same bucket, every
 * visit, with no server-side state beyond the visitor id cookie itself.
 */

export type ExperimentStatus = "draft" | "running" | "stopped";

export interface ExperimentVariant {
  /** Short id. The first variant in `variants` is the control / baseline. */
  id: string;
  /** Relative weight. Weights need not sum to 100; they are normalized. */
  weight: number;
  /** Replacement text for the data-exp hook. Omitted for control: the page's own copy stands. */
  text?: string;
  /** Human label for the ops ledger and QA links. Defaults to `id`. */
  label?: string;
}

export interface ExperimentDef {
  id: string;
  description: string;
  status: ExperimentStatus;
  /** The surface this experiment's data-exp hook lives on (the logical page, not every alias path). */
  path: string;
  variants: readonly ExperimentVariant[];
  /** Goal event names this experiment is scored against. */
  goals: readonly string[];
  /** ISO day (YYYY-MM-DD) recorded when status first became "running". Informational only. */
  startedAt?: string;
  /** ISO day (YYYY-MM-DD). Enforced: past this day (UTC, end of day), the experiment behaves as stopped even if `status` still says "running". */
  endedAt?: string;
  /** Pins everyone to one variant id regardless of assignment, once a winner is called. */
  winner?: string;
}

export const EXPERIMENTS: readonly ExperimentDef[] = [
  {
    id: "hero_cta",
    description:
      "Hero primary call to action on the opened landing: 'Launch APP' (control) vs a plainer 'Open the app', " +
      "in response to the growth audit finding that public surfaces overclaim (forgejo:otto/mamoru#10).",
    status: "draft",
    path: "/",
    variants: [
      { id: "control", weight: 1, label: "Launch APP" },
      { id: "b", weight: 1, text: "Open the app", label: "Open the app" },
    ],
    goals: ["open_app_click"],
  },
] as const;

export function experimentById(id: string): ExperimentDef | undefined {
  return EXPERIMENTS.find((e) => e.id === id);
}

/** Experiments whose hook lives on this surface. */
export function experimentsForPath(path: string): ExperimentDef[] {
  return EXPERIMENTS.filter((e) => e.path === path);
}

/** The control (first) variant id, the fallback for any state that must be uniform across visitors. */
export function controlVariantId(def: ExperimentDef): string {
  return def.variants[0]?.id ?? "control";
}

export function variantById(def: ExperimentDef, id: string): ExperimentVariant | undefined {
  return def.variants.find((v) => v.id === id);
}

/**
 * `def.status` as written in the registry, unless `endedAt` has passed — then
 * "running" reads as "stopped" regardless of what the field still says, so a
 * forgotten end date never leaves an experiment live.
 */
export function experimentStatus(def: ExperimentDef, now: Date = new Date()): ExperimentStatus {
  if (def.status === "running" && def.endedAt) {
    const endMs = Date.parse(`${def.endedAt}T23:59:59.999Z`);
    if (Number.isFinite(endMs) && now.getTime() > endMs) return "stopped";
  }
  return def.status;
}

/** Whether this experiment is actually serving variants right now (status "running", end date not yet passed). */
export function isRunning(def: ExperimentDef, now: Date = new Date()): boolean {
  return experimentStatus(def, now) === "running";
}

/** FNV-1a, 32-bit. Deterministic across runtimes; not cryptographic, just stable and well distributed. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic float in [0, 1) derived from `input`. */
function unitFraction(input: string): number {
  return hash32(input) / 0x1_0000_0000;
}

/**
 * Which variant this visitor sees for this experiment. Stable across visits
 * for the same (visitorId, experimentId) pair, and honors each variant's weight.
 *
 * A winner pins everyone. A stopped experiment, one still in draft, or one
 * whose `endedAt` has passed, serves control to everyone — nothing changes
 * for visitors until status is "running" and the window is open.
 */
export function assignVariant(def: ExperimentDef, visitorId: string, now: Date = new Date()): string {
  if (def.winner && variantById(def, def.winner)) return def.winner;
  if (!isRunning(def, now)) return controlVariantId(def);
  const total = def.variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (total <= 0) return controlVariantId(def);
  const target = unitFraction(`${visitorId}:${def.id}`) * total;
  let acc = 0;
  for (const v of def.variants) {
    acc += Math.max(0, v.weight);
    if (target < acc) return v.id;
  }
  return def.variants[def.variants.length - 1]?.id ?? controlVariantId(def);
}

/** Whether this experiment can show different HTML to different visitors right now. Gates caching and the visitor cookie. */
export function variesPerVisitor(def: ExperimentDef, now: Date = new Date()): boolean {
  if (def.winner) return false;
  if (!isRunning(def, now)) return false;
  const active = def.variants.filter((v) => v.weight > 0);
  return active.length > 1;
}
