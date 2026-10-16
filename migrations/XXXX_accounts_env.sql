-- Owned by ottodevs/mamoru: kept here for reference only. The canonical copy to apply lives at
-- migrations/d1/XXXX_accounts_env.sql in ottodevs/mamoru, with the backfill strategy and the coordinator's
-- to-do spelled out there (otto/mamoru#130). This Worker (mamoru-astro / Worker mamoru-lol) only reads
-- accounts.env and accounts.is_test through the MAMORU_DB binding; it never runs migrations itself.

ALTER TABLE accounts ADD COLUMN env TEXT NOT NULL DEFAULT 'prod' CHECK (env IN ('prod', 'beta'));
ALTER TABLE accounts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));
