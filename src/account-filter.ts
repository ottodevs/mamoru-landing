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
 * Whether the historical "value held" chart should keep reading `metrics_daily` (otto/mamoru#130).
 * `metrics_daily` was always one global row per day: no account ever carried a chain or an environment, so
 * there is nothing to retroactively split it by. `env: "prod"` (the default view) and `env: "all"` both read
 * it as an approximation that was already almost entirely true before beta or test accounts existed
 * (beta shipped 2026-10-01; there has only ever been one test account) — the alternative is no history at
 * all until `metrics_daily_v2` accumulates its own days. `beta`, `test`, or a specific chain narrow enough
 * that mixing in the rest would be actively misleading, so those read `metrics_daily_v2` only, empty or not.
 */
export function usesLegacyHistory(filter: Pick<AccountFilter, "env" | "chainId">): boolean {
  return (filter.env === "prod" || filter.env === "all") && filter.chainId === "all";
}
