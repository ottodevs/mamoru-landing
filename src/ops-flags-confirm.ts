/**
 * The confirm step for turning a /ops/functions flag on (otto/mamoru-astro#20): a risky change, written only
 * with a token the server issued on the confirm screen, bound to the session, to the exact flag and target
 * state, and to the newest change row shown for that flag. Same shape as engine-settings-confirm.ts. Turning
 * a flag off is not risky (engine-settings-confirm.ts's model: the only risk here is turning something on
 * that was off) and never needs this token.
 */

import { sameSecret } from "./text";

export const FLAG_CONFIRM_TTL_MS = 10 * 60_000;

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function digestOf(flag: string, enabled: boolean, baseId: number): string {
  return JSON.stringify({ flag, enabled, baseId });
}

export async function issueFlagConfirmToken(secret: string, sessionCsrf: string, flag: string, enabled: boolean, baseId: number, now = Date.now()): Promise<string> {
  const exp = now + FLAG_CONFIRM_TTL_MS;
  return `${exp}.${await hmacHex(secret, `ops-flag-confirm-v1\n${sessionCsrf}\n${exp}\n${digestOf(flag, enabled, baseId)}`)}`;
}

export async function checkFlagConfirmToken(
  secret: string,
  sessionCsrf: string,
  token: string,
  flag: string,
  enabled: boolean,
  baseId: number,
  now = Date.now(),
): Promise<boolean> {
  const m = /^([0-9]{1,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + FLAG_CONFIRM_TTL_MS) return false;
  return sameSecret(m[2]!, await hmacHex(secret, `ops-flag-confirm-v1\n${sessionCsrf}\n${exp}\n${digestOf(flag, enabled, baseId)}`));
}
