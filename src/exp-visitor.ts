/**
 * First-party visitor id and the consent/bot gate experiments run behind.
 *
 * No fingerprinting: the id is 32 random bytes, carries no device/browser
 * signal, and is never derived from IP, headers, or timing. No IP is stored
 * anywhere in this file or in exp-store.ts. No third party ever sees it.
 *
 * Sec-GPC: 1 and DNT: 1 are both honored the same way: no cookie is set, no
 * event is ever written for that request, and every experiment serves its
 * control variant. Simple bots (by User-Agent substring) get the same
 * treatment. None of this runs for /ops paths at all; the caller excludes them.
 */

import { randomToken } from "./google";

export const VISITOR_COOKIE = "__Host-mamoru_vid";
const VISITOR_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

// Common crawlers, uptime checks, and link-preview fetchers. Not exhaustive;
// a false negative just means one bot gets bucketed, which is harmless.
const BOT_UA =
  /bot|crawler|spider|slurp|crawling|bingpreview|facebookexternalhit|whatsapp|telegrambot|embedly|quora link preview|outbrain|vkshare|monitor|lighthouse|headlesschrome|phantomjs|ahrefs|semrush|mj12bot|petalbot|duckduckbot|applebot|yandex(bot)?|pingdom|uptimerobot|curl|wget|python-requests|go-http-client/i;

export function isBot(userAgent: string | null): boolean {
  if (!userAgent || !userAgent.trim()) return true;
  return BOT_UA.test(userAgent);
}

/** Sec-GPC: 1 or DNT: 1. Either one is a full opt-out of tracking. */
export function declinesTracking(request: Request): boolean {
  return request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1";
}

/** Whether this request may be bucketed into an experiment and counted at all. */
export function eligibleForExperiments(request: Request): boolean {
  return !declinesTracking(request) && !isBot(request.headers.get("user-agent"));
}

function readCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function readVisitorId(request: Request): string | null {
  const raw = readCookieValue(request.headers.get("cookie"), VISITOR_COOKIE);
  // Defensive: only ever trust values shaped like our own token (b64url).
  return raw && /^[A-Za-z0-9_-]{20,64}$/.test(raw) ? raw : null;
}

/** 32 bytes of randomness, base64url. Opaque: no identity, no fingerprint input. */
export function newVisitorId(): string {
  return randomToken(32);
}

/**
 * `__Host-` requires Secure, Path=/, and no Domain attribute — which is also
 * exactly the shape that keeps this id first-party and scoped to this origin.
 * On a non-secure request (local dev) the cookie is not set: the browser
 * would refuse a `__Host-` cookie without Secure anyway.
 */
export function visitorCookie(id: string, secure: boolean): string | null {
  if (!secure) return null;
  return [`${VISITOR_COOKIE}=${id}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${VISITOR_MAX_AGE}`, "Secure"].join(
    "; ",
  );
}

export function clearVisitorCookie(): string {
  return [`${VISITOR_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Secure"].join("; ");
}
