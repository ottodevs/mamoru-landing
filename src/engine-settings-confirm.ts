/**
 * Spec 006 (otto/mamoru#147): the confirm step for risky engine-settings changes. A risky change is written only
 * with a token the server issued on the confirm screen, bound to that session, to the exact change (env, scope,
 * settings, template, rollback link) and to the versions in effect when it was shown. A caller-supplied
 * `confirm=1`, a token for another change, an expired one, or one shown before someone else changed the settings
 * never writes.
 */

import { canonicalJson, riskyChanges, type EngineSettings } from "./engine-settings-model";
import type { Env, InEffect } from "./engine-settings-store";
import { sameSecret } from "./text";

export const CONFIRM_TTL_MS = 10 * 60_000;

export type ChangeToConfirm = {
  env: Env;
  accountKeys: string[] | null;
  template: string;
  settings: EngineSettings;
  rollbackOf: number | null;
};

function digestOf(c: ChangeToConfirm, inEffect: InEffect): string {
  const keys = c.accountKeys && c.accountKeys.length ? [...new Set(c.accountKeys.map((k) => k.toLowerCase()))].sort() : null;
  return JSON.stringify({ env: c.env, keys, template: c.template, settings: canonicalJson(c.settings), rollbackOf: c.rollbackOf, base: [inEffect.wide?.id ?? 0, inEffect.canary?.id ?? 0] });
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueConfirmToken(secret: string, sessionCsrf: string, c: ChangeToConfirm, inEffect: InEffect, now = Date.now()): Promise<string> {
  const exp = now + CONFIRM_TTL_MS;
  return `${exp}.${await hmacHex(secret, `settings-confirm-v1\n${sessionCsrf}\n${exp}\n${digestOf(c, inEffect)}`)}`;
}

export async function checkConfirmToken(secret: string, sessionCsrf: string, token: string, c: ChangeToConfirm, inEffect: InEffect, now = Date.now()): Promise<boolean> {
  const m = /^([0-9]{1,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + CONFIRM_TTL_MS) return false;
  return sameSecret(m[2]!, await hmacHex(secret, `settings-confirm-v1\n${sessionCsrf}\n${exp}\n${digestOf(c, inEffect)}`));
}

/**
 * Every risk of the change against what each affected account runs now. One canary at most is live per env, so:
 * - a new environment-wide version retires the live canary: its accounts move from the canary, the others from the
 *   environment-wide version;
 * - a new canary retires the previous one: the named accounts move from what they run (the previous canary if it
 *   named them, else the environment-wide version), and accounts only in the previous canary fall back to the
 *   environment-wide version.
 */
export function risksOf(c: ChangeToConfirm, now: InEffect, defaults: EngineSettings): string[] {
  const wide = now.wide?.settings ?? defaults;
  const canary = now.canary;
  const out = new Set<string>();
  const add = (from: EngineSettings, to: EngineSettings, who: string) => {
    for (const r of riskyChanges(from, to)) out.add(who ? `${r} (${who})` : r);
  };
  if (!c.accountKeys || !c.accountKeys.length) {
    add(wide, c.settings, "");
    if (canary) add(canary.settings, c.settings, "accounts of the current canary");
    return [...out];
  }
  const named = new Set(c.accountKeys.map((k) => k.toLowerCase()));
  const inOld = new Set((canary?.accountKeys ?? []).map((k) => k.toLowerCase()));
  if ([...named].some((k) => !inOld.has(k))) add(wide, c.settings, "canary accounts");
  if (canary && [...named].some((k) => inOld.has(k))) add(canary.settings, c.settings, "canary accounts already in the current canary");
  if (canary && [...inOld].some((k) => !named.has(k))) add(canary.settings, wide, "accounts leaving the current canary");
  return [...out];
}
