/**
 * otto/mamoru-astro#28: the gate in front of `/ops/lab/runner/*`. No session cookie is ever read here — only
 * the signature (lab-sign.ts) and the `lab_nonces` replay guard. Missing secret fails closed (503): the runner
 * routes are unreachable, not reachable-with-no-auth.
 */

import type { D1Db } from "./d1-infra";
import { MAX_BODY_BYTES, NONCE_RE, NONCE_WINDOW_SECONDS, signRunnerRequest, TS_SKEW_SECONDS } from "./lab-sign";
import { recordNonce } from "./lab-store";
import { sameSecret } from "./text";

export type RunnerAuthResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies `x-lab-ts` / `x-lab-nonce` / `x-lab-sig` against the raw body, in the order that fails cheapest
 * first (shape, then timestamp skew, then the signature itself, then the nonce replay check — a nonce is only
 * ever recorded once the signature is known good, so a forged request can never burn a real nonce).
 */
export async function verifyRunnerRequest(
  request: Request,
  secret: string | undefined,
  db: D1Db | undefined,
  path: string,
  /** Test-only override for "now" (otto/mamoru-astro#28's runner-side cross-check vector has a fixed ts). */
  nowOverride?: number,
): Promise<RunnerAuthResult> {
  if (!secret) return { ok: false, status: 503, error: "LAB_RUNNER_NOT_CONFIGURED" };
  if (!db) return { ok: false, status: 503, error: "LAB_RUNNER_NOT_CONFIGURED" };
  const ts = Number(request.headers.get("x-lab-ts") ?? "");
  const nonce = request.headers.get("x-lab-nonce") ?? "";
  const sig = request.headers.get("x-lab-sig") ?? "";
  if (!Number.isFinite(ts) || !NONCE_RE.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, status: 401, error: "LAB_RUNNER_BAD_REQUEST" };
  }
  const now = nowOverride ?? nowEpoch();
  if (Math.abs(now - ts) > TS_SKEW_SECONDS) return { ok: false, status: 401, error: "LAB_RUNNER_TS_SKEW" };

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return { ok: false, status: 413, error: "LAB_RUNNER_BODY_TOO_LARGE" };
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "LAB_RUNNER_BODY_TOO_LARGE" };

  const expected = await signRunnerRequest(secret, request.method, path, ts, nonce, rawBody);
  if (!(await sameSecret(sig, expected))) return { ok: false, status: 401, error: "LAB_RUNNER_BAD_SIGNATURE" };

  const fresh = await recordNonce(db, nonce, now, NONCE_WINDOW_SECONDS);
  if (!fresh) return { ok: false, status: 401, error: "LAB_RUNNER_NONCE_REPLAYED" };

  let body: unknown = null;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, status: 400, error: "LAB_RUNNER_BAD_BODY" };
    }
  }
  return { ok: true, body };
}
