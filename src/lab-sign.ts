/**
 * otto/mamoru-astro#28 (spec 008 "Architecture"): the runner HTTP signing scheme, deliberately different from
 * the engine-settings pull (which signs method, path and minute, and is a read). This one signs a body:
 *
 *   sig = hex(HMAC-SHA256(secret, `${METHOD}\n${path}\n${ts}\n${nonce}\n${sha256hex(rawBody)}`))
 *
 * headers: `x-lab-ts` (unix seconds), `x-lab-nonce` (32 lowercase hex), `x-lab-sig` (the hex HMAC above).
 * A captured request cannot be replayed (nonce, checked against `lab_nonces`) or carry another body (the body
 * hash is inside the signed string) or be reused past 60 s (`x-lab-ts` skew).
 *
 * Pure string/crypto here; D1 (`lab_nonces`) is handled by the caller (lab-runner-auth.ts) so this file has no
 * Worker-only dependency and is easy to exercise with `node:crypto` from a test, per the fixed vector the
 * runner side uses to cross-check this implementation.
 */

import { hmacHex, sha256Hex } from "./text";

export const NONCE_RE = /^[0-9a-f]{32}$/;
export const TS_SKEW_SECONDS = 60;
export const NONCE_WINDOW_SECONDS = 600;
/** Runner request bodies are small job/run payloads; this is a denial-of-service backstop, not a schema bound. */
export const MAX_BODY_BYTES = 1024 * 1024;

export function signingString(method: string, path: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodySha256Hex}`;
}

/** The hex HMAC a caller must send as `x-lab-sig`. */
export async function signRunnerRequest(
  secret: string,
  method: string,
  path: string,
  ts: number,
  nonce: string,
  rawBody: string,
): Promise<string> {
  const bodyHash = await sha256Hex(rawBody);
  return hmacHex(secret, signingString(method, path, ts, nonce, bodyHash));
}
