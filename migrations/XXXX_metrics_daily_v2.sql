-- Owned by ottodevs/mamoru: kept here for reference only. The canonical copy to apply lives at
-- migrations/d1/XXXX_metrics_daily_v2.sql in ottodevs/mamoru (otto/mamoru#130). This Worker
-- (mamoru-astro / Worker mamoru-lol) is the one that writes metrics_daily_v2 and metrics_daily_chain,
-- through the MAMORU_DB binding, same as metrics_daily; it never runs migrations itself. Additive only:
-- metrics_daily is untouched and stays readable.
--
-- `relayer_eth` and `eth_usd` are NOT on metrics_daily_v2: the relayer is one wallet shared by every env on
-- a chain, and the ETH/USD price is one number for the whole day, neither of them scoped to prod vs. beta.
-- They live once per (day, chain_id) in metrics_daily_chain instead, so nothing that reads either table can
-- double count them by summing or grouping across env.

CREATE TABLE IF NOT EXISTS metrics_daily_v2 (
  day TEXT NOT NULL,            -- UTC YYYY-MM-DD
  chain_id INTEGER NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod', 'beta')),
  users INTEGER NOT NULL,
  accounts INTEGER NOT NULL,
  funded_accounts INTEGER NOT NULL,
  active_accounts INTEGER NOT NULL,  -- accounts holding >=1 LP position
  dau INTEGER NOT NULL,
  tvl_usd REAL NOT NULL,
  idle_usdc_usd REAL NOT NULL,
  lp_usd REAL NOT NULL,
  positions INTEGER NOT NULL,
  in_range INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id, env)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS metrics_daily_v2_env_day ON metrics_daily_v2 (env, day);

CREATE TABLE IF NOT EXISTS metrics_daily_chain (
  day TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  relayer_eth REAL NOT NULL,
  eth_usd REAL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (day, chain_id)
) WITHOUT ROWID;
