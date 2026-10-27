import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import { appendFlagChange, currentFlagStates, listFlagChanges, maxIdOf } from "../src/ops-flags-store";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

/** The table of migration 0012 in ottodevs/mamoru (otto/mamoru#129), so these tests run without that repo. */
const SCHEMA = `
CREATE TABLE ops_flag_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, flag TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
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

const get = (path: string, cookie: string) => new Request(`https://mamoru.lol${path}`, { headers: { cookie } });
const post = (path: string, body: URLSearchParams, cookie: string) =>
  new Request(`https://mamoru.lol${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;

/** Submits the confirm screen exactly as the browser would: every hidden field it rendered. */
function confirmBodyOf(html: string): URLSearchParams {
  return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
}

describe("/ops/functions", () => {
  test("without the table it says so and offers no form", async () => {
    const { env, cookie } = await opsEnv(memoryDb(false));
    const html = await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text();
    expect(html).toContain("Migration 0012 is not applied yet");
    expect(html).not.toContain("/ops/functions/apply");
  });

  test("with the table and no row, the flag reads off", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text();
    expect(html).toContain("Yield ledger");
    expect(html).toContain('class="pill pill-off">Off</span>');
    expect(html).toContain("No change recorded");
    expect(html).toContain("Costs roughly 3");
  });

  test("a wrong CSRF token never writes", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const res = await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf: "wrong", flag: "yield_ledger", enabled: "1", reason: "test" }), cookie), env);
    expect(res.status).toBe(403);
    expect(await currentFlagStates(db)).toEqual(new Map());
  });

  test("an unknown flag name is refused before anything is written", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text());
    const res = await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf, flag: "not_a_flag", enabled: "1", reason: "test" }), cookie), env);
    expect(res.status).toBe(400);
    expect(await maxIdOf(db, "not_a_flag")).toBe(0);
  });

  test("a reason is required", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text());
    const res = await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf, flag: "yield_ledger", enabled: "1", reason: "" }), cookie), env);
    expect(res.status).toBe(400);
    expect(await listFlagChanges(db, "yield_ledger")).toEqual([]);
  });

  test("turning on asks for a second confirm naming the RPC cost; the confirmed write records author and reason", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const page = await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text();
    const csrf = csrfOf(page);
    const ask = await (await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf, flag: "yield_ledger", enabled: "1", reason: "go live" }), cookie), env)).text();
    expect(ask).toContain("Confirm this change");
    expect(ask).toContain("Costs roughly 3");
    expect(await listFlagChanges(db, "yield_ledger")).toEqual([]);
    const done = await (await worker.fetch(post("/ops/functions/apply", confirmBodyOf(ask), cookie), env)).text();
    expect(done).toContain("turned on");
    const [row] = (await listFlagChanges(db, "yield_ledger"))!;
    expect(row!.enabled).toBe(true);
    expect(row!.author).toBe("ottodevs@gmail.com");
    expect(row!.reason).toBe("go live");
    expect(done).toContain('class="pill pill-on">On</span>');
  });

  test("turning off needs no confirm screen: a straight write with a reason", async () => {
    const db = memoryDb();
    await appendFlagChange(db, { flag: "yield_ledger", enabled: true, author: "x", reason: "on", expectedMaxId: await maxIdOf(db, "yield_ledger") });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text());
    const res = await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf, flag: "yield_ledger", enabled: "0", reason: "pause" }), cookie), env);
    expect(res.status).toBe(200);
    const [row] = (await listFlagChanges(db, "yield_ledger"))!;
    expect(row!.enabled).toBe(false);
    expect(row!.reason).toBe("pause");
  });

  test("a stale confirm token (the flag moved meanwhile) asks again instead of writing", async () => {
    const db = memoryDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/functions/apply", new URLSearchParams({ csrf, flag: "yield_ledger", enabled: "1", reason: "go live" }), cookie), env)).text();
    // Someone else's change lands between the ask and the confirm.
    await appendFlagChange(db, { flag: "yield_ledger", enabled: false, author: "someone-else@example.com", reason: "unrelated", expectedMaxId: 0 });
    const confirmed = await (await worker.fetch(post("/ops/functions/apply", confirmBodyOf(ask), cookie), env)).text();
    expect(confirmed).toContain("Confirm this change");
    const rows = (await listFlagChanges(db, "yield_ledger"))!;
    expect(rows.length).toBe(1);
    expect(rows[0]!.author).toBe("someone-else@example.com");
  });

  test("history is newest first, capped at 20", async () => {
    const db = memoryDb();
    for (let i = 0; i < 25; i++) {
      await appendFlagChange(db, { flag: "yield_ledger", enabled: i % 2 === 0, author: "x", reason: `r${i}`, expectedMaxId: await maxIdOf(db, "yield_ledger") });
    }
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/engine/functions", cookie), env)).text();
    expect(html).toContain("r24");
    expect(html).not.toContain(">r0<");
    expect((await listFlagChanges(db, "yield_ledger", 20))!.length).toBe(20);
  });
});
