import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import { loadConsole, money, poolLabel } from "../src/console-data";
import type { InfraSnapshot } from "../src/infra-snapshot";
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

/** Same as SEED_DATA, with a recorded gas figure on acc1's 2026-10-17 row (0.002 ETH). */
const SEED_DATA_WITH_GAS = SEED_DATA.replace(
  "INSERT INTO account_daily VALUES ('2026-10-17', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 90, 95, 120000000, 121000000, 0, 120000000, 1000000, 1500000, 500000, NULL);",
  "INSERT INTO account_daily VALUES ('2026-10-17', 8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'acc1', 'unknown', 90, 95, 120000000, 121000000, 0, 120000000, 1000000, 1500000, 500000, '2000000000000000');",
);

const OPERATOR_SCHEMA = `CREATE TABLE operator_metrics_latest (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL, generated_at TEXT NOT NULL, fetched_at TEXT NOT NULL);`;
const OPERATOR_PAYLOAD = {
  operator: { gitSha: "abc1234", relayer: { address: "0x8F7D", balanceWei: "3600000000000000" } },
  // The operator's real shape (apps/mamoru-operator/src/metrics.ts): per provider, per method.
  rpc: { last48h: [{ hourStart: "2026-10-18T07:00:00.000Z", data: { "alchemy.com": { eth_call: { cuEstimate: 12000 }, eth_blockNumber: { cuEstimate: 3000 } } } }, { hourStart: "2026-10-18T08:00:00.000Z", data: { "alchemy.com": { eth_call: { cuEstimate: 42000 } } } }] },
  engines: [],
  opsRecent: [
    { accountKey: "acc1", kind: "enter", state: "confirmed", at: "2026-10-18T08:30:00Z", code: "EXEC_OK" },
    { accountKey: "acc1", kind: "enter", state: "failed", at: "2026-10-18T08:00:00Z", code: "OWNER_TX_ERROR" },
    { accountKey: "acc1", kind: "enter", state: "confirmed", at: "2026-10-04T00:00:00Z", code: "EXEC_OK" },
    { accountKey: "acc2", kind: "enter", state: "failed", at: "2026-10-18T07:00:00Z", code: "BETA_ONLY_CODE" },
  ],
};
const OPERATOR_SEED = `INSERT INTO operator_metrics_latest VALUES (1, '${JSON.stringify(OPERATOR_PAYLOAD)}', '2026-10-18T09:00:00Z', '2026-10-18T09:00:05Z');`;

function memoryDb(tables: string[]): D1Db {
  const db = new Database(":memory:");
  if (tables.includes("yield")) db.exec(YIELD_SCHEMA);
  if (tables.includes("flags")) db.exec(FLAGS_SCHEMA);
  if (tables.includes("seed")) db.exec(SEED_DATA);
  if (tables.includes("seed-gas")) db.exec(SEED_DATA_WITH_GAS);
  if (tables.includes("operator")) db.exec(OPERATOR_SCHEMA + OPERATOR_SEED);
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

const get = (path: string, cookie = "", fragment = false) =>
  new Request(`https://mamoru.lol${path}`, { headers: { ...(cookie ? { cookie } : {}), ...(fragment ? { "x-ops-fragment": "1" } : {}) } });

const PATHS = ["/ops", "/ops/yield", "/ops/accounts", "/ops/engine", "/ops/costs", "/ops/more"];
const NOW = new Date("2026-10-18T10:00:00Z");

describe("console gate (otto/mamoru-astro#24)", () => {
  test("no session: every console view, document or fragment, hands out no data", async () => {
    const { env } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    for (const path of PATHS) {
      const doc = await worker.fetch(get(path), env);
      expect(doc.status).not.toBe(200);
      const frag = await worker.fetch(get(path, "", true), env);
      expect(frag.status).toBe(401);
      expect(await frag.text()).not.toContain("acc1");
    }
  });
});

describe("console views", () => {
  test("Pulse, production by default: the beta account is out, the prod account's fees lead", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    const html = await (await worker.fetch(get("/ops", cookie), env)).text();
    expect(html).toContain("Earned for users so far");
    expect(html).toContain('<p class="c-big">30¢</p>');
    expect(html).not.toContain("c-acct-acc2");
    expect(html).toContain('id="c-acct-acc1"');
  });

  test("?env=all brings in the beta account and marks the switch", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    const html = await (await worker.fetch(get("/ops/yield?env=all", cookie), env)).text();
    expect(html).toContain('id="c-acct-acc2"');
    expect(html).toContain('href="/ops/yield?env=all" aria-current="true"');
  });

  test("ledger tables missing: Pulse says the ledger is not set up instead of showing zeros as yield", async () => {
    const { env, cookie } = await opsEnv(memoryDb([]));
    const html = await (await worker.fetch(get("/ops", cookie), env)).text();
    expect(html).toContain("The yield ledger is not set up on this database");
  });

  test("Engine without the operator table reads as not connected; with it, ops and failure codes show", async () => {
    const off = await opsEnv(memoryDb(["yield", "seed"]));
    expect(await (await worker.fetch(get("/ops/engine", off.cookie), off.env)).text()).toContain("Not connected yet");
    const on = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    const html = await (await worker.fetch(get("/ops/engine", on.cookie), on.env)).text();
    expect(html).toContain("OWNER_TX_ERROR");
    expect(html).toContain("Confirmed operations per day");
  });

  test("Costs: RPC hours from the operator metrics, relayer from its balance, the top-up link kept", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    const html = await (await worker.fetch(get("/ops/costs", cookie), env)).text();
    expect(html).toContain("RPC compute units per hour");
    expect(html).toContain("0.0036 ETH");
    expect(html).toContain('href="/ops/infra"');
  });

  test("fragments carry the view body, never the frame", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    for (const path of PATHS) {
      const res = await worker.fetch(get(path, cookie, true), env);
      expect(res.status).toBe(200);
      const view = (await res.json()) as { html: string };
      expect(view.html).not.toContain("<!DOCTYPE");
      expect(view.html).not.toContain("<script");
    }
  });
});

describe("console honesty (review r1, PR #13)", () => {
  test("production views leave out the operations of accounts outside the scope", async () => {
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed", "operator"]));
    expect(await (await worker.fetch(get("/ops/engine", cookie), env)).text()).not.toContain("BETA_ONLY_CODE");
    expect(await (await worker.fetch(get("/ops/engine?env=all", cookie), env)).text()).toContain("BETA_ONLY_CODE");
  });

  test("without the engine's first entry there is no APR, no break-even and no harvest count: n/a, not a guess", async () => {
    const m = await loadConsole(memoryDb(["yield", "seed"]), "prod", NOW, null);
    expect(m.accounts[0]!.since).toBeNull();
    expect(m.accounts[0]!.apr).toBeNull();
    expect(m.totals.apr).toBeNull();
    const { env, cookie } = await opsEnv(memoryDb(["yield", "seed"]));
    const costs = await (await worker.fetch(get("/ops/costs", cookie), env)).text();
    expect(costs).toContain("Needs a fee APR");
    const y = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(y).toContain("engine data not connected yet");
    expect(y).not.toContain(">$0</span><span class=\"c-note\">none yet");
  });

  test("portfolio APR counts only accounts with capital placed and a first entry, in both terms", async () => {
    const m = await loadConsole(memoryDb(["yield", "seed", "operator"]), "all", NOW, null);
    // acc2 (beta) has fees but no reported first entry: it is out of the numerator as well as the denominator.
    const a1 = m.accounts.find((a) => a.key === "acc1")!;
    expect(m.totals.apr!).toBeCloseTo(a1.apr!, 6);
  });
});

describe("console model", () => {
  test("fee APR uses the first confirmed entry the operator reports, and pools aggregate positions", async () => {
    const m = await loadConsole(memoryDb(["yield", "seed", "operator"]), "prod", NOW, null);
    expect(m.accounts.map((a) => a.key)).toEqual(["acc1"]);
    const a = m.accounts[0]!;
    expect(a.since).toBe("2026-10-04T00:00:00Z");
    // 0.30 on 130 placed over 14.4 days.
    expect(a.apr!).toBeCloseTo((0.3 / 130) * (365 / 14.41666) * 100, 1);
    expect(m.pools).toHaveLength(1);
    expect(m.totals.inRange).toBe(1);
    expect(m.alerts.some((x) => x.title.includes("failed in the last 48 hours"))).toBe(true);
    expect(m.operator!.rpc.map((h) => h.cu)).toEqual([15000, 42000]);
  });

  test("short money and fee tiers", () => {
    expect(money(0)).toBe("$0");
    expect(money(0.0004)).toBe("<0.1¢");
    expect(money(0.0084)).toBe("0.8¢");
    expect(money(0.099)).toBe("9.9¢");
    expect(money(50.71)).toBe("$50.71");
    expect(money(142996)).toBe("$143.0K");
    expect(poolLabel("pool:USDC/cbBTC/500")).toEqual({ pair: "USDC / cbBTC", fee: "0.05%" });
    expect(poolLabel("pool:WETH/USDC/3000").fee).toBe("0.3%");
    expect(poolLabel("pool:USDC/USDT/100").fee).toBe("0.01%");
  });
});
