/**
 * The confirm step for raising an account's cap (otto/mamoru-astro#25): written only with a token the server issued
 * on the confirm screen, bound to the session, to the full account key, to the exact amount (null: back to the
 * general cap) and to the newest override row of that account when it was issued. A row written in between changes
 * that id, so a stale confirm is refused and a fresh confirm screen is shown. Same shape as ops-flags-confirm.ts.
 */

import { sameSecret } from "./text";

export const CAP_CONFIRM_TTL_MS = 10 * 60_000;

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function digestOf(accountKey: string, capUsdc: number | null, baseId: number): string {
  return JSON.stringify({ accountKey: accountKey.toLowerCase(), capUsdc, baseId });
}

const material = (sessionCsrf: string, exp: number, accountKey: string, capUsdc: number | null, baseId: number) =>
  `ops-account-cap-confirm-v1\n${sessionCsrf}\n${exp}\n${digestOf(accountKey, capUsdc, baseId)}`;

export async function issueCapConfirmToken(secret: string, sessionCsrf: string, accountKey: string, capUsdc: number | null, baseId: number, now = Date.now()): Promise<string> {
  if (!secret) throw new Error("no signing secret");
  const exp = now + CAP_CONFIRM_TTL_MS;
  return `${exp}.${await hmacHex(secret, material(sessionCsrf, exp, accountKey, capUsdc, baseId))}`;
}

export async function checkCapConfirmToken(
  secret: string,
  sessionCsrf: string,
  token: string,
  accountKey: string,
  capUsdc: number | null,
  baseId: number,
  now = Date.now(),
): Promise<boolean> {
  if (!secret) return false;
  const m = /^([0-9]{1,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + CAP_CONFIRM_TTL_MS) return false;
  return sameSecret(m[2]!, await hmacHex(secret, material(sessionCsrf, exp, accountKey, capUsdc, baseId)));
}
