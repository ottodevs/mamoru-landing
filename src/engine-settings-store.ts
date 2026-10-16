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

/** The environment-wide version in effect for each env, read directly (not from a limited history page). */
export async function activeByEnv(db: D1Db): Promise<Record<Env, VersionRow | null>> {
  const one = async (env: Env) => {
    const r = await db
      .prepare(
        "SELECT id, env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of FROM engine_settings_versions WHERE env = ? AND account_keys_json IS NULL ORDER BY id DESC LIMIT 20",
      )
      .bind(env)
      .all<RawVersion>();
    // The newest readable one: a row the code would refuse is skipped, as the operator skips it.
    for (const raw of r.results) {
      const v = toVersion(raw);
      if (v) return v;
    }
    return null;
  };
  return { prod: await one("prod"), beta: await one("beta") };
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

export type NewVersion = { env: Env; accountKeys: string[] | null; template: string; settings: EngineSettings; author: string; reason: string; rollbackOf?: number | null };

/** Appends one version. Refuses settings out of bounds and an empty reason; returns the new id. */
export async function appendVersion(db: D1Db, v: NewVersion, now: Date = new Date()): Promise<number> {
  const errors = validateSettings(v.settings);
  if (errors.length) throw new Error(errors.join("; "));
  if (!v.reason.trim()) throw new Error("a reason is required");
  if (v.env !== "prod" && v.env !== "beta") throw new Error("env must be prod or beta");
  if (v.accountKeys !== null && (!v.accountKeys.length || v.accountKeys.some((k) => !/^[0-9a-f-]{8,64}$/i.test(k)))) throw new Error("canary account keys look wrong");
  const accountKeys = v.accountKeys === null ? null : [...new Set(v.accountKeys.map((k) => k.toLowerCase()))];
  const stmt = db
    .prepare(
      "INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at, rollback_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      v.env,
      accountKeys === null ? null : JSON.stringify(accountKeys),
      v.template.slice(0, 120),
      canonicalJson(v.settings),
      await settingsHash(v.settings),
      v.author,
      v.reason.trim().slice(0, 500),
      now.toISOString(),
      v.rollbackOf ?? null,
    ) as WriteStatement;
  await stmt.run();
  const row = await db.prepare("SELECT MAX(id) AS id FROM engine_settings_versions").first<{ id: number }>();
  return row?.id ?? 0;
}
