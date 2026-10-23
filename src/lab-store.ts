/**
 * otto/mamoru-astro#28 (spec 008 phase 1): D1 access for the Lab bench tables. Schema owned by `ottodevs/mamoru`
 * (migration `XXXX_lab_bench.sql`, mirrored for reference in `migrations/` of this repo): `lab_runs`, `lab_jobs`,
 * `lab_nonces`. This file only ever reads `lab_runs` and reads/writes `lab_jobs`/`lab_nonces` — the run store
 * itself (B-02 `RunResult` JSON) is written by the runner on lady, never computed here (Constitution VII: D1 is
 * a projection for the screen).
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";
import type { LabBase, LabSpec } from "./lab-spec";

type WriteStatement = D1PreparedStatement & { run(): Promise<{ meta?: { changes?: number; last_row_id?: number }; changes?: number }> };

// ---- RunResult (B-02), built by ottodevs/mamoru, read-only here ----

export interface LabWindowMeta {
  id: string;
  label: string;
  regime: string;
  split: string;
  from: string;
  to: string;
  market: unknown;
}

export interface LabMetrics {
  days: number;
  end: number;
  net: number;
  hodl: number;
  vsHodl: number;
  fees: number;
  gas: number;
  timeInRangeBps: number;
  maxDrawdownBps: number;
  returnBps: number;
  operations: Record<string, number>;
}

export interface LabOp {
  t: number;
  kind: string;
  pool: string;
  gas: number;
  fees: number;
  code: string;
  reason: string;
}

export interface LabSeriesPoint {
  t: number;
  v: number;
  h: number;
  price: Record<string, number>;
  band: Record<string, [number, number] | null>;
}

export interface LabRunSummary {
  specKey: string;
  spec: LabSpec;
  variantLabel: string;
  policyId: string;
  resultHash: string;
  simVersion: string;
  window: LabWindowMeta;
  deposit: number;
  pools: string[];
  metrics: LabMetrics;
}

export interface LabRunFull extends LabRunSummary {
  reasons: Record<string, number>;
  ops: LabOp[];
  series: LabSeriesPoint[];
}

type LabRunRow = {
  result_hash: string;
  spec_key: string;
  window_id: string;
  summary_json: string;
  run_json: string;
  sim_version: string;
  created_at: string;
};

export interface CatalogRun {
  resultHash: string;
  specKey: string;
  base: LabBase;
  widthTicks: number;
  deposit: number;
  variantLabel: string;
  policyId: string;
  simVersion: string;
}

export interface CatalogWindow {
  windowId: string;
  label: string;
  regime: string;
  split: string;
  from: string;
  to: string;
  /** Bases (B-03) that have at least one run for this window; the Probar panel offers only these. */
  bases: LabBase[];
  runs: CatalogRun[];
}

/** B-06 `GET /ops/lab/api/catalog`: every window with a run, and the strategies present in each. */
export async function readCatalog(db: D1Db): Promise<CatalogWindow[]> {
  const { results } = await db
    .prepare("SELECT result_hash, spec_key, window_id, summary_json, sim_version, created_at FROM lab_runs ORDER BY created_at ASC")
    .all<LabRunRow>();
  const byWindow = new Map<string, CatalogWindow>();
  for (const row of results) {
    let summary: LabRunSummary;
    try {
      summary = JSON.parse(row.summary_json) as LabRunSummary;
    } catch {
      continue;
    }
    let w = byWindow.get(row.window_id);
    if (!w) {
      w = {
        windowId: row.window_id,
        label: summary.window?.label ?? row.window_id,
        regime: summary.window?.regime ?? "",
        split: summary.window?.split ?? "",
        from: summary.window?.from ?? "",
        to: summary.window?.to ?? "",
        bases: [],
        runs: [],
      };
      byWindow.set(row.window_id, w);
    }
    const base = summary.spec?.base;
    if (base && !w.bases.includes(base)) w.bases.push(base);
    w.runs.push({
      resultHash: row.result_hash,
      specKey: row.spec_key,
      base: summary.spec?.base,
      widthTicks: summary.spec?.widthTicks,
      deposit: summary.deposit,
      variantLabel: summary.variantLabel,
      policyId: summary.policyId,
      simVersion: row.sim_version,
    });
  }
  return [...byWindow.values()];
}

/** B-06 `GET /ops/lab/api/runs?window=`: summaries only (no ops/series/reasons). */
export async function runSummariesForWindow(db: D1Db, windowId: string): Promise<LabRunSummary[]> {
  const { results } = await db
    .prepare("SELECT summary_json FROM lab_runs WHERE window_id = ? ORDER BY created_at ASC")
    .bind(windowId)
    .all<{ summary_json: string }>();
  const out: LabRunSummary[] = [];
  for (const r of results) {
    try {
      out.push(JSON.parse(r.summary_json) as LabRunSummary);
    } catch {
      // A row that fails to parse is dropped rather than breaking the whole list.
    }
  }
  return out;
}

/** B-06 `GET /ops/lab/api/run/:hash`: the full B-02 result (ops + series + reasons). */
export async function runByHash(db: D1Db, hash: string): Promise<LabRunFull | null> {
  const row = await db.prepare("SELECT run_json FROM lab_runs WHERE result_hash = ?").bind(hash).first<{ run_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.run_json) as LabRunFull;
  } catch {
    return null;
  }
}

export async function findRunBySpecKey(db: D1Db, key: string): Promise<{ resultHash: string } | null> {
  const row = await db.prepare("SELECT result_hash FROM lab_runs WHERE spec_key = ? LIMIT 1").bind(key).first<{ result_hash: string }>();
  return row ? { resultHash: row.result_hash } : null;
}

export async function hasWindow(db: D1Db, windowId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM lab_runs WHERE window_id = ? LIMIT 1").bind(windowId).first();
  return Boolean(row);
}

/** B-03/coordinator note: a window whose dataset lacks a pool a base needs has no runs for that base. */
export async function windowHasBase(db: D1Db, windowId: string, base: LabBase): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM lab_runs WHERE window_id = ? AND spec_key LIKE ? LIMIT 1")
    .bind(windowId, `${windowId}|${base}|%`)
    .first();
  return Boolean(row);
}

/** Upserts one run. Same `resultHash` twice is a no-op (B-03: re-seeding the same spec is a no-op). */
export async function upsertRun(
  db: D1Db,
  row: { resultHash: string; specKey: string; windowId: string; summaryJson: string; runJson: string; simVersion: string; createdAt: string },
): Promise<void> {
  const stmt = db
    .prepare(
      `INSERT INTO lab_runs (result_hash, spec_key, window_id, summary_json, run_json, sim_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(result_hash) DO NOTHING`,
    )
    .bind(row.resultHash, row.specKey, row.windowId, row.summaryJson, row.runJson, row.simVersion, row.createdAt) as WriteStatement;
  await stmt.run();
}

// ---- lab_jobs ----

export type LabJobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  kind: string;
  origin: string;
  requester: string;
  spec: LabSpec;
  specKey: string;
  status: LabJobStatus;
  leaseId: string | null;
  leaseUntil: number | null;
  attempts: number;
  resultHash: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

type LabJobRaw = {
  id: string;
  kind: string;
  origin: string;
  requester: string;
  spec_json: string;
  spec_key: string;
  status: LabJobStatus;
  lease_id: string | null;
  lease_until: number | null;
  attempts: number;
  result_hash: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

function toJob(r: LabJobRaw): JobRow {
  let spec: LabSpec;
  try {
    spec = JSON.parse(r.spec_json) as LabSpec;
  } catch {
    spec = { windowId: "", base: "live", widthTicks: 0, deposit: 0 };
  }
  return {
    id: r.id,
    kind: r.kind,
    origin: r.origin,
    requester: r.requester,
    spec,
    specKey: r.spec_key,
    status: r.status,
    leaseId: r.lease_id,
    leaseUntil: r.lease_until,
    attempts: r.attempts,
    resultHash: r.result_hash,
    errorCode: r.error_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const JOB_COLUMNS = "id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at";

export async function jobById(db: D1Db, id: string): Promise<JobRow | null> {
  const row = await db.prepare(`SELECT ${JOB_COLUMNS} FROM lab_jobs WHERE id = ?`).bind(id).first<LabJobRaw>();
  return row ? toJob(row) : null;
}

/** B-04: jobs created by this requester in the last 24h, any status — the 20/day limit. */
export async function countJobsToday(db: D1Db, requester: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM lab_jobs WHERE requester = ? AND created_at >= ?")
    .bind(requester, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** B-04: jobs of this requester occupying a queue slot (queued or actively running) — the "3 queued" limit. */
export async function countActiveJobs(db: D1Db, requester: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM lab_jobs WHERE requester = ? AND status IN ('queued', 'running')")
    .bind(requester)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Direct, unconditional insert — used by tests to seed job rows. The screen API never calls this: job
 * creation always goes through the atomic, limit-checked inserts below (GPT-6 Sol review, otto/mamoru-astro#28:
 * a read-then-insert of the daily/queued counts races two concurrent requests past the limit). */
export async function insertJob(
  db: D1Db,
  opts: { id: string; requester: string; spec: LabSpec; specKey: string; status: "queued" | "done"; resultHash: string | null; now: string },
): Promise<void> {
  const stmt = db
    .prepare(
      `INSERT INTO lab_jobs (id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at)
       VALUES (?, 'bench', 'ops', ?, ?, ?, ?, NULL, NULL, 0, ?, NULL, ?, ?)`,
    )
    .bind(opts.id, opts.requester, JSON.stringify(opts.spec), opts.specKey, opts.status, opts.resultHash, opts.now, opts.now) as WriteStatement;
  await stmt.run();
}

/**
 * B-04: a spec that already has a finished run (`lab_runs`) finishes the job at once. The only race here is
 * the daily cap, so the count check and the insert are one statement; returns `false` (nothing written) only
 * when the requester is already at the daily limit.
 */
export async function insertDoneJobIfUnderLimit(
  db: D1Db,
  opts: { id: string; requester: string; spec: LabSpec; specKey: string; resultHash: string; now: string; sinceIso: string; maxPerDay: number },
): Promise<boolean> {
  const stmt = db
    .prepare(
      `INSERT INTO lab_jobs (id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at)
       SELECT ?, 'bench', 'ops', ?, ?, ?, 'done', NULL, NULL, 0, ?, NULL, ?, ?
       WHERE (SELECT COUNT(*) FROM lab_jobs WHERE requester = ? AND created_at >= ?) < ?`,
    )
    .bind(opts.id, opts.requester, JSON.stringify(opts.spec), opts.specKey, opts.resultHash, opts.now, opts.now, opts.requester, opts.sinceIso, opts.maxPerDay) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

/**
 * B-04: inserts a new `queued` job only if, in one statement: no queued/running job already shares this
 * `spec_key` (dedupe against work already in flight, not only finished runs — a second "Run scenario" for the
 * same spec must never double the work), the requester is under the daily cap, and under the queued-slot cap.
 * `false` means none of that is true at the moment of the statement — the caller reads `activeJobBySpecKey` to
 * tell "a duplicate is already in flight" from "a limit was hit" for the response, never to decide the write.
 */
export async function insertQueuedJobIfEligible(
  db: D1Db,
  opts: { id: string; requester: string; spec: LabSpec; specKey: string; now: string; sinceIso: string; maxPerDay: number; maxActive: number },
): Promise<boolean> {
  const stmt = db
    .prepare(
      `INSERT INTO lab_jobs (id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at)
       SELECT ?, 'bench', 'ops', ?, ?, ?, 'queued', NULL, NULL, 0, NULL, NULL, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM lab_jobs WHERE spec_key = ? AND status IN ('queued', 'running'))
         AND (SELECT COUNT(*) FROM lab_jobs WHERE requester = ? AND created_at >= ?) < ?
         AND (SELECT COUNT(*) FROM lab_jobs WHERE requester = ? AND status IN ('queued', 'running')) < ?`,
    )
    .bind(
      opts.id,
      opts.requester,
      JSON.stringify(opts.spec),
      opts.specKey,
      opts.now,
      opts.now,
      opts.specKey,
      opts.requester,
      opts.sinceIso,
      opts.maxPerDay,
      opts.requester,
      opts.maxActive,
    ) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

/** The oldest queued/running job already covering this spec_key, if any (B-04 dedupe against in-flight work). */
export async function activeJobBySpecKey(db: D1Db, key: string): Promise<JobRow | null> {
  const row = await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM lab_jobs WHERE spec_key = ? AND status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 1`)
    .bind(key)
    .first<LabJobRaw>();
  return row ? toJob(row) : null;
}

/** AL-02: jobs stuck `running` past their lease with no retries left are given up on. Returns rows changed. */
export async function failExhaustedLeases(db: D1Db, nowEpoch: number, nowIso: string): Promise<number> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'failed', error_code = 'LAB_JOB_LEASE_LOST', lease_id = NULL, updated_at = ?
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ? AND attempts >= 2`,
    )
    .bind(nowIso, nowEpoch) as WriteStatement;
  const res = await stmt.run();
  return res.meta?.changes ?? res.changes ?? 0;
}

/** The oldest job eligible to be claimed: queued, or running with an expired lease and a retry left. */
export async function oldestClaimable(db: D1Db, nowEpoch: number): Promise<{ id: string } | null> {
  const row = await db
    .prepare(
      `SELECT id FROM lab_jobs
       WHERE status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ? AND attempts < 2)
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(nowEpoch)
    .first<{ id: string }>();
  return row ?? null;
}

/**
 * Atomically takes one job: only succeeds if it is still eligible (not claimed by a concurrent request since
 * `oldestClaimable` read it). Returns the new lease on success, null if the race was lost (caller returns 204:
 * with one runner in practice (B-12) this is a defensive path, not a retry loop).
 */
export async function claimJobById(db: D1Db, id: string, nowEpoch: number, nowIso: string): Promise<{ leaseId: string; spec: LabSpec } | null> {
  const leaseId = crypto.randomUUID();
  const leaseUntil = nowEpoch + 120;
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'running', lease_id = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND (status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ? AND attempts < 2))`,
    )
    .bind(leaseId, leaseUntil, nowIso, id, nowEpoch) as WriteStatement;
  const res = await stmt.run();
  const changes = res.meta?.changes ?? res.changes ?? 0;
  if (changes !== 1) return null;
  const job = await jobById(db, id);
  return job ? { leaseId, spec: job.spec } : null;
}

/** AL-02a: a renewal only succeeds while it still matches the live lease. */
export async function renewLease(db: D1Db, id: string, leaseId: string, nowEpoch: number, nowIso: string): Promise<boolean> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET lease_until = ?, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?`,
    )
    .bind(nowEpoch + 120, nowIso, id, leaseId, nowEpoch) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

/**
 * AL-02a: fenced on `lease_id` — a reclaimed job always carries a fresh lease, so a stale runner's write never
 * matches — AND on `status = 'running' AND lease_until >= now` (GPT-6 Sol review, otto/mamoru-astro#28): without
 * the status check a job already `done` could be flipped back to `failed` by a late duplicate request; without
 * the `lease_until` check a runner whose lease has technically expired, but that nobody has reclaimed yet, could
 * still finish the job — both are refused here, not just an identity match on `lease_id`.
 */
export async function finishJobDone(db: D1Db, id: string, leaseId: string, resultHash: string, nowEpoch: number, nowIso: string): Promise<boolean> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'done', result_hash = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?`,
    )
    .bind(resultHash, nowIso, id, leaseId, nowEpoch) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

export async function finishJobFailed(db: D1Db, id: string, leaseId: string, errorCode: string, nowEpoch: number, nowIso: string): Promise<boolean> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'failed', error_code = ?, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= ?`,
    )
    .bind(errorCode, nowIso, id, leaseId, nowEpoch) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

// ---- lab_nonces ----

/**
 * Replay guard (Architecture): inserts the nonce if unseen in the last `windowSeconds`; `false` means it was
 * already seen (refuse the request). Opportunistically prunes rows older than the window on every call so the
 * table never grows unbounded.
 */
export async function recordNonce(db: D1Db, nonce: string, nowEpoch: number, windowSeconds: number): Promise<boolean> {
  const prune = db.prepare("DELETE FROM lab_nonces WHERE seen_at < ?").bind(nowEpoch - windowSeconds) as WriteStatement;
  await prune.run();
  const seen = await db.prepare("SELECT 1 AS x FROM lab_nonces WHERE nonce = ?").bind(nonce).first();
  if (seen) return false;
  const insert = db.prepare("INSERT INTO lab_nonces (nonce, seen_at) VALUES (?, ?)").bind(nonce, nowEpoch) as WriteStatement;
  await insert.run();
  return true;
}
