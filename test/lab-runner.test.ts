// otto/mamoru-astro#28: the runner routes end to end through worker.fetch — claim/heartbeat/result/publish,
// lease renewal and fencing (a stale runner's write is refused), and that these routes are unreachable with
// only a session cookie (never through the /ops Google gate).
import { describe, expect, test } from "bun:test";
import worker, { type Env } from "../src/worker";
import { sealSession } from "../src/ops";
import { signRunnerRequest } from "../src/lab-sign";
import { labDb, makeRun } from "./lab-fixture";
import { claimJobById, finishJobDoneWithRun, finishJobFailed, insertJob, jobById } from "../src/lab-store";

const SECRET = "test-runner-secret";

function opsEnv(db: ReturnType<typeof labDb>): Env {
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    MAMORU_DB: db,
    LAB_RUNNER_SECRET: SECRET,
  };
}

async function signedFetch(env: Env, path: string, body: unknown): Promise<Response> {
  const raw = JSON.stringify(body ?? {});
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  const sig = await signRunnerRequest(SECRET, "POST", path, ts, nonce, raw);
  return worker.fetch(
    new Request(`https://mamoru.lol${path}`, {
      method: "POST",
      headers: { "x-lab-ts": String(ts), "x-lab-nonce": nonce, "x-lab-sig": sig, "content-type": "application/json" },
      body: raw,
    }),
    env,
  );
}

describe("worker.ts: /ops/lab/runner/* never goes through the /ops session", () => {
  test("a valid session cookie alone does not reach the runner routes (401, not routed as ops)", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/lab/runner/claim", { method: "POST", headers: { cookie: `mamoru_list=${token}` }, body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("");
  });

  test("missing LAB_RUNNER_SECRET: 503, even with a correctly shaped request", async () => {
    const db = labDb({ seed: false });
    const env = { ...opsEnv(db), LAB_RUNNER_SECRET: undefined };
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/runner/claim", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(503);
  });

  test("GET on a runner path is not found, only POST is routed", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/runner/claim"), env);
    expect(res.status).toBe(404);
  });
});

describe("lab-runner.ts: claim / heartbeat / result, with fencing", () => {
  test("claim returns 204 when nothing is queued", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const res = await signedFetch(env, "/ops/lab/runner/claim", {});
    expect(res.status).toBe(204);
  });

  test("claim takes the oldest queued job, heartbeat renews it, result finishes it", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-1", requester: "ottodevs@gmail.com", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });

    const claimRes = await signedFetch(env, "/ops/lab/runner/claim", {});
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { job: { id: string; leaseId: string; spec: typeof spec } };
    expect(claimed.job.id).toBe("job-1");
    expect(claimed.job.spec).toEqual(spec);
    const leaseId = claimed.job.leaseId;
    expect(typeof leaseId).toBe("string");

    const job = await jobById(db, "job-1");
    expect(job?.status).toBe("running");

    const hbRes = await signedFetch(env, "/ops/lab/runner/heartbeat", { id: "job-1", leaseId });
    expect(hbRes.status).toBe(200);

    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", resultHash: "fresh-hash-1", vsHodl: -5 });
    const resultRes = await signedFetch(env, "/ops/lab/runner/result", { id: "job-1", leaseId, run });
    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as { ok: boolean; status: string; resultHash: string };
    expect(resultBody.status).toBe("done");
    expect(resultBody.resultHash).toBe("fresh-hash-1");

    const finished = await jobById(db, "job-1");
    expect(finished?.status).toBe("done");
    expect(finished?.resultHash).toBe("fresh-hash-1");

    const row = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE result_hash = ?").bind("fresh-hash-1").first();
    expect(row).toBeTruthy();
  });

  test("heartbeat on a lease that no longer matches is refused with LAB_JOB_LEASE_LOST (409)", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-2", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const res = await signedFetch(env, "/ops/lab/runner/heartbeat", { id: "job-2", leaseId: "not-the-real-lease" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_JOB_LEASE_LOST");
  });

  test("AL-02a fencing: a stale runner's result (reclaimed job, new lease) is refused; the reclaiming runner's answer stands", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-3", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claim1 = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    const staleLease = claim1.job.leaseId;

    // Simulate the lease expiring and attempts already at 1 (one prior retry), then reclaimed by a fresh runner.
    db.raw.query("UPDATE lab_jobs SET lease_until = ?, attempts = 1 WHERE id = 'job-3'").run(Math.floor(Date.now() / 1000) - 10);
    const claim2 = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    const newLease = claim2.job.leaseId;
    expect(newLease).not.toBe(staleLease);

    // The stale runner (holding the old lease) tries to post a result: refused.
    const staleRun = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "stale", resultHash: "stale-hash", vsHodl: -1 });
    const staleRes = await signedFetch(env, "/ops/lab/runner/result", { id: "job-3", leaseId: staleLease, run: staleRun });
    expect(staleRes.status).toBe(409);
    // GPT-6 Sol review (otto/mamoru-astro#28): a refused result must never land in lab_runs either, not only
    // leave the job's own resultHash untouched — this is what "fence before writing the run" actually buys.
    const staleRow = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE result_hash = ?").bind("stale-hash").first();
    expect(staleRow).toBeNull();

    // The reclaiming runner's own result is accepted.
    const freshRun = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "fresh", resultHash: "fresh-hash-2", vsHodl: -1 });
    const okRes = await signedFetch(env, "/ops/lab/runner/result", { id: "job-3", leaseId: newLease, run: freshRun });
    expect(okRes.status).toBe(200);

    const job = await jobById(db, "job-3");
    expect(job?.resultHash).toBe("fresh-hash-2");
    const freshRow = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE result_hash = ?").bind("fresh-hash-2").first();
    expect(freshRow).toBeTruthy();
  });

  // GPT-6 Sol review (otto/mamoru-astro#28): even when the cheap early-out (jobById) still matches at read
  // time, the run must only be written once the atomic, fenced job update itself matched. Simulates the exact
  // race by expiring the lease between the cheap check and the fenced update would require interleaving two
  // in-flight requests; this instead proves the invariant the ordering establishes: a result call that the
  // fenced update refuses never reaches lab_runs, regardless of why the fence failed (expired lease here, not
  // just a reclaimed one).
  test("a result call whose lease has merely expired (not reclaimed) is refused and writes nothing to lab_runs", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-expire-result", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claim = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    // Let the lease expire in place: lease_id is unchanged (still what the runner holds), lease_until is past.
    db.raw.query("UPDATE lab_jobs SET lease_until = ? WHERE id = 'job-expire-result'").run(Math.floor(Date.now() / 1000) - 5);
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "late", resultHash: "expired-lease-hash", vsHodl: -1 });
    const res = await signedFetch(env, "/ops/lab/runner/result", { id: "job-expire-result", leaseId: claim.job.leaseId, run });
    expect(res.status).toBe(409);
    const row = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE result_hash = ?").bind("expired-lease-hash").first();
    expect(row).toBeNull();
  });

  test("result with spec_key mismatch between the run and the job is refused", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-4", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claim = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    const wrongRun = makeRun({ windowId: "feb2025", base: "guard", widthTicks: 2000, deposit: 1000, variantLabel: "wrong", resultHash: "wrong-hash", vsHodl: -1 });
    const res = await signedFetch(env, "/ops/lab/runner/result", { id: "job-4", leaseId: claim.job.leaseId, run: wrongRun });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_RUN_SPEC_MISMATCH");
  });

  test("result with an error code marks the job failed", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-5", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claim = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    const res = await signedFetch(env, "/ops/lab/runner/result", { id: "job-5", leaseId: claim.job.leaseId, error: "LAB_DATASET_MISSING" });
    expect(res.status).toBe(200);
    const job = await jobById(db, "job-5");
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("LAB_DATASET_MISSING");
  });

  test("claim fails a job stuck past two attempts with LAB_JOB_LEASE_LOST", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-6", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    db.raw
      .query("UPDATE lab_jobs SET status='running', lease_id='x', lease_until=?, attempts=2 WHERE id='job-6'")
      .run(Math.floor(Date.now() / 1000) - 10);
    const res = await signedFetch(env, "/ops/lab/runner/claim", {});
    expect(res.status).toBe(204); // nothing claimable: job-6 just got failed, not re-offered
    const job = await jobById(db, "job-6");
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("LAB_JOB_LEASE_LOST");
  });

  test("publish upserts a run without a job (seeding); re-publishing the same hash is a no-op", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const run = makeRun({ windowId: "dec2024", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", resultHash: "seed-hash-1", vsHodl: 4 });
    const res1 = await signedFetch(env, "/ops/lab/runner/publish", { run });
    expect(res1.status).toBe(200);
    const res2 = await signedFetch(env, "/ops/lab/runner/publish", { run });
    expect(res2.status).toBe(200);
    const { results } = await db.prepare("SELECT result_hash FROM lab_runs WHERE result_hash = ?").bind("seed-hash-1").all();
    expect(results.length).toBe(1);
  });

  test("publish refuses an obviously malformed RunResult", async () => {
    const db = labDb({ seed: false });
    const env = opsEnv(db);
    const res = await signedFetch(env, "/ops/lab/runner/publish", { run: { not: "a run" } });
    expect(res.status).toBe(400);
  });

  /** Builds finishJobDoneWithRun's `run` input from a full makeRun() result. */
  function runInput(run: ReturnType<typeof makeRun>, nowIso: string) {
    const { reasons, ops, series, ...summary } = run;
    void reasons;
    void ops;
    void series;
    return {
      resultHash: run.resultHash,
      specKey: run.specKey,
      windowId: run.window.id,
      summaryJson: JSON.stringify(summary),
      runJson: JSON.stringify(run),
      simVersion: run.simVersion,
      createdAt: nowIso,
    };
  }

  test("finishJobDoneWithRun/finishJobFailed are also fenced directly at the store layer", async () => {
    const db = labDb({ seed: false });
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-7", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "x", resultHash: "h", vsHodl: -1 });
    const ok = await finishJobDoneWithRun(db, { id: "job-7", leaseId: "no-such-lease", nowIso: new Date().toISOString(), run: runInput(run, new Date().toISOString()) });
    expect(ok).toBe(false);
  });

  // GPT-6 Sol review (otto/mamoru-astro#28): finishJobDoneWithRun/finishJobFailed must fence on more than
  // lease_id — an expired-but-not-yet-reclaimed lease must not be able to finish, and a job already terminal
  // must not be flipped by a late duplicate write.
  test("finishJobDoneWithRun refuses an expired lease even when lease_id still matches (nobody reclaimed it yet)", async () => {
    const db = labDb({ seed: false });
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-expired", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claimed = await claimJobById(db, "job-expired", new Date().toISOString());
    expect(claimed).not.toBeNull();
    // Let the lease expire in place (no reclaim): lease_id is unchanged, lease_until is now in the past.
    db.raw.query("UPDATE lab_jobs SET lease_until = ? WHERE id = 'job-expired'").run(Math.floor(Date.now() / 1000) - 5);
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "late", resultHash: "late-hash", vsHodl: -1 });
    const ok = await finishJobDoneWithRun(db, { id: "job-expired", leaseId: claimed!.leaseId, nowIso: new Date().toISOString(), run: runInput(run, new Date().toISOString()) });
    expect(ok).toBe(false);
    const job = await jobById(db, "job-expired");
    expect(job?.status).toBe("running"); // untouched, not silently finished
    const row = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE result_hash = ?").bind("late-hash").first();
    expect(row).toBeNull();
  });

  test("finishJobFailed cannot flip an already-done job back to failed", async () => {
    const db = labDb({ seed: false });
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-done", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const nowIso = new Date().toISOString();
    const claimed = await claimJobById(db, "job-done", nowIso);
    expect(claimed).not.toBeNull();
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "real", resultHash: "real-hash", vsHodl: -1 });
    const doneOk = await finishJobDoneWithRun(db, { id: "job-done", leaseId: claimed!.leaseId, nowIso, run: runInput(run, nowIso) });
    expect(doneOk).toBe(true);
    // A late duplicate "error" write for the same lease arrives after the job already finished successfully.
    const failOk = await finishJobFailed(db, "job-done", claimed!.leaseId, "LAB_JOB_TIMEOUT", nowIso);
    expect(failOk).toBe(false);
    const job = await jobById(db, "job-done");
    expect(job?.status).toBe("done");
    expect(job?.resultHash).toBe("real-hash");
  });

  // GPT-6 Sol review round 2 (otto/mamoru-astro#28): the job UPDATE and the run INSERT are one D1 transaction
  // (finishJobDoneWithRun's db.batch([...])) specifically so a run-write failure can never leave a job stuck
  // `done` with nothing in lab_runs to show for it. A broken lab_runs table (missing a column the INSERT
  // writes to) makes the insert throw after the UPDATE would otherwise have matched; the whole batch must roll
  // back, leaving the job exactly as it was.
  test("finishJobDoneWithRun: when the run insert throws, the whole batch rolls back and the job stays running", async () => {
    const db = labDb({ seed: false, brokenRunsTable: true });
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-broken", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const nowIso = new Date().toISOString();
    const claimed = await claimJobById(db, "job-broken", nowIso);
    expect(claimed).not.toBeNull();
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "x", resultHash: "would-be-hash", vsHodl: -1 });
    let threw = false;
    try {
      await finishJobDoneWithRun(db, { id: "job-broken", leaseId: claimed!.leaseId, nowIso, run: runInput(run, nowIso) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const job = await jobById(db, "job-broken");
    expect(job?.status).toBe("running"); // the UPDATE was rolled back along with the failed INSERT
    expect(job?.resultHash).toBeNull();
  });

  // Same scenario through the full signed HTTP path: the runner gets a clear error, not a silently
  // half-applied write, and a retry (the runner's own lease renewal / next claim cycle) can still resolve it.
  test("POST /ops/lab/runner/result: a run-write failure answers 503 and leaves the job running, not stuck done", async () => {
    const db = labDb({ seed: false, brokenRunsTable: true });
    const env = opsEnv(db);
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 2000, deposit: 1000 };
    await insertJob(db, { id: "job-http-broken", requester: "r", spec, specKey: "feb2025|live|2000|1000", status: "queued", resultHash: null, now: new Date().toISOString() });
    const claim = (await (await signedFetch(env, "/ops/lab/runner/claim", {})).json()) as { job: { leaseId: string } };
    const run = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "x", resultHash: "http-would-be-hash", vsHodl: -1 });
    const res = await signedFetch(env, "/ops/lab/runner/result", { id: "job-http-broken", leaseId: claim.job.leaseId, run });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_RUN_WRITE_FAILED");
    const job = await jobById(db, "job-http-broken");
    expect(job?.status).toBe("running");
  });
});
