import { afterEach, describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { EXPERIMENTS, assignVariant, type ExperimentDef } from "../src/experiments";
import { expNonce, handleExpEvent, recordWaitlistSubmit } from "../src/exp-events";
import { newVisitorId, signVisitorId, VISITOR_COOKIE } from "../src/exp-visitor";
import type { WaitlistKv } from "../src/list";
import { sha256Hex } from "../src/text";
import worker from "../src/worker";

const SECRET = "test-visitor-secret";

type Recorded = { experiment: string; variant: string; visitor: string; event: string; day: string };

/** A tiny in-memory exp_events table: records writes and answers hasExposure()'s LIMIT 1 query. */
function fakeDb(seed: Recorded[] = []) {
  const rows: Recorded[] = [...seed];
  const db: D1Db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async first<T>() {
          if (sql.includes("LIMIT 1")) {
            const [experiment, visitor, variant] = args as [string, string, string];
            const found = rows.some(
              (r) => r.experiment === experiment && r.visitor === visitor && r.variant === variant && r.event === "exposure",
            );
            return (found ? { x: 1 } : null) as T | null;
          }
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

/** An exposure row for (experiment, visitor, variant), today — what applyExperiments() would have written when it served that variant. */
function exposureRow(experiment: string, visitor: string, variant: string): Recorded {
  return { experiment, variant, visitor, event: "exposure", day: new Date().toISOString().slice(0, 10) };
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
    headers: { "user-agent": BROWSER_UA, origin: "https://mamoru.lol", ...headers },
    body: JSON.stringify(body),
  });
}

async function cookieFor(visitorId: string): Promise<string> {
  return `${VISITOR_COOKIE}=${await signVisitorId(SECRET, visitorId)}`;
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
  goals: [
    { name: "open_app_click", source: "client" },
    { name: "waitlist_submit", source: "server" },
  ],
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

  test("records a valid beacon for a visitor with a recorded exposure to that exact variant", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const { ctx, flush } = ctxCollector();
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const res = await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce },
          { cookie: await cookieFor(visitorId) },
        ),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
        ctx,
      );
      await flush();
      expect(res.status).toBe(204);
      expect(rows.filter((r) => r.event === "open_app_click")).toEqual([
        { experiment: FIXTURE.id, variant, visitor: visitorId, event: "open_app_click", day },
      ]);
    });
  });

  test("ignored: unknown experiment", async () => {
    const { db, rows } = fakeDb();
    const visitorId = newVisitorId();
    await handleExpEvent(
      post({ experiment: "ghost", variant: "control", event: "open_app_click", nonce: "" }, { cookie: await cookieFor(visitorId) }),
      { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
    );
    expect(rows).toHaveLength(0);
  });

  test("ignored: event not one of the experiment's declared goals", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: "control", event: "not_a_goal", nonce: "" }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: a server-only goal (waitlist_submit) is refused even with a valid exposure row and nonce", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "waitlist_submit", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "waitlist_submit")).toHaveLength(0);
    });
  });

  test("ignored: variant is not one of the experiment's variants", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      const visitorId = newVisitorId();
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: "z", event: "open_app_click", nonce: "" }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: no recorded exposure for this (visitor, variant) — nothing to prove the variant was ever shown", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb(); // no seeded exposure
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: exposed to one variant, claims an event for the other — no spoofing a win", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const real = assignVariant(FIXTURE, visitorId);
      const other = FIXTURE.variants.find((v) => v.id !== real)!.id;
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, real)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant: other, event: "open_app_click", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("ignored: GPC, DNT, or a bot user-agent", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const body = { experiment: FIXTURE.id, variant, event: "open_app_click", nonce };
      const cookie = await cookieFor(visitorId);
      const env = { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET };
      await handleExpEvent(post(body, { cookie, "sec-gpc": "1" }), env);
      await handleExpEvent(post(body, { cookie, dnt: "1" }), env);
      await handleExpEvent(post(body, { cookie, "user-agent": "Googlebot" }), env);
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("ignored: no visitor cookie at all", async () => {
    await withExperiment(FIXTURE, async () => {
      const { db, rows } = fakeDb();
      await handleExpEvent(post({ experiment: FIXTURE.id, variant: "control", event: "open_app_click", nonce: "" }), {
        MAMORU_DB: db,
        EXP_VISITOR_SECRET: SECRET,
      });
      expect(rows).toHaveLength(0);
    });
  });

  test("ignored: an unsigned cookie (no EXP_VISITOR_SECRET configured) — nothing is ever a valid visitor without it", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" }, { cookie: `${VISITOR_COOKIE}=${visitorId}` }),
        { MAMORU_DB: db }, // no EXP_VISITOR_SECRET
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("ignored: cross-origin Origin header", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "" },
          { cookie: await cookieFor(visitorId), origin: "https://evil.example" },
        ),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("ignored: neither Origin nor Sec-Fetch-Site present — refused, not waved through", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const req = new Request("https://mamoru.lol/api/exp/event", {
        method: "POST",
        headers: { "user-agent": BROWSER_UA, cookie: await cookieFor(visitorId) },
        body: JSON.stringify({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }),
      });
      await handleExpEvent(req, { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET });
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("accepted with Sec-Fetch-Site: same-origin and no Origin header", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const req = new Request("https://mamoru.lol/api/exp/event", {
        method: "POST",
        headers: {
          "user-agent": BROWSER_UA,
          "sec-fetch-site": "same-origin",
          cookie: await cookieFor(visitorId),
        },
        body: JSON.stringify({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }),
      });
      await handleExpEvent(req, { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET });
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(1);
    });
  });

  test("same-origin Origin header is accepted", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post(
          { experiment: FIXTURE.id, variant, event: "open_app_click", nonce },
          { cookie: await cookieFor(visitorId), origin: "https://mamoru.lol" },
        ),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(1);
    });
  });

  test("with EXP_VISITOR_SECRET set, a wrong nonce is ignored and the right one (expNonce) is accepted", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const cookie = await cookieFor(visitorId);

      const { db: wrongDb, rows: wrongRows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce: "bogus" }, { cookie }),
        { MAMORU_DB: wrongDb, EXP_VISITOR_SECRET: SECRET },
      );
      expect(wrongRows.filter((r) => r.event === "open_app_click")).toHaveLength(0);

      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const { db: rightDb, rows: rightRows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie }),
        { MAMORU_DB: rightDb, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rightRows.filter((r) => r.event === "open_app_click")).toHaveLength(1);
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
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, WAITLIST: kv, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("not rate-limited below the cap", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const kv = fakeKv();
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, WAITLIST: kv, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(1);
    });
  });

  test("a draft experiment: no work is done, even for a client claiming its deterministic control assignment", async () => {
    const draft: ExperimentDef = { ...FIXTURE, id: "fx_draft_evt", status: "draft" };
    await withExperiment(draft, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(draft.id, visitorId, "control")]);
      const res = await handleExpEvent(
        post({ experiment: draft.id, variant: "control", event: "open_app_click", nonce: "" }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect([204, 404]).toContain(res.status);
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("a stopped experiment: no work is done", async () => {
    const stopped: ExperimentDef = { ...FIXTURE, id: "fx_stopped_evt", status: "stopped" };
    await withExperiment(stopped, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(stopped.id, visitorId, "control")]);
      await handleExpEvent(
        post({ experiment: stopped.id, variant: "control", event: "open_app_click", nonce: "" }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("a running experiment past its endedAt: no work is done (behaves as stopped)", async () => {
    const expired: ExperimentDef = { ...FIXTURE, id: "fx_expired_evt", status: "running", endedAt: "2020-01-01" };
    await withExperiment(expired, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(expired.id, visitorId, "control")]);
      await handleExpEvent(
        post({ experiment: expired.id, variant: "control", event: "open_app_click", nonce: "" }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(rows.filter((r) => r.event === "open_app_click")).toHaveLength(0);
    });
  });

  test("never sets a cookie itself, on any outcome", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const day = new Date().toISOString().slice(0, 10);
      const nonce = await expNonce(SECRET, visitorId, day);
      const ok = await handleExpEvent(
        post({ experiment: FIXTURE.id, variant, event: "open_app_click", nonce }, { cookie: await cookieFor(visitorId) }),
        { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET },
      );
      expect(ok.headers.get("set-cookie")).toBeNull();
      const rejected = await handleExpEvent(post({ experiment: "ghost" }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET });
      expect(rejected.headers.get("set-cookie")).toBeNull();
    });
  });
});

describe("recordWaitlistSubmit", () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request("https://mamoru.lol/api/notify", { method: "POST", headers: { "user-agent": BROWSER_UA, ...headers } });
  }

  test("records waitlist_submit for a running experiment with a server goal, only for a visitor already exposed to that variant", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const expected = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, expected)]);
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: await cookieFor(visitorId) }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(
        rows.some((r) => r.experiment === FIXTURE.id && r.event === "waitlist_submit" && r.variant === expected && r.visitor === visitorId),
      ).toBe(true);
    });
  });

  test("does not record when the visitor has no recorded exposure to this experiment", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb(); // no exposure seeded
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: await cookieFor(visitorId) }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(rows.some((r) => r.event === "waitlist_submit")).toBe(false);
    });
  });

  test("does not record for an experiment whose waitlist_submit goal is not declared", async () => {
    const other: ExperimentDef = { ...FIXTURE, id: "fx_no_waitlist", goals: [{ name: "open_app_click", source: "client" }] };
    await withExperiment(other, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(other.id, visitorId, "control")]);
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: await cookieFor(visitorId) }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(rows.some((r) => r.experiment === other.id && r.event === "waitlist_submit")).toBe(false);
    });
  });

  test("does not record for a draft experiment, even if it declares the goal", async () => {
    const draft: ExperimentDef = { ...FIXTURE, id: "fx_draft", status: "draft" };
    await withExperiment(draft, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(draft.id, visitorId, "control")]);
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: await cookieFor(visitorId) }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(rows.some((r) => r.experiment === draft.id && r.event === "waitlist_submit")).toBe(false);
    });
  });

  test("a declined visitor (GPC) is never recorded", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, "control")]);
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: await cookieFor(visitorId), "sec-gpc": "1" }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(rows.filter((r) => r.event === "waitlist_submit")).toHaveLength(0);
    });
  });

  test("an unsigned/invalid cookie records nothing — never trusted enough to attribute a goal", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, "control")]);
      const { ctx, flush } = ctxCollector();
      recordWaitlistSubmit(req({ cookie: `${VISITOR_COOKIE}=${visitorId}` }), { MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET }, ctx);
      await flush();
      expect(rows.filter((r) => r.event === "waitlist_submit")).toHaveLength(0);
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

  test("a genuinely new signup records the goal for a visitor already exposed; a client cannot spoof it by posting to the beacon instead", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const variant = assignVariant(FIXTURE, visitorId);
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, variant)]);
      const { kv } = fakeWaitlistKv();
      const req = new Request("https://mamoru.lol/api/notify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
          "user-agent": BROWSER_UA,
          cookie: await cookieFor(visitorId),
        },
        body: JSON.stringify({ email: "exp-notify-test@example.com", leave_blank: "" }),
      });
      const tasks: Promise<unknown>[] = [];
      const res = await worker.fetch(
        req,
        {
          ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } as unknown as Fetcher,
          WAITLIST: kv,
          MAMORU_DB: db,
          EXP_VISITOR_SECRET: SECRET,
        },
        { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } as never,
      );
      await Promise.all(tasks);
      expect(res.status).toBe(200);
      expect(
        rows.some((r) => r.experiment === FIXTURE.id && r.event === "waitlist_submit" && r.variant === variant && r.visitor === visitorId),
      ).toBe(true);
    });
  });

  test("an already-saved address (not a new signup) never records the goal", async () => {
    await withExperiment(FIXTURE, async () => {
      const visitorId = newVisitorId();
      const { db, rows } = fakeDb([exposureRow(FIXTURE.id, visitorId, "control")]);
      const { kv } = fakeWaitlistKv();
      const headers = {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": BROWSER_UA,
        cookie: await cookieFor(visitorId),
      };
      const body = JSON.stringify({ email: "already-on-list@example.com", leave_blank: "" });
      const env = { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } as unknown as Fetcher, WAITLIST: kv, MAMORU_DB: db, EXP_VISITOR_SECRET: SECRET };
      await worker.fetch(new Request("https://mamoru.lol/api/notify", { method: "POST", headers, body }), env);
      rows.length = 0;
      await worker.fetch(new Request("https://mamoru.lol/api/notify", { method: "POST", headers, body }), env);
      expect(rows.filter((r) => r.event === "waitlist_submit")).toHaveLength(0);
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
