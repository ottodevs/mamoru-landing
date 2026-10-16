import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import { BOUNDS, DEFAULT_SETTINGS, canonicalJson, riskyChanges, settingsFromForm, validateSettings, type EngineSettings } from "../src/engine-settings-model";
import { appendVersion, listVersions } from "../src/engine-settings-store";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

/** The tables of migration 0011 in ottodevs/mamoru, so these tests run without that repo. */
const SCHEMA = `
CREATE TABLE engine_settings_templates (name TEXT PRIMARY KEY, settings_json TEXT NOT NULL, source TEXT NOT NULL, note TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE engine_settings_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, env TEXT NOT NULL CHECK (env IN ('prod','beta')), account_keys_json TEXT, template TEXT NOT NULL, settings_json TEXT NOT NULL, settings_hash TEXT NOT NULL, author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, rollback_of INTEGER);
INSERT INTO engine_settings_templates VALUES ('conservador-live-v2 (today)', '{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}', 'seed', null, 'migration', '2026-10-16T00:00:00Z');
INSERT INTO engine_settings_templates VALUES ('conservador + depth 30/500/5, cap 1000', '{"capUsdc":1000,"depth":{"impactBps":30,"shareBps":500,"stablesImpactBps":5},"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}', 'seed', null, 'migration', '2026-10-16T00:00:00Z');
`;

function memoryDb(withSchema = true): D1Db & { raw: Database } {
  const db = new Database(":memory:");
  if (withSchema) db.exec(SCHEMA);
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    run: async () => db.query(sql).run(...(values as never[])),
  });
  return { raw: db, prepare: (sql: string) => stmt(sql) };
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function opsEnv(db: D1Db | undefined) {
  const env: Env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    ...(db ? { MAMORU_DB: db } : {}),
  };
  const sealed = await sealSession("k1", "ottodevs@gmail.com");
  return { env, cookie: `mamoru_list=${sealed}` };
}

const get = (path: string, cookie: string) => new Request(`https://mamoru.lol${path}`, { headers: { "user-agent": BROWSER_UA, cookie } });
const post = (path: string, body: URLSearchParams, cookie: string) =>
  new Request(`https://mamoru.lol${path}`, { method: "POST", headers: { "user-agent": BROWSER_UA, cookie, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

function formFor(s: EngineSettings, extra: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    env: "prod",
    template: "t",
    ...(s.depth ? { depth_on: "1", depth_impact: String(s.depth.impactBps), depth_share: String(s.depth.shareBps), depth_stables: String(s.depth.stablesImpactBps ?? "") } : {}),
    cap: s.capUsdc === null ? "" : String(s.capUsdc),
    ...(s.guard.enabled ? { guard_on: "1" } : {}),
    btc_fall: String(s.guard.btc.fallBps),
    btc_vol: String(s.guard.btc.volBps),
    eth_fall: String(s.guard.eth.fallBps),
    eth_vol: String(s.guard.eth.volBps),
    reason: "test",
    ...extra,
  });
}

/** Submits the confirm screen exactly as the browser would: every hidden field it rendered. */
function confirmBodyOf(html: string): URLSearchParams {
  return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
}

const DEPTH: EngineSettings = { ...DEFAULT_SETTINGS, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, capUsdc: 1000 };

describe("engine settings model (copy of packages/policy/src/engine-settings.ts)", () => {
  test("bounds and defaults are pinned to the operator's", () => {
    expect(BOUNDS).toEqual({
      impactBps: { min: 1, max: 500 },
      shareBps: { min: 1, max: 5000 },
      stablesImpactBps: { min: 1, max: 500 },
      capUsdc: { min: 1, max: 1_000_000 },
      fallBps: { min: 100, max: 3000 },
      volBps: { min: 1000, max: 50_000 },
    });
    expect(canonicalJson(DEFAULT_SETTINGS)).toBe('{"capUsdc":null,"depth":null,"guard":{"btc":{"fallBps":700,"volBps":8000},"enabled":false,"eth":{"fallBps":900,"volBps":10000}}}');
  });

  test("validation, risky lines and form parsing", () => {
    expect(validateSettings(DEPTH)).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, capUsdc: 1000 })).toContain("capUsdc above 100 needs depth sizing");
    expect(riskyChanges(DEFAULT_SETTINGS, DEPTH)).toEqual(["cap per account rises from 100 to 1000 USDC"]);
    const f = new FormData();
    for (const [k, v] of formFor(DEPTH, {})) f.set(k, v);
    expect(settingsFromForm(f)).toEqual(DEPTH);
    f.set("cap", "12.5");
    expect(validateSettings(settingsFromForm(f)).join()).toContain("capUsdc must be a whole number");
  });
});

describe("/ops/settings (spec 006)", () => {
  test("without the tables it says so and the operator runs the defaults", async () => {
    const { env, cookie } = await opsEnv(memoryDb(false));
    const html = await (await worker.fetch(get("/ops/settings", cookie), env)).text();
    expect(html).toContain("not set up in D1 yet");
  });

  test("a wrong CSRF token never writes", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const res = await worker.fetch(post("/ops/settings/apply", formFor(DEPTH, { csrf: "wrong", confirm: "1" }), cookie), env);
    expect(res.status).toBe(403);
    expect(await listVersions(db)).toEqual([]);
  });

  test("a risky change asks again; the confirmed one is written with author and reason", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const page = await (await worker.fetch(get("/ops/settings", cookie), env)).text();
    const csrf = csrfOf(page);
    const first = await (await worker.fetch(post("/ops/settings/apply", formFor(DEPTH, { csrf }), cookie), env)).text();
    expect(first).toContain("Confirm this change");
    expect(first).toContain("cap per account rises from 100 to 1000 USDC");
    expect(await listVersions(db)).toEqual([]);
    const done = await (await worker.fetch(post("/ops/settings/apply", confirmBodyOf(first), cookie), env)).text();
    expect(done).toContain("Version 1 written for prod");
    const [v] = (await listVersions(db))!;
    expect(v!.settings).toEqual(DEPTH);
    expect(v!.author).toBe("ottodevs@gmail.com");
    expect(v!.reason).toBe("test");
  });

  test("out-of-bounds values are refused before anything is written", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const res = await worker.fetch(post("/ops/settings/apply", formFor({ ...DEPTH, capUsdc: 2_000_000 }, { csrf, confirm: "1" }), cookie), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not applied");
    expect(await listVersions(db)).toEqual([]);
  });

  test("rollback writes a new, higher version that copies the old one; turning the guard off needs a confirm", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: null, template: "a", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await appendVersion(db, { env: "prod", accountKeys: null, template: "b", settings: { ...DEFAULT_SETTINGS, guard: { ...DEFAULT_SETTINGS.guard, enabled: true } }, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/settings/rollback", new URLSearchParams({ csrf, id: "1", reason: "back" }), cookie), env)).text();
    expect(ask).toContain("the fall guard turns off");
    const confirmBody = new URLSearchParams([...ask.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    const done = await (await worker.fetch(post("/ops/settings/apply", confirmBody, cookie), env)).text();
    expect(done).toContain("Version 3 written for prod");
    const versions = (await listVersions(db))!;
    expect(versions.map((v) => [v.id, v.rollbackOf])).toEqual([[3, 1], [2, null], [1, null]]);
    expect(versions[0]!.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("/ops/settings review fixes (spec 006)", () => {
  test("dropping the stables value is a risky change; an edited preset is not recorded under the preset's name", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: null, template: "conservador + depth 30/500/5, cap 1000", settings: DEPTH, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const loose: EngineSettings = { ...DEPTH, depth: { impactBps: 30, shareBps: 500 } };
    const ask = await (await worker.fetch(post("/ops/settings/apply", formFor(loose, { csrf, template: "conservador + depth 30/500/5, cap 1000" }), cookie), env)).text();
    expect(ask).toContain("stables entries may move the pool price more");
    await worker.fetch(post("/ops/settings/apply", confirmBodyOf(ask), cookie), env);
    expect((await listVersions(db))![0]!.template).toBe("custom (from conservador + depth 30/500/5, cap 1000)");
  });

  test("a rollback_of that does not match the submitted settings is not recorded", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: null, template: "a", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    await worker.fetch(post("/ops/settings/apply", formFor(DEPTH, { csrf, confirm: "1", rollback_of: "1" }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBeNull();
  });

  test("the version in effect is found even behind a long history of the other env", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: null, template: "prod-wide", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    for (let i = 0; i < 60; i++) await appendVersion(db, { env: "beta", accountKeys: null, template: `b${i}`, settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/settings", cookie), env)).text();
    expect(html).toContain("prod-wide");
  });
});

describe("/ops/settings review round 2 (spec 006)", () => {
  const KEY_A = "11111111-aaaa-4bbb-8ccc-000000000001";

  test("an edited preset keeps its lineage through the confirm screen", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const edited: EngineSettings = { ...DEPTH, capUsdc: 2000 };
    const ask = await (await worker.fetch(post("/ops/settings/apply", formFor(edited, { csrf, template: "conservador + depth 30/500/5, cap 1000" }), cookie), env)).text();
    const confirmBody = new URLSearchParams([...ask.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    await worker.fetch(post("/ops/settings/apply", confirmBody, cookie), env);
    expect((await listVersions(db))![0]!.template).toBe("custom (from conservador + depth 30/500/5, cap 1000)");
  });

  test("a rollback link is kept only for the same scope", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: [KEY_A], template: "c", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    await worker.fetch(post("/ops/settings/apply", formFor(DEFAULT_SETTINGS, { csrf, confirm: "1", rollback_of: "1" }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBeNull();
    await worker.fetch(post("/ops/settings/apply", formFor(DEFAULT_SETTINGS, { csrf, confirm: "1", rollback_of: "1", canary: KEY_A.toUpperCase() }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBe(1);
  });

  test("the live canary is shown even behind a long history, and only the newest one", async () => {
    const db = memoryDb();
    await appendVersion(db, { env: "prod", accountKeys: null, template: "wide", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await appendVersion(db, { env: "prod", accountKeys: [KEY_A], template: "old-canary", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await appendVersion(db, { env: "prod", accountKeys: [KEY_A], template: "live-canary", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    for (let i = 0; i < 60; i++) await appendVersion(db, { env: "beta", accountKeys: null, template: `b${i}`, settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/settings", cookie), env)).text();
    const inEffect = html.slice(html.indexOf('id="set-active"'), html.indexOf('id="set-edit"'));
    expect(inEffect).toContain("live-canary");
    expect(inEffect).not.toContain("old-canary");
  });

  test("a POST before migration 0011 answers with a notice, not a 500", async () => {
    const { env, cookie } = await opsEnv(memoryDb(false));
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text().catch(() => 'name="csrf" value="x"'));
    const res = await worker.fetch(post("/ops/settings/apply", formFor(DEPTH, { csrf, confirm: "1" }), cookie), env);
    expect(res.status).not.toBe(500);
  });
});

describe('/ops/settings confirm token (spec 006, Sol review)', () => {
  const KEY_A = '11111111-aaaa-4bbb-8ccc-000000000001'
  const KEY_B = '11111111-aaaa-4bbb-8ccc-000000000002'

  test('confirm=1 on the first POST never writes a risky change', async () => {
    const db = memoryDb()
    const { env, cookie } = await opsEnv(db)
    const csrf = csrfOf(await (await worker.fetch(get('/ops/settings', cookie), env)).text())
    const html = await (await worker.fetch(post('/ops/settings/apply', formFor(DEPTH, { csrf, confirm: '1' }), cookie), env)).text()
    expect(html).toContain('Confirm this change')
    expect(await listVersions(db)).toEqual([])
  })

  test('a token issued for one change does not confirm another, nor survives a change in what is in effect', async () => {
    const db = memoryDb()
    const { env, cookie } = await opsEnv(db)
    const csrf = csrfOf(await (await worker.fetch(get('/ops/settings', cookie), env)).text())
    const ask = await (await worker.fetch(post('/ops/settings/apply', formFor(DEPTH, { csrf }), cookie), env)).text()
    const body = confirmBodyOf(ask)
    const bigger = new URLSearchParams(body)
    bigger.set('cap', '5000')
    await worker.fetch(post('/ops/settings/apply', bigger, cookie), env)
    expect(await listVersions(db)).toEqual([])
    await appendVersion(db, { env: 'prod', accountKeys: null, template: 'meanwhile', settings: DEFAULT_SETTINGS, author: 'y', reason: 'r' })
    const res = await (await worker.fetch(post('/ops/settings/apply', body, cookie), env)).text()
    expect(res).toContain('Confirm this change')
    expect((await listVersions(db))!.map((v) => v.template)).toEqual(['meanwhile'])
  })

  test('a canary is compared with what its accounts run now, and accounts leaving the old canary are counted', async () => {
    const db = memoryDb()
    await appendVersion(db, { env: 'prod', accountKeys: null, template: 'wide', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r' })
    await appendVersion(db, { env: 'prod', accountKeys: [KEY_A, KEY_B], template: 'old canary', settings: DEPTH, author: 'x', reason: 'r' })
    const { env, cookie } = await opsEnv(db)
    const csrf = csrfOf(await (await worker.fetch(get('/ops/settings', cookie), env)).text())
    // New canary on A only, with today's defaults: A turns depth sizing off (it ran the old canary), and B leaves the
    // old canary for the wide version, which turns depth sizing off for B too. Both are named; nothing is written yet.
    const ask = await (await worker.fetch(post('/ops/settings/apply', formFor(DEFAULT_SETTINGS, { csrf, canary: KEY_A }), cookie), env)).text()
    expect(ask).toContain('depth sizing turns off (canary accounts already in the current canary)')
    expect(ask).toContain('depth sizing turns off (accounts leaving the current canary)')
    expect((await listVersions(db))!.map((v) => v.template)).toEqual(['old canary', 'wide'])
    // A cap raise on an account outside every canary is compared with the wide version.
    const KEY_C = '11111111-aaaa-4bbb-8ccc-000000000003'
    const ask2 = await (await worker.fetch(post('/ops/settings/apply', formFor(DEPTH, { csrf, canary: KEY_C }), cookie), env)).text()
    expect(ask2).toContain('cap per account rises from 100 to 1000 USDC (canary accounts)')
  })
})
