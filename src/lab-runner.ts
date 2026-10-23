/**
 * otto/mamoru-astro#28: `/ops/lab/runner/{claim,heartbeat,result,publish}` — the lady runner's only way to
 * reach this Worker (spec 008 "Architecture"). Never behind the `/ops` session; always behind `lab-runner-auth.ts`.
 */

import type { D1Db } from "./d1-infra";
import { verifyRunnerRequest } from "./lab-runner-auth";
import {
  claimJobById,
  failExhaustedLeases,
  finishJobDoneWithRun,
  finishJobFailed,
  jobById,
  oldestClaimable,
  renewLease,
  upsertRun,
  type LabRunFull,
} from "./lab-store";
import { specKey, validateSpec } from "./lab-spec";

export interface LabRunnerEnv {
  MAMORU_DB?: D1Db;
  LAB_RUNNER_SECRET?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** B-02 shape check: required top-level fields present with sane basic types. Not a deep schema validator — the
 * runner (ottodevs/mamoru) owns the result builder; this only refuses something obviously not a RunResult. */
export function validateRunResult(input: unknown): { ok: true; run: LabRunFull } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "LAB_RUN_INVALID" };
  const r = input as Record<string, unknown>;
  const specCheck = validateSpec(r.spec);
  if (!specCheck.ok) return { ok: false, error: "LAB_RUN_INVALID" };
  if (typeof r.specKey !== "string" || r.specKey !== specKey(specCheck.spec)) return { ok: false, error: "LAB_RUN_INVALID" };
  if (typeof r.variantLabel !== "string" || typeof r.policyId !== "string") return { ok: false, error: "LAB_RUN_INVALID" };
  if (typeof r.resultHash !== "string" || !r.resultHash) return { ok: false, error: "LAB_RUN_INVALID" };
  if (typeof r.simVersion !== "string" || !r.simVersion) return { ok: false, error: "LAB_RUN_INVALID" };
  const w = r.window as Record<string, unknown> | undefined;
  if (!w || typeof w.id !== "string" || !w.id) return { ok: false, error: "LAB_RUN_INVALID" };
  if (typeof r.deposit !== "number" || !Array.isArray(r.pools)) return { ok: false, error: "LAB_RUN_INVALID" };
  if (!r.metrics || typeof r.metrics !== "object") return { ok: false, error: "LAB_RUN_INVALID" };
  if (!r.reasons || typeof r.reasons !== "object") return { ok: false, error: "LAB_RUN_INVALID" };
  if (!Array.isArray(r.ops) || !Array.isArray(r.series)) return { ok: false, error: "LAB_RUN_INVALID" };
  return { ok: true, run: r as unknown as LabRunFull };
}

function summaryOf(run: LabRunFull): string {
  const { reasons, ops, series, ...summary } = run;
  void reasons;
  void ops;
  void series;
  return JSON.stringify(summary);
}

async function handleClaim(db: D1Db): Promise<Response> {
  const nowIso = new Date().toISOString();
  await failExhaustedLeases(db, nowIso);
  const candidate = await oldestClaimable(db);
  if (!candidate) return new Response(null, { status: 204 });
  const claimed = await claimJobById(db, candidate.id, nowIso);
  if (!claimed) return new Response(null, { status: 204 });
  return json({ job: { id: candidate.id, spec: claimed.spec, leaseId: claimed.leaseId } });
}

async function handleHeartbeat(db: D1Db, body: unknown): Promise<Response> {
  const b = (body ?? {}) as { id?: unknown; leaseId?: unknown };
  if (typeof b.id !== "string" || typeof b.leaseId !== "string") return json({ error: "LAB_RUNNER_BAD_BODY" }, 400);
  const ok = await renewLease(db, b.id, b.leaseId, new Date().toISOString());
  if (!ok) return json({ error: "LAB_JOB_LEASE_LOST" }, 409);
  return json({ ok: true });
}

async function handleResult(db: D1Db, body: unknown): Promise<Response> {
  const b = (body ?? {}) as { id?: unknown; leaseId?: unknown; run?: unknown; error?: unknown };
  if (typeof b.id !== "string" || typeof b.leaseId !== "string") return json({ error: "LAB_RUNNER_BAD_BODY" }, 400);
  const job = await jobById(db, b.id);
  if (!job || job.leaseId !== b.leaseId) return json({ error: "LAB_JOB_LEASE_LOST" }, 409);
  const nowIso = new Date().toISOString();
  if (b.error !== undefined) {
    const code = typeof b.error === "string" && b.error ? b.error : "LAB_JOB_FAILED";
    const ok = await finishJobFailed(db, b.id, b.leaseId, code, nowIso);
    if (!ok) return json({ error: "LAB_JOB_LEASE_LOST" }, 409);
    return json({ ok: true, status: "failed", errorCode: code });
  }
  const check = validateRunResult(b.run);
  if (!check.ok) return json({ error: check.error }, 400);
  if (check.run.specKey !== job.specKey) return json({ error: "LAB_RUN_SPEC_MISMATCH" }, 400);
  // The job's fenced UPDATE and the run's guarded INSERT are one D1 transaction (GPT-6 Sol review round 2,
  // otto/mamoru-astro#28): the earlier jobById read above is only a cheap early-out, not the authoritative
  // check, and writing the job and the run as two separate statements risked either half landing without the
  // other (a stale run with no fenced job update behind it, or a job marked done with no run to show for it).
  // If the batch itself throws, D1 rolls the whole transaction back: the job is left exactly as it was.
  let ok: boolean;
  try {
    ok = await finishJobDoneWithRun(db, {
      id: b.id,
      leaseId: b.leaseId,
      nowIso,
      run: {
        resultHash: check.run.resultHash,
        specKey: check.run.specKey,
        windowId: check.run.window.id,
        summaryJson: summaryOf(check.run),
        runJson: JSON.stringify(check.run),
        simVersion: check.run.simVersion,
        createdAt: nowIso,
      },
    });
  } catch {
    // Rolled back: nothing was written, the job is untouched (still `running` under this lease). The runner's
    // own retry (lease renewal keeps it alive, or the next claim cycle once it expires) resolves this, not a
    // half-committed job.
    return json({ error: "LAB_RUN_WRITE_FAILED" }, 503);
  }
  if (!ok) return json({ error: "LAB_JOB_LEASE_LOST" }, 409);
  return json({ ok: true, status: "done", resultHash: check.run.resultHash });
}

/** Seed results without a job (B-05): used by `mamoru-lab-runner seed`, not by this repo. */
async function handlePublish(db: D1Db, body: unknown): Promise<Response> {
  const b = (body ?? {}) as { run?: unknown };
  const check = validateRunResult(b.run);
  if (!check.ok) return json({ error: check.error }, 400);
  await upsertRun(db, {
    resultHash: check.run.resultHash,
    specKey: check.run.specKey,
    windowId: check.run.window.id,
    summaryJson: summaryOf(check.run),
    runJson: JSON.stringify(check.run),
    simVersion: check.run.simVersion,
    createdAt: new Date().toISOString(),
  });
  return json({ ok: true, resultHash: check.run.resultHash });
}

const ROUTES: Record<string, (db: D1Db, body: unknown) => Promise<Response>> = {
  "/ops/lab/runner/claim": (db) => handleClaim(db),
  "/ops/lab/runner/heartbeat": handleHeartbeat,
  "/ops/lab/runner/result": handleResult,
  "/ops/lab/runner/publish": handlePublish,
};

/** Entry point from `dispatch()` in worker.ts for any `/ops/lab/runner/*` path. Never touches the `/ops` session. */
export async function handleLabRunner(request: Request, env: LabRunnerEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const route = request.method === "POST" ? ROUTES[path] : undefined;
  if (!route) return json({ error: "LAB_RUNNER_NOT_FOUND" }, 404);
  const auth = await verifyRunnerRequest(request, env.LAB_RUNNER_SECRET, env.MAMORU_DB, path);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  return route(env.MAMORU_DB as D1Db, auth.body);
}
