-- otto/mamoru-astro#30 (spec 008 phase 2 "the agent"). Reference copy only, same convention as
-- XXXX_lab_bench.sql in this directory: the canonical file to apply lives at migrations/d1/0020_lab_agent.sql
-- in ottodevs/mamoru, which owns D1 `mamoru` (Constitution VII).
--
-- lab_jobs gains the chat-turn fields (AL-01, AL-20, AL-40, AL-60). A bench job (`kind` = 'bench') leaves these
-- NULL; an agent job (`kind` = 'agent') uses thread_id/question/answer_json/verifier_json/cost_json.
-- quote_json/payer are x402 shape only (AL-60) -- always NULL until that later ticket writes them.
ALTER TABLE lab_jobs ADD COLUMN thread_id TEXT;
ALTER TABLE lab_jobs ADD COLUMN question TEXT;
ALTER TABLE lab_jobs ADD COLUMN answer_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN verifier_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN cost_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN quote_json TEXT;
ALTER TABLE lab_jobs ADD COLUMN payer TEXT;
CREATE INDEX IF NOT EXISTS lab_jobs_thread_id ON lab_jobs (thread_id);

-- lab_threads: one row per chat thread (AL-01). owner = ops email, same identity lab_jobs.requester uses.
CREATE TABLE IF NOT EXISTS lab_threads (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lab_threads_owner_updated ON lab_threads (owner, updated_at);

-- lab_job_runs: which stored runs (lab_runs) an agent job's answer may cite (AL-21: "a run that merely exists
-- in the store is not citable" -- only the runs this job's own tool calls produced or fetched). Written in the
-- same fenced batch as the job's done/answer write; a hash not yet landed in lab_runs (the runner POSTs runs to
-- /publish before /result) is refused whole with LAB_RUN_MISSING, nothing written for that result.
CREATE TABLE IF NOT EXISTS lab_job_runs (
  job_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  PRIMARY KEY (job_id, result_hash)
);
CREATE INDEX IF NOT EXISTS lab_job_runs_result_hash ON lab_job_runs (result_hash);

-- lab_prices: shadow prices per resource (AL-40), one row per (resource, unit) with a validity date -- the
-- cost meter prices a job's tokens/CPU ms against whichever row's valid_from is the latest one <= the job's
-- created_at. Written by ops (pricing config), never by the runner. Normalizes ShadowPriceTable
-- (ottodevs/mamoru packages/lab-agent/src/cost-meter.ts) into rows: resource 'model:<name>' with unit
-- 'input_per_mtok'/'output_per_mtok', resource 'compute' unit 'usd_per_cpu_ms', resource 'data'/'settlement'
-- unit 'usd_per_job'.
CREATE TABLE IF NOT EXISTS lab_prices (
  resource TEXT NOT NULL,
  unit TEXT NOT NULL,
  usd REAL NOT NULL,
  valid_from TEXT NOT NULL,
  PRIMARY KEY (resource, unit, valid_from)
);
