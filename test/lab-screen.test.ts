// otto/mamoru-astro#28: the screen API (B-06) behind the /ops session — session required, CSRF on the one POST
// route, job dedupe by spec_key, the daily/queued limits, and the B-03 dataset-missing check (coordinator note:
// a window whose dataset lacks a pool a base needs has no runs for that base; the screen refuses that (window,
// base) with LAB_DATASET_MISSING before a job is ever created).
import { describe, expect, test } from "bun:test";
import worker, { type Env } from "../src/worker";
import { openSession, sealSession } from "../src/ops";
import { labDb } from "./lab-fixture";
import { countJobsToday, insertJob, jobById } from "../src/lab-store";
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
  test("20 jobs/requester/day: the 21st in the window is refused with LAB_JOB_LIMIT (429)", async () => {
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
    expect(body.error).toBe("LAB_JOB_LIMIT");
  });

  test("3 queued at a time: the 4th distinct not-yet-run spec is refused, but a dedupe hit still goes through", async () => {
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
    // A brand-new spec would be a 4th queued slot: refused.
    const blocked = await postJob(env, cookie, csrf, { windowId: "feb2025", base: "live", widthTicks: "6500", deposit: "1000" });
    expect(blocked.status).toBe(429);
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
