/**
 * Spec 006 (otto/mamoru#147): engine settings in D1 (`engine_settings_templates`, `engine_settings_versions`,
 * migration 0011 in ottodevs/mamoru). Append-only: this file only ever INSERTs a version; a rollback inserts a copy
 * of an older one. There is no UPDATE or DELETE of a version anywhere.
 */

import type { D1Db, D1PreparedStatement } from "./d1-infra";
import { canonicalJson, parseStored, settingsHash, validateSettings, type EngineSettings } from "./engine-settings-model";

type WriteStatement = D1PreparedStatement & { run(): Promise<unknown> };

export type Env = "prod" | "beta";

export type TemplateRow = { name: string; settings: EngineSettings; source: string; note: string | null };

export type VersionRow = {
  id: number;
  env: Env;
  accountKeys: string[] | null;
  template: string;
  settings: EngineSettings;
  hash: string;
  author: string;
  reason: string;
  createdAt: string;
  rollbackOf: number | null;
};

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

export async function listTemplates(db: D1Db): Promise<TemplateRow[] | null> {
  try {
    const { results } = await db
      .prepare("SELECT name, settings_json, source, note FROM engine_settings_templates ORDER BY source, name")
      .all<{ name: string; settings_json: string; source: string; note: string | null }>();
    return results.flatMap((r) => {
      const settings = parseStored(r.settings_json);
      return settings ? [{ name: r.name, settings, source: r.source, note: r.note }] : [];
    });
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

type RawVersion = {
  id: number;
  env: Env;
  account_keys_json: string | null;
  template: string;
  settings_json: string;
  settings_hash: string;
  author: string;
  reason: string;
  created_at: string;
  rollback_of: number | null;
};

function toVersion(r: RawVersion): VersionRow | null {
  const settings = parseStored(r.settings_json);
  if (!settings) return null;
  let accountKeys: string[] | null = null;
  if (r.account_keys_json !== null) {
    try {
      const keys = JSON.parse(r.account_keys_json);
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return null;
      accountKeys = keys;
    } catch {
      return null;
    }
  }
  return { id: r.id, env: r.env, accountKeys, template: r.template, settings, hash: r.settings_hash, author: r.author, reason: r.reason, createdAt: r.created_at, rollbackOf: r.rollback_of };
}

/** Newest first, at most `limit`. Null when migration 0011 is not applied. */
export async function listVersions(db: D1Db, limit = 50): Promise<VersionRow[] | null> {
  try {
    const { results } = await db
      .prepare(
        "SELECT id, env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of FROM engine_settings_versions ORDER BY id DESC LIMIT ?",
      )
      .bind(limit)
      .all<RawVersion>();
    return results.flatMap((r) => toVersion(r) ?? []);
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

export type InEffect = { wide: VersionRow | null; canary: VersionRow | null };

/**
 * What runs per env, read directly (never from a limited history page): the newest readable environment-wide
 * version, and the newest readable canary if it is newer than that (one canary at most is live, as the operator
 * resolves it). Without migration 0011 both are null.
 */
export async function inEffect(db: D1Db): Promise<Record<Env, InEffect>> {
  const newest = async (env: Env, canary: boolean, after: number) => {
    const r = await db
      .prepare(
        `SELECT id, env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of FROM engine_settings_versions WHERE env = ? AND account_keys_json IS ${canary ? "NOT NULL" : "NULL"} AND id > ? ORDER BY id DESC LIMIT 20`,
      )
      .bind(env, after)
      .all<RawVersion>();
    for (const raw of r.results) {
      const v = toVersion(raw);
      if (v) return v;
    }
    return null;
  };
  const one = async (env: Env): Promise<InEffect> => {
    const wide = await newest(env, false, 0);
    return { wide, canary: await newest(env, true, wide?.id ?? 0) };
  };
  try {
    return { prod: await one("prod"), beta: await one("beta") };
  } catch (e) {
    if (missingTable(e)) return { prod: { wide: null, canary: null }, beta: { wide: null, canary: null } };
    throw e;
  }
}

export async function versionById(db: D1Db, id: number): Promise<VersionRow | null> {
  const r = await db
    .prepare(
      "SELECT id, env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of FROM engine_settings_versions WHERE id = ?",
    )
    .bind(id)
    .first<RawVersion>();
  return r ? toVersion(r) : null;
}

/** The newest version id of an env (any scope), 0 when none: what a write is checked against. */
export async function maxIdOf(db: D1Db, env: Env): Promise<number> {
  try {
    const r = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM engine_settings_versions WHERE env = ?").bind(env).first<{ id: number }>();
    return r?.id ?? 0;
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
}

/** Thrown when another version of the env was written after the one the change was checked against. */
export class SettingsConflict extends Error {}

/** The database did not report whether the insert ran: it may have committed. Never reported as "not applied". */
export class SettingsOutcomeUnknown extends Error {}

export type NewVersion = { env: Env; accountKeys: string[] | null; template: string; settings: EngineSettings; author: string; reason: string; rollbackOf?: number | null };

/** Appends one version. Refuses settings out of bounds and an empty reason; returns the new id. */
/**
 * Appends one version, only if the env has not moved since `expectedMaxId` (the newest id of the env when its risks
 * were checked and confirmed). The check and the insert are one SQL statement, so no other writer can land between
 * them; when the env moved, nothing is written and SettingsConflict is thrown, so the change is checked again.
 */
export async function appendVersion(db: D1Db, v: NewVersion & { expectedMaxId: number }, now: Date = new Date()): Promise<number> {
  const errors = validateSettings(v.settings);
  if (errors.length) throw new Error(errors.join("; "));
  if (!v.reason.trim()) throw new Error("a reason is required");
  if (v.env !== "prod" && v.env !== "beta") throw new Error("env must be prod or beta");
  if (v.accountKeys !== null && (!v.accountKeys.length || v.accountKeys.some((k) => !/^[0-9a-f-]{8,64}$/i.test(k)))) throw new Error("canary account keys look wrong");
  const accountKeys = v.accountKeys === null ? null : [...new Set(v.accountKeys.map((k) => k.toLowerCase()))];
  const hash = await settingsHash(v.settings);
  const createdAt = now.toISOString();
  const stmt = db
    .prepare(
      "INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(id), 0) FROM engine_settings_versions WHERE env = ?) = ?",
    )
    .bind(
      v.env,
      accountKeys === null ? null : JSON.stringify(accountKeys),
      v.template.slice(0, 120),
      canonicalJson(v.settings),
      hash,
      v.author,
      v.reason.trim().slice(0, 500),
      createdAt,
      v.rollbackOf ?? null,
      v.env,
      v.expectedMaxId,
    ) as WriteStatement;
  const res = (await stmt.run()) as { meta?: { changes?: number; last_row_id?: number }; changes?: number; lastInsertRowid?: number | bigint } | undefined;
  // The guarded insert reports its own outcome (D1: meta.changes and meta.last_row_id): 0 rows means the env moved;
  // 1 row carries its id. No second read decides anything, so a committed write is never reported as failed and a
  // losing request never claims another one's row.
  const changes = res?.meta?.changes ?? res?.changes;
  const id = res?.meta?.last_row_id ?? (res?.lastInsertRowid === undefined ? undefined : Number(res.lastInsertRowid));
  if (changes === 0) throw new SettingsConflict("the settings of this environment changed meanwhile");
  if (changes !== 1 || !id) throw new SettingsOutcomeUnknown("the database did not say whether the version was written");
  return id;
}
