// Fixture for the Lab bench tests (otto/mamoru-astro#28). The real `lab_bench` schema is owned by
// ottodevs/mamoru (migration `XXXX_lab_bench.sql`, mirrored for reference in `migrations/` of this repo); this
// file only needs to agree on column names, not on how the migration itself is applied.
import { Database } from "bun:sqlite";
import type { D1Db } from "../src/d1-infra";
import type { LabRunFull } from "../src/lab-store";

const SCHEMA = `
CREATE TABLE lab_runs (
  result_hash TEXT PRIMARY KEY,
  spec_key TEXT NOT NULL,
  window_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  run_json TEXT NOT NULL,
  sim_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lab_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'ops',
  requester TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_key TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_hash TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE lab_nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
`;

// Deliberately missing `sim_version` (and selected via the same 7-column INSERT finishJobDoneWithRun uses):
// inserting a run against this table throws "no such column", for the test proving a failed run write rolls
// the whole batch back (GPT-6 Sol round 2, otto/mamoru-astro#28) rather than leaving the job stuck `done`.
const SCHEMA_BROKEN_RUNS = `
CREATE TABLE lab_runs (
  result_hash TEXT PRIMARY KEY,
  spec_key TEXT NOT NULL,
  window_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  run_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lab_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'ops',
  requester TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_key TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_hash TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE lab_nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
`;

function op(t: number, kind: string, pool: string, gas: number, fees: number, code: string) {
  return { t, kind, pool, gas, fees, code, reason: code };
}

function series(t0: number, deposit: number, pool: string, points: number) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const t = t0 + i * 3600;
    out.push({
      t,
      v: deposit + i,
      h: deposit + i * 0.5,
      price: { [pool]: 3000 + i },
      band: { [pool]: i > 1 ? [2900, 3100] : null },
    });
  }
  return out;
}

/** One RunResult (B-02), close to the real shape but small enough to hand-write. */
export function makeRun(opts: {
  windowId: string;
  base: "live" | "guard";
  widthTicks: number;
  deposit: number;
  variantLabel: string;
  resultHash: string;
  vsHodl: number;
  simVersion?: string;
  pool?: string;
}): LabRunFull {
  const pool = opts.pool ?? "pool:WETH/USDC/3000";
  const t0 = 1738194947;
  const s = series(t0, opts.deposit, pool, 6);
  const end = opts.deposit + opts.vsHodl + 2;
  return {
    specKey: `${opts.windowId}|${opts.base}|${opts.widthTicks}|${opts.deposit}`,
    spec: { windowId: opts.windowId, base: opts.base, widthTicks: opts.widthTicks, deposit: opts.deposit },
    variantLabel: opts.variantLabel,
    policyId: opts.base === "guard" ? "conservador-lab-guards-v1" : "conservador-live-v2",
    resultHash: opts.resultHash,
    simVersion: opts.simVersion ?? "sim-1",
    window: { id: opts.windowId, label: `Window ${opts.windowId}`, regime: "crash", split: "train", from: new Date(t0 * 1000).toISOString(), to: new Date((t0 + 5 * 3600) * 1000).toISOString(), market: {} },
    deposit: opts.deposit,
    pools: [pool],
    metrics: { days: 1, end, net: end - opts.deposit, hodl: opts.deposit + 2, vsHodl: opts.vsHodl, fees: 1.5, gas: 0.3, timeInRangeBps: 9000, maxDrawdownBps: 100, returnBps: 10, operations: { enter_swap: 1, enter_mint: 1, harvest: 1, rerange: 1, reduce: 0 } },
    reasons: { DECIDE_IN_RANGE: 10, DECIDE_ENTER: 1 },
    ops: [op(t0, "enter_mint", pool, 0.1, 0, "DECIDE_ENTER"), op(t0 + 3600, "harvest", pool, 0.05, 1.5, "DECIDE_HARVEST")],
    series: s,
  };
}

export function labDb(
  opts: { seed?: boolean; brokenRunsTable?: boolean } = {},
): D1Db & { raw: Database; batch(statements: { _sql: string; _values: unknown[] }[]): Promise<{ meta: { changes: number; last_row_id: number } }[]> } {
  const db = new Database(":memory:");
  db.exec(opts.brokenRunsTable ? SCHEMA_BROKEN_RUNS : SCHEMA);
  if (opts.seed ?? true) {
    const w1Live2000 = makeRun({ windowId: "feb2025", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", resultHash: "hash-feb-live-2000-1000", vsHodl: -16.44 });
    const w1Live4000 = makeRun({ windowId: "feb2025", base: "live", widthTicks: 4000, deposit: 1000, variantLabel: "Rango ×2", resultHash: "hash-feb-live-4000-1000", vsHodl: -3.26 });
    const w1Guard2000 = makeRun({ windowId: "feb2025", base: "guard", widthTicks: 2000, deposit: 1000, variantLabel: "Con guarda de caídas", resultHash: "hash-feb-guard-2000-1000", vsHodl: -12.37 });
    const w2Live2000 = makeRun({ windowId: "sep2026", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", resultHash: "hash-sep-live-2000-1000", vsHodl: 0.1 });
    // aug2024 has no cbBTC on Base yet (B-03): only `live` runs exist for it, never `guard`.
    const w3Live2000 = makeRun({ windowId: "aug2024", base: "live", widthTicks: 2000, deposit: 1000, variantLabel: "Política actual", resultHash: "hash-aug-live-2000-1000", vsHodl: 1.2 });
    for (const run of [w1Live2000, w1Live4000, w1Guard2000, w2Live2000, w3Live2000]) {
      const { reasons, ops, series: s, ...summary } = run;
      void reasons;
      void ops;
      void s;
      db.query(
        "INSERT INTO lab_runs (result_hash, spec_key, window_id, summary_json, run_json, sim_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(run.resultHash, run.specKey, run.window.id, JSON.stringify(summary), JSON.stringify(run), run.simVersion, run.window.from);
    }
  }
  const stmt = (sql: string, values: unknown[] = []): any => ({
    _sql: sql,
    _values: values,
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => (db.query(sql).get(...(values as never[])) as unknown) ?? null,
    all: async () => ({ results: db.query(sql).all(...(values as never[])), success: true }),
    run: async () => {
      const r = db.query(sql).run(...(values as never[]));
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    raw: db,
    prepare: (sql: string) => stmt(sql),
    // Mirrors D1's real `batch()`: all statements run in one SQLite transaction (bun:sqlite's own
    // `Database.transaction()`), so a throw from any statement rolls every earlier statement in the call back
    // too — the same all-or-nothing semantics `finishJobDoneWithRun` (lab-store.ts) depends on.
    batch: async (statements: { _sql: string; _values: unknown[] }[]) => {
      const out: { meta: { changes: number; last_row_id: number } }[] = [];
      const txn = db.transaction(() => {
        for (const s of statements) {
          const r = db.query(s._sql).run(...(s._values as never[]));
          out.push({ meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } });
        }
      });
      txn();
      return out;
    },
  };
}
