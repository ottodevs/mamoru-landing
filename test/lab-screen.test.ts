// otto/mamoru-astro#28: the screen API (B-06) behind the /ops session — session required, CSRF on the one POST
// route, job dedupe by spec_key, the daily/queued limits, and the B-03 dataset-missing check (coordinator note:
// a window whose dataset lacks a pool a base needs has no runs for that base; the screen refuses that (window,
// base) with LAB_DATASET_MISSING before a job is ever created).
import { describe, expect, test } from "bun:test";
import worker, { type Env } from "../src/worker";
import { openSession, sealSession } from "../src/ops";
import { labDb } from "./lab-fixture";
import { activeJobBySpecKey, countJobsToday, insertAgentJob, insertDoneJobIfUnderLimit, insertJob, insertQueuedJobIfEligible, insertThread, jobById, threadById } from "../src/lab-store";
import { MAX_JOBS_PER_DAY, MAX_QUEUED_JOBS } from "../src/lab-spec";

function opsEnv(db: ReturnType<typeof labDb>): Env {
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    MAMORU_DB: db,
    LAB_RUNNER_SECRET: "runner-secret",
  };
}

async function sessionCookie(email = "ottodevs@gmail.com"): Promise<{ cookie: string; csrf: string }> {
  const token = await sealSession("k1", email);
  const session = await openSession("k1", `mamoru_list=${token}`);
  return { cookie: `mamoru_list=${token}`, csrf: session!.csrf };
}

async function postJob(env: Env, cookie: string, csrf: string, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ csrf, ...fields }).toString();
  return worker.fetch(
    new Request("https://mamoru.lol/ops/lab/api/jobs", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    env,
  );
}

describe("worker.ts: /ops/lab and /ops/lab/api/* require the /ops session", () => {
  test("GET /ops/lab with no session starts Google sign-in, never the page", async () => {
    const env = opsEnv(labDb());
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
  });

  test("GET /ops/lab/api/catalog with no session is refused (never leaks run data)", async () => {
    const env = opsEnv(labDb());
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/catalog"), env);
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).not.toContain("feb2025");
  });

  test("GET /ops/lab/api/runs, /api/run/:hash and /api/jobs/:id all refuse an unsigned session too", async () => {
    const env = opsEnv(labDb());
    for (const path of ["/ops/lab/api/runs?window=feb2025", "/ops/lab/api/run/hash-feb-live-2000-1000", "/ops/lab/api/jobs/anything"]) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`), env);
      expect(res.status).not.toBe(200);
    }
  });

  test("a signed-in allowlisted session reaches the page and the catalog", async () => {
    const env = opsEnv(labDb());
    const { cookie } = await sessionCookie();
    const page = await worker.fetch(new Request("https://mamoru.lol/ops/lab", { headers: { cookie } }), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("lab-root");
    expect(html).toContain('data-section="lab"');

    const catalog = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/catalog", { headers: { cookie } }), env);
    expect(catalog.status).toBe(200);
    const body = (await catalog.json()) as { windows: { windowId: string; bases: string[] }[] };
    const feb = body.windows.find((w) => w.windowId === "feb2025")!;
    expect(feb.bases.sort()).toEqual(["guard", "live"]);
    // aug2024 has no cbBTC on Base yet (B-03 fixture note): only `live` ever seeded.
    const aug = body.windows.find((w) => w.windowId === "aug2024")!;
    expect(aug.bases).toEqual(["live"]);
  });

  test("an email removed from the allowlist is denied like everywhere else in /ops", async () => {
    const env = opsEnv(labDb());
    const { cookie } = await sessionCookie("someone@example.com");
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab", { headers: { cookie } }), env);
    expect(res.status).toBe(404);
  });
});

describe("POST /ops/lab/api/jobs: CSRF", () => {
  test("a wrong csrf token is refused (403) and nothing is written", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    const res = await postJob(env, cookie, "not-the-real-token", { windowId: "feb2025", base: "live", widthTicks: "2000", deposit: "1000" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_CSRF_INVALID");
  });

  test("a missing csrf field is refused the same way", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/lab/api/jobs", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ windowId: "feb2025", base: "live", widthTicks: "2000", deposit: "1000" }).toString(),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /ops/lab/api/jobs: dedupe by spec_key (B-04, LAB-AL-09)", () => {
  test("a spec whose run already exists finishes at once with that run — no queued row", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    // feb2025|live|2000|1000 was seeded with resultHash "hash-feb-live-2000-1000" (lab-fixture.ts).
    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "2000", deposit: "1000" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { status: string; resultHash: string } };
    expect(body.job.status).toBe("done");
    expect(body.job.resultHash).toBe("hash-feb-live-2000-1000");
  });

  test("the same spec twice both resolve to the same resultHash (LAB-AL-09)", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const r1 = (await (await postJob(env, cookie, csrf, { windowId: "feb2025", base: "guard", widthTicks: "2000", deposit: "1000" })).json()) as { job: { resultHash: string } };
    const r2 = (await (await postJob(env, cookie, csrf, { windowId: "feb2025", base: "guard", widthTicks: "2000", deposit: "1000" })).json()) as { job: { resultHash: string } };
    expect(r1.job.resultHash).toBe(r2.job.resultHash);
  });

  test("a spec nothing has run yet is queued (not an instant 'done')", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "6000", deposit: "1000" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { status: string; resultHash: string | null } };
    expect(body.job.status).toBe("queued");
    expect(body.job.resultHash).toBeNull();
  });

  // GPT-6 Sol review (otto/mamoru-astro#28): dedupe must also cover a spec that is already queued or running —
  // not only one that already has a finished run — or two requests for the exact same spec queue the work twice.
  test("a spec already queued (no finished run yet) returns that same job instead of creating a second one", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 6500, deposit: 1000 };
    const key = "feb2025|live|6500|1000";
    await insertJob(db, { id: "already-queued", requester: "someone-else@example.com", spec, specKey: key, status: "queued", resultHash: null, now: new Date().toISOString() });

    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "6500", deposit: "1000" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; status: string } };
    expect(body.job.id).toBe("already-queued");
    expect(body.job.status).toBe("queued");

    const { results } = await db.prepare("SELECT id FROM lab_jobs WHERE spec_key = ?").bind(key).all();
    expect(results.length).toBe(1); // no duplicate row was inserted
  });

  test("a spec already running (claimed, not finished) also returns that job instead of a new one", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const spec = { windowId: "feb2025", base: "guard" as const, widthTicks: 4500, deposit: 1000 };
    const key = "feb2025|guard|4500|1000";
    await insertJob(db, { id: "already-running", requester: "someone-else@example.com", spec, specKey: key, status: "queued", resultHash: null, now: new Date().toISOString() });
    db.raw.query("UPDATE lab_jobs SET status='running', lease_id='x', lease_until=? WHERE id='already-running'").run(Math.floor(Date.now() / 1000) + 120);

    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "guard", widthTicks: "4500", deposit: "1000" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; status: string } };
    expect(body.job.id).toBe("already-running");
    expect(body.job.status).toBe("running");
  });

  // GPT-6 Sol review round 2 (otto/mamoru-astro#28): returning an in-flight duplicate must not let a requester
  // who is themselves already at the daily cap get service without ever creating a row of their own.
  test("a requester already at the daily cap is refused 429 even when the spec they ask for is already in flight", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_JOBS_PER_DAY; i++) {
      await insertJob(db, {
        id: `cap-${i}`,
        requester: "ottodevs@gmail.com",
        spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
        specKey: "unused-key",
        status: "done",
        resultHash: "x",
        now,
      });
    }
    const dupSpec = { windowId: "feb2025", base: "guard" as const, widthTicks: 5000, deposit: 1000 };
    const dupKey = "feb2025|guard|5000|1000";
    await insertJob(db, { id: "in-flight", requester: "someone-else@example.com", spec: dupSpec, specKey: dupKey, status: "queued", resultHash: null, now });

    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "guard", widthTicks: "5000", deposit: "1000" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_JOB_LIMIT_DAILY");
    // The in-flight job itself is untouched — still exactly one row for that spec, owned by the original requester.
    const { results } = await db.prepare("SELECT requester FROM lab_jobs WHERE spec_key = ?").bind(dupKey).all<{ requester: string }>();
    expect(results.length).toBe(1);
    expect(results[0]!.requester).toBe("someone-else@example.com");
  });

  test("a requester under the daily cap still gets the in-flight duplicate job normally", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const dupSpec = { windowId: "feb2025", base: "guard" as const, widthTicks: 5500, deposit: 1000 };
    const dupKey = "feb2025|guard|5500|1000";
    await insertJob(db, { id: "in-flight-2", requester: "someone-else@example.com", spec: dupSpec, specKey: dupKey, status: "queued", resultHash: null, now: new Date().toISOString() });

    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "guard", widthTicks: "5500", deposit: "1000" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string } };
    expect(body.job.id).toBe("in-flight-2");
  });
});

// GPT-6 Sol review (otto/mamoru-astro#28): the limits and the in-flight dedupe must be enforced by the write
// itself (one conditional INSERT ... SELECT ... WHERE), not by a read-then-insert that two concurrent requests
// could both pass. These exercise the atomic store functions directly.
describe("lab-store.ts: insertQueuedJobIfEligible / insertDoneJobIfUnderLimit are atomic, not read-then-insert", () => {
  const spec = { windowId: "feb2025", base: "live" as const, widthTicks: 7000, deposit: 1000 };
  const key = "feb2025|live|7000|1000";

  test("insertQueuedJobIfEligible refuses when a queued/running job already shares the spec_key, inserting nothing", async () => {
    const db = labDb();
    const now = new Date().toISOString();
    await insertJob(db, { id: "existing", requester: "r", spec, specKey: key, status: "queued", resultHash: null, now });
    const ok = await insertQueuedJobIfEligible(db, { id: "new-one", requester: "r", spec, specKey: key, now, sinceIso: now, maxPerDay: 20, maxActive: 3 });
    expect(ok).toBe(false);
    expect(await jobById(db, "new-one")).toBeNull();
  });

  test("insertQueuedJobIfEligible refuses at the daily cap and at the active-slot cap, in one statement each", async () => {
    const db = labDb();
    const now = new Date().toISOString();
    const underDaily = await insertQueuedJobIfEligible(db, { id: "day-ok", requester: "r", spec, specKey: key, now, sinceIso: now, maxPerDay: 1, maxActive: 3 });
    expect(underDaily).toBe(true);
    const overDaily = await insertQueuedJobIfEligible(db, { id: "day-over", requester: "r", spec: { ...spec, widthTicks: 7500 }, specKey: "feb2025|live|7500|1000", now, sinceIso: now, maxPerDay: 1, maxActive: 3 });
    expect(overDaily).toBe(false);
    expect(await jobById(db, "day-over")).toBeNull();

    const db2 = labDb();
    await insertJob(db2, { id: "slot-1", requester: "r", spec: { ...spec, widthTicks: 500 }, specKey: "feb2025|live|500|1000", status: "queued", resultHash: null, now });
    const overActive = await insertQueuedJobIfEligible(db2, { id: "slot-2", requester: "r", spec, specKey: key, now, sinceIso: now, maxPerDay: 20, maxActive: 1 });
    expect(overActive).toBe(false);
    expect(await jobById(db2, "slot-2")).toBeNull();
  });

  test("insertQueuedJobIfEligible succeeds once eligible", async () => {
    const db = labDb();
    const now = new Date().toISOString();
    const ok = await insertQueuedJobIfEligible(db, { id: "fresh", requester: "r", spec, specKey: key, now, sinceIso: now, maxPerDay: 20, maxActive: 3 });
    expect(ok).toBe(true);
    const job = await jobById(db, "fresh");
    expect(job?.status).toBe("queued");
    expect(job?.specKey).toBe(key);
  });

  test("insertDoneJobIfUnderLimit refuses at the daily cap and inserts nothing", async () => {
    const db = labDb();
    const now = new Date().toISOString();
    await insertJob(db, { id: "day-1", requester: "r", spec, specKey: key, status: "done", resultHash: "x", now });
    const ok = await insertDoneJobIfUnderLimit(db, { id: "day-2", requester: "r", spec, specKey: key, resultHash: "hash-feb-live-2000-1000", now, sinceIso: now, maxPerDay: 1 });
    expect(ok).toBe(false);
    expect(await jobById(db, "day-2")).toBeNull();
  });

  test("activeJobBySpecKey finds a queued or running job for the spec, null otherwise", async () => {
    const db = labDb({ seed: false });
    expect(await activeJobBySpecKey(db, key)).toBeNull();
    const now = new Date().toISOString();
    await insertJob(db, { id: "a1", requester: "r", spec, specKey: key, status: "queued", resultHash: null, now });
    const found = await activeJobBySpecKey(db, key);
    expect(found?.id).toBe("a1");
  });
});

describe("POST /ops/lab/api/jobs: B-01 spec bounds", () => {
  test("an out-of-bounds widthTicks is refused with LAB_SPEC_INVALID (400)", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "100", deposit: "1000" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_SPEC_INVALID");
  });

  test("an unknown windowId (not in lab_runs) is refused with LAB_SPEC_INVALID", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postJob(env, cookie, csrf, { windowId: "nope2099", base: "live", widthTicks: "2000", deposit: "1000" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_SPEC_INVALID");
  });
});

describe("POST /ops/lab/api/jobs: B-03 dataset-missing (coordinator note)", () => {
  test("a (window, base) with no existing run for that base is refused with LAB_DATASET_MISSING, even within bounds", async () => {
    const db = labDb(); // aug2024 only ever seeded with `live` runs (no cbBTC on Base yet)
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postJob(env, cookie, csrf, { windowId: "aug2024", base: "guard", widthTicks: "2000", deposit: "1000" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_DATASET_MISSING");
  });

  test("the same window with the base it does have is accepted", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postJob(env, cookie, csrf, { windowId: "aug2024", base: "live", widthTicks: "2000", deposit: "1000" });
    expect(res.status).toBe(200);
  });
});

describe("POST /ops/lab/api/jobs: limits (B-04)", () => {
  test("20 jobs/requester/day: the 21st in the window is refused with LAB_JOB_LIMIT_DAILY (429)", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_JOBS_PER_DAY; i++) {
      await insertJob(db, {
        id: `day-${i}`,
        requester: "ottodevs@gmail.com",
        spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
        specKey: "unused-key",
        status: "done",
        resultHash: "x",
        now,
      });
    }
    expect(await countJobsToday(db, "ottodevs@gmail.com", new Date(Date.now() - 86400000).toISOString())).toBe(MAX_JOBS_PER_DAY);
    const res = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "4000", deposit: "1000" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_JOB_LIMIT_DAILY");
  });

  test("3 queued at a time: the 4th distinct not-yet-run spec is refused with LAB_JOB_LIMIT_QUEUED, but a dedupe hit still goes through", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      await insertJob(db, {
        id: `q-${i}`,
        requester: "ottodevs@gmail.com",
        spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
        specKey: `q-${i}-key`,
        status: "queued",
        resultHash: null,
        now,
      });
    }
    // A brand-new spec would be a 4th queued slot: refused, and distinguishable from the daily cap.
    const blocked = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "6500", deposit: "1000" });
    expect(blocked.status).toBe(429);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("LAB_JOB_LIMIT_QUEUED");
    // An already-seeded spec resolves instantly to `done` and never touches the queued-slot limit.
    const dedupe = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "2000", deposit: "1000" });
    expect(dedupe.status).toBe(200);
    const body = (await dedupe.json()) as { job: { status: string } };
    expect(body.job.status).toBe("done");
  });
});

describe("GET /ops/lab/api/jobs/:id and /api/run/:hash", () => {
  test("job status round-trips id/status/resultHash/spec", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    await insertJob(db, {
      id: "job-x",
      requester: "ottodevs@gmail.com",
      spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
      specKey: "feb2025|live|2000|1000",
      status: "queued",
      resultHash: null,
      now: new Date().toISOString(),
    });
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/jobs/job-x", { headers: { cookie } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string; status: string } };
    expect(body.job.id).toBe("job-x");
    expect(body.job.status).toBe("queued");
    const job = await jobById(db, "job-x");
    expect(job?.status).toBe("queued");
  });

  test("an unknown job id is 404", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/jobs/does-not-exist", { headers: { cookie } }), env);
    expect(res.status).toBe(404);
  });

  test("GET /ops/lab/api/run/:hash returns the full run (ops+series+reasons), not just the summary", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/run/hash-feb-live-2000-1000", { headers: { cookie } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { ops: unknown[]; series: unknown[]; reasons: Record<string, number> } };
    expect(Array.isArray(body.run.ops)).toBe(true);
    expect(Array.isArray(body.run.series)).toBe(true);
    expect(body.run.reasons).toBeTruthy();
  });
});

// otto/mamoru-astro#30 (spec 008 phase 2): "Preguntar al Lab" — POST /api/ask, GET /api/threads(/:id).
async function postAsk(env: Env, cookie: string, csrf: string, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ csrf, ...fields }).toString();
  return worker.fetch(
    new Request("https://mamoru.lol/ops/lab/api/ask", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body }),
    env,
  );
}

describe("worker.ts: /ops/lab/api/ask and /api/threads(/:id) require the /ops session", () => {
  test("GET /api/threads and /api/threads/:id both refuse an unsigned session", async () => {
    const env = opsEnv(labDb());
    for (const path of ["/ops/lab/api/threads", "/ops/lab/api/threads/anything"]) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`), env);
      expect(res.status).not.toBe(200);
    }
  });

  test("POST /api/ask with no session is refused, not merely unauthenticated-but-processed", async () => {
    const env = opsEnv(labDb());
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/lab/api/ask", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "question=hola" }),
      env,
    );
    expect(res.status).not.toBe(201);
  });
});

describe("POST /ops/lab/api/ask: CSRF", () => {
  test("a wrong csrf token is refused (403) and creates no thread or job", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    const res = await postAsk(env, cookie, "not-the-real-token", { question: "¿Qué tal febrero?" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_CSRF_INVALID");
    const threads = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads", { headers: { cookie } }), env);
    expect(((await threads.json()) as { threads: unknown[] }).threads).toEqual([]);
  });
});

describe("POST /ops/lab/api/ask: contract", () => {
  test("a fresh question with no threadId creates a thread (title = the question) and a queued agent job", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const res = await postAsk(env, cookie, csrf, { question: "¿Qué habría pasado con 1.000 USDC en la caída de febrero 2025?", windowId: "feb2025" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { threadId: string; job: { id: string; status: string; question: string } };
    expect(body.job.status).toBe("queued");
    expect(body.job.question).toContain("1.000 USDC");

    const thread = await threadById(db, body.threadId);
    expect(thread?.owner).toBe("ottodevs@gmail.com");
    expect(thread?.title).toBe("¿Qué habría pasado con 1.000 USDC en la caída de febrero 2025?".slice(0, 60));

    const job = await jobById(db, body.job.id);
    expect(job?.kind).toBe("agent");
    expect(job?.threadId).toBe(body.threadId);
    expect(job?.specKey).toBe(`agent:${body.job.id}`);
  });

  test("an empty or over-length question is refused with LAB_ASK_INVALID, no thread or job created", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    for (const question of ["", "   ", "a".repeat(601)]) {
      const res = await postAsk(env, cookie, csrf, { question });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("LAB_ASK_INVALID");
    }
    const threads = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads", { headers: { cookie } }), env);
    expect(((await threads.json()) as { threads: unknown[] }).threads).toEqual([]);
  });

  test("a follow-up with an existing threadId reuses that thread and bumps it to the front of the picker", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const first = (await (await postAsk(env, cookie, csrf, { question: "primera" })).json()) as { threadId: string };
    const follow = await postAsk(env, cookie, csrf, { question: "segunda", threadId: first.threadId });
    expect(follow.status).toBe(201);
    const followBody = (await follow.json()) as { threadId: string };
    expect(followBody.threadId).toBe(first.threadId);

    const threadRes = await worker.fetch(new Request(`https://mamoru.lol/ops/lab/api/threads/${first.threadId}`, { headers: { cookie } }), env);
    const threadBody = (await threadRes.json()) as { jobs: { question: string }[] };
    expect(threadBody.jobs.map((j) => j.question)).toEqual(["primera", "segunda"]); // oldest first
  });

  test("a threadId owned by someone else is refused with LAB_THREAD_NOT_FOUND (never silently reparented)", async () => {
    const db = labDb();
    const env = opsEnv(db);
    await insertThread(db, { id: "someone-elses-thread", owner: "other@example.com", title: "t", now: new Date().toISOString() });
    const { cookie, csrf } = await sessionCookie();
    const res = await postAsk(env, cookie, csrf, { question: "q", threadId: "someone-elses-thread" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_THREAD_NOT_FOUND");
  });
});

describe("POST /ops/lab/api/ask: daily/queued limits are shared with the bench (kind-agnostic caps)", () => {
  test("a requester already at the daily cap from bench jobs is refused asking too", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_JOBS_PER_DAY; i++) {
      await insertJob(db, {
        id: `bench-${i}`,
        requester: "ottodevs@gmail.com",
        spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
        specKey: `k-${i}`,
        status: "done",
        resultHash: "hash-feb-live-2000-1000",
        now,
      });
    }
    const res = await postAsk(env, cookie, csrf, { question: "¿una más?" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_JOB_LIMIT_DAILY");
  });

  test("a requester already at the queued-slot cap from an in-flight bench job is refused asking too", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie, csrf } = await sessionCookie();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      await insertJob(db, {
        id: `queued-bench-${i}`,
        requester: "ottodevs@gmail.com",
        spec: { windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000 },
        specKey: `qk-${i}`,
        status: "queued",
        resultHash: null,
        now,
      });
    }
    const res = await postAsk(env, cookie, csrf, { question: "¿una más?" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("LAB_JOB_LIMIT_QUEUED");
  });
});

describe("GET /ops/lab/api/threads(/:id): ownership and run resolution", () => {
  test("threads are mine only, newest first by activity", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const { cookie } = await sessionCookie();
    await insertThread(db, { id: "mine-old", owner: "ottodevs@gmail.com", title: "vieja", now: "2026-01-01T00:00:00.000Z" });
    await insertThread(db, { id: "mine-new", owner: "ottodevs@gmail.com", title: "nueva", now: "2026-02-01T00:00:00.000Z" });
    await insertThread(db, { id: "not-mine", owner: "other@example.com", title: "ajena", now: "2026-03-01T00:00:00.000Z" });
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads", { headers: { cookie } }), env);
    const body = (await res.json()) as { threads: { id: string }[] };
    expect(body.threads.map((t) => t.id)).toEqual(["mine-new", "mine-old"]);
  });

  test("GET /api/threads/:id for a thread owned by someone else is 404, never leaks its jobs", async () => {
    const db = labDb();
    const env = opsEnv(db);
    await insertThread(db, { id: "ajeno", owner: "other@example.com", title: "t", now: new Date().toISOString() });
    const { cookie } = await sessionCookie();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads/ajeno", { headers: { cookie } }), env);
    expect(res.status).toBe(404);
  });

  test("a done job's claim/verdict runIds resolve into the response's runs map (AL-21 render support)", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const now = new Date().toISOString();
    await insertThread(db, { id: "t-runs", owner: "ottodevs@gmail.com", title: "t", now });
    await insertAgentJob(db, { id: "j-runs", requester: "ottodevs@gmail.com", threadId: "t-runs", question: "q", status: "done", now });
    const answer = {
      blocks: [
        { type: "verdict", runId: "hash-feb-live-2000-1000", against: "hold" },
        { type: "claim", metric: "fees", runId: "hash-feb-live-4000-1000", value: 1.5 },
      ],
    };
    await db.prepare("UPDATE lab_jobs SET answer_json = ? WHERE id = ?").bind(JSON.stringify(answer), "j-runs").run();

    const { cookie } = await sessionCookie();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads/t-runs", { headers: { cookie } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { id: string; answer: unknown }[]; runs: Record<string, { variantLabel: string }> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].answer).toEqual(answer);
    expect(Object.keys(body.runs).sort()).toEqual(["hash-feb-live-2000-1000", "hash-feb-live-4000-1000"]);
    expect(body.runs["hash-feb-live-2000-1000"].variantLabel).toBe("Política actual");
  });

  test("a job's cost is priced into shadowUsd when lab_prices has rows, omitted otherwise", async () => {
    const db = labDb();
    const env = opsEnv(db);
    const now = new Date().toISOString();
    await insertThread(db, { id: "t-cost", owner: "ottodevs@gmail.com", title: "t", now });
    await insertAgentJob(db, { id: "j-cost", requester: "ottodevs@gmail.com", threadId: "t-cost", question: "q", status: "done", now });
    const cost = { modelCalls: [{ model: "qwen3", promptTokens: 1000, completionTokens: 200 }], toolRounds: 1, runs: [], sweepCpuMs: 0, wallMs: 500, repairUsed: false, verifierOutcome: "ok" };
    await db.prepare("UPDATE lab_jobs SET answer_json = ?, cost_json = ? WHERE id = ?").bind(JSON.stringify({ blocks: [] }), JSON.stringify(cost), "j-cost").run();

    const { cookie } = await sessionCookie();
    const beforePrices = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads/t-cost", { headers: { cookie } }), env);
    const beforeBody = (await beforePrices.json()) as { jobs: { shadowUsd: number | null }[] };
    expect(beforeBody.jobs[0].shadowUsd).toBeNull();

    await db
      .prepare("INSERT INTO lab_prices (resource, unit, usd, valid_from) VALUES (?, ?, ?, ?)")
      .bind("model:qwen3", "input_per_mtok", 0.1, "2020-01-01T00:00:00.000Z")
      .run();
    const afterPrices = await worker.fetch(new Request("https://mamoru.lol/ops/lab/api/threads/t-cost", { headers: { cookie } }), env);
    const afterBody = (await afterPrices.json()) as { jobs: { shadowUsd: number | null }[] };
    expect(afterBody.jobs[0].shadowUsd).toBeCloseTo((1000 / 1_000_000) * 0.1, 10);
  });
});
