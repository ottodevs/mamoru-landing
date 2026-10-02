/**
 * POST /api/exp/event: the client-side goal beacon (open_app_click, deck_click,
 * and any future click-style goal), plus the server-side waitlist_submit hook
 * called from handleNotify() on a genuinely new signup — never from client input.
 *
 * The beacon is validated against the registry (experiment exists, event is
 * one of its declared goals AND is marked "client"-sourced there — a
 * "server"-sourced goal like waitlist_submit is refused outright, no matter
 * what the client claims), and the visitor id itself must be the signed
 * cookie this Worker issued (see exp-visitor.ts): an invalid or unsigned id
 * is treated as no id at all, so there is nothing to record against. Beyond
 * that, an event only ever counts for a (experiment, visitor, variant) this
 * Worker already has an exposure row for — proof the variant was actually
 * served, not a recomputation that could disagree with it after a redeploy
 * changes weights or pins a winner. A per-visitor nonce derived from
 * (visitorId, day) ties the beacon to a page rendered today. Same-origin
 * only (both Origin and Sec-Fetch-Site absent is refused, not waved
 * through), rate-limited per visitor, and it always answers 204: a beacon's
 * response body is never read, so there is nothing to leak by answering the
 * same way to a forged request as to a real one.
 */

import type { D1Db } from "./d1-infra";
import { assignVariant, EXPERIMENTS, experimentById, goalByName, isRunning } from "./experiments";
import { hasExposure, recordExpEvent } from "./exp-store";
import { eligibleForExperiments, readVisitorId } from "./exp-visitor";
import type { WaitlistKv } from "./list";
import { bumpedLimit } from "./list";
import { utcDay } from "./metrics-math";
import { hmacB64Url, sameSecret } from "./text";

export interface ExpEventEnv {
  MAMORU_DB?: D1Db;
  WAITLIST?: WaitlistKv;
  /** Signs the visitor cookie and derives the beacon nonce. Without it, every visitor reads as unidentified. */
  EXP_VISITOR_SECRET?: string;
}

export interface Background {
  waitUntil(work: Promise<unknown>): void;
}

const RATE_LIMIT_PER_HOUR = 60;

/** Derived, not stored: ties a beacon to "this visitor, today" without any server-side session of its own. */
export async function expNonce(secret: string | undefined, visitorId: string, day: string): Promise<string> {
  if (!secret) return "";
  return (await hmacB64Url(secret, `exp:${visitorId}:${day}`)).slice(0, 22);
}

/** Origin must equal this site, or Sec-Fetch-Site must say so. Both headers absent is refused, not waved through. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  // "none" means a user-initiated top-level navigation (typed URL, bookmark) — never how a fetch/sendBeacon
  // POST from our own page's script arrives, so it is not accepted as a stand-in for same-origin here.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return false;
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

interface EventBody {
  experiment?: unknown;
  variant?: unknown;
  event?: unknown;
  nonce?: unknown;
}

/**
 * Always a 204, whether the event was recorded or quietly dropped — a
 * sendBeacon caller never reads the response, and a uniform answer gives a
 * forging client nothing to learn from.
 */
export async function handleExpEvent(request: Request, env: ExpEventEnv, ctx?: Background): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { "cache-control": "no-store" } });
  if (!sameOrigin(request)) return noContent();
  if (!eligibleForExperiments(request)) return noContent();
  const visitorId = await readVisitorId(request, env.EXP_VISITOR_SECRET);
  if (!visitorId) return noContent();

  let body: EventBody;
  try {
    body = JSON.parse(await request.text()) as EventBody;
  } catch {
    return noContent();
  }
  const experiment = typeof body.experiment === "string" ? body.experiment : "";
  const variant = typeof body.variant === "string" ? body.variant : "";
  const event = typeof body.event === "string" ? body.event : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";

  const def = experimentById(experiment);
  if (!def) return noContent();
  const goal = goalByName(def, event);
  // A goal not declared, or declared but server-only (e.g. waitlist_submit): the beacon never gets to record it.
  if (!goal || goal.source !== "client") return noContent();
  if (!def.variants.some((v) => v.id === variant)) return noContent();
  // Not running (draft, stopped, or past endedAt): no work, regardless of what the client claims.
  if (!isRunning(def)) return noContent();

  const day = utcDay(new Date());
  const expected = await expNonce(env.EXP_VISITOR_SECRET, visitorId, day);
  if (!expected || !(await sameSecret(nonce, expected))) return noContent();

  if (env.WAITLIST && (await bumpedLimit(env.WAITLIST, "exp-evt", visitorId, RATE_LIMIT_PER_HOUR))) return noContent();

  // The authority: this visitor must already have a recorded exposure to exactly this variant. Recomputing
  // assignment here could disagree with what was actually shown if the registry changed since — the
  // exposure row is what the server itself wrote at serve time, so it is what the beacon is checked against.
  if (!env.MAMORU_DB || !(await hasExposure(env.MAMORU_DB, experiment, visitorId, variant))) return noContent();

  const write = recordExpEvent(env.MAMORU_DB, {
    experiment,
    variant,
    visitor: visitorId,
    event,
    day,
    at: new Date().toISOString(),
  });
  if (ctx) ctx.waitUntil(write);
  else await write;
  return noContent();
}

/**
 * The waitlist_submit goal, hooked server-side into a genuinely new /api/notify
 * save — never reachable from client input, so it cannot be spoofed the way a
 * beacon could be. A no-op for any visitor excluded from tracking, for any
 * experiment that is not running or does not declare this goal as a server
 * goal, and — same rule as the beacon — for any experiment this visitor has
 * no recorded exposure for (never attribute a signup to an experiment they
 * were never actually shown).
 */
export function recordWaitlistSubmit(request: Request, env: ExpEventEnv, ctx?: Background): void {
  if (!env.MAMORU_DB || !eligibleForExperiments(request)) return;
  const db = env.MAMORU_DB;
  const day = utcDay(new Date());
  const at = new Date().toISOString();

  const attribute = async (): Promise<void> => {
    const visitorId = await readVisitorId(request, env.EXP_VISITOR_SECRET);
    if (!visitorId) return;
    for (const def of EXPERIMENTS) {
      const goal = goalByName(def, "waitlist_submit");
      if (!isRunning(def) || !goal || goal.source !== "server") continue;
      const variant = assignVariant(def, visitorId);
      if (!(await hasExposure(db, def.id, visitorId, variant))) continue;
      await recordExpEvent(db, { experiment: def.id, variant, visitor: visitorId, event: "waitlist_submit", day, at });
    }
  };

  if (ctx) ctx.waitUntil(attribute());
}
