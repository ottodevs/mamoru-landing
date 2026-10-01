/**
 * D1 access for experiment events. `exp_events` is additive to the `mamoru`
 * database (owned by ottodevs/mamoru — see migrations/0003_experiments.sql in
 * this repo for the file to land at migrations/d1/ there) and may not exist
 * yet on every environment: every read returns null and every write is a
 * silent no-op when the table is missing, exactly like account_activity in
 * metrics-store.ts.
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";

export interface ExpEventRow {
  experiment: string;
  variant: string;
  visitor: string;
  event: string;
  /** UTC day, YYYY-MM-DD. Part of the dedupe key: one row per visitor+event+day. */
  day: string;
  at: string;
}

type WriteStatement = D1PreparedStatement & { run(): Promise<unknown> };

/** Idempotent: a repeat of the same (experiment, visitor, event, day) is a no-op, by the table's own primary key. */
export async function recordExpEvent(db: D1Db, row: ExpEventRow): Promise<void> {
  try {
    const stmt = db
      .prepare(
        "INSERT OR IGNORE INTO exp_events (experiment, variant, visitor, event, day, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(row.experiment, row.variant, row.visitor, row.event, row.day, row.at) as WriteStatement;
    await stmt.run();
  } catch {
    // exp_events is additive and may not exist yet on every environment.
  }
}

export interface ExpCounts {
  /** variant id -> unique visitors exposed. */
  exposures: Map<string, number>;
  /** goal name -> variant id -> unique converters. */
  conversions: Map<string, Map<string, number>>;
}

function toCountMap(rows: { variant: string; n: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.variant, Number(r.n) || 0]));
}

/** Unique-visitor counts for one experiment: exposures per variant, and conversions per goal per variant. null when exp_events is missing or unreadable. */
export async function readExpCounts(db: D1Db, experimentId: string, goals: readonly string[]): Promise<ExpCounts | null> {
  try {
    const exposureRows = await db
      .prepare(
        "SELECT variant, COUNT(DISTINCT visitor) AS n FROM exp_events WHERE experiment = ? AND event = 'exposure' GROUP BY variant",
      )
      .bind(experimentId)
      .all<{ variant: string; n: number }>();
    const exposures = toCountMap(exposureRows.results);
    const conversions = new Map<string, Map<string, number>>();
    for (const goal of goals) {
      const rows = await db
        .prepare("SELECT variant, COUNT(DISTINCT visitor) AS n FROM exp_events WHERE experiment = ? AND event = ? GROUP BY variant")
        .bind(experimentId, goal)
        .all<{ variant: string; n: number }>();
      conversions.set(goal, toCountMap(rows.results));
    }
    return { exposures, conversions };
  } catch {
    return null;
  }
}
