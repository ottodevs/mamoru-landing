import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import { BOUNDS, DEFAULT_SETTINGS, canonicalJson, riskyChanges, settingsFromForm, settingsHash, validateSettings, type EngineSettings } from "../src/engine-settings-model";
import { appendVersion, listVersions, maxIdOf, SettingsConflict, type NewVersion } from "../src/engine-settings-store";
import { describeSettings } from "../src/ops-settings";
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

/** A version written as another writer would: against the env's newest id at that moment. */
async function seed(db: D1Db, v: NewVersion): Promise<number> {
  return appendVersion(db, { ...v, expectedMaxId: await maxIdOf(db, v.env) });
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
    ...(s.rerange?.mode === "lazy"
      ? {
          rerange_mode: "lazy",
          rerange_buffer: String(s.rerange.edgeBufferTicks),
          rerange_dwell: String(s.rerange.minDwellSeconds),
          rerange_horizon: String(s.rerange.horizonSeconds),
          rerange_lvr: String(s.rerange.lvrWeightBps),
        }
      : {}),
    reason: "test",
    ...extra,
  });
}

/** Submits the confirm screen exactly as the browser would: every hidden field it rendered. */
function confirmBodyOf(html: string): URLSearchParams {
  return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
}

const DEPTH: EngineSettings = { ...DEFAULT_SETTINGS, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, capUsdc: 1000 };

// otto/mamoru#172: the TRAIN/TEST candidate the app side seeds as `conservador-live-v2 + lazy-h24h-b100-d30`.
const LAZY: EngineSettings = { ...DEFAULT_SETTINGS, rerange: { mode: "lazy", edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 } };

describe("engine settings model (copy of packages/policy/src/engine-settings.ts)", () => {
  test("bounds and defaults are pinned to the operator's", () => {
    expect(BOUNDS).toEqual({
      impactBps: { min: 1, max: 500 },
      shareBps: { min: 1, max: 5000 },
      stablesImpactBps: { min: 1, max: 500 },
      capUsdc: { min: 1, max: 1_000_000 },
      fallBps: { min: 100, max: 3000 },
      volBps: { min: 1000, max: 50_000 },
      // #172
      edgeBufferTicks: { min: 0, max: 1000 },
      minDwellSeconds: { min: 0, max: 86_400 },
      horizonSeconds: { min: 3_600, max: 604_800 },
      lvrWeightBps: { min: 0, max: 20_000 },
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

describe("rerange (otto/mamoru#172)", () => {
  test("lazy validates clean; a missing number is refused; an out-of-bounds eager number is refused too", () => {
    expect(validateSettings(LAZY)).toEqual([]);
    const missingDwell: EngineSettings = { ...DEFAULT_SETTINGS, rerange: { mode: "lazy", edgeBufferTicks: 100, horizonSeconds: 86_400, lvrWeightBps: 10_000 } };
    expect(validateSettings(missingDwell).join()).toContain("rerange.minDwellSeconds must be a whole number from 0 to 86400");
    // Eager may still carry the four numbers (a form flipping back and forth); they are checked if present.
    const eagerWithBadNumber: EngineSettings = { ...DEFAULT_SETTINGS, rerange: { mode: "eager", edgeBufferTicks: 5000 } };
    expect(validateSettings(eagerWithBadNumber).join()).toContain("rerange.edgeBufferTicks must be a whole number from 0 to 1000");
  });

  test("settingsFromForm omits rerange entirely for eager, even with numbers left in the fields, and round-trips lazy", () => {
    const eagerForm = new FormData();
    for (const [k, v] of formFor(DEFAULT_SETTINGS, {})) eagerForm.set(k, v);
    eagerForm.set("rerange_mode", "eager");
    eagerForm.set("rerange_buffer", "100");
    eagerForm.set("rerange_dwell", "1800");
    const eagerSettings = settingsFromForm(eagerForm);
    expect(eagerSettings.rerange).toBeUndefined();
    expect(canonicalJson(eagerSettings)).toBe(canonicalJson(DEFAULT_SETTINGS));

    const lazyForm = new FormData();
    for (const [k, v] of formFor(LAZY, {})) lazyForm.set(k, v);
    expect(settingsFromForm(lazyForm)).toEqual(LAZY);
  });

  test("the hash changes with rerange present, and writing {mode:'eager'} explicitly would not match the omitted form", () => {
    expect(canonicalJson(LAZY)).not.toBe(canonicalJson(DEFAULT_SETTINGS));
    const explicitEager: EngineSettings = { ...DEFAULT_SETTINGS, rerange: { mode: "eager" } };
    expect(canonicalJson(explicitEager)).not.toBe(canonicalJson(DEFAULT_SETTINGS));
  });

  test("riskyChanges: eager to lazy is risky, lazy to eager is not, and only the 'lazier' direction is risky", () => {
    expect(riskyChanges(DEFAULT_SETTINGS, LAZY)).toEqual(["re-ranges become lazy: an out-of-range position waits for the buffer, the dwell and the cost test, and may stay out of range"]);
    expect(riskyChanges(LAZY, DEFAULT_SETTINGS)).toEqual([]);
    expect(riskyChanges(LAZY, LAZY)).toEqual([]);
    const biggerBuffer: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, edgeBufferTicks: 200 } };
    expect(riskyChanges(LAZY, biggerBuffer)).toEqual(["a position must be further out of range before it is re-ranged"]);
    const longerDwell: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, minDwellSeconds: 3600 } };
    expect(riskyChanges(LAZY, longerDwell)).toEqual(["a position waits longer out of range before it is re-ranged"]);
    const shorterHorizon: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, horizonSeconds: 7200 } };
    expect(riskyChanges(LAZY, shorterHorizon)).toEqual(["the cost test counts fewer hours of fees, so it lets fewer re-ranges through"]);
    const moreLvr: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, lvrWeightBps: 20_000 } };
    expect(riskyChanges(LAZY, moreLvr)).toEqual(["the cost test weighs LVR more, so it lets fewer re-ranges through"]);
    // The opposite direction on each number is not risky.
    const smallerBuffer: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, edgeBufferTicks: 0 } };
    expect(riskyChanges(LAZY, smallerBuffer)).toEqual([]);
  });

  test("describeSettings shows eager plainly and lazy with its numbers, in the active/history views", () => {
    expect(describeSettings(DEFAULT_SETTINGS)).toContain("re-range eager");
    expect(describeSettings(LAZY)).toContain("re-range lazy (buffer 100 ticks, dwell 1800s, horizon 86400s, LVR weight 100%)");
  });
});

describe("/ops/settings rerange through the form (otto/mamoru#172)", () => {
  test("eager to lazy asks for confirm with the lazy message; confirmed, it is written and shown in effect and history", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/settings/apply", formFor(LAZY, { csrf }), cookie), env)).text();
    expect(ask).toContain("Confirm this change");
    expect(ask).toContain("re-ranges become lazy");
    expect(await listVersions(db)).toEqual([]);
    const done = await (await worker.fetch(post("/ops/settings/apply", confirmBodyOf(ask), cookie), env)).text();
    expect(done).toContain("Version 1 written for prod");
    const [v] = (await listVersions(db))!;
    expect(v!.settings).toEqual(LAZY);
    const page = await (await worker.fetch(get("/ops/settings", cookie), env)).text();
    const active = page.slice(page.indexOf('id="set-active"'), page.indexOf('id="set-edit"'));
    expect(active).toContain("re-range lazy (buffer 100 ticks, dwell 1800s, horizon 86400s, LVR weight 100%)");
    const history = page.slice(page.indexOf('id="set-hist"'));
    expect(history).toContain("re-range lazy (buffer 100 ticks, dwell 1800s, horizon 86400s, LVR weight 100%)");
  });

  test("lazy back to eager is not risky and writes without a confirm step; the written settings carry no rerange key", async () => {
    const db = memoryDb();
    await seed(db, { env: "prod", accountKeys: null, template: "lazy", settings: LAZY, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const done = await (await worker.fetch(post("/ops/settings/apply", formFor(DEFAULT_SETTINGS, { csrf }), cookie), env)).text();
    expect(done).toContain("Version 2 written for prod");
    expect(done).not.toContain("Confirm this change");
    const [v] = (await listVersions(db))!;
    expect(v!.settings.rerange).toBeUndefined();
    expect(v!.hash).toBe(await settingsHash(DEFAULT_SETTINGS));
  });

  test("a lazier change (bigger buffer) after an existing lazy version is risky; a non-lazier edit (shorter dwell) is not", async () => {
    const db = memoryDb();
    await seed(db, { env: "prod", accountKeys: null, template: "lazy", settings: LAZY, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const bigger: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, edgeBufferTicks: 500 } };
    const askBigger = await (await worker.fetch(post("/ops/settings/apply", formFor(bigger, { csrf }), cookie), env)).text();
    expect(askBigger).toContain("a position must be further out of range before it is re-ranged");
    const shorterDwell: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, minDwellSeconds: 0 } };
    const doneShorter = await (await worker.fetch(post("/ops/settings/apply", formFor(shorterDwell, { csrf }), cookie), env)).text();
    expect(doneShorter).toContain("Version 2 written for prod");
    expect(doneShorter).not.toContain("Confirm this change");
  });

  test("an out-of-bounds rerange number, or a lazy form missing one of the four, is refused before anything is written", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    const tooMuchBuffer: EngineSettings = { ...LAZY, rerange: { ...LAZY.rerange!, edgeBufferTicks: 5000 } };
    const res1 = await worker.fetch(post("/ops/settings/apply", formFor(tooMuchBuffer, { csrf, confirm: "1" }), cookie), env);
    expect(res1.status).toBe(400);
    expect(await res1.text()).toContain("Not applied");
    const missingHorizon = formFor(LAZY, { csrf, confirm: "1" });
    missingHorizon.delete("rerange_horizon");
    const res2 = await worker.fetch(post("/ops/settings/apply", missingHorizon, cookie), env);
    expect(res2.status).toBe(400);
    expect(await res2.text()).toContain("rerange.horizonSeconds must be a whole number");
    expect(await listVersions(db)).toEqual([]);
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
    await seed(db, { env: "prod", accountKeys: null, template: "a", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await seed(db, { env: "prod", accountKeys: null, template: "b", settings: { ...DEFAULT_SETTINGS, guard: { ...DEFAULT_SETTINGS.guard, enabled: true } }, author: "x", reason: "r" });
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
    await seed(db, { env: "prod", accountKeys: null, template: "conservador + depth 30/500/5, cap 1000", settings: DEPTH, author: "x", reason: "r" });
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
    await seed(db, { env: "prod", accountKeys: null, template: "a", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    await worker.fetch(post("/ops/settings/apply", formFor(DEPTH, { csrf, confirm: "1", rollback_of: "1" }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBeNull();
  });

  test("the version in effect is found even behind a long history of the other env", async () => {
    const db = memoryDb();
    await seed(db, { env: "prod", accountKeys: null, template: "prod-wide", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    for (let i = 0; i < 60; i++) await seed(db, { env: "beta", accountKeys: null, template: `b${i}`, settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
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
    await seed(db, { env: "prod", accountKeys: [KEY_A], template: "c", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/settings", cookie), env)).text());
    await worker.fetch(post("/ops/settings/apply", formFor(DEFAULT_SETTINGS, { csrf, confirm: "1", rollback_of: "1" }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBeNull();
    await worker.fetch(post("/ops/settings/apply", formFor(DEFAULT_SETTINGS, { csrf, confirm: "1", rollback_of: "1", canary: KEY_A.toUpperCase() }), cookie), env);
    expect((await listVersions(db))![0]!.rollbackOf).toBe(1);
  });

  test("the live canary is shown even behind a long history, and only the newest one", async () => {
    const db = memoryDb();
    await seed(db, { env: "prod", accountKeys: null, template: "wide", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await seed(db, { env: "prod", accountKeys: [KEY_A], template: "old-canary", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    await seed(db, { env: "prod", accountKeys: [KEY_A], template: "live-canary", settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
    for (let i = 0; i < 60; i++) await seed(db, { env: "beta", accountKeys: null, template: `b${i}`, settings: DEFAULT_SETTINGS, author: "x", reason: "r" });
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
    await seed(db, { env: 'prod', accountKeys: null, template: 'meanwhile', settings: DEFAULT_SETTINGS, author: 'y', reason: 'r' })
    const res = await (await worker.fetch(post('/ops/settings/apply', body, cookie), env)).text()
    expect(res).toContain('Confirm this change')
    expect((await listVersions(db))!.map((v) => v.template)).toEqual(['meanwhile'])
  })

  test('a canary is compared with what its accounts run now, and accounts leaving the old canary are counted', async () => {
    const db = memoryDb()
    await seed(db, { env: 'prod', accountKeys: null, template: 'wide', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r' })
    await seed(db, { env: 'prod', accountKeys: [KEY_A, KEY_B], template: 'old canary', settings: DEPTH, author: 'x', reason: 'r' })
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

describe('/ops/settings writes are atomic against what was checked (spec 006, Sol round 3)', () => {
  test('the guarded insert refuses when the env moved after the check', async () => {
    const db = memoryDb()
    await seed(db, { env: 'prod', accountKeys: null, template: 'a', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r' })
    const checked = await maxIdOf(db, 'prod')
    await seed(db, { env: 'prod', accountKeys: null, template: 'other writer', settings: DEFAULT_SETTINGS, author: 'y', reason: 'r' })
    await expect(appendVersion(db, { env: 'prod', accountKeys: null, template: 'late', settings: DEPTH, author: 'x', reason: 'r', expectedMaxId: checked })).rejects.toBeInstanceOf(SettingsConflict)
    expect((await listVersions(db))!.map((v) => v.template)).toEqual(['other writer', 'a'])
    // A write in the other env does not block this one.
    await seed(db, { env: 'beta', accountKeys: null, template: 'beta', settings: DEFAULT_SETTINGS, author: 'z', reason: 'r' })
    expect(await appendVersion(db, { env: 'prod', accountKeys: null, template: 'now', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r', expectedMaxId: await maxIdOf(db, 'prod') })).toBeGreaterThan(0)
  })

  test('a non-risky change raced by another writer is not written and asks for review (409)', async () => {
    const db = memoryDb()
    await seed(db, { env: 'prod', accountKeys: null, template: 'cap 1000', settings: DEPTH, author: 'x', reason: 'r' })
    const { env, cookie } = await opsEnv(db)
    const csrf = csrfOf(await (await worker.fetch(get('/ops/settings', cookie), env)).text())
    // 1000 -> 500 needs no confirm; another writer lowers it to 50 between our check and our insert.
    const orig = db.prepare.bind(db)
    let raced = false
    db.prepare = ((sql: string) => {
      if (!raced && sql.startsWith('INSERT INTO engine_settings_versions')) {
        raced = true
        db.raw.query(`INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of) VALUES ('prod', NULL, 'cap 50', ?, 'h', 'y', 'r', '2026-10-17T00:00:00Z', NULL)`).run(JSON.stringify({ ...DEPTH, capUsdc: 50 }))
      }
      return orig(sql)
    }) as typeof db.prepare
    const res = await worker.fetch(post('/ops/settings/apply', formFor({ ...DEPTH, capUsdc: 500 }, { csrf }), cookie), env)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('changed the settings of this environment meanwhile')
    expect((await listVersions(db))!.map((v) => v.template)).toEqual(['cap 50', 'cap 1000'])
  })
})

test('two writes by the same author, same settings and millisecond to different canaries: only the first wins (Sol round 4)', async () => {
  const db = memoryDb()
  const at = new Date('2026-10-17T01:00:00.000Z')
  const expected = await maxIdOf(db, 'prod')
  const base = { env: 'prod' as const, template: 't', settings: DEPTH, author: 'same@x', reason: 'r', expectedMaxId: expected }
  const a = await appendVersion(db, { ...base, accountKeys: ['11111111-aaaa-4bbb-8ccc-00000000000a'] }, at)
  expect(a).toBe(1)
  await expect(appendVersion(db, { ...base, accountKeys: ['11111111-aaaa-4bbb-8ccc-00000000000b'] }, at)).rejects.toBeInstanceOf(SettingsConflict)
  expect((await listVersions(db))!.length).toBe(1)
})

test('a write whose outcome the database does not report is never claimed as written (Sol round 5)', async () => {
  const db = memoryDb()
  const orig = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const st = orig(sql)
    if (!sql.startsWith('INSERT INTO engine_settings_versions')) return st
    const bindOrig = st.bind
    return { ...st, bind: (...v: unknown[]) => ({ ...bindOrig(...v), run: async () => { await bindOrig(...v).run(); return {} } }) }
  }) as typeof db.prepare
  await expect(appendVersion(db, { env: 'prod', accountKeys: null, template: 't', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r', expectedMaxId: 0 })).rejects.toThrow('did not say whether')
})

test('a successful write returns its own id from the insert, without a second read (Sol round 5)', async () => {
  const db = memoryDb()
  const id = await appendVersion(db, { env: 'beta', accountKeys: null, template: 't', settings: DEFAULT_SETTINGS, author: 'x', reason: 'r', expectedMaxId: 0 })
  expect(id).toBe(1)
})

describe('concurrent writers: property over every interleaving (spec 006, Sol round 6)', () => {
  const KA = '11111111-aaaa-4bbb-8ccc-0000000000aa'
  const KB = '11111111-aaaa-4bbb-8ccc-0000000000bb'
  type Scope = 'wide' | 'canaryA' | 'canaryB'
  const keysOf = (s: Scope) => (s === 'wide' ? null : s === 'canaryA' ? [KA] : [KB])
  const raceAt = ['before', 'between', 'after'] as const
  const scopes: Scope[] = ['wide', 'canaryA', 'canaryB']
  const cases: { aScope: Scope; risky: boolean; bScope: Scope; when: (typeof raceAt)[number] }[] = []
  for (const aScope of scopes) for (const risky of [true, false]) for (const bScope of scopes) for (const when of raceAt) cases.push({ aScope, risky, bScope, when })

  /** What runs before version `id`: the env-wide version and the live canary, from the rows below it. */
  function stateBelow(rows: { id: number; accountKeys: string[] | null; settings: EngineSettings }[], id: number) {
    const below = rows.filter((r) => r.id < id).sort((a, b) => b.id - a.id)
    const wide = below.find((r) => r.accountKeys === null) ?? null
    const canary = below.find((r) => r.accountKeys !== null && (!wide || r.id > wide.id)) ?? null
    return { wide, canary } as never
  }

  test.each(cases)('A %o', async ({ aScope, risky, bScope, when }) => {
    const { risksOf } = await import('../src/engine-settings-confirm')
    const db = memoryDb()
    await seed(db, { env: 'prod', accountKeys: null, template: 'base', settings: DEPTH, author: 'seed', reason: 'r' })
    const bWrite = () => seed(db, { env: 'prod', accountKeys: keysOf(bScope), template: 'B', settings: { ...DEPTH, capUsdc: 50 }, author: 'b@x', reason: 'r' })
    if (when === 'before') await bWrite()
    const aSettings: EngineSettings = { ...DEPTH, capUsdc: risky ? 2000 : 500 }
    const { env, cookie } = await opsEnv(db)
    const csrf = csrfOf(await (await worker.fetch(get('/ops/settings', cookie), env)).text())
    // B lands between A's last check and A's insert: injected just before A's INSERT runs.
    if (when === 'between') {
      const orig = db.prepare.bind(db)
      let done = false
      db.prepare = ((sql: string) => {
        if (!done && sql.startsWith('INSERT INTO engine_settings_versions')) {
          done = true
          db.prepare = orig
          db.raw.query(`INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of) VALUES ('prod', ?, 'B', ?, 'h', 'b@x', 'r', '2026-10-17T00:00:00Z', NULL)`).run(keysOf(bScope) ? JSON.stringify(keysOf(bScope)) : null, canonicalJson({ ...DEPTH, capUsdc: 50 }))
        }
        return orig(sql)
      }) as typeof db.prepare
    }
    const form = formFor(aSettings, { csrf, ...(keysOf(aScope) ? { canary: keysOf(aScope)!.join('\n') } : {}) })
    let res = await worker.fetch(post('/ops/settings/apply', form, cookie), env)
    let html = await res.text()
    let confirmedAt: number | null = null
    if (html.includes('Confirm this change')) {
      confirmedAt = (await maxIdOf(db, 'prod'))
      res = await worker.fetch(post('/ops/settings/apply', confirmBodyOf(html), cookie), env)
      html = await res.text()
    }
    if (when === 'after') await bWrite()

    const rows = (await listVersions(db, 500))!
    const mine = rows.filter((r) => r.author === 'ottodevs@gmail.com')
    const written = /Version (\d+) written/.exec(html)
    // Every response reports exactly what was committed.
    if (written) {
      expect(mine.map((r) => r.id)).toEqual([Number(written[1])])
      expect(canonicalJson(mine[0]!.settings)).toBe(canonicalJson(aSettings))
    } else {
      expect(mine).toEqual([])
      expect(html).toMatch(/Not applied|Confirm this change|Unknown whether/)
    }
    // No unconfirmed risky change is ever committed: a committed row is either not risky against what ran just
    // before it, or it was confirmed against exactly that state.
    for (const r of mine) {
      const change = { env: 'prod' as const, accountKeys: r.accountKeys, template: r.template, settings: r.settings, rollbackOf: r.rollbackOf }
      const risks = risksOf(change, stateBelow(rows, r.id), DEFAULT_SETTINGS)
      if (risks.length) {
        expect(confirmedAt).not.toBeNull()
        expect(Math.max(0, ...rows.filter((x) => x.id < r.id).map((x) => x.id))).toBe(confirmedAt!)
      }
    }
  })
})
