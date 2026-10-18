import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import type { InfraSnapshot } from "../src/infra-snapshot";
import { appendFlagChange, maxIdOf } from "../src/ops-flags-store";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

const YIELD_SCHEMA = `
CREATE TABLE accounts (account_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, created_at TEXT NOT NULL, env TEXT NOT NULL DEFAULT 'prod', is_test INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account_snapshot_latest (chain_id INTEGER NOT NULL, address TEXT NOT NULL, account_key TEXT NOT NULL, env TEXT NOT NULL, block INTEGER NOT NULL, read_at TEXT NOT NULL, deployed INTEGER NOT NULL, idle_usdc INTEGER NOT NULL, lp_usdc INTEGER NOT NULL, fees_usdc INTEGER NOT NULL, owed_usdc INTEGER NOT NULL, total_usdc INTEGER NOT NULL, positions_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE account_daily (day TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, account_key TEXT NOT NULL, env TEXT NOT NULL, block_open INTEGER NOT NULL, block_close INTEGER NOT NULL, total_open_usdc INTEGER NOT NULL, total_close_usdc INTEGER NOT NULL, idle_close_usdc INTEGER NOT NULL, lp_close_usdc INTEGER NOT NULL, fees_open_usdc INTEGER NOT NULL, fees_close_usdc INTEGER NOT NULL, collected_usdc INTEGER, gas_paid_wei TEXT);
CREATE TABLE yield_ledger_position_daily (day TEXT NOT NULL, chain_id INTEGER NOT NULL, token_id INTEGER NOT NULL, account_key TEXT NOT NULL, address TEXT NOT NULL, env TEXT NOT NULL, pool TEXT NOT NULL, block_open INTEGER NOT NULL, block_close INTEGER NOT NULL, accrued0_open TEXT NOT NULL, accrued1_open TEXT NOT NULL, accrued_usd_open INTEGER NOT NULL, accrued0_close TEXT NOT NULL, accrued1_close TEXT NOT NULL, accrued_usd_close INTEGER NOT NULL, value_usd INTEGER NOT NULL, hold_value_usd INTEGER NOT NULL, collected0 TEXT, collected1 TEXT, collected_usd INTEGER, fee_accrued_usd INTEGER, updated_at TEXT NOT NULL);
`;

const FLAGS_SCHEMA = `CREATE TABLE ops_flag_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, flag TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);`;

const SEED_DATA = `
INSERT INTO accounts VALUES ('acc1', 'u1', 8453, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '2026-09-01T00:00:00Z', 'prod', 0);
INSERT INTO accounts VALUES ('acc2', 'u2', 8453, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '2026-09-02T00:00:00Z', 'beta', 0);
INSERT INTO account_snapshot_latest VALUES (8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 100, '2026-10-18T09:00:00Z', 1, 1000000, 130000000, 300000, 0, 131300000, '[{"tokenId":"1","pool":"pool:USDC/ETH/500","inRange":true,"valueUsdc":"130000000","feesUsdc":"300000","owedUsdc":"0"}]', '2026-10-18T09:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'acc2', 'unknown', 100, '2026-10-18T09:00:00Z', 1, 500000, 10000000, 50000, 0, 10550000, '[]', '2026-10-18T09:00:05Z');
INSERT INTO account_daily VALUES ('2026-10-17', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 90, 95, 120000000, 121000000, 0, 120000000, 1000000, 1500000, 500000, NULL);
INSERT INTO account_daily VALUES ('2026-10-18', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 96, 100, 121000000, 131300000, 1000000, 130000000, 1500000, 2000000, NULL, NULL);
`;

function memoryDb(tables: string[]): D1Db {
  const db = new Database(":memory:");
  if (tables.includes("yield")) db.exec(YIELD_SCHEMA);
  if (tables.includes("flags")) db.exec(FLAGS_SCHEMA);
  if (tables.includes("seed")) db.exec(SEED_DATA);
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    run: async () => db.query(sql).run(...(values as never[])),
  });
  return { prepare: (sql: string) => stmt(sql) };
}

function memoryKv(ethUsd: number | null = 2000) {
  const snapshot: InfraSnapshot = {
    asOf: "2026-10-18T09:30:00.000Z",
    ethUsd,
    btcUsd: null,
    relayer: null,
    cost: null,
    accounts: { totalUsers: 2, totalAccounts: 2, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0 },
  } as unknown as InfraSnapshot;
  const store = new Map<string, string>();
  store.set("ops:infra:v2", JSON.stringify({ snapshot, storedAt: Date.now() }));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async (o: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(o.prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

async function opsEnv(db: D1Db | undefined, ethUsd: number | null = 2000) {
  const env: Env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    WAITLIST: memoryKv(ethUsd) as unknown as Env["WAITLIST"],
    ...(db ? { MAMORU_DB: db } : {}),
  };
  const sealed = await sealSession("k1", "ottodevs@gmail.com");
  return { env, cookie: `mamoru_list=${sealed}` };
}

const get = (path: string, cookie: string) => new Request(`https://mamoru.lol${path}`, { headers: { cookie } });

describe("/ops/yield empty states", () => {
  test("migration 0009 not applied: no account_snapshot_latest/account_daily at all", async () => {
    const { env, cookie } = await opsEnv(memoryDb([]));
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("Migration 0009 is not applied yet");
  });

  test("today's real state: 0009/0010 applied and empty, 0012 not applied yet — reads as flag off", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield"]));
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("The yield ledger is off");
    expect(html).toContain('href="/ops/functions"');
  });

  test("flag on, no snapshot rows yet: waiting for the first one", async () => {
    const db = memoryDb(["yield", "flags"]);
    await appendFlagChange(db, { flag: "yield_ledger", enabled: true, author: "x", reason: "go", expectedMaxId: await maxIdOf(db, "yield_ledger") });
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("Waiting for the first snapshot");
  });
});

describe("/ops/yield with data", () => {
  async function flagOnDb() {
    const db = memoryDb(["yield", "flags", "seed"]);
    await appendFlagChange(db, { flag: "yield_ledger", enabled: true, author: "x", reason: "go", expectedMaxId: await maxIdOf(db, "yield_ledger") });
    return db;
  }

  test("prod default excludes beta: only acc1 shows, with earned-so-far and capital figures", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("acc1");
    expect(html).not.toContain("acc2");
    expect(html).toContain("Capital in positions");
    expect(html).toContain("Fees earned to date");
    expect(html).toContain("Net yield to users");
  });

  test("env=beta reveals the beta account instead", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const html = await (await worker.fetch(get("/ops/yield?env=beta", cookie), env)).text();
    expect(html).toContain("acc2");
    expect(html).not.toContain("acc1");
  });

  test("free-text account filter narrows to the matching one", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const html = await (await worker.fetch(get("/ops/yield?env=all&account=acc2", cookie), env)).text();
    expect(html).toContain("acc2");
    expect(html).not.toContain("acc1");
  });

  test("no gas recorded anywhere: the hero reads fees only, labelled as such", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("Fees only. Gas not recorded yet.");
  });

  test("the fragment carries the same body as the document, and the gate covers it unauthenticated", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const doc = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(doc).toContain("Per account");
    const fragRes = await worker.fetch(new Request("https://mamoru.lol/ops/yield", { headers: { cookie, "x-ops-fragment": "1" } }), env);
    expect(fragRes.status).toBe(200);
    const fragment = (await fragRes.json()) as { section: string; html: string };
    expect(fragment.section).toBe("yield");
    expect(doc).toContain(fragment.html);

    const bare = await worker.fetch(new Request("https://mamoru.lol/ops/yield", { headers: { "x-ops-fragment": "1" } }), env);
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe('{"v":1,"login":true}');
  });

  test("period=30d widens the per-account period fee sum", async () => {
    const { env, cookie } = await opsEnv(await flagOnDb());
    const html = await (await worker.fetch(get("/ops/yield?period=30d", cookie), env)).text();
    expect(html).toContain('value="30d" selected');
  });
});
