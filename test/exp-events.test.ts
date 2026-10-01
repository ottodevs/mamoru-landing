import { afterEach, describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { EXPERIMENTS, assignVariant, type ExperimentDef } from "../src/experiments";
import { expNonce, handleExpEvent, recordWaitlistSubmit } from "../src/exp-events";
import { newVisitorId, VISITOR_COOKIE } from "../src/exp-visitor";
import type { WaitlistKv } from "../src/list";
import { sha256Hex } from "../src/text";
import worker from "../src/worker";

type Recorded = { experiment: string; variant: string; visitor: string; event: string; day: string };

function fakeDb() {
  const rows: Recorded[] = [];
  const db: D1Db = {
    prepare(sql: string) {
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

function fakeKv(): WaitlistKv & { store: Map<string, string> } {
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

function ctxCollector() {
  const tasks: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) }, flush: () => Promise.all(tasks) };
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://mamoru.lol/api/exp/event", {
    method: "POST",
    headers: { "user-agent": BROWSER_UA, ...headers },
    body: JSON.stringify(body),
  });
}

/** Mutates the live registry for one test, then restores it — EXPERIMENTS has no other seam for this. */
function withExperiment<T>(def: ExperimentDef, fn: () => T | Promise<T>): Promise<T> {
  const mutable = EXPERIMENTS as unknown as ExperimentDef[];
  mutable.push(def);
  return Promise.resolve(fn()).finally(() => {
    const i = mutable.indexOf(def);
    if (i >= 0) mutable.splice(i, 1);
  });
}

const FIXTURE: ExperimentDef = {
  id: "fx_running",
  description: "fixture",
  status: "running",
  path: "/fixture",
  variants: [
    { id: "control", weight: 1 },
    { id: "b", weight: 1 },
  ],
  goals: ["open_app_click", "waitlist_submit"],
};

describe("handleExpEvent", () => {
  test("rejects a non-POST request", async () => {
    const { db } = fakeDb();
    const res = await handleExpEvent(new Request("https://mamoru.lol/api/exp/event"), { MAMORU_DB: db });
    expect(res.status).toBe(405);
  });

  test("always answers 204 for a POST, whether or not anything was recorded", async () => {
    const { db } = fakeDb();
    const res = await handleExpEvent(post({ experiment: "nope" }), { MAMORU_DB: db });
    expect(res.status).toBe(204);
  });

  test("records a valid beacon for the visitor's actual assignment", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const res = await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" },
          { cookie: `${VISITOR_COOKIE}=${visitorId}` },
        ),
        { MAMORU_DB: db },
        ctx,
      );
      await flush();
      expect(res.status).toBe(204);
      expect(rows).toEqual([{ experiment: FIXTURE.id, variant, visitor: visitorId, event: "open_app_click", day: rows[0]?.day }]);
    });
  });

  test("ignored: unknown experiment", async () => {
    const { db, rows } = fakeDb();
    const visitorId = newVisitorId();
    await handleExpEvent(
      post({ experiment: "ghost", variant: "control", event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
      { MAMORU_DB: db },
    );
    expect(rows).toHaveLength(0);
  });

  test("ignored: event not one of the experiment's declared goals", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: "control", event: "not_a_goal", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: variant is not one of the experiment's variants", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: "z", event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: reported variant does not match this visitor's actual assignment (no spoofing a win)", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      const real = assignVariant(FIXTURE, visitorId);
      const other = FIXTURE.variants.find((v) => v.id !== real)!.id;
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: other, event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: GPC, DNT, or a bot user-agent", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const body = { experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" };
      const cookie = `${VISITOR_COOKIE}=${visitorId}`;
      await handleExpEvent(post(body, { cookie, "sec-gpc": "1" }), { MAMORU_DB: db });
      await handleExpEvent(post(body, { cookie, dnt: "1" }), { MAMORU_DB: db });
      await handleExpEvent(post(body, { cookie, "user-agent": "Googlebot" }), { MAMORU_DB: db });
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: no visitor cookie at all", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      await handleExpEvent(post({ experiment: FIXTURE.id, variant: "control", event: "open_app_click", nonce: "" }), { MAMORU_DB: db });
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: cross-origin Origin header", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" },
          { cookie: `${VISITOR_COOKIE}=${visitorId}`, origin: "https://evil.example" },
        ),
        { MAMORU_DB: db },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("same-origin Origin header is accepted", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" },
          { cookie: `${VISITOR_COOKIE}=${visitorId}`, origin: "https://mamoru.lol" },
        ),
        { MAMORU_DB: db },
      );
      expect(rows).toHaveLength(1);
    });
  });

  test("with OPS_SESSION_SECRET set, a wrong nonce is ignored and the right one (expNonce) is accepted", async () => {
    await withExperiment(FIXTURE, async () => {
      const secret = "test-secret";
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const cookie = `${VISITOR_COOKIE}=${visitorId}`;

      const { db: wrongDb, rows: wrongRows } = fakeDb();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "bogus" }, { cookie }),
        { MAMORU_DB: wrongDb, OPS_SESSION_SECRET: secret },
      );
      expect(wrongRows).toHaveLength(0);

      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(secret, visitorId, day);
      const { db: rightDb, rows: rightRows } = fakeDb();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie }),
        { MAMORU_DB: rightDb, OPS_SESSION_SECRET: secret },
      );
      expect(rightRows).toHaveLength(1);
    });
  });

  test("rate-limited per visitor: a visitor already at the cap is dropped", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const kv = fakeKv();
      // Prime the bucket past any plausible cap, replicating bumpedLimit's own key shape.
      const hex = (await sha256Hex(`exp-evt:${visitorId}`)).slice(0, 32);
      kv.store.set(`exp-evt:${hex}`, "999999");
      const { db, rows } = fakeDb();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db, WAITLIST: kv },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("not rate-limited below the cap", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const kv = fakeKv();
      const { db, rows } = fakeDb();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db, WAITLIST: kv },
      );
      expect(rows).toHaveLength(1);
    });
  });
});

describe("recordWaitlistSubmit", () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request("https://mamoru.lol/api/notify", { method: "POST", headers: { "user-agent": BROWSER_UA, ...headers } });
  }

  test("records waitlist_submit for a running experiment that declares the goal, under this visitor's own assignment", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      const visitorId = newVisitorId();
      recordWaitlistSubmit(req({ cookie: `${VISITOR_COOKIE}=${visitorId}` }), { MAMORU_DB: db }, ctx);
      await flush();
      const expected = assignVariant(FIXTURE, visitorId);
      expect(rows.some((r) => r.experiment === FIXTURE.id && r.event === "waitlist_submit" && r.variant === expected && r.visitor === visitorId)).toBe(true);
    });
  });

  test("does not record for an experiment that does not declare waitlist_submit", async () => {
    const other: ExperimentDef = { ...FIXTURE, id: "fx_no_waitlist", goals: ["open_app_click"] };
    await withExperiment(other, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: `${VISITOR_COOKIE}=${newVisitorId()}` }), { MAMORU_DB: db }, ctx);
      await flush();
      expect(rows.some((r) => r.experiment === other.id)).toBe(false);
    });
  });

  test("does not record for a draft experiment, even if it declares the goal", async () => {
    const draft: ExperimentDef = { ...FIXTURE, id: "fx_draft", status: "draft" };
    await withExperiment(draft, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: `${VISITOR_COOKIE}=${newVisitorId()}` }), { MAMORU_DB: db }, ctx);
      await flush();
      expect(rows.some((r) => r.experiment === draft.id)).toBe(false);
    });
  });

  test("a declined visitor (GPC) is never recorded", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: `${VISITOR_COOKIE}=${newVisitorId()}`, "sec-gpc": "1" }), { MAMORU_DB: db }, ctx);
      await flush();
      expect(rows).toHaveLength(0);
    });
  });
});

describe("waitlist_submit, end to end through POST /api/notify", () => {
  function fakeWaitlistKv() {
    const store = new Map<string, string>();
    return {
      store,
      kv: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
        list: async (o: { prefix: string }) => ({
          keys: [...store.keys()].filter((k) => k.startsWith(o.prefix)).map((name) => ({ name })),
          list_complete: true,
        }),
      },
    };
  }

  test("a genuinely new signup records the goal for the visitor's own assignment; a client cannot spoof it by posting to the beacon instead", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const { kv } = fakeWaitlistKv();
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const req = new Request("https://mamoru.lol/api/notify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
          "user-agent": BROWSER_UA,
          cookie: `${VISITOR_COOKIE}=${visitorId}`,
        },
        body: JSON.stringify({ email: "exp-notify-test@example.com", leave_blank: "" }),
      });
      const tasks: Promise<unknown>[] = [];
      const res = await worker.fetch(req, { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } as unknown as Fetcher, WAITLIST: kv, MAMORU_DB: db }, {
        waitUntil: (p: Promise<unknown>) => void tasks.push(p),
      } as never);
      await Promise.all(tasks);
      expect(res.status).toBe(200);
      expect(rows.some((r) => r.experiment === FIXTURE.id && r.event === "waitlist_submit" && r.variant === variant && r.visitor === visitorId)).toBe(true);
    });
  });

  test("an already-saved address (not a new signup) never records the goal", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const { kv } = fakeWaitlistKv();
      const visitorId = newVisitorId();
      const headers = {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": BROWSER_UA,
        cookie: `${VISITOR_COOKIE}=${visitorId}`,
      };
      const body = JSON.stringify({ email: "already-on-list@example.com", leave_blank: "" });
      const env = { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } as unknown as Fetcher, WAITLIST: kv, MAMORU_DB: db };
      await worker.fetch(new Request("https://mamoru.lol/api/notify", { method: "POST", headers, body }), env);
      rows.length = 0;
      await worker.fetch(new Request("https://mamoru.lol/api/notify", { method: "POST", headers, body }), env);
      expect(rows).toHaveLength(0);
    });
  });
});

afterEach(() => {
  // Defensive: any withExperiment() that threw mid-test still leaves the registry clean for the next one.
  const mutable = EXPERIMENTS as unknown as ExperimentDef[];
  for (let i = mutable.length - 1; i >= 0; i--) {
    if (mutable[i].id.startsWith("fx_")) mutable.splice(i, 1);
  }
});
