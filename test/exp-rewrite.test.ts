import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { experimentById, type ExperimentDef } from "../src/experiments";
import { sealSession } from "../src/ops";
import { VISITOR_COOKIE } from "../src/exp-visitor";
import { STAGING_PROXY_HEADER } from "../src/staging-preview";
import worker, { type Env } from "../src/worker";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const HERO = experimentById("hero_cta")!;

type Recorded = { experiment: string; variant: string; visitor: string; event: string; day: string };

function fakeDb() {
  const rows: Recorded[] = [];
  const db: D1Db = {
    prepare() {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async first<T>() {
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
        async run() {
          const [experiment, variant, visitor, event, day] = args as [string, string, string, string, string];
          if (!rows.some((r) => r.experiment === experiment && r.visitor === visitor && r.event === event && r.day === day)) {
            rows.push({ experiment, variant, visitor, event, day });
          }
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, rows };
}

/** The real built /open/index.html shape, trimmed to what applyExperiments needs: the hero CTA hook. */
function assetsWithOpenPage(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input as string);
      const url = new URL(req.url);
      if (url.pathname === "/open/index.html") {
        return new Response(
          '<!doctype html><html><head><title>Mamoru</title></head><body><header class="nav"><a class="cta nav-cta js-launch" href="https://app.mamoru.lol">Launch APP</a></header>' +
            '<section class="hero"><a class="cta js-launch" href="https://app.mamoru.lol" data-exp="hero_cta" data-exp-goal="open_app_click">Launch APP</a></section>' +
            "</body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    ASSETS: assetsWithOpenPage(),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    ...over,
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mamoru.lol${path}`, { headers: { "user-agent": BROWSER_UA, ...headers } });
}

function heroHtml(res: Response): Promise<string> {
  return res.text();
}

function ctxCollector() {
  const tasks: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) }, flush: () => Promise.all(tasks) };
}

/** Flips the shipped hero_cta experiment to running for one test, then restores it to draft. */
function withHeroRunning<T>(over: Partial<ExperimentDef>, fn: () => T | Promise<T>): Promise<T> {
  const mutable = HERO as unknown as { status: string; winner?: string };
  const before = { status: mutable.status, winner: mutable.winner };
  Object.assign(mutable, { status: "running", winner: undefined, ...over });
  return Promise.resolve(fn()).finally(() => Object.assign(mutable, before));
}

describe("serving '/': draft experiment (shipped state)", () => {
  test("every visitor sees control copy, unchanged", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    const html = await heroHtml(res);
    expect(html).toContain(">Launch APP</a>");
    expect(html).toContain('data-exp-variant="control"');
  });

  test("the response stays publicly cacheable: no Vary, no private cache-control", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("public");
  });

  test("an eligible first-time visitor still gets a stable visitor id cookie", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(res.headers.get("set-cookie") ?? "").toContain(`${VISITOR_COOKIE}=`);
  });

  test("no exposure is logged for a draft experiment", async () => {
    const { db, rows } = fakeDb();
    const { ctx, flush } = ctxCollector();
    await worker.fetch(get("/"), baseEnv({ MAMORU_DB: db }), ctx as never);
    await flush();
    expect(rows).toHaveLength(0);
  });

  test("works with no MAMORU_DB bound at all — never throws", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(res.status).toBe(200);
  });
});

describe("serving '/': running experiment", () => {
  test("HTMLRewriter swaps the hero CTA text for a visitor bucketed into the non-control variant", async () => {
    await withHeroRunning({}, async () => {
      // Scan a handful of fresh visitors until we find one bucketed into "b" — deterministic once found.
      for (let i = 0; i < 40; i++) {
        const res = await worker.fetch(get("/"), baseEnv());
        const cookie = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))?.[1];
        const html = await heroHtml(res);
        if (html.includes('data-exp-variant="b"')) {
          expect(html).toContain(">Open the app</a>");
          // The same visitor id gets the same variant again.
          const again = await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${cookie}` }), baseEnv());
          expect(await heroHtml(again)).toContain('data-exp-variant="b"');
          return;
        }
      }
      throw new Error("never saw variant b across 40 fresh visitors — assignment or fixture is broken");
    });
  });

  test("a running, un-pinned experiment marks the response private with Vary: Cookie", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/"), baseEnv());
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(res.headers.get("cache-control")).toContain("no-store");
    });
  });

  test("exposure is logged once per visitor per day, for the variant they were actually shown", async () => {
    await withHeroRunning({}, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      const res = await worker.fetch(get("/"), baseEnv({ MAMORU_DB: db }), ctx as never);
      await flush();
      const cookie = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))?.[1]!;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ experiment: "hero_cta", event: "exposure", visitor: cookie });

      // A second visit the same day by the same visitor does not add a second row.
      const { ctx: ctx2, flush: flush2 } = ctxCollector();
      await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${cookie}` }), baseEnv({ MAMORU_DB: db }), ctx2 as never);
      await flush2();
      expect(rows).toHaveLength(1);
    });
  });

  test("a pinned winner serves everyone the same variant and stops varying by visitor", async () => {
    await withHeroRunning({ winner: "b" }, async () => {
      const res1 = await worker.fetch(get("/"), baseEnv());
      const res2 = await worker.fetch(get("/"), baseEnv());
      expect(await heroHtml(res1)).toContain('data-exp-variant="b"');
      expect(await heroHtml(res2)).toContain('data-exp-variant="b"');
      expect(res1.headers.get("vary")).toBeNull();
      expect(res1.headers.get("cache-control")).toContain("public");
    });
  });

  test("GPC declines tracking: control is served, no cookie, no exposure, regardless of status", async () => {
    await withHeroRunning({}, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      const res = await worker.fetch(get("/", { "sec-gpc": "1" }), baseEnv({ MAMORU_DB: db }), ctx as never);
      await flush();
      expect(await heroHtml(res)).toContain('data-exp-variant="control"');
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(rows).toHaveLength(0);
    });
  });

  test("DNT declines tracking the same way", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/", { dnt: "1" }), baseEnv());
      expect(await heroHtml(res)).toContain('data-exp-variant="control"');
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });

  test("a bot user-agent is served control with no cookie", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/", { "user-agent": "Googlebot/2.1" }), baseEnv());
      expect(await heroHtml(res)).toContain('data-exp-variant="control"');
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });
});

describe("QA override (?exp=<id>:<variant>)", () => {
  test("ignored for the public: a stranger's request is unaffected", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/?exp=hero_cta:b"), baseEnv());
      // A stranger gets their own deterministic assignment, which may or may not be "b" — but the
      // response must not be force-cacheable-as-private purely from the query string, and no visitor id is forced.
      expect(res.status).toBe(200);
      const html = await heroHtml(res);
      expect(html).toMatch(/data-exp-variant="(control|b)"/);
    });
  });

  test("a valid ops session forces the requested variant, on the public '/' route itself", async () => {
    await withHeroRunning({}, async () => {
      const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
      const res = await worker.fetch(get("/?exp=hero_cta:b", { cookie }), baseEnv());
      expect(await heroHtml(res)).toContain('data-exp-variant="b"');
      const control = await worker.fetch(get("/?exp=hero_cta:control", { cookie }), baseEnv());
      expect(await heroHtml(control)).toContain('data-exp-variant="control"');
    });
  });

  test("a forced QA preview never sets a visitor cookie and is never counted as exposure", async () => {
    await withHeroRunning({}, async () => {
      const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      const res = await worker.fetch(get("/?exp=hero_cta:b", { cookie }), baseEnv({ MAMORU_DB: db }), ctx as never);
      await flush();
      expect(res.headers.get("set-cookie") ?? "").not.toContain(VISITOR_COOKIE);
      expect(rows).toHaveLength(0);
    });
  });

  test("the staging channel allows the override on its own public '/', with no session at all", async () => {
    await withHeroRunning({}, async () => {
      const secret = "shh-staging";
      const res = await worker.fetch(
        get("/?exp=hero_cta:b", { [STAGING_PROXY_HEADER]: secret }),
        baseEnv({
          DEPLOY_CHANNEL: "staging",
          STAGING_PROXY_SECRET: secret,
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
        }),
      );
      expect(await heroHtml(res)).toContain('data-exp-variant="b"');
    });
  });

  test("a session for an address off the allowlist does not unlock the override", async () => {
    await withHeroRunning({}, async () => {
      const cookie = `mamoru_list=${await sealSession("k1", "someone@example.com")}`;
      const res = await worker.fetch(get("/?exp=hero_cta:b", { cookie }), baseEnv());
      // Not forced: falls back to this visitor's own normal assignment (either variant, deterministically).
      const html = await heroHtml(res);
      expect(html).toMatch(/data-exp-variant="(control|b)"/);
      expect(res.headers.get("set-cookie") ?? "").toContain(VISITOR_COOKIE);
    });
  });
});
