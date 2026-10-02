import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { experimentById, type ExperimentDef } from "../src/experiments";
import { escapeForInlineScript } from "../src/exp-rewrite";
import { sealSession } from "../src/ops";
import { signVisitorId, VISITOR_COOKIE } from "../src/exp-visitor";
import { STAGING_PROXY_HEADER } from "../src/staging-preview";
import type { WaitlistKv } from "../src/list";
import { sha256Hex } from "../src/text";
import worker, { type Env } from "../src/worker";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const HERO = experimentById("hero_cta")!;
const SECRET = "test-visitor-secret";

/** Pulls the bare visitor id out of a Set-Cookie header's signed `id.mac` value. */
function bareId(setCookie: string | null): string | undefined {
  const signed = (setCookie ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))?.[1];
  return signed?.slice(0, signed.lastIndexOf("."));
}

function fakeWaitlistKv(): WaitlistKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

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
    EXP_VISITOR_SECRET: SECRET,
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
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) },
    flush: () => Promise.all(tasks),
    count: () => tasks.length,
  };
}

/** Flips the shipped hero_cta experiment to running for one test, then restores it to draft. */
function withHeroRunning<T>(over: Partial<ExperimentDef>, fn: () => T | Promise<T>): Promise<T> {
  const mutable = HERO as unknown as { status: string; winner?: string; endedAt?: string };
  // Snapshot every field this helper (or `over`) might touch, so the restore below is complete —
  // a partial snapshot here once leaked `endedAt` across tests and silently broke everything after it.
  const before = { status: mutable.status, winner: mutable.winner, endedAt: mutable.endedAt };
  Object.assign(mutable, { status: "running", winner: undefined, endedAt: undefined, ...over });
  return Promise.resolve(fn()).finally(() => Object.assign(mutable, before));
}

/**
 * Captured once, verbatim, from `origin/main`'s worker.ts (before this branch
 * existed) via `git show origin/main:src/worker.ts` run against the exact
 * same mock ASSETS fixture used below (see
 * /tmp/.../golden-main/run.ts in that session — reproducible with
 * `git show origin/main:src/worker.ts` plus the fixture in assetsWithOpenPage()).
 * Nothing in src/exp-rewrite.ts may change a single byte of this when nothing
 * registered on "/" is running.
 */
const GOLDEN_MAIN_SLASH_RESPONSE = {
  status: 200,
  headers: {
    "cache-control": "public, max-age=0, must-revalidate, no-transform",
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-mamoru-home": "site",
  },
  body:
    '<!doctype html><html><head><title>Mamoru</title></head><body><header class="nav"><a class="cta nav-cta js-launch" href="https://app.mamoru.lol">Launch APP</a></header>' +
    '<section class="hero"><a class="cta js-launch" href="https://app.mamoru.lol" data-exp="hero_cta" data-exp-goal="open_app_click">Launch APP</a></section>' +
    "</body></html>",
};

describe("serving '/': draft experiment (shipped state) — byte-identical to origin/main", () => {
  test("the full response (status, headers, body) matches origin/main exactly: no set-cookie, no vary, no rewriter pass", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    const headers: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    const body = await res.text();
    expect(res.status).toBe(GOLDEN_MAIN_SLASH_RESPONSE.status);
    expect(headers).toEqual(GOLDEN_MAIN_SLASH_RESPONSE.headers);
    expect(body).toBe(GOLDEN_MAIN_SLASH_RESPONSE.body);
    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers.vary).toBeUndefined();
    expect(body).not.toContain("data-exp-variant");
    expect(body).not.toContain("<script");
  });

  test("the response stays publicly cacheable: no Vary, no private cache-control", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("public");
  });

  test("no identifier at all is minted or set: no cookie, nothing to need it for", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(res.headers.get("set-cookie")).toBeNull();
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
      const signedCookie = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))?.[1]!;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ experiment: "hero_cta", event: "exposure", visitor: bareId(res.headers.get("set-cookie")) });

      // A second visit the same day by the same visitor does not add a second row.
      const { ctx: ctx2, flush: flush2 } = ctxCollector();
      await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${signedCookie}` }), baseEnv({ MAMORU_DB: db }), ctx2 as never);
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

  test("a pinned winner is the page for everyone — GPC, DNT, and a bot see it too, not control", async () => {
    await withHeroRunning({ winner: "b" }, async () => {
      const gpc = await worker.fetch(get("/", { "sec-gpc": "1" }), baseEnv());
      const dnt = await worker.fetch(get("/", { dnt: "1" }), baseEnv());
      const bot = await worker.fetch(get("/", { "user-agent": "Googlebot/2.1" }), baseEnv());
      expect(await heroHtml(gpc)).toContain('data-exp-variant="b"');
      expect(await heroHtml(dnt)).toContain('data-exp-variant="b"');
      expect(await heroHtml(bot)).toContain('data-exp-variant="b"');
      // Still uniform and public: no identifier was needed to decide any of this.
      expect(gpc.headers.get("set-cookie")).toBeNull();
      expect(gpc.headers.get("vary")).toBeNull();
      expect(gpc.headers.get("cache-control")).toContain("public");
    });
  });

  test("a running, un-pinned experiment is private for an opted-out visitor too — a shared cache cannot tell them apart", async () => {
    await withHeroRunning({}, async () => {
      const gpc = await worker.fetch(get("/", { "sec-gpc": "1" }), baseEnv());
      const bot = await worker.fetch(get("/", { "user-agent": "Googlebot/2.1" }), baseEnv());
      expect(gpc.headers.get("cache-control")).toContain("no-store");
      expect(gpc.headers.get("vary")).toBe("Cookie");
      expect(bot.headers.get("cache-control")).toContain("no-store");
      expect(bot.headers.get("vary")).toBe("Cookie");
    });
  });

  test("an experiment past its endedAt with no winner is dead: byte-identical pass-through, same as draft", async () => {
    await withHeroRunning({ endedAt: "2020-01-01" }, async () => {
      const res = await worker.fetch(get("/"), baseEnv());
      const html = await heroHtml(res);
      expect(html).not.toContain("data-exp-variant");
      expect(html).not.toContain("<script");
      expect(res.headers.get("vary")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });

  test("an experiment past its endedAt with a winner pinned still serves the winner, not control", async () => {
    await withHeroRunning({ endedAt: "2020-01-01", winner: "b" }, async () => {
      const res = await worker.fetch(get("/"), baseEnv());
      expect(await heroHtml(res)).toContain('data-exp-variant="b"');
    });
  });

  test("the injected beacon script carries a CSP nonce attribute; the public page sends no CSP header to cover it yet", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/"), baseEnv());
      const html = await heroHtml(res);
      expect(html).toMatch(/<script nonce="[A-Za-z0-9_-]{10,}">/);
      // Documents the current, unchanged posture: do not loosen or fabricate a CSP here.
      expect(res.headers.get("content-security-policy")).toBeNull();
    });
  });

  test("the beacon script is never injected when nothing is running (draft) — same byte-identical rule", async () => {
    const res = await worker.fetch(get("/"), baseEnv());
    expect(await heroHtml(res)).not.toContain("<script");
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

describe("signed visitor cookie (end to end through worker.fetch)", () => {
  test("an unsigned cookie from a client is not trusted: treated as a brand-new visitor, a fresh signed id is minted", async () => {
    await withHeroRunning({}, async () => {
      const claimedId = "a".repeat(32);
      const res = await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${claimedId}` }), baseEnv());
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${VISITOR_COOKIE}=`);
      expect(bareId(setCookie)).not.toBe(claimedId);
    });
  });

  test("a cookie signed under a different secret is not trusted either", async () => {
    await withHeroRunning({}, async () => {
      const id = "b".repeat(32);
      const signed = await signVisitorId("some-other-secret", id);
      const res = await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${signed}` }), baseEnv());
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${VISITOR_COOKIE}=`);
      expect(bareId(setCookie)).not.toBe(id);
    });
  });

  test("a validly signed cookie is reused as-is: no new Set-Cookie on a repeat visit", async () => {
    await withHeroRunning({}, async () => {
      const first = await worker.fetch(get("/"), baseEnv());
      const signed = (first.headers.get("set-cookie") ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))?.[1]!;
      const again = await worker.fetch(get("/", { cookie: `${VISITOR_COOKIE}=${signed}` }), baseEnv());
      expect(again.headers.get("set-cookie")).toBeNull();
      expect(await heroHtml(again)).toContain(`data-exp-variant="${(await heroHtml(first)).includes('variant="b"') ? "b" : "control"}"`);
    });
  });

  test("without EXP_VISITOR_SECRET configured, no cookie is ever set — every visitor reads as unidentified", async () => {
    await withHeroRunning({}, async () => {
      const res = await worker.fetch(get("/"), baseEnv({ EXP_VISITOR_SECRET: undefined }));
      expect(res.headers.get("set-cookie")).toBeNull();
      // Served as control, same as any other visitor this Worker cannot identify.
      expect(await heroHtml(res)).toContain('data-exp-variant="control"');
    });
  });
});

describe("per-IP-prefix daily cap on new identities", () => {
  test("once a network's cap is reached, a fresh visitor from it reads as control with no cookie", async () => {
    await withHeroRunning({}, async () => {
      const kv = fakeWaitlistKv();
      const hash = (await sha256Hex(`${new Date().toISOString().slice(0, 10)}:203.0.113.0/24`)).slice(0, 32);
      kv.store.set(`exp-newid:${new Date().toISOString().slice(0, 10)}:${hash}`, "999999");
      const res = await worker.fetch(get("/", { "cf-connecting-ip": "203.0.113.55" }), baseEnv({ WAITLIST: kv }));
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await heroHtml(res)).toContain('data-exp-variant="control"');
    });
  });

  test("below the cap, a fresh visitor from that network is still minted normally", async () => {
    await withHeroRunning({}, async () => {
      const kv = fakeWaitlistKv();
      const res = await worker.fetch(get("/", { "cf-connecting-ip": "203.0.113.56" }), baseEnv({ WAITLIST: kv }));
      expect(res.headers.get("set-cookie") ?? "").toContain(VISITOR_COOKIE);
    });
  });

  test("an already-established, validly signed visitor is never throttled by the cap, even once it is reached", async () => {
    await withHeroRunning({}, async () => {
      const kv = fakeWaitlistKv();
      const day = new Date().toISOString().slice(0, 10);
      const hash = (await sha256Hex(`${day}:203.0.113.0/24`)).slice(0, 32);
      kv.store.set(`exp-newid:${day}:${hash}`, "999999");
      const id = "c".repeat(32);
      const signed = await signVisitorId(SECRET, id);
      const res = await worker.fetch(
        get("/", { "cf-connecting-ip": "203.0.113.57", cookie: `${VISITOR_COOKIE}=${signed}` }),
        baseEnv({ WAITLIST: kv }),
      );
      expect(res.headers.get("set-cookie")).toBeNull(); // already had a cookie: nothing new to set, and nothing throttled
      expect(await heroHtml(res)).toMatch(/data-exp-variant="(control|b)"/);
    });
  });
});

describe("escapeForInlineScript: safe to embed JSON inside <script>", () => {
  test("escapes <, >, & so a payload cannot break out of the script tag", () => {
    const out = escapeForInlineScript('{"a":"</script><img src=x onerror=alert(1)>&"}');
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
  });

  test("escapes U+2028 and U+2029 (valid JSON, invalid raw JS line terminators)", () => {
    const out = escapeForInlineScript('{"a":"  "}');
    expect(out).not.toContain(" ");
    expect(out).not.toContain(" ");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
  });

  test("leaves ordinary JSON untouched", () => {
    const out = escapeForInlineScript('{"hero_cta":"b"}');
    expect(out).toBe('{"hero_cta":"b"}');
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

describe("staging isolation: experiment writes never reach prod D1", () => {
  // Mirrors wrangler.toml's real [env.staging]: no d1_databases block at all, so there is no MAMORU_DB
  // binding to even attempt a write through — this is the invariant that makes the no-op guaranteed,
  // not just a runtime check.
  function stagingEnv(over: Partial<Env> = {}): Env {
    return baseEnv({
      DEPLOY_CHANNEL: "staging",
      STAGING_PROXY_SECRET: "shh-staging",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      MAMORU_DB: undefined,
      WAITLIST: undefined,
      ...over,
    });
  }

  test("a normal visit to staging's own '/' with a running experiment never calls ctx.waitUntil (no MAMORU_DB to write through)", async () => {
    await withHeroRunning({}, async () => {
      const { ctx, flush, count } = ctxCollector();
      const res = await worker.fetch(
        get("/", { [STAGING_PROXY_HEADER]: "shh-staging" }),
        stagingEnv(),
        ctx as never,
      );
      await flush();
      expect(res.status).toBe(200);
      expect(await heroHtml(res)).toMatch(/data-exp-variant="(control|b)"/);
      expect(count()).toBe(0);
    });
  });

  test("a QA-forced preview on staging also never calls ctx.waitUntil", async () => {
    await withHeroRunning({}, async () => {
      const { ctx, flush, count } = ctxCollector();
      const res = await worker.fetch(
        get("/?exp=hero_cta:b", { [STAGING_PROXY_HEADER]: "shh-staging" }),
        stagingEnv(),
        ctx as never,
      );
      await flush();
      expect(await heroHtml(res)).toContain('data-exp-variant="b"');
      expect(count()).toBe(0);
    });
  });
});
