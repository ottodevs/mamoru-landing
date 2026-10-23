// otto/mamoru-astro#28: the runner HTTP signing scheme (lab-sign.ts) and the gate in front of it
// (lab-runner-auth.ts) — skew, nonce replay, body swap, bad signature, missing secret.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NONCE_WINDOW_SECONDS, signRunnerRequest, signingString } from "../src/lab-sign";
import { verifyRunnerRequest } from "../src/lab-runner-auth";
import { labDb } from "./lab-fixture";

// Fixed vector from the ticket, cross-checked against this implementation with node:crypto so it agrees with
// whatever the runner side (ottodevs/mamoru) computes from the same inputs.
const VECTOR = {
  secret: "lab-test-secret",
  method: "POST",
  path: "/ops/lab/runner/claim",
  ts: 1792700000,
  nonce: "00112233445566778899aabbccddeeff",
  body: "{}",
};

function nodeSig(v: typeof VECTOR): string {
  const bodyHash = createHash("sha256").update(v.body).digest("hex");
  const str = `${v.method}\n${v.path}\n${v.ts}\n${v.nonce}\n${bodyHash}`;
  expect(str).toBe(signingString(v.method, v.path, v.ts, v.nonce, bodyHash));
  return createHmac("sha256", v.secret).update(str).digest("hex");
}

async function sign(secret: string, method: string, path: string, ts: number, nonce: string, body: string) {
  return signRunnerRequest(secret, method, path, ts, nonce, body);
}

describe("lab-sign.ts: fixed vector", () => {
  test("signRunnerRequest equals an independent node:crypto computation of the same vector", async () => {
    const expected = nodeSig(VECTOR);
    const got = await sign(VECTOR.secret, VECTOR.method, VECTOR.path, VECTOR.ts, VECTOR.nonce, VECTOR.body);
    expect(got).toBe(expected);
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  // Cross-check with the runner side (ottodevs/mamoru#117): this exact vector, signature and all, came from
  // that implementation. If this ever stops matching, the two sides have drifted apart on the signing scheme.
  test("matches the runner side's own vector (ottodevs/mamoru#117) byte for byte", async () => {
    const v = {
      secret: "test-lab-runner-secret-v1",
      method: "POST",
      path: "/ops/lab/runner/claim",
      ts: 1761220000,
      nonce: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      body: "{}",
    };
    const expectedSig = "0ab17ef830b47b5eeecec34a7d99250fc1b2bc3b9e73931ab0f8b218779ced79";
    expect(nodeSig(v)).toBe(expectedSig);
    const got = await sign(v.secret, v.method, v.path, v.ts, v.nonce, v.body);
    expect(got).toBe(expectedSig);
  });

  // Same vector, through the full HTTP gate (lab-runner-auth.ts) rather than just the signing function: the
  // vector's timestamp is fixed in the past, so `now` is injected to make it pass the 60s skew check — the
  // point of this test is the signature and nonce path, not live clock skew (already covered above).
  test("the runner-side vector is accepted end to end by verifyRunnerRequest, with `now` injected to bypass skew", async () => {
    const v = {
      secret: "test-lab-runner-secret-v1",
      path: "/ops/lab/runner/claim",
      ts: 1761220000,
      nonce: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      body: "{}",
    };
    const sig = "0ab17ef830b47b5eeecec34a7d99250fc1b2bc3b9e73931ab0f8b218779ced79";
    const db = labDb({ seed: false });
    const result = await verifyRunnerRequest(
      req(v.path, { "x-lab-ts": String(v.ts), "x-lab-nonce": v.nonce, "x-lab-sig": sig }, v.body),
      v.secret,
      db,
      v.path,
      v.ts, // injected "now": the vector's own timestamp, so the fixed-in-the-past ts passes the skew check
    );
    expect(result.ok).toBe(true);
  });
});

function freshNonce(suffix: string): string {
  return (suffix.repeat(32).slice(0, 32)).toLowerCase();
}

function req(path: string, headers: Record<string, string>, body: string): Request {
  return new Request(`https://mamoru.lol${path}`, { method: "POST", headers, body });
}

describe("lab-runner-auth.ts: verifyRunnerRequest", () => {
  const secret = "runner-secret";
  const path = "/ops/lab/runner/claim";

  async function signedHeaders(ts: number, nonce: string, body: string, overrideSig?: string) {
    const sig = overrideSig ?? (await sign(secret, "POST", path, ts, nonce, body));
    return { "x-lab-ts": String(ts), "x-lab-nonce": nonce, "x-lab-sig": sig };
  }

  test("accepts a correctly signed, fresh request", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a1");
    const body = "{}";
    const headers = await signedHeaders(now, nonce, body);
    const result = await verifyRunnerRequest(req(path, headers, body), secret, db, path);
    expect(result.ok).toBe(true);
  });

  test("missing secret fails closed with 503, not 401 (never 'no auth required')", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a2");
    const headers = await signedHeaders(now, nonce, "{}");
    const result = await verifyRunnerRequest(req(path, headers, "{}"), undefined, db, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  test("refuses a timestamp older than 60s (skew)", async () => {
    const db = labDb({ seed: false });
    const stale = Math.floor(Date.now() / 1000) - 61;
    const nonce = freshNonce("a3");
    const headers = await signedHeaders(stale, nonce, "{}");
    const result = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  test("refuses a timestamp more than 60s in the future too", async () => {
    const db = labDb({ seed: false });
    const future = Math.floor(Date.now() / 1000) + 61;
    const nonce = freshNonce("a4");
    const headers = await signedHeaders(future, nonce, "{}");
    const result = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(result.ok).toBe(false);
  });

  test("refuses a replayed nonce (same nonce seen twice)", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a5");
    const headers = await signedHeaders(now, nonce, "{}");
    const first = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(first.ok).toBe(true);
    const second = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("LAB_RUNNER_NONCE_REPLAYED");
  });

  test("refuses a body swapped after signing (the body hash is inside the signed string)", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a6");
    // Sign over one body, send another: the signature was computed for a different bodyHash.
    const headers = await signedHeaders(now, nonce, '{"id":"a"}');
    const result = await verifyRunnerRequest(req(path, headers, '{"id":"b"}'), secret, db, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("LAB_RUNNER_BAD_SIGNATURE");
  });

  test("refuses a bad signature outright", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a7");
    const headers = await signedHeaders(now, nonce, "{}", "0".repeat(64));
    const result = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("LAB_RUNNER_BAD_SIGNATURE");
  });

  test("refuses a signature computed for a different path (the path is inside the signed string)", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const nonce = freshNonce("a8");
    const sig = await sign(secret, "POST", "/ops/lab/runner/heartbeat", now, nonce, "{}");
    const headers = { "x-lab-ts": String(now), "x-lab-nonce": nonce, "x-lab-sig": sig };
    const result = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(result.ok).toBe(false);
  });

  test("malformed nonce shape is refused before any D1 lookup", async () => {
    const db = labDb({ seed: false });
    const now = Math.floor(Date.now() / 1000);
    const headers = { "x-lab-ts": String(now), "x-lab-nonce": "not-hex", "x-lab-sig": "a".repeat(64) };
    const result = await verifyRunnerRequest(req(path, headers, "{}"), secret, db, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("LAB_RUNNER_BAD_REQUEST");
  });

  test("NONCE_WINDOW_SECONDS is 10 minutes, as the Architecture section specifies", () => {
    expect(NONCE_WINDOW_SECONDS).toBe(600);
  });
});
