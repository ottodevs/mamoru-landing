/**
 * First-party visitor id and the consent/bot gate experiments run behind.
 *
 * No fingerprinting: the id is 32 random bytes, carries no device/browser
 * signal, and is never derived from IP, headers, or timing. No IP is stored
 * anywhere in this file or in exp-store.ts (only a daily-salted hash of a
 * /24 or /64 prefix, in newIdentityAllowed() below). No third party ever
 * sees any of it.
 *
 * The cookie is signed: `<id>.<mac>`, HMAC-SHA256 under EXP_VISITOR_SECRET
 * with a domain-separated label ("vid:"), so an id cannot be forged or
 * ground-for-bucket by a client minting its own cookie values. Without that
 * secret configured, readVisitorId() always returns null — every visitor
 * reads as brand new and nothing is ever trusted enough to assign or record
 * against, which is the safe failure mode (see exp-rewrite.ts).
 *
 * Sec-GPC: 1 and DNT: 1 are both honored the same way: no cookie is set, no
 * event is ever written for that request, and every experiment serves its
 * control variant. Simple bots (by User-Agent substring) get the same
 * treatment. None of this runs for /ops paths at all; the caller excludes them.
 */

import { randomToken } from "./google";
import type { WaitlistKv } from "./list";
import { hmacB64Url, sameSecret, sha256Hex } from "./text";

export const VISITOR_COOKIE = "__Host-mamoru_vid";
const VISITOR_MAX_AGE = 60 * 60 * 24 * 90; // 90 days
const MAC_LEN = 22; // ~132 bits of a 256-bit HMAC, base64url — short, still unguessable

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

/** 32 bytes of randomness, base64url. Opaque: no identity, no fingerprint input. */
export function newVisitorId(): string {
  return randomToken(32);
}

async function visitorMac(secret: string, id: string): Promise<string> {
  return (await hmacB64Url(secret, `vid:${id}`)).slice(0, MAC_LEN);
}

/** The exact cookie value for a given id: `<id>.<mac>`. */
export async function signVisitorId(secret: string, id: string): Promise<string> {
  return `${id}.${await visitorMac(secret, id)}`;
}

/**
 * Reads and verifies the cookie. Any of: no secret configured, no cookie, a
 * malformed value, or a mac that does not check out — all read the same way,
 * as null. A forged or replayed-with-a-different-secret value is therefore
 * indistinguishable from "no cookie at all": the caller mints a fresh,
 * server-generated id instead of trusting it.
 */
export async function readVisitorId(request: Request, secret: string | undefined): Promise<string | null> {
  if (!secret) return null;
  const raw = readCookieValue(request.headers.get("cookie"), VISITOR_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  const expected = await visitorMac(secret, id);
  return (await sameSecret(mac, expected)) ? id : null;
}

/**
 * `__Host-` requires Secure, Path=/, and no Domain attribute — which is also
 * exactly the shape that keeps this id first-party and scoped to this origin.
 * On a non-secure request (local dev) the cookie is not set: the browser
 * would refuse a `__Host-` cookie without Secure anyway. Without a secret,
 * there is nothing safe to sign, so no cookie is issued either.
 */
export async function visitorCookie(secret: string | undefined, id: string, secure: boolean): Promise<string | null> {
  if (!secure || !secret) return null;
  const value = await signVisitorId(secret, id);
  return [`${VISITOR_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${VISITOR_MAX_AGE}`, "Secure"].join(
    "; ",
  );
}

export function clearVisitorCookie(): string {
  return [`${VISITOR_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Secure"].join("; ");
}

/** Daily cap on brand-new visitor identities per network, keyed by a salted hash of an IP prefix. No raw IP is ever stored. */
export const NEW_IDENTITY_DAILY_CAP = 200;

/** IPv4 → /24, IPv6 → /64 (with `::` expanded first). A coarse network, not an individual address. */
export function ipPrefix(ip: string): string {
  if (ip.includes(":")) {
    const [head, tail] = ip.split("::") as [string, string | undefined];
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    // `::` stands for as many zero groups as it takes to reach eight.
    const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
    if (groups.length !== 8) return ip;
    return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
}

/**
 * Whether this network may mint one more brand-new visitor identity today.
 * Gates only NEW identity creation — a visitor who already holds a valid
 * signed cookie is never throttled by this, only fresh-id farming is. The
 * key is `sha256(day:prefix)`, salted by the day itself (so it is not a
 * stable identifier across days) and the KV entry expires on its own.
 * No KV bound (e.g. the staging channel never has WAITLIST): nothing to
 * meter against, so this is a no-op allow (consistent with staging never
 * writing experiment events at all — see wrangler.toml).
 */
export async function newIdentityAllowed(
  kv: WaitlistKv | undefined,
  request: Request,
  day: string,
  cap: number = NEW_IDENTITY_DAILY_CAP,
): Promise<boolean> {
  if (!kv) return true;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const prefix = ipPrefix(ip);
  const hash = (await sha256Hex(`${day}:${prefix}`)).slice(0, 32);
  const key = `exp-newid:${day}:${hash}`;
  // A soft cap: KV has no atomic increment, so concurrent requests can pass it by a few. It bounds
  // farming to the order of `cap` a day per network, which is all the analysis needs.
  // KV down or throwing: mint nothing. The visitor sees control and the page still renders.
  try {
    const hits = Number((await kv.get(key)) || "0");
    if (hits >= cap) return false;
    await kv.put(key, String(hits + 1), { expirationTtl: 60 * 60 * 30 });
    return true;
  } catch {
    return false;
  }
}
