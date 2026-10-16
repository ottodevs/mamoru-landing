/**
 * The environment/chain/account filter and group-by toggle for /ops (otto/mamoru#130). Pure types and
 * parsing only, so every other module (the D1 queries, the live snapshot, the Overview builder, the
 * renderer) depends on this one instead of on each other.
 */

export type EnvFilter = "prod" | "beta" | "test" | "all";
export type GroupBy = "none" | "chain" | "env";

export interface AccountFilter {
  /** 'test' means is_test = 1, whatever accounts.env says. 'prod'/'beta' both imply is_test = 0. 'all' is every
   * account, test ones included: the one case where the pre-#130 global numbers are still the right thing to show. */
  env: EnvFilter;
  chainId: number | "all";
  /** Free text matched against the account_key or the address. */
  account: string | null;
  group: GroupBy;
}

/** The subset the D1 queries need: env and chain only, never the free-text account or the group toggle. */
export type AccountScopeFilter = Pick<AccountFilter, "env" | "chainId">;

/** otto/mamoru#130's default view: real production accounts only. */
export const DEFAULT_FILTER: AccountFilter = { env: "prod", chainId: "all", account: null, group: "none" };

/**
 * True only for the one scope `AccountFilter.env`'s doc above describes as "the pre-#130 global numbers":
 * no env, chain or account narrowing at all. Only here does "users" mean every row in `users`, including
 * one who has not yet created an account — any narrower scope (a specific env, or a specific chain with
 * env: "all") is necessarily read from `accounts`, which by definition excludes a user with none.
 */
export function isFullyUnscoped(filter: AccountScopeFilter): boolean {
  return filter.env === "all" && filter.chainId === "all";
}

/**
 * The query string `parseAccountFilter` would read back to the same filter (otto/mamoru#130), for a link
 * or a form action that must carry the reader's current env/chain/account/group selection forward instead
 * of silently resetting it to `DEFAULT_FILTER` — e.g. the Overview's "Refresh" button, which posts to a
 * fixed action URL that otherwise carries no query string of its own.
 */
export function filterQuery(filter: AccountFilter): string {
  const params = new URLSearchParams();
  if (filter.env !== "prod") params.set("env", filter.env);
  if (filter.chainId !== "all") params.set("chain", String(filter.chainId));
  if (filter.account) params.set("account", filter.account);
  if (filter.group !== "none") params.set("group", filter.group);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function parseAccountFilter(params: URLSearchParams): AccountFilter {
  const envRaw = params.get("env");
  const env: EnvFilter = envRaw === "beta" || envRaw === "test" || envRaw === "all" ? envRaw : "prod";
  const chainRaw = params.get("chain");
  const chainId: number | "all" = chainRaw && chainRaw !== "all" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : "all";
  const account = params.get("account")?.trim() || null;
  const groupRaw = params.get("group");
  const group: GroupBy = groupRaw === "chain" || groupRaw === "env" ? groupRaw : "none";
  return { env, chainId, account, group };
}

/**
 * The accounts.env/chain_id/is_test SQL predicate for a scoped query (otto/mamoru#130), aliased to `alias`.
 * `filter.env === "test"` means is_test = 1 regardless of env; "prod"/"beta" both require is_test = 0 and a
 * matching env; "all" adds no predicate at all — every account, test ones included. Empty `sql` means no
 * WHERE clause is needed.
 */
export function accountScopeSql(filter: AccountScopeFilter, alias: string): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.env === "test") {
    clauses.push(`${alias}.is_test = 1`);
  } else if (filter.env !== "all") {
    clauses.push(`${alias}.is_test = 0`);
    clauses.push(`${alias}.env = ?`);
    params.push(filter.env);
  }
  if (filter.chainId !== "all") {
    clauses.push(`${alias}.chain_id = ?`);
    params.push(filter.chainId);
  }
  return { sql: clauses.join(" AND "), params };
}

/**
 * Whether the historical "value held" chart should keep reading `metrics_daily` (otto/mamoru#130).
 * `metrics_daily` was always one global row per day: no account ever carried a chain or an environment, so
 * there is nothing to retroactively split it by. `env: "prod"` (the default view) and `env: "all"` both read
 * it as an approximation that was already almost entirely true before beta or test accounts existed
 * (beta shipped 2026-10-01; there has only ever been one test account) — the alternative is no history at
 * all until `metrics_daily_v2` accumulates its own days. The chain filter is ignored here on purpose: Base
 * (8453) is the only chain that has ever existed, so narrowing to it changes nothing about what
 * `metrics_daily` already was. `beta`, `test`, or a specific chain narrow enough that mixing in the rest
 * would be actively misleading, so those read `metrics_daily_v2` only, empty or not — once a second chain
 * is real, a chain-specific filter must stop taking this path, since `metrics_daily` would then be wrong,
 * not merely approximate.
 */
export function usesLegacyHistory(filter: Pick<AccountFilter, "env" | "chainId">): boolean {
  return filter.env === "prod" || filter.env === "all";
}
