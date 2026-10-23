-- otto/mamoru-astro#28 (spec 008 phase 1 "the bench"). Reference copy only, same convention as
-- 0004_experiments.sql and XXXX_metrics_daily_v2.sql in this directory: the canonical file to apply lives at
-- migrations/d1/XXXX_lab_bench.sql in ottodevs/mamoru, which owns D1 `mamoru` (Constitution VII — D1 here is a
-- projection for the screen, never applied by this Worker or this repo).
--
-- lab_runs: one row per distinct RunResult (B-02). spec_key = `${windowId}|${base}|${widthTicks}|${deposit}`,
-- the same spec always gives the same result_hash (LAB-AL-09), so re-seeding is an upsert, never a duplicate.
-- summary_json is the B-02 result minus ops/series/reasons (list views); run_json is the full result (bench charts).
CREATE TABLE IF NOT EXISTS lab_runs (
  result_hash TEXT PRIMARY KEY,
  spec_key TEXT NOT NULL,
  window_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  run_json TEXT NOT NULL,
  sim_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lab_runs_window_id ON lab_runs (window_id);
CREATE INDEX IF NOT EXISTS lab_runs_spec_key ON lab_runs (spec_key);

-- lab_jobs: "Run scenario" (B-04) and, in phase 2, chat turns. Lease + fencing fields are AL-02/AL-02a.
CREATE TABLE IF NOT EXISTS lab_jobs (
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
CREATE INDEX IF NOT EXISTS lab_jobs_requester_created ON lab_jobs (requester, created_at);
CREATE INDEX IF NOT EXISTS lab_jobs_status ON lab_jobs (status);

-- lab_nonces: the runner HMAC replay guard (Architecture section of spec 008). Rows older than 10 minutes are
-- pruned opportunistically on every signed request (lab-store.ts's recordNonce).
CREATE TABLE IF NOT EXISTS lab_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
