// Fixture for test/account-caps.test.ts and the visual check of otto/mamoru-astro#25 (no test runner needed).
import { Database } from "bun:sqlite";
import type { D1Db } from "../src/d1-infra";

// ---- fixtures: three accounts, as on 22 Oct ----
// 3f9a7c21: its own 2,000 cap, in effect. 9b0e41aa: asked for 1,500, refused (code default). 5c2d8e10: no data.
export const A = "3f9a7c21aa00000000000000000000000000000000000000";
export const B = "9b0e41aabb00000000000000000000000000000000000000";
export const C = "5c2d8e10cc00000000000000000000000000000000000000";

const BASE_SCHEMA = `
CREATE TABLE accounts (account_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, created_at TEXT NOT NULL, env TEXT NOT NULL DEFAULT 'prod', is_test INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account_snapshot_latest (chain_id INTEGER NOT NULL, address TEXT NOT NULL, account_key TEXT NOT NULL, env TEXT NOT NULL, block INTEGER NOT NULL, read_at TEXT NOT NULL, deployed INTEGER NOT NULL, idle_usdc INTEGER NOT NULL, lp_usdc INTEGER NOT NULL, fees_usdc INTEGER NOT NULL, owed_usdc INTEGER NOT NULL, total_usdc INTEGER NOT NULL, positions_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE operator_metrics_latest (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL, generated_at TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE engine_settings_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, env TEXT NOT NULL CHECK (env IN ('prod','beta')), account_keys_json TEXT, template TEXT NOT NULL, settings_json TEXT NOT NULL, settings_hash TEXT NOT NULL, author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, rollback_of INTEGER);
INSERT INTO accounts VALUES ('${A}', 'u1', 8453, '0xA', '2026-10-01T00:00:00Z', 'prod', 0);
INSERT INTO accounts VALUES ('${B}', 'u2', 8453, '0xB', '2026-10-02T00:00:00Z', 'prod', 0);
INSERT INTO accounts VALUES ('${C}', 'u3', 8453, '0xC', '2026-10-03T00:00:00Z', 'prod', 0);
INSERT INTO account_snapshot_latest VALUES (8453, '0xa', '${A}', 'prod', 1, '2026-10-22T09:00:00Z', 1, 4000000, 1950000000, 2100000, 0, 1956100000, '[{"tokenId":"7","pool":"pool:USDC/cbBTC/500","inRange":true,"valueUsdc":"1950000000","feesUsdc":"2100000"}]', '2026-10-22T09:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0xb', '${B}', 'prod', 1, '2026-10-22T09:00:00Z', 1, 1000000, 98000000, 150000, 0, 99150000, '[{"tokenId":"8","pool":"pool:WETH/USDC/3000","inRange":true,"valueUsdc":"98000000","feesUsdc":"150000"}]', '2026-10-22T09:00:05Z');
INSERT INTO account_snapshot_latest VALUES (8453, '0xc', '${C}', 'prod', 1, '2026-10-22T09:00:00Z', 1, 25000000, 0, 0, 0, 25000000, '[]', '2026-10-22T09:00:05Z');
INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at) VALUES
  ('prod', NULL, 'live', '{"depth":{"impactBps":30,"shareBps":1000},"capUsdc":1000,"guard":{"enabled":false,"btc":{"fallBps":700,"volBps":8000},"eth":{"fallBps":900,"volBps":10000}}}', 'h', 'ops', 'v2', '2026-10-20T00:00:00Z');
`;

const CAPS_SCHEMA = `CREATE TABLE account_cap_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, env TEXT NOT NULL CHECK (env IN ('prod', 'beta')), account_key TEXT NOT NULL, cap_usdc INTEGER, author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);`;

const CAPS_SEED = `
INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at) VALUES ('prod', '${A}', 2000, 'ops@example.com', 'test with more money', '2026-10-22T08:00:00Z');
INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at) VALUES ('prod', '${B}', 1500, 'ops@example.com', 'second tester', '2026-10-22T08:10:00Z');
`;

export const AUTHORIZATIONS = [
  { account: "3f9a7c21", active: true, policyId: "conservador-live-v2", policyVersion: "2", pools: ["pool:USDC/cbBTC/500", "pool:WETH/USDC/3000"], validUntil: "2026-11-01T00:00:00.000Z", grants: [{ grant: "enter-swap:pool:USDC/cbBTC/500", usedBps: 1200 }, { grant: "enter-swap:pool:WETH/USDC/3000", usedBps: 6400 }, { grant: "withdraw", usedBps: 0 }], capUsdc: 2000, capSource: "override", signedCapUsdc: 1000, holds: [], deactivated: null },
  { account: "9b0e41aa", active: true, policyId: "conservador-v1", policyVersion: "1", pools: ["pool:WETH/USDC/3000"], validUntil: "2026-10-25T00:00:00.000Z", grants: [{ grant: "enter-swap:pool:WETH/USDC/3000", usedBps: 9300 }], capUsdc: 100, capSource: "default", signedCapUsdc: 100, holds: ["SESSION_RENEWAL_DUE"], deactivated: null },
];

const operatorSeed = (withAuth: boolean) =>
  `INSERT INTO operator_metrics_latest VALUES (1, '${JSON.stringify({ operator: { gitSha: "abc" }, opsRecent: [], ...(withAuth ? { authorizations: AUTHORIZATIONS } : {}) })}', '2026-10-22T09:00:00Z', '2026-10-22T09:00:05Z');`;

export function capsDb(o: { table?: boolean; seed?: boolean; auth?: boolean; dupe?: boolean; runResult?: unknown } = {}): D1Db & { raw: Database } {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA + operatorSeed(o.auth ?? true));
  if (o.table ?? true) db.exec(CAPS_SCHEMA);
  if ((o.table ?? true) && (o.seed ?? true)) db.exec(CAPS_SEED);
  if (o.dupe) db.exec(`INSERT INTO accounts VALUES ('3f9a7c21ff0000', 'u9', 8453, '0xF', '2026-10-04T00:00:00Z', 'prod', 0);`);
  const stmt = (sql: string, values: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    run: async () => {
      if (o.runResult !== undefined && /^\s*INSERT INTO account_cap_overrides/.test(sql)) return o.runResult;
      const r = db.query(sql).run(...(values as never[]));
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { raw: db, prepare: (sql: string) => stmt(sql) };
}

