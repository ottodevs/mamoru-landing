/**
 * POST /api/exp/event: the client-side goal beacon (open_app_click, deck_click,
 * and any future click-style goal), plus the server-side waitlist_submit hook
 * called from handleNotify() on a genuinely new signup — never from client input.
 *
 * The beacon is validated against the registry (experiment exists, event is one
 * of its declared goals, variant is one of its variants), and the reported
 * variant must match what this visitor is actually assigned, so a client can
 * never spoof a win for a bucket it was not placed in. A per-visitor nonce
 * derived from (visitorId, day) — no server-side session, nothing stored —
 * ties the beacon to a page this Worker actually rendered for that visitor
 * today. Same-origin only, rate-limited per visitor, and it always answers
 * 204: a beacon's response body is never read, so there is nothing to leak by
 * answering the same way to a forged request as to a real one.
 */

import type { D1Db } from "./d1-infra";
import { assignVariant, EXPERIMENTS, experimentById, isRunning } from "./experiments";
import { recordExpEvent } from "./exp-store";
import { eligibleForExperiments, readVisitorId } from "./exp-visitor";
import type { WaitlistKv } from "./list";
import { bumpedLimit } from "./list";
import { utcDay } from "./metrics-math";
import { hmacB64Url, sameSecret } from "./text";

export interface ExpEventEnv {
  MAMORU_DB?: D1Db;
  WAITLIST?: WaitlistKv;
  OPS_SESSION_SECRET?: string;
}

export interface Background {
  waitUntil(work: Promise<unknown>): void;
}

const RATE_LIMIT_PER_HOUR = 60;

/** Derived, not stored: ties a beacon to "this visitor, today" without any server-side session or secret of its own. */
export async function expNonce(secret: string | undefined, visitorId: string, day: string): Promise<string> {
  if (!secret) return "";
  return (await hmacB64Url(secret, `exp:${visitorId}:${day}`)).slice(0, 22);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
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
  const visitorId = readVisitorId(request);
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
  if (!def || !def.goals.includes(event)) return noContent();
  if (!def.variants.some((v) => v.id === variant)) return noContent();
  // Not running (draft, stopped, or past endedAt): no work, regardless of what the client claims.
  if (!isRunning(def)) return noContent();
  // The reported variant must be what this visitor is actually assigned: no spoofing another bucket's result.
  if (assignVariant(def, visitorId) !== variant) return noContent();

  const day = utcDay(new Date());
  if (env.OPS_SESSION_SECRET) {
    const expected = await expNonce(env.OPS_SESSION_SECRET, visitorId, day);
    if (!expected || !(await sameSecret(nonce, expected))) return noContent();
  }

  if (env.WAITLIST && (await bumpedLimit(env.WAITLIST, "exp-evt", visitorId, RATE_LIMIT_PER_HOUR))) return noContent();

  if (env.MAMORU_DB) {
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
  }
  return noContent();
}

/**
 * The waitlist_submit goal, hooked server-side into a genuinely new /api/notify
 * save — never reachable from client input, so it cannot be spoofed the way a
 * beacon could be. A no-op for any visitor excluded from tracking, and for any
 * experiment that is not running or does not declare this goal.
 */
export function recordWaitlistSubmit(request: Request, env: ExpEventEnv, ctx?: Background): void {
  if (!env.MAMORU_DB || !eligibleForExperiments(request)) return;
  const visitorId = readVisitorId(request);
  if (!visitorId) return;
  const day = utcDay(new Date());
  const at = new Date().toISOString();
  for (const def of EXPERIMENTS) {
    if (!isRunning(def) || !def.goals.includes("waitlist_submit")) continue;
    const variant = assignVariant(def, visitorId);
    const write = recordExpEvent(env.MAMORU_DB, {
      experiment: def.id,
      variant,
      visitor: visitorId,
      event: "waitlist_submit",
      day,
      at,
    });
    if (ctx) ctx.waitUntil(write);
  }
}
