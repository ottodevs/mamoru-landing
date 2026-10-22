/**
 * D1 access for a cap per account (otto/mamoru-astro#25): `account_cap_overrides`, added by ottodevs/mamoru#109
 * (otto/mamoru#26), not applied at the time of writing. Append-only like ops_flag_changes and engine_settings_versions:
 * this file only ever INSERTs. The newest row of an account wins (the app Worker groups by lowercase account_key);
 * cap_usdc NULL means the account is back on its environment's cap. Every read degrades to "not set up" when the
 * table is missing.
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";
import { SHORT_KEY, validateAccountCapOverride } from "./account-cap-model";

type WriteStatement = D1PreparedStatement & { run(): Promise<unknown> };

export type CapOverrideRow = {
  id: number;
  env: string;
  accountKey: string;
  capUsdc: number | null;
  author: string;
  reason: string;
  createdAt: string;
};

type RawRow = { id: number; env: string; account_key: string; cap_usdc: number | null; author: string; reason: string; created_at: string };

const toRow = (r: RawRow): CapOverrideRow => ({ id: r.id, env: r.env, accountKey: r.account_key, capUsdc: r.cap_usdc, author: r.author, reason: r.reason, createdAt: r.created_at });

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/**
 * The newest row of every account (one correlated MAX(id) per lowercase key, as the app Worker reads it). Null when
 * the table is not there yet.
 */
export async function newestOverrides(db: D1Db): Promise<CapOverrideRow[] | null> {
  try {
    const { results } = await db
      .prepare(
        `SELECT o.id, o.env, o.account_key, o.cap_usdc, o.author, o.reason, o.created_at FROM account_cap_overrides o
         WHERE o.id = (SELECT MAX(id) FROM account_cap_overrides WHERE lower(account_key) = lower(o.account_key))`,
      )
      .all<RawRow>();
    return results.map(toRow);
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** The newest row for one full account key, null when it has none; undefined when the table is not there. */
export async function newestOverrideOf(db: D1Db, accountKey: string): Promise<CapOverrideRow | null | undefined> {
  try {
    const r = await db
      .prepare("SELECT id, env, account_key, cap_usdc, author, reason, created_at FROM account_cap_overrides WHERE lower(account_key) = lower(?) ORDER BY id DESC LIMIT 1")
      .bind(accountKey)
      .first<RawRow>();
    return r ? toRow(r) : null;
  } catch (e) {
    if (missingTable(e)) return undefined;
    throw e;
  }
}

export type Resolved =
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "one"; accountKey: string; env: string; isTest: boolean };

/**
 * The 8-character key the console shows, to exactly one full `account_key` in `accounts`. Zero or several matches
 * are reported as such and the caller writes nothing: a cap never lands on a guessed account.
 */
export async function resolveAccountKey(db: D1Db, short: string): Promise<Resolved> {
  if (!SHORT_KEY.test(short)) return { kind: "none" };
  const { results } = await db
    .prepare("SELECT account_key, env, is_test FROM accounts WHERE lower(substr(account_key, 1, 8)) = lower(?) LIMIT 3")
    .bind(short)
    .all<{ account_key: string; env: string | null; is_test: number | null }>();
  if (!results.length) return { kind: "none" };
  if (results.length > 1) return { kind: "many", count: results.length };
  const r = results[0]!;
  return { kind: "one", accountKey: r.account_key, env: r.env ?? "prod", isTest: r.is_test === 1 };
}

/** Thrown when another row for this account was written after the one this write was checked against. */
export class CapConflict extends Error {}

/** The table is not there: nothing was written. */
export class CapTableMissing extends Error {}

/** The database did not report whether the insert ran: it may have committed. Never reported as "not applied". */
export class CapOutcomeUnknown extends Error {}

export type NewCapOverride = { env: "prod" | "beta"; accountKey: string; capUsdc: number | null; author: string; reason: string; expectedMaxId: number };

/**
 * Appends one row, only if the account has no row newer than `expectedMaxId` (its newest id when the form or the
 * confirm screen was shown). Check and insert are one statement, so no other writer lands between them. Same pattern
 * as appendFlagChange; the outcome is read from the statement's own meta.
 */
export async function appendCapOverride(db: D1Db, v: NewCapOverride, now: Date = new Date()): Promise<number> {
  const errors = validateAccountCapOverride({ accountKey: v.accountKey, capUsdc: v.capUsdc });
  if (errors.length) throw new Error(errors.join("; "));
  if (!v.reason.trim()) throw new Error("a reason is required");
  if (v.env !== "prod" && v.env !== "beta") throw new Error("env must be prod or beta");
  const stmt = db
    .prepare(
      `INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(id), 0) FROM account_cap_overrides WHERE lower(account_key) = lower(?)) = ?`,
    )
    .bind(v.env, v.accountKey, v.capUsdc, v.author, v.reason.trim().slice(0, 500), now.toISOString(), v.accountKey, v.expectedMaxId) as WriteStatement;
  let res: { meta?: { changes?: number; last_row_id?: number }; changes?: number; lastInsertRowid?: number | bigint } | undefined;
  try {
    res = (await stmt.run()) as typeof res;
  } catch (e) {
    if (missingTable(e)) throw new CapTableMissing("the account caps table is not set up");
    // A statement that threw for any other reason (timeout, lost connection) may still have committed.
    throw new CapOutcomeUnknown(e instanceof Error ? e.message : String(e));
  }
  const changes = res?.meta?.changes ?? res?.changes;
  const id = res?.meta?.last_row_id ?? (res?.lastInsertRowid === undefined ? undefined : Number(res.lastInsertRowid));
  if (changes === 0) throw new CapConflict("this account's cap changed meanwhile");
  if (changes !== 1 || !id) throw new CapOutcomeUnknown("the database did not say whether the row was written");
  return id;
}
