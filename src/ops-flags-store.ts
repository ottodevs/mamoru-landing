/**
 * D1 access for /ops/functions (otto/mamoru-astro#20): `ops_flag_changes`, migration 0012 in
 * ottodevs/mamoru (otto/mamoru#129), not applied yet at the time of writing. Append-only, same shape as
 * engine_settings_versions (0011, engine-settings-store.ts): this file only ever INSERTs a change row; the
 * current value of a flag is the newest row for its name, and no row at all means off.
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";

type WriteStatement = D1PreparedStatement & { run(): Promise<unknown> };

export type FlagChangeRow = {
  id: number;
  flag: string;
  enabled: boolean;
  author: string;
  reason: string;
  createdAt: string;
};

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

type RawRow = { id: number; flag: string; enabled: number; author: string; reason: string; created_at: string };

function toRow(r: RawRow): FlagChangeRow {
  return { id: r.id, flag: r.flag, enabled: r.enabled === 1, author: r.author, reason: r.reason, createdAt: r.created_at };
}

/** Newest first, at most `limit`, for one flag. Null when migration 0012 is not applied. */
export async function listFlagChanges(db: D1Db, flag: string, limit = 20): Promise<FlagChangeRow[] | null> {
  try {
    const { results } = await db
      .prepare("SELECT id, flag, enabled, author, reason, created_at FROM ops_flag_changes WHERE flag = ? ORDER BY id DESC LIMIT ?")
      .bind(flag, limit)
      .all<RawRow>();
    return results.map(toRow);
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/**
 * The current state of every flag that has ever been written, keyed by name: the newest row per flag (a
 * correlated MAX(id) subquery, portable to D1 without a window function). Null when migration 0012 is not
 * applied. A flag absent from the returned map has no row at all, i.e. it is off.
 */
export async function currentFlagStates(db: D1Db): Promise<Map<string, FlagChangeRow> | null> {
  try {
    const { results } = await db
      .prepare(
        `SELECT c.id, c.flag, c.enabled, c.author, c.reason, c.created_at FROM ops_flag_changes c
         WHERE c.id = (SELECT MAX(id) FROM ops_flag_changes WHERE flag = c.flag)`,
      )
      .all<RawRow>();
    return new Map(results.map((r) => [r.flag, toRow(r)]));
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** The newest id for one flag, 0 when it has no row yet: what a write is checked against. */
export async function maxIdOf(db: D1Db, flag: string): Promise<number> {
  try {
    const r = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM ops_flag_changes WHERE flag = ?").bind(flag).first<{ id: number }>();
    return r?.id ?? 0;
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
}

/** Thrown when another change to this flag was written after the one this write was checked against. */
export class FlagConflict extends Error {}

/** The database did not report whether the insert ran: it may have committed. Never reported as "not applied". */
export class FlagOutcomeUnknown extends Error {}

export type NewFlagChange = { flag: string; enabled: boolean; author: string; reason: string; expectedMaxId: number };

/**
 * Appends one change, only if the flag has not moved since `expectedMaxId` (its newest id when the change
 * was shown and, for turning on, confirmed). The check and the insert are one SQL statement, so no other
 * writer can land between them; when the flag moved, nothing is written and FlagConflict is thrown. Same
 * pattern as engine-settings-store.ts's appendVersion, outcome read from the statement's own meta.
 */
export async function appendFlagChange(db: D1Db, v: NewFlagChange, now: Date = new Date()): Promise<number> {
  if (!v.reason.trim()) throw new Error("a reason is required");
  const createdAt = now.toISOString();
  const stmt = db
    .prepare(
      "INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(id), 0) FROM ops_flag_changes WHERE flag = ?) = ?",
    )
    .bind(v.flag, v.enabled ? 1 : 0, v.author, v.reason.trim().slice(0, 500), createdAt, v.flag, v.expectedMaxId) as WriteStatement;
  const res = (await stmt.run()) as { meta?: { changes?: number; last_row_id?: number }; changes?: number; lastInsertRowid?: number | bigint } | undefined;
  const changes = res?.meta?.changes ?? res?.changes;
  const id = res?.meta?.last_row_id ?? (res?.lastInsertRowid === undefined ? undefined : Number(res.lastInsertRowid));
  if (changes === 0) throw new FlagConflict("this flag changed meanwhile");
  if (changes !== 1 || !id) throw new FlagOutcomeUnknown("the database did not say whether the change was written");
  return id;
}
