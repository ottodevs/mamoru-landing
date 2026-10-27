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
  /** otto/mamoru-astro#30 (spec 008 phase 2): NULL on a `kind: 'bench'` row, set on a `kind: 'agent'` row. */
  threadId: string | null;
  question: string | null;
  answerJson: string | null;
  verifierJson: string | null;
  costJson: string | null;
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
  thread_id: string | null;
  question: string | null;
  answer_json: string | null;
  verifier_json: string | null;
  cost_json: string | null;
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
    threadId: r.thread_id,
    question: r.question,
    answerJson: r.answer_json,
    verifierJson: r.verifier_json,
    costJson: r.cost_json,
  };
}

const JOB_COLUMNS =
  "id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at, thread_id, question, answer_json, verifier_json, cost_json";

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

/**
 * AL-02: jobs stuck `running` past their lease with no retries left are given up on. Returns rows changed.
 * `unixepoch()` (GPT-6 Sol round 2, otto/mamoru-astro#28): every lease comparison below uses SQLite's own
 * clock at the moment the statement runs, not a JS `Date.now()` captured earlier in the handler — a value
 * captured before `await`ing validation, a JSON parse, or an earlier query could be stale by the time it is
 * finally bound into the write, which is exactly the kind of gap fencing is supposed to close.
 */
export async function failExhaustedLeases(db: D1Db, nowIso: string): Promise<number> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'failed', error_code = 'LAB_JOB_LEASE_LOST', lease_id = NULL, updated_at = ?
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < unixepoch() AND attempts >= 2`,
    )
    .bind(nowIso) as WriteStatement;
  const res = await stmt.run();
  return res.meta?.changes ?? res.changes ?? 0;
}

/** The oldest job eligible to be claimed: queued, or running with an expired lease and a retry left. */
export async function oldestClaimable(db: D1Db): Promise<{ id: string } | null> {
  const row = await db
    .prepare(
      `SELECT id FROM lab_jobs
       WHERE status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < unixepoch() AND attempts < 2)
       ORDER BY created_at ASC LIMIT 1`,
    )
    .first<{ id: string }>();
  return row ?? null;
}

/**
 * Atomically takes one job: only succeeds if it is still eligible (not claimed by a concurrent request since
 * `oldestClaimable` read it). Returns the new lease on success, null if the race was lost (caller returns 204:
 * with one runner in practice (B-12) this is a defensive path, not a retry loop). The new `lease_until` is
 * `unixepoch() + 120`, computed in SQL for the same reason as the comparisons above.
 */
export async function claimJobById(
  db: D1Db,
  id: string,
  nowIso: string,
): Promise<{ leaseId: string; spec: LabSpec; kind: string; threadId: string | null; question: string | null } | null> {
  const leaseId = crypto.randomUUID();
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'running', lease_id = ?, lease_until = unixepoch() + 120, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND (status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < unixepoch() AND attempts < 2))`,
    )
    .bind(leaseId, nowIso, id) as WriteStatement;
  const res = await stmt.run();
  const changes = res.meta?.changes ?? res.changes ?? 0;
  if (changes !== 1) return null;
  const job = await jobById(db, id);
  return job ? { leaseId, spec: job.spec, kind: job.kind, threadId: job.threadId, question: job.question } : null;
}

/** AL-02a: a renewal only succeeds while it still matches the live lease. */
export async function renewLease(db: D1Db, id: string, leaseId: string, nowIso: string): Promise<boolean> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET lease_until = unixepoch() + 120, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= unixepoch()`,
    )
    .bind(nowIso, id, leaseId) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

/**
 * AL-02a: fenced on `lease_id` — a reclaimed job always carries a fresh lease, so a stale runner's write never
 * matches — AND on `status = 'running' AND lease_until >= unixepoch()` (GPT-6 Sol review, otto/mamoru-astro#28):
 * without the status check a job already `done` could be flipped back to `failed` by a late duplicate request;
 * without the `lease_until` check a runner whose lease has technically expired, but that nobody has reclaimed
 * yet, could still finish the job — both are refused here, not just an identity match on `lease_id`. Kept for
 * the failure path, which is a single write with nothing else to coordinate; the success path's job update is
 * in `finishJobDoneWithRun` below, batched with the run insert so neither can land without the other.
 */
export async function finishJobFailed(db: D1Db, id: string, leaseId: string, errorCode: string, nowIso: string): Promise<boolean> {
  const stmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'failed', error_code = ?, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= unixepoch()`,
    )
    .bind(errorCode, nowIso, id, leaseId) as WriteStatement;
  const res = await stmt.run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

type BatchableDb = D1Db & { batch(statements: D1PreparedStatement[]): Promise<{ meta?: { changes?: number }; changes?: number }[]> };

/**
 * AL-02a + the run store, as one D1 transaction (GPT-6 Sol round 2, otto/mamoru-astro#28): the job's fenced
 * UPDATE and the run's guarded INSERT either both commit or neither does. Without this, a run-insert failure
 * after a successful job update (a constraint, a dropped connection, anything) left the job `done` pointing at
 * a `resultHash` that was never actually written to `lab_runs` — `GET /api/run/:hash` would 404 forever. The
 * insert is itself guarded by `WHERE EXISTS` against the job's row as the UPDATE just left it (statements in a
 * `batch()` run in one transaction, so the second statement sees the first's effect): if the UPDATE didn't
 * match (fence lost), the row still won't show `status = 'done'` with this `resultHash`, so the INSERT's guard
 * is false and nothing is written — and if the batch itself throws for any reason, D1 rolls the whole
 * transaction back, so the job update is undone too and the job is left exactly as it was (`running`).
 */
export async function finishJobDoneWithRun(
  db: D1Db,
  opts: { id: string; leaseId: string; nowIso: string; run: { resultHash: string; specKey: string; windowId: string; summaryJson: string; runJson: string; simVersion: string; createdAt: string } },
): Promise<boolean> {
  const updateStmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'done', result_hash = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= unixepoch()`,
    )
    .bind(opts.run.resultHash, opts.nowIso, opts.id, opts.leaseId);
  const insertStmt = db
    .prepare(
      `INSERT INTO lab_runs (result_hash, spec_key, window_id, summary_json, run_json, sim_version, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM lab_jobs WHERE id = ? AND lease_id = ? AND status = 'done' AND result_hash = ?)
       ON CONFLICT(result_hash) DO NOTHING`,
    )
    .bind(opts.run.resultHash, opts.run.specKey, opts.run.windowId, opts.run.summaryJson, opts.run.runJson, opts.run.simVersion, opts.run.createdAt, opts.id, opts.leaseId, opts.run.resultHash);
  const results = await (db as BatchableDb).batch([updateStmt, insertStmt]);
  const changes = results[0]?.meta?.changes ?? results[0]?.changes ?? 0;
  return changes === 1;
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

// ---------------------------------------------------------------------------
// Agent Lab (otto/mamoru-astro#30, spec 008 phase 2): threads, agent jobs, their cited runs and shadow prices.
// ---------------------------------------------------------------------------

function parseJsonOrNull(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- lab_threads ----

export interface ThreadRow {
  id: string;
  owner: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

type ThreadRaw = { id: string; owner: string; title: string; created_at: string; updated_at: string };
function toThread(r: ThreadRaw): ThreadRow {
  return { id: r.id, owner: r.owner, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** AL-01: mine, newest first (by last activity, not just creation -- a follow-up bumps its thread). */
export async function threadsByOwner(db: D1Db, owner: string): Promise<ThreadRow[]> {
  const { results } = await db
    .prepare("SELECT id, owner, title, created_at, updated_at FROM lab_threads WHERE owner = ? ORDER BY updated_at DESC")
    .bind(owner)
    .all<ThreadRaw>();
  return results.map(toThread);
}

export async function threadById(db: D1Db, id: string): Promise<ThreadRow | null> {
  const row = await db.prepare("SELECT id, owner, title, created_at, updated_at FROM lab_threads WHERE id = ?").bind(id).first<ThreadRaw>();
  return row ? toThread(row) : null;
}

export async function insertThread(db: D1Db, opts: { id: string; owner: string; title: string; now: string }): Promise<void> {
  const stmt = db
    .prepare("INSERT INTO lab_threads (id, owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(opts.id, opts.owner, opts.title, opts.now, opts.now) as WriteStatement;
  await stmt.run();
}

/** Bumps `updated_at` when a follow-up question lands in an existing thread, so the picker's "newest first" reflects activity. */
export async function touchThread(db: D1Db, id: string, now: string): Promise<void> {
  const stmt = db.prepare("UPDATE lab_threads SET updated_at = ? WHERE id = ?").bind(now, id) as WriteStatement;
  await stmt.run();
}

// ---- agent lab_jobs ----

/**
 * AL-01/AL-04: inserts a new `queued` agent job only if, in one statement, the requester is under the daily cap
 * (shared with bench jobs -- `countJobsToday`'s query has no `kind` filter) and the queued-slot cap (same
 * sharing). No spec_key dedupe (unlike the bench path): `spec_key` here is `agent:<jobId>`, unique by
 * construction, so two different questions never collide and must not be deduped against each other.
 */
function agentJobInsertStatement(
  db: D1Db,
  opts: { id: string; requester: string; threadId: string; question: string; windowId: string | null; now: string; sinceIso: string; maxPerDay: number; maxActive: number },
): D1PreparedStatement {
  const specJson = JSON.stringify(opts.windowId ? { windowId: opts.windowId } : {});
  const specKeyVal = `agent:${opts.id}`;
  return db
    .prepare(
      `INSERT INTO lab_jobs (id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at, thread_id, question)
       SELECT ?, 'agent', 'ops', ?, ?, ?, 'queued', NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM lab_jobs WHERE requester = ? AND created_at >= ?) < ?
         AND (SELECT COUNT(*) FROM lab_jobs WHERE requester = ? AND status IN ('queued', 'running')) < ?`,
    )
    .bind(opts.id, opts.requester, specJson, specKeyVal, opts.now, opts.now, opts.threadId, opts.question, opts.requester, opts.sinceIso, opts.maxPerDay, opts.requester, opts.maxActive);
}

export async function insertQueuedAgentJobIfEligible(
  db: D1Db,
  opts: { id: string; requester: string; threadId: string; question: string; windowId: string | null; now: string; sinceIso: string; maxPerDay: number; maxActive: number },
): Promise<boolean> {
  const res = await (agentJobInsertStatement(db, opts) as WriteStatement).run();
  return (res.meta?.changes ?? res.changes ?? 0) === 1;
}

/** Direct, unconditional insert -- tests only (mirrors bench's `insertJob`), never the screen API's own path. */
export async function insertAgentJob(
  db: D1Db,
  opts: { id: string; requester: string; threadId: string; question: string; status: LabJobStatus; now: string },
): Promise<void> {
  const stmt = db
    .prepare(
      `INSERT INTO lab_jobs (id, kind, origin, requester, spec_json, spec_key, status, lease_id, lease_until, attempts, result_hash, error_code, created_at, updated_at, thread_id, question)
       VALUES (?, 'agent', 'ops', ?, '{}', ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?)`,
    )
    .bind(opts.id, opts.requester, `agent:${opts.id}`, opts.status, opts.now, opts.now, opts.threadId, opts.question) as WriteStatement;
  await stmt.run();
}

export interface AgentJobRow {
  id: string;
  question: string;
  status: LabJobStatus;
  /** Parsed `answer_json` (the `{blocks: Block[]}` shape `packages/lab-agent/src/contract.ts` owns) -- opaque here. */
  answer: unknown;
  verifier: unknown;
  cost: unknown;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** AL-50: a thread's latest `limit` turns, oldest first (a chat transcript reads top to bottom); `truncated` when older turns were cut. */
export async function agentJobsByThread(db: D1Db, threadId: string, limit = 50): Promise<{ jobs: AgentJobRow[]; truncated: boolean }> {
  const { results } = await db
    .prepare(
      "SELECT id, question, status, answer_json, verifier_json, cost_json, error_code, created_at, updated_at FROM lab_jobs WHERE thread_id = ? AND kind = 'agent' ORDER BY created_at DESC LIMIT ?",
    )
    .bind(threadId, limit + 1)
    .all<{
      id: string;
      question: string | null;
      status: LabJobStatus;
      answer_json: string | null;
      verifier_json: string | null;
      cost_json: string | null;
      error_code: string | null;
      created_at: string;
      updated_at: string;
    }>();
  const truncated = results.length > limit;
  const rows = results.slice(0, limit).reverse();
  const jobs = rows.map((r) => ({
    id: r.id,
    question: r.question ?? "",
    status: r.status,
    answer: parseJsonOrNull(r.answer_json),
    verifier: parseJsonOrNull(r.verifier_json),
    cost: parseJsonOrNull(r.cost_json),
    errorCode: r.error_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return { jobs, truncated };
}

/** The runner claim contract's `history` (AL-03): earlier *done* turns of the thread, oldest first, with their
 * verified answer -- never raw tool output, never a turn that failed or is still in flight. */
export async function agentThreadHistory(db: D1Db, threadId: string): Promise<{ question: string; answer: unknown }[]> {
  const { results } = await db
    .prepare("SELECT question, answer_json FROM lab_jobs WHERE thread_id = ? AND kind = 'agent' AND status = 'done' ORDER BY created_at ASC")
    .bind(threadId)
    .all<{ question: string | null; answer_json: string | null }>();
  const out: { question: string; answer: unknown }[] = [];
  for (const r of results) {
    if (!r.question) continue;
    out.push({ question: r.question, answer: parseJsonOrNull(r.answer_json) });
  }
  return out;
}

/** The lightweight run summary (no ops/series/reasons) for one `resultHash` -- claim/verdict rendering needs
 * only this, never the full `run_json` (B-02's bench full result, up to 400 KB). */
export async function runSummaryByHash(db: D1Db, hash: string): Promise<LabRunSummary | null> {
  const row = await db.prepare("SELECT summary_json FROM lab_runs WHERE result_hash = ?").bind(hash).first<{ summary_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.summary_json) as LabRunSummary;
  } catch {
    return null;
  }
}

const VERIFIED_BLOCK_TYPES = new Set(["claim", "verdict", "chart"]);

/**
 * The run hashes one answer block cites, or `null` when the block is a verified kind (claim/verdict/chart)
 * whose citation is missing or malformed (`runId` / `against` not a non-empty string, `runIds` not a non-empty
 * array of non-empty strings). A verified block with no citable run is never valid. `against` of "hold"/"usdc"
 * is a baseline, not a hash. Text/caveat blocks cite nothing (`[]`).
 */
export function citedRunIdsOfBlock(raw: unknown): string[] | null {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (b.type === "claim") return str(b.runId) ? [b.runId] : null;
  if (b.type === "verdict") {
    if (!str(b.runId) || !str(b.against)) return null;
    return b.against === "hold" || b.against === "usdc" ? [b.runId] : [b.runId, b.against];
  }
  if (b.type === "chart") {
    if (!Array.isArray(b.runIds) || b.runIds.length === 0 || !b.runIds.every(str)) return null;
    return b.runIds as string[];
  }
  return [];
}

export function isVerifiedBlockType(raw: unknown): boolean {
  return VERIFIED_BLOCK_TYPES.has(((raw ?? {}) as { type?: unknown }).type as string);
}

/** Citations of a whole answer; `null` when any block's citation is malformed (see `citedRunIdsOfBlock`). */
export function citedRunIdsOfAnswer(answer: unknown): string[] | null {
  const blocks = (answer as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const blk of blocks) {
    const c = citedRunIdsOfBlock(blk);
    if (c === null) return null;
    out.push(...c);
  }
  return out;
}

const IN_CHUNK = 50;

/** AL-21: the runs a job's answer may cite are exactly its `lab_job_runs` rows, never "any run that exists".
 * One query per chunk of 50 jobs (so one query for a normal, capped transcript). */
export async function recordedRunHashesForJobs(db: D1Db, jobIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const id of jobIds) out.set(id, new Set());
  for (let i = 0; i < jobIds.length; i += IN_CHUNK) {
    const chunk = jobIds.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT job_id, result_hash FROM lab_job_runs WHERE job_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ job_id: string; result_hash: string }>();
    for (const r of results) out.get(r.job_id)?.add(r.result_hash);
  }
  return out;
}

/** Summaries for many hashes, chunked `IN` queries instead of one query per hash. */
export async function runSummariesByHashes(db: D1Db, hashes: string[]): Promise<Record<string, LabRunSummary>> {
  const out: Record<string, LabRunSummary> = {};
  for (let i = 0; i < hashes.length; i += IN_CHUNK) {
    const chunk = hashes.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT result_hash, summary_json FROM lab_runs WHERE result_hash IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ result_hash: string; summary_json: string }>();
    for (const r of results) {
      try {
        out[r.result_hash] = JSON.parse(r.summary_json) as LabRunSummary;
      } catch {
        /* unparsable summary: treated as absent */
      }
    }
  }
  return out;
}

/**
 * AL-01/AL-04 for a brand-new thread: the agent job (under the same caps) and its thread land in ONE D1 batch;
 * the thread row is inserted only if the job row exists, so a refused job (cap hit) leaves no orphan thread.
 */
export async function insertThreadWithQueuedAgentJobIfEligible(
  db: D1Db,
  opts: {
    threadId: string;
    title: string;
    id: string;
    requester: string;
    question: string;
    windowId: string | null;
    now: string;
    sinceIso: string;
    maxPerDay: number;
    maxActive: number;
  },
): Promise<boolean> {
  const jobStmt = agentJobInsertStatement(db, opts);
  const threadStmt = db
    .prepare("INSERT INTO lab_threads (id, owner, title, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lab_jobs WHERE id = ?)")
    .bind(opts.threadId, opts.requester, opts.title, opts.now, opts.now, opts.id);
  const results = await (db as BatchableDb).batch([jobStmt, threadStmt]);
  return (results[0]?.meta?.changes ?? results[0]?.changes ?? 0) === 1;
}

/**
 * AL-21/the runner result contract: in one fenced D1 batch, stores the verified answer/verifier/cost and
 * records which stored runs (`lab_job_runs`) this job's answer may cite -- mirrors `finishJobDoneWithRun`'s
 * all-or-nothing shape. Every cited hash must already be in `lab_runs` (the runner POSTs runs to `/publish`
 * before `/result`): checked up front, as a plain read (no concurrent writer deletes `lab_runs` rows, so this
 * is race-free the same way the bench path's two-step claim-then-read is) -- if any hash is missing, nothing is
 * written and the caller gets `RUN_MISSING` to turn into 409 `LAB_RUN_MISSING`.
 */
export async function finishAgentJobDone(
  db: D1Db,
  opts: { id: string; leaseId: string; nowIso: string; answerJson: string; verifierJson: string; costJson: string; runHashes: string[] },
): Promise<{ ok: true } | { ok: false; reason: "LEASE_LOST" | "RUN_MISSING" }> {
  const uniqueHashes = [...new Set(opts.runHashes)];
  if (uniqueHashes.length) {
    const placeholders = uniqueHashes.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT result_hash FROM lab_runs WHERE result_hash IN (${placeholders})`)
      .bind(...uniqueHashes)
      .all<{ result_hash: string }>();
    if (results.length !== uniqueHashes.length) return { ok: false, reason: "RUN_MISSING" };
  }
  const updateStmt = db
    .prepare(
      `UPDATE lab_jobs SET status = 'done', answer_json = ?, verifier_json = ?, cost_json = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND lease_id = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until >= unixepoch()`,
    )
    .bind(opts.answerJson, opts.verifierJson, opts.costJson, opts.nowIso, opts.id, opts.leaseId);
  const runStmts = uniqueHashes.map((hash) =>
    db
      .prepare(
        `INSERT INTO lab_job_runs (job_id, result_hash)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM lab_jobs WHERE id = ? AND lease_id = ? AND status = 'done')
         ON CONFLICT(job_id, result_hash) DO NOTHING`,
      )
      .bind(opts.id, hash, opts.id, opts.leaseId),
  );
  const results = await (db as BatchableDb).batch([updateStmt, ...runStmts]);
  const changes = results[0]?.meta?.changes ?? results[0]?.changes ?? 0;
  return changes === 1 ? { ok: true } : { ok: false, reason: "LEASE_LOST" };
}

// ---- lab_prices (AL-40) ----

export type ShadowPriceTable = {
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }> & { default?: { inputPerMTok: number; outputPerMTok: number } };
  computeUsdPerCpuMs: number;
  dataUsdPerJob: number;
  settlementUsdPerJob: number;
};

/**
 * Normalizes `lab_prices` rows (resource, unit, usd, valid_from) into a `ShadowPriceTable`, taking for each
 * (resource, unit) pair the latest row with `valid_from <= asOfIso` (AL-40: "shadow prices... live in one
 * config table with a date"). Returns `null` when nothing is configured yet, so callers can treat "shadow
 * cost" as simply absent rather than zero (coordinator: "shadow cost if present").
 */
export type ShadowPriceRow = { resource: string; unit: string; usd: number; valid_from: string };

/** All price rows with `valid_from <= uptoIso`, ascending: one query, then `shadowPriceTableAt` picks per job. */
export async function loadShadowPriceRows(db: D1Db, uptoIso: string): Promise<ShadowPriceRow[]> {
  const { results } = await db
    .prepare("SELECT resource, unit, usd, valid_from FROM lab_prices WHERE valid_from <= ? ORDER BY valid_from ASC")
    .bind(uptoIso)
    .all<ShadowPriceRow>();
  return results;
}

/** Pure: for each (resource, unit) the latest row with `valid_from <= asOfIso` (rows ascending); `null` when none. */
export function shadowPriceTableAt(rows: ShadowPriceRow[], asOfIso: string): ShadowPriceTable | null {
  // Later rows (ASC order) overwrite earlier ones for the same (resource, unit): "the latest row <= asOf" wins.
  const latest = new Map<string, number>();
  for (const r of rows) if (r.valid_from <= asOfIso) latest.set(`${r.resource}|${r.unit}`, r.usd);
  if (!latest.size) return null;
  const table: ShadowPriceTable = { models: {}, computeUsdPerCpuMs: 0, dataUsdPerJob: 0, settlementUsdPerJob: 0 };
  for (const [key, usd] of latest) {
    const [resource, unit] = key.split("|");
    if (resource === "compute" && unit === "usd_per_cpu_ms") table.computeUsdPerCpuMs = usd;
    else if (resource === "data" && unit === "usd_per_job") table.dataUsdPerJob = usd;
    else if (resource === "settlement" && unit === "usd_per_job") table.settlementUsdPerJob = usd;
    else if (resource.startsWith("model:")) {
      const model = resource.slice("model:".length);
      const entry = table.models[model] ?? (table.models[model] = { inputPerMTok: 0, outputPerMTok: 0 });
      if (unit === "input_per_mtok") entry.inputPerMTok = usd;
      else if (unit === "output_per_mtok") entry.outputPerMTok = usd;
    }
  }
  return table;
}

export async function loadShadowPriceTable(db: D1Db, asOfIso: string): Promise<ShadowPriceTable | null> {
  return shadowPriceTableAt(await loadShadowPriceRows(db, asOfIso), asOfIso);
}

export type CostMeterLike = {
  modelCalls: { model: string; promptTokens: number; completionTokens: number }[];
  runs: { cpuMs: number }[];
  sweepCpuMs: number;
};

/** Port of `packages/lab-agent/src/cost-meter.ts`'s `shadowCost()` total (LLM + compute + data + settlement),
 * kept in sync with that file -- it is the one place a metric key or a price formula is defined, not here. */
export function shadowCostUsd(meter: CostMeterLike, prices: ShadowPriceTable): number {
  const llm = meter.modelCalls.reduce((sum, c) => {
    const p = prices.models[c.model] ?? prices.models.default ?? { inputPerMTok: 0, outputPerMTok: 0 };
    return sum + (c.promptTokens / 1_000_000) * p.inputPerMTok + (c.completionTokens / 1_000_000) * p.outputPerMTok;
  }, 0);
  const cpuMs = meter.runs.reduce((sum, r) => sum + r.cpuMs, 0) + meter.sweepCpuMs;
  const compute = cpuMs * prices.computeUsdPerCpuMs;
  return llm + compute + prices.dataUsdPerJob + prices.settlementUsdPerJob;
}
