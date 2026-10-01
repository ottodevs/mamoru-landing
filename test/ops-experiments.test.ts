import { describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { buildExperimentReport } from "../src/exp-report";
import type { ExperimentDef } from "../src/experiments";
import { sealSession } from "../src/ops";
import { experimentsSection } from "../src/ops-experiments";
import worker, { type Env } from "../src/worker";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function assets(): Fetcher {
  return { fetch: async () => new Response("asset") } as unknown as Fetcher;
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mamoru.lol${path}`, { headers: { "user-agent": BROWSER_UA, ...headers } });
}

async function sessionEnv(over: Partial<Env> = {}) {
  const env: Env = {
    ASSETS: assets(),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    ...over,
  };
  const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
  return { env, cookie };
}

/** exp_events pre-loaded with fixture rows so the ledger has real numbers to show. */
function fixtureDb(): D1Db {
  const rows = [
    ...Array.from({ length: 900 }, (_, i) => ({ experiment: "hero_cta", variant: "control", visitor: `c${i}`, event: "exposure" })),
    ...Array.from({ length: 900 }, (_, i) => ({ experiment: "hero_cta", variant: "b", visitor: `b${i}`, event: "exposure" })),
    ...Array.from({ length: 90 }, (_, i) => ({ experiment: "hero_cta", variant: "control", visitor: `c${i}`, event: "open_app_click" })),
    ...Array.from({ length: 144 }, (_, i) => ({ experiment: "hero_cta", variant: "b", visitor: `b${i}`, event: "open_app_click" })),
  ];
  return {
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
          const [experiment, event] = sql.includes("event = 'exposure'") ? [args[0] as string, "exposure"] : [args[0] as string, args[1] as string];
          const bucket = new Map<string, Set<string>>();
          for (const r of rows) {
            if (r.experiment !== experiment || r.event !== event) continue;
            if (!bucket.has(r.variant)) bucket.set(r.variant, new Set());
            bucket.get(r.variant)!.add(r.visitor);
          }
          return { results: [...bucket.entries()].map(([variant, visitors]) => ({ variant, n: visitors.size })) as T[], success: true };
        },
        async run() {
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
}

function missingTableDb(): D1Db {
  return {
    prepare() {
      const stmt = {
        bind: () => stmt,
        first: async () => {
          throw new Error("D1_ERROR: no such table: exp_events");
        },
        all: async () => {
          throw new Error("D1_ERROR: no such table: exp_events");
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
}

describe("/ops/experiments", () => {
  test("without a MAMORU_DB binding at all, the section says event data is not connected", async () => {
    const { env, cookie } = await sessionEnv();
    const res = await worker.fetch(get("/ops/experiments", { cookie }), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Event data is not connected on this deployment");
  });

  test("a missing exp_events table degrades the same way, never a 500", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: missingTableDb() });
    const res = await worker.fetch(get("/ops/experiments", { cookie }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Event data is not connected on this deployment");
  });

  test("declares the hero_cta experiment as draft, read-only, with a QA preview link per variant", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: missingTableDb() });
    const html = await (await worker.fetch(get("/ops/experiments", { cookie }), env)).text();
    expect(html).toContain("hero_cta");
    expect(html).toContain("Draft");
    expect(html).toContain("set in code and shipped by deploy");
  });

  test("with real fixture numbers: exposures, conversions, rate, and a verdict sentence", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: fixtureDb() });
    const html = await (await worker.fetch(get("/ops/experiments", { cookie }), env)).text();
    expect(html).toContain("900"); // exposures per variant
    expect(html).toContain("90"); // control conversions
    expect(html).toContain("144"); // variant b conversions
    expect(html).toContain("16.0%"); // b's conversion rate (144/900)
    expect(html).toContain("10.0%"); // control's conversion rate (90/900)
    expect(html).toMatch(/is ahead|is behind|No detectable difference/);
    expect(html).toContain('href="/?exp=hero_cta:control"');
    expect(html).toContain('href="/?exp=hero_cta:b"');
  });

  test("the goal column shows a human label, the raw event id as a title attribute, and the split as a percentage", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: fixtureDb() });
    const html = await (await worker.fetch(get("/ops/experiments", { cookie }), env)).text();
    expect(html).toContain('title="open_app_click">Opened the app</th>');
    expect(html).toContain(">50%<"); // split, per variant row — not the old raw weight "1"
  });

  test("fragment and document carry the same section body", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: fixtureDb() });
    const doc = await (await worker.fetch(get("/ops/experiments", { cookie }), env)).text();
    const view = (await (await worker.fetch(get("/ops/experiments", { cookie, "x-ops-fragment": "1" }), env)).json()) as {
      section: string;
      title: string;
      html: string;
    };
    expect(view.section).toBe("experiments");
    expect(view.title).toBe("Experiments");
    expect(doc).toContain(view.html);
  });

  test("markup is well-formed: every tag opened is closed", async () => {
    const { env, cookie } = await sessionEnv({ MAMORU_DB: fixtureDb() });
    const view = (await (await worker.fetch(get("/ops/experiments", { cookie, "x-ops-fragment": "1" }), env)).json()) as { html: string };
    expect(view.html).not.toMatch(/NaN|Infinity|undefined/);
    const stack: string[] = [];
    for (const m of view.html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
      const [, close, tag, rest] = m;
      if (rest.trimEnd().endsWith("/") || ["img", "br", "input", "link", "meta"].includes(tag)) continue;
      if (close) expect(stack.pop()).toBe(tag);
      else stack.push(tag);
    }
    expect(stack).toEqual([]);
  });
});

describe("display: an experiment past its endedAt reads as stopped, not running", () => {
  const PAST: ExperimentDef = {
    id: "fx_expired",
    description: "fixture",
    status: "running",
    path: "/fixture",
    variants: [
      { id: "control", weight: 1 },
      { id: "b", weight: 1 },
    ],
    goals: ["open_app_click"],
    endedAt: "2026-01-01",
  };
  const FUTURE: ExperimentDef = { ...PAST, id: "fx_not_yet_expired", endedAt: "2099-01-01" };
  const now = new Date("2026-06-01T00:00:00Z");

  test("shows 'Stopped' with the end date, not 'Running'", () => {
    const report = buildExperimentReport(PAST, null);
    const view = experimentsSection([report], now);
    expect(view.html).toContain("Stopped");
    expect(view.html).toContain("ended 2026-01-01");
    expect(view.html).not.toMatch(/>Running</);
  });

  test("an experiment whose endedAt has not passed still shows 'Running'", () => {
    const report = buildExperimentReport(FUTURE, null);
    const view = experimentsSection([report], now);
    expect(view.html).toContain("Running");
    expect(view.html).not.toContain("ended");
  });
});
