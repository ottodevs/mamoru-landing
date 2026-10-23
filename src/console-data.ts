// otto/mamoru-astro#24: one model for the console's five views (Pulse, Yield, Accounts, Engine, Costs), read from
// D1 only: the yield ledger (ottodevs/mamoru#129), accounts and users, the legacy daily metrics, and the operator's
// own /metrics as the app Worker stores it in operator_metrics_latest (ottodevs/mamoru migration 0013). Every
// figure says where it comes from, and a source that is not there yet is null, never a guessed zero.
import type { D1Db } from "./d1-infra";
import type { InfraSnapshot } from "./infra-snapshot";
import { CAP_SOURCES, DEFAULT_CAP_USDC, type CapSource } from "./account-cap-model";
import { newestOverrides, type CapOverrideRow } from "./account-caps-store";
import { inEffect } from "./engine-settings-store";

export type ConsoleEnv = "prod" | "all";

export function parseConsoleEnv(value: string | null): ConsoleEnv {
  return value === "all" ? "all" : "prod";
}

export type Position = { tokenId: string; pool: string; inRange: boolean; value: number; fees: number };

export type AccountYield = {
  key: string;
  env: string;
  total: number;
  lp: number;
  idle: number;
  /** Uncollected fees since each position's checkpoint, USD. */
  fees: number;
  /** Its first confirmed entry, as the operator reports it; null when the operator has not reported one. */
  since: string | null;
  days: number | null;
  /**
   * Fee APR, gross of gas, %: uncollected fees over capital placed, annualised from the first entry. A lower bound:
   * fees count from each position's last checkpoint, which is never earlier than the first entry, so a harvest or a
   * re-centre can only make the true figure higher. Null without a reported first entry or under 50¢ placed.
   */
  apr: number | null;
  /**
   * ottodevs/mamoru#129 phase 2: fees collected to date (harvest, re-centre, Stop), USD, from
   * yield_ledger_account_receipts (migration 0015). Null when that table is not there.
   */
  collected: number | null;
  /** Gas this account's operations paid to date, ETH, from the same receipts. Null when that table is not there. */
  gasEth: number | null;
  /**
   * Uncollected plus collected, USD. When a receipt is newer than this account's snapshot (a Stop collected what the
   * snapshot still shows as uncollected, and a stopped account is not read again), only the collected part counts:
   * adding both would count those fees twice (same rule as the app's loadYieldLedger).
   */
  earned: number;
  /** True when `earned` left the snapshot's uncollected fees out for that reason. */
  feesStale: boolean;
  positions: Position[];
  readAt: string;
};

/**
 * One UTC day: fees earned (accrued change plus collected, from account_daily; null on a day no snapshot covered),
 * gas paid (receipts; null when that table is not there) priced at that day's ETH price (metrics_daily; null without
 * one), and the net of the two (null when either is unknown).
 */
export type DayYield = { day: string; fees: number | null; gasEth: number | null; gasUsd: number | null; net: number | null };

export type PoolYield = { pool: string; value: number; fees: number; positions: number; inRange: number; apr: number | null };

export type EngineOp = { accountKey: string; kind: string; state: string; at: string; code: string | null };

export type EngineHealth = { accountKey?: string; [field: string]: unknown };

/**
 * otto/mamoru-astro#25: one account's approval as the operator holds it (/metrics `authorizations`, ottodevs/mamoru#109),
 * mirrored into operator_metrics_latest. Whole USDC, ISO times; a field the payload does not carry is null.
 */
export type Authorization = {
  account: string;
  /** Null when the payload does not say. */
  active: boolean | null;
  policyId: string | null;
  policyVersion: string | null;
  pools: string[];
  validUntil: string | null;
  grants: { grant: string; usedBps: number }[];
  capUsdc: number | null;
  capSource: CapSource | null;
  signedCapUsdc: number | null;
  holds: string[];
  deactivated: string | null;
};

/** The environment's cap from the engine settings in effect (engine_settings_versions), for one account. */
export type GeneralCap = { capUsdc: number; depth: boolean; version: number; canary: boolean };

/** Everything the console knows about one account's cap: what the operator runs, what was asked, the general cap. */
export type AccountCap = {
  key: string;
  accountKey: string;
  env: string;
  authorization: Authorization | null;
  /** The newest row of account_cap_overrides for it, a removal included (capUsdc null); null without a row. */
  override: CapOverrideRow | null;
  general: GeneralCap | null;
};

export type Alert = { tone: "bad" | "warn" | "info"; title: string; detail: string; account?: string };

export type DayPoint = { day: string; value: number };

export interface ConsoleModel {
  env: ConsoleEnv;
  asOf: string;
  /** Read time of the newest ledger row, or null before the ledger has written one. */
  ledgerReadAt: string | null;
  accounts: AccountYield[];
  totals: {
    fees: number;
    /** The uncollected fees `earned` counts: those of accounts whose snapshot is newer than their receipts. */
    feesCounted: number;
    lp: number;
    idle: number;
    apr: number | null;
    positions: number;
    inRange: number;
    earning: number;
    /** Every account in scope, a snapshot or not. Null when the receipts table (migration 0015) is not there. */
    collected: number | null;
    earned: number;
    gasEth: number | null;
    /** Each day's gas at that day's ETH price (metrics_daily), over the days that have one: a past cost is never
     * repriced at today's market. Null without the receipts table. */
    gasUsd: number | null;
    /** Gas paid on days with no recorded ETH price, left out of gasUsd. Null without the receipts table. */
    gasUnpricedEth: number | null;
    /** Earned minus gasUsd; an upper bound when gasUnpricedEth > 0 (that gas can only lower it). Null exactly when gasUsd is. */
    net: number | null;
  };
  /** Days since the ledger's first, oldest first; empty before it has written one. */
  daily: DayYield[];
  pools: PoolYield[];
  lifecycle: { total: number; earning: number; waiting: number; signedUp: number };
  /** Capital held per day from metrics_daily: every environment, test included (that table has no env column). */
  capital: DayPoint[];
  signups: DayPoint[];
  operator: null | {
    generatedAt: string;
    gitSha: string | null;
    relayerWei: string | null;
    ops: EngineOp[];
    rpc: { hour: string; cu: number }[];
    engines: EngineHealth[];
  };
  relayer: null | { address: string; eth: number; usd: number | null; costPerAccountUsd: number | null; runway: number | null };
  alerts: Alert[];
  /**
   * otto/mamoru-astro#25. `reported`: the stored operator metrics carry `authorizations` (ottodevs/mamoru#109 deployed).
   * `table`: account_cap_overrides exists. `byKey`: accounts in scope, by lowercase 8-character key.
   */
  caps: { reported: boolean; complete: boolean; table: boolean; byKey: Map<string, AccountCap> };
}

const missing = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));

async function rows<T>(db: D1Db, sql: string, ...binds: unknown[]): Promise<T[] | null> {
  try {
    const stmt = db.prepare(sql);
    const res = await (binds.length ? stmt.bind(...binds) : stmt).all<T>();
    return res.results ?? [];
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** USDC base units (1e6) as stored by the ledger writer, to dollars. */
const usd = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) / 1e6);

const dayOf = (iso: string) => iso.slice(0, 10);

function daysBetween(fromIso: string, to: Date): number {
  return Math.max(0.5, (to.getTime() - new Date(fromIso).getTime()) / 864e5);
}

function eachDay(from: string, to: Date): string[] {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

type SnapRow = { account_key: string; env: string; read_at: string; idle_usdc: number; lp_usdc: number; fees_usdc: number; total_usdc: number; positions_json: string; updated_at: string };
type ReceiptRow = { account_key: string; day: string; gas_paid_wei: string; collected_usdc: number | null; updated_at: string };
type DailyRow = { account_key: string; day: string; fees_delta: number; collected_usdc: number | null };

/** Wei as decimal text to ETH; an unparseable value reads as 0 rather than throwing the whole console. */
function weiToEth(wei: string): number {
  try {
    return Number(BigInt(wei)) / 1e18;
  } catch {
    return 0;
  }
}
type AccountRow = { account_key: string; env: string | null; is_test: number | null; created_at: string };
type MetricsRow = { day: string; lp_usd: number; idle_usdc_usd: number; eth_usd: number | null };
type OperatorRow = { payload_json: string; generated_at: string };

type StoredOperatorMetrics = {
  operator?: { gitSha?: string; relayer?: { balanceWei?: string } };
  /** As the operator serves it (apps/mamoru-operator/src/metrics.ts): ISO hour start, per provider, per method. */
  rpc?: { last48h?: { hourStart: string; data?: Record<string, Record<string, { cuEstimate?: number }>> }[] };
  engines?: EngineHealth[];
  opsRecent?: EngineOp[];
  authorizations?: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** A cap as the operator reports it: whole USDC within the bounds a row can hold, or unknown. Never trusted beyond them. */
const capValue = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : null);
const bps = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Tolerant of anything: an entry without an account key is dropped, a malformed field reads as unknown. `complete` is
 * false when any entry was dropped: then an account missing from the list is "not reported", never "no approval".
 */
export function parseAuthorizations(raw: unknown): { entries: Authorization[]; complete: boolean } | null {
  if (!Array.isArray(raw)) return null;
  const out: Authorization[] = [];
  let complete = true;
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || typeof a.account !== "string" || !a.account) {
      complete = false;
      continue;
    }
    const src = a.capSource;
    out.push({
      account: a.account.slice(0, 8),
      active: typeof a.active === "boolean" ? a.active : null,
      policyId: str(a.policyId),
      policyVersion: a.policyVersion == null ? null : String(a.policyVersion),
      pools: Array.isArray(a.pools) ? a.pools.filter((p): p is string => typeof p === "string") : [],
      validUntil: typeof a.validUntil === "string" && Number.isFinite(Date.parse(a.validUntil)) ? a.validUntil : null,
      grants: Array.isArray(a.grants)
        ? (a.grants as Record<string, unknown>[]).flatMap((g) => (g && typeof g.grant === "string" && bps(g.usedBps) != null ? [{ grant: g.grant, usedBps: g.usedBps as number }] : []))
        : [],
      capUsdc: capValue(a.capUsdc),
      capSource: typeof src === "string" && (CAP_SOURCES as readonly string[]).includes(src) ? (src as CapSource) : null,
      signedCapUsdc: capValue(a.signedCapUsdc),
      holds: Array.isArray(a.holds) ? a.holds.filter((h): h is string => typeof h === "string") : [],
      deactivated: str(a.deactivated),
    });
  }
  return { entries: out, complete };
}

/** Compute units of one hour: the operator's static per-method estimate, summed over providers and methods. */
function cuOf(data: Record<string, Record<string, { cuEstimate?: number }>> | undefined): number {
  let total = 0;
  for (const methods of Object.values(data ?? {})) for (const m of Object.values(methods ?? {})) total += Number(m?.cuEstimate ?? 0);
  return total;
}

function parsePayload(row: OperatorRow | undefined): StoredOperatorMetrics | null {
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload_json) as StoredOperatorMetrics;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

function parseOperator(row: OperatorRow | undefined): ConsoleModel["operator"] {
  const p = row ? parsePayload(row) : null;
  if (!row || !p) return null;
  const last = Array.isArray(p.rpc?.last48h) ? p.rpc.last48h : [];
  return {
    generatedAt: row.generated_at,
    gitSha: p.operator?.gitSha ?? null,
    relayerWei: p.operator?.relayer?.balanceWei ?? null,
    ops: Array.isArray(p.opsRecent) ? p.opsRecent.filter((o) => o && typeof o.kind === "string" && typeof o.at === "string") : [],
    rpc: last
      .map((h) => ({ hour: String(h.hourStart), cu: cuOf(h.data) }))
      .filter((h) => Number.isFinite(h.cu) && Number.isFinite(Date.parse(h.hour))),
    engines: Array.isArray(p.engines) ? p.engines : [],
  };
}

export function inScope(env: ConsoleEnv, accountEnv: string | null | undefined, isTest: number | null | undefined): boolean {
  if (env === "all") return true;
  return accountEnv === "prod" && isTest !== 1;
}

export async function loadConsole(db: D1Db | undefined, env: ConsoleEnv, now: Date, infra: InfraSnapshot | null): Promise<ConsoleModel> {
  const empty: ConsoleModel = {
    env,
    asOf: now.toISOString(),
    ledgerReadAt: null,
    accounts: [],
    totals: { fees: 0, feesCounted: 0, lp: 0, idle: 0, apr: null, positions: 0, inRange: 0, earning: 0, collected: null, earned: 0, gasEth: null, gasUsd: null, gasUnpricedEth: null, net: null },
    daily: [],
    pools: [],
    lifecycle: { total: 0, earning: 0, waiting: 0, signedUp: 0 },
    capital: [],
    signups: [],
    operator: null,
    relayer: relayerOf(infra, null),
    alerts: [],
    caps: { reported: false, complete: false, table: false, byKey: new Map() },
  };
  if (!db) return empty;

  const [snaps, accounts, metrics, operatorRows, overrides, settings, receipts, dailyRows] = await Promise.all([
    rows<SnapRow>(db, `SELECT account_key, env, read_at, idle_usdc, lp_usdc, fees_usdc, total_usdc, positions_json, updated_at FROM account_snapshot_latest`),
    rows<AccountRow>(db, `SELECT account_key, env, is_test, created_at FROM accounts ORDER BY created_at`),
    rows<MetricsRow>(db, `SELECT day, lp_usd, idle_usdc_usd, eth_usd FROM metrics_daily ORDER BY day`),
    rows<OperatorRow>(db, `SELECT payload_json, generated_at FROM operator_metrics_latest WHERE id = 1`),
    newestOverrides(db),
    inEffect(db),
    rows<ReceiptRow>(db, `SELECT account_key, day, gas_paid_wei, collected_usdc, updated_at FROM yield_ledger_account_receipts`),
    rows<DailyRow>(db, `SELECT account_key, day, fees_close_usdc - fees_open_usdc AS fees_delta, collected_usdc FROM account_daily`),
  ]);

  const parsedOperator = parseOperator(operatorRows?.[0]);
  const acctRows = (accounts ?? []).filter((a) => inScope(env, a.env, a.is_test));
  // The operator reports every account; a production view only counts operations of accounts in scope.
  const inView = new Set(acctRows.map((a) => a.account_key.slice(0, 8)));
  const operator = parsedOperator && { ...parsedOperator, ops: parsedOperator.ops.filter((o) => inView.has(o.accountKey)) };
  const byKey = new Map(acctRows.map((a) => [a.account_key, a]));
  // First confirmed entry per account (8-char key on the wire), when the operator's recent ops reach back that far.
  const firstEnter = new Map<string, string>();
  for (const o of operator?.ops ?? []) {
    if (o.kind !== "enter" || o.state !== "confirmed") continue;
    const prev = firstEnter.get(o.accountKey);
    if (!prev || o.at < prev) firstEnter.set(o.accountKey, o.at);
  }

  // Lifetime receipts per account (full key), and the newest write, for the double-count rule on `earned`.
  const receiptsBy = new Map<string, { collected: number; gasEth: number; lastWrite: string }>();
  for (const r of receipts ?? []) {
    if (!byKey.has(r.account_key)) continue;
    const cur = receiptsBy.get(r.account_key) ?? { collected: 0, gasEth: 0, lastWrite: "" };
    cur.collected += usd(r.collected_usdc);
    cur.gasEth += weiToEth(r.gas_paid_wei);
    if (r.updated_at > cur.lastWrite) cur.lastWrite = r.updated_at;
    receiptsBy.set(r.account_key, cur);
  }

  const yields: AccountYield[] = [];
  for (const s of snaps ?? []) {
    const acct = byKey.get(s.account_key);
    if (!acct) continue;
    let positions: Position[] = [];
    try {
      positions = (JSON.parse(s.positions_json) as { tokenId: string; pool: string; inRange: boolean; valueUsdc: string; feesUsdc: string }[]).map((p) => ({
        tokenId: String(p.tokenId),
        pool: p.pool,
        inRange: Boolean(p.inRange),
        value: usd(p.valueUsdc),
        fees: usd(p.feesUsdc),
      }));
    } catch {
      positions = [];
    }
    const lp = usd(s.lp_usdc);
    const fees = usd(s.fees_usdc);
    const since = firstEnter.get(s.account_key.slice(0, 8)) ?? null;
    const days = since ? daysBetween(since, now) : null;
    const r = receipts === null ? null : receiptsBy.get(s.account_key) ?? { collected: 0, gasEth: 0, lastWrite: "" };
    const feesStale = !!r && !!s.updated_at && r.lastWrite > s.updated_at;
    yields.push({
      key: s.account_key.slice(0, 8),
      env: acct.is_test === 1 ? "test" : acct.env ?? "unknown",
      total: usd(s.total_usdc),
      lp,
      idle: usd(s.idle_usdc),
      fees,
      since,
      days,
      apr: days && lp >= 0.5 ? (fees / lp) * (365 / days) * 100 : null,
      collected: r ? r.collected : null,
      gasEth: r ? r.gasEth : null,
      earned: (feesStale ? 0 : fees) + (r?.collected ?? 0),
      feesStale,
      positions,
      readAt: s.read_at,
    });
  }
  yields.sort((a, b) => b.earned - a.earned || b.lp - a.lp);

  const working = yields.filter((a) => a.lp > 0.01);
  // Numerator and denominator over the same accounts: those with capital placed and a known first entry.
  const dated = working.filter((a) => a.days != null);
  const capDays = dated.reduce((x, a) => x + a.lp * (a.days ?? 0), 0);
  const datedFees = dated.reduce((x, a) => x + a.fees, 0);
  const feesSum = yields.reduce((x, a) => x + a.fees, 0);
  const positions = working.flatMap((a) => a.positions.map((p) => ({ ...p, days: a.days })));
  const poolMap = new Map<string, PoolYield & { capDays: number }>();
  for (const p of positions) {
    const q = poolMap.get(p.pool) ?? { pool: p.pool, value: 0, fees: 0, positions: 0, inRange: 0, apr: null, capDays: 0 };
    q.value += p.value;
    q.fees += p.fees;
    q.positions += 1;
    q.inRange += p.inRange ? 1 : 0;
    q.capDays += p.value * (p.days ?? 0);
    poolMap.set(p.pool, q);
  }
  const pools = [...poolMap.values()]
    .map(({ capDays: cd, ...q }) => ({ ...q, apr: cd > 0 ? (q.fees / cd) * 365 * 100 : null }))
    .sort((a, b) => b.fees - a.fees);

  const waiting = yields.filter((a) => a.idle >= 0.2 && a.lp <= 0.01).length;
  const lifecycle = { total: acctRows.length, earning: working.length, waiting, signedUp: Math.max(0, acctRows.length - working.length - waiting) };

  // Daily yield: fees from account_daily (accrued change plus what was collected that day, both seen by that day's
  // snapshots, so a fee is never counted on two days), gas from the receipts (every day an operation paid it), each
  // day's gas at that day's ETH price from metrics_daily, so a past cost does not move with today's market.
  const dayFees = new Map<string, number>();
  for (const d of dailyRows ?? []) if (byKey.has(d.account_key)) dayFees.set(d.day, (dayFees.get(d.day) ?? 0) + usd(d.fees_delta) + usd(d.collected_usdc));
  const dayGas = new Map<string, number>();
  for (const r of receipts ?? []) if (byKey.has(r.account_key)) dayGas.set(r.day, (dayGas.get(r.day) ?? 0) + weiToEth(r.gas_paid_wei));
  const dayPrice = new Map((metrics ?? []).filter((m) => m.eth_usd != null && m.eth_usd > 0).map((m) => [m.day, m.eth_usd as number]));
  const gasUsdOf = (day: string, eth: number): number | null => (eth === 0 ? 0 : dayPrice.has(day) ? eth * dayPrice.get(day)! : null);
  const first = [...dayFees.keys(), ...dayGas.keys()].sort()[0] ?? null;
  const daily: DayYield[] = first
    ? eachDay(first, now).map((day) => {
        const fees = dayFees.get(day) ?? null;
        const gasEth = receipts === null ? null : dayGas.get(day) ?? 0;
        const gasUsd = gasEth == null ? null : gasUsdOf(day, gasEth);
        return { day, fees, gasEth, gasUsd, net: fees != null && gasUsd != null ? fees - gasUsd : null };
      })
    : [];
  // Totals over every account in scope, a snapshot or not: a receipt written before an account's first snapshot counts.
  const scopeReceipts = [...receiptsBy.values()];
  const collectedSum = receipts === null ? null : scopeReceipts.reduce((x, r) => x + r.collected, 0);
  const gasEthSum = receipts === null ? null : scopeReceipts.reduce((x, r) => x + r.gasEth, 0);
  let gasUsdSum: number | null = receipts === null ? null : 0;
  let gasUnpricedEth: number | null = receipts === null ? null : 0;
  for (const [day, eth] of dayGas) {
    const v = gasUsdOf(day, eth);
    if (gasUsdSum == null || gasUnpricedEth == null) break;
    if (v == null) gasUnpricedEth += eth;
    else gasUsdSum += v;
  }
  const feesCounted = yields.reduce((x, a) => x + (a.feesStale ? 0 : a.fees), 0);
  const earnedSum = feesCounted + (collectedSum ?? 0);

  const capital = (metrics ?? []).map((m) => ({ day: m.day, value: (m.lp_usd ?? 0) + (m.idle_usdc_usd ?? 0) }));
  const signupCount = new Map<string, number>();
  for (const a of acctRows) signupCount.set(dayOf(a.created_at), (signupCount.get(dayOf(a.created_at)) ?? 0) + 1);
  const firstDay = acctRows[0] ? dayOf(acctRows[0].created_at) : null;
  const signups = firstDay ? eachDay(firstDay, now).map((d) => ({ day: d, value: signupCount.get(d) ?? 0 })) : [];

  const model: ConsoleModel = {
    env,
    asOf: now.toISOString(),
    ledgerReadAt: yields.length ? yields.map((a) => a.readAt).sort().at(-1)! : null,
    accounts: yields,
    totals: {
      fees: feesSum,
      feesCounted,
      lp: working.reduce((x, a) => x + a.lp, 0),
      idle: yields.reduce((x, a) => x + a.idle, 0),
      apr: capDays > 0 ? (datedFees / capDays) * 365 * 100 : null,
      positions: positions.length,
      inRange: positions.filter((p) => p.inRange).length,
      earning: working.length,
      collected: collectedSum,
      earned: earnedSum,
      gasEth: gasEthSum,
      gasUsd: gasUsdSum,
      gasUnpricedEth,
      net: gasUsdSum != null ? earnedSum - gasUsdSum : null,
    },
    daily,
    pools,
    lifecycle,
    capital,
    signups,
    operator,
    relayer: relayerOf(infra, operator?.relayerWei ?? null),
    alerts: [],
    caps: empty.caps,
  };
  model.caps = capsOf(acctRows, parseAuthorizations(parsePayload(operatorRows?.[0])?.authorizations), overrides, settings);
  model.alerts = alertsOf(model, now, snaps === null);
  return model;
}

/** What the operator runs now for this account, as far as the console can tell; null when nothing says. */
export function capNow(c: Pick<AccountCap, "authorization" | "general">): number | null {
  return c.authorization?.capUsdc ?? c.general?.capUsdc ?? null;
}

/**
 * One account's cap, read fresh for the cap route (otto/mamoru-astro#25): the operator's report, the newest override
 * and the general cap. `table` is false when account_cap_overrides is not there.
 */
export async function loadAccountCap(db: D1Db, accountKey: string, env: string): Promise<{ cap: AccountCap; table: boolean; reportedAt: string | null }> {
  const [operatorRows, overrides, settings] = await Promise.all([
    rows<OperatorRow>(db, `SELECT payload_json, generated_at FROM operator_metrics_latest WHERE id = 1`),
    newestOverrides(db),
    inEffect(db),
  ]);
  const key = accountKey.slice(0, 8);
  const auth = parseAuthorizations(parsePayload(operatorRows?.[0])?.authorizations)?.entries ?? [];
  return {
    cap: {
      key,
      accountKey,
      env,
      authorization: auth.find((a) => a.account.toLowerCase() === key.toLowerCase()) ?? null,
      override: overrides?.find((o) => o.accountKey.toLowerCase() === accountKey.toLowerCase()) ?? null,
      general: generalCapOf(settings, env, accountKey),
    },
    table: overrides !== null,
    reportedAt: operatorRows?.[0]?.generated_at ?? null,
  };
}

/** The environment's cap for one account: its canary when the newest canary names it, else the environment-wide one. */
function generalCapOf(settings: Awaited<ReturnType<typeof inEffect>>, env: string, accountKey: string): GeneralCap | null {
  if (env !== "prod" && env !== "beta") return null;
  const { wide, canary } = settings[env];
  const lower = accountKey.toLowerCase();
  const v = canary && canary.accountKeys?.some((k) => k.toLowerCase() === lower) ? canary : wide;
  if (!v) return null;
  return { capUsdc: v.settings.capUsdc ?? DEFAULT_CAP_USDC, depth: v.settings.depth != null, version: v.id, canary: v === canary };
}

function capsOf(
  acctRows: AccountRow[],
  parsed: { entries: Authorization[]; complete: boolean } | null,
  overrides: CapOverrideRow[] | null,
  settings: Awaited<ReturnType<typeof inEffect>>,
): ConsoleModel["caps"] {
  const auth = new Map((parsed?.entries ?? []).map((a) => [a.account.toLowerCase(), a]));
  const over = new Map((overrides ?? []).map((o) => [o.accountKey.toLowerCase(), o]));
  const byKey = new Map<string, AccountCap>();
  // Two accounts sharing the first 8 characters cannot be told apart by the operator's key: neither is shown, and the
  // cap route refuses an ambiguous key the same way.
  const seen = new Map<string, number>();
  for (const a of acctRows) seen.set(a.account_key.slice(0, 8).toLowerCase(), (seen.get(a.account_key.slice(0, 8).toLowerCase()) ?? 0) + 1);
  for (const a of acctRows) {
    const key = a.account_key.slice(0, 8);
    if (seen.get(key.toLowerCase())! > 1) continue;
    byKey.set(key.toLowerCase(), {
      key,
      accountKey: a.account_key,
      env: a.env ?? "prod",
      authorization: auth.get(key.toLowerCase()) ?? null,
      override: over.get(a.account_key.toLowerCase()) ?? null,
      general: generalCapOf(settings, a.env ?? "prod", a.account_key),
    });
  }
  return { reported: parsed !== null, complete: parsed?.complete ?? false, table: overrides !== null, byKey };
}

function relayerOf(infra: InfraSnapshot | null, operatorWei: string | null): ConsoleModel["relayer"] {
  const r = infra?.relayer;
  const eth = r ? r.ethBalance : operatorWei ? Number(operatorWei) / 1e18 : null;
  if (eth == null) return null;
  const ethUsd = infra?.ethUsd ?? null;
  const cost = infra?.cost ? infra.cost.totalUsd ?? (ethUsd != null ? infra.cost.totalEth * ethUsd : null) : null;
  const value = r?.usd ?? (ethUsd != null ? eth * ethUsd : null);
  return {
    address: r?.address ?? "",
    eth,
    usd: value,
    costPerAccountUsd: cost,
    runway: value != null && cost ? Math.floor(value / cost) : null,
  };
}

export function alertsOf(m: ConsoleModel, now: Date, ledgerMissing: boolean): Alert[] {
  const out: Alert[] = [];
  if (ledgerMissing) out.push({ tone: "info", title: "The yield ledger is not set up on this database", detail: "Migrations 0009 and 0010 have not been applied, so no yield can be shown." });
  for (const a of m.accounts) {
    for (const p of a.positions) {
      if (!p.inRange && a.lp > 0.01) out.push({ tone: "warn", title: `Out of range in ${poolLabel(p.pool).pair}`, detail: `Account ${a.key}: ${money(p.value)} earns nothing until the engine re-centres it.`, account: a.key });
    }
  }
  const since = now.getTime() - 48 * 3600e3;
  const failed = (m.operator?.ops ?? []).filter((o) => o.state === "failed" && new Date(o.at).getTime() > since);
  if (failed.length) {
    const codes = [...new Set(failed.map((f) => f.code ?? "no code"))].join(", ");
    out.push({ tone: "bad", title: `${failed.length} engine operation${failed.length > 1 ? "s" : ""} failed in the last 48 hours`, detail: codes });
  }
  if (m.relayer?.runway != null && m.relayer.runway < 10) {
    out.push({ tone: m.relayer.runway < 3 ? "bad" : "warn", title: `The relayer can fund ${m.relayer.runway} more new account${m.relayer.runway === 1 ? "" : "s"}`, detail: `${m.relayer.eth.toFixed(4)} ETH left, ${m.relayer.costPerAccountUsd != null ? money(m.relayer.costPerAccountUsd) : "unknown"} per new account.` });
  }
  for (const a of m.accounts) if (a.idle >= 0.2 && a.lp <= 0.01) out.push({ tone: "info", title: `Funds waiting in ${a.key}`, detail: `${money(a.idle)} deposited and not placed yet.`, account: a.key });
  if (!m.operator) out.push({ tone: "info", title: "Engine data is not connected yet", detail: "Engine and RPC figures appear once the app Worker stores the operator metrics (migration 0013)." });
  return out;
}

// ---- formatting shared by the views (otto/mamoru-astro#24): short figures, never a wall of decimals ----

/** Dollars, short: $1,284.50 · $12.9K · 9.9¢ · 0.8¢ · <0.1¢. */
export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a === 0) return "$0";
  if (a < 0.001) return `${s}<0.1¢`;
  if (a < 1) return `${s}${(a * 100).toFixed(a < 0.1 ? 1 : 0)}¢`;
  if (a < 10_000) return `${s}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (a < 1_000_000) return `${s}$${(a / 1000).toFixed(1)}K`;
  return `${s}$${(a / 1e6).toFixed(1)}M`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(digits)}%`;
}

export function poolLabel(pool: string): { pair: string; fee: string } {
  const [, a = "?", b = "?", f = "0"] = pool.split(/[:/]/);
  // Uniswap v3 fee tiers are in hundredths of a basis point: 500 is 0.05%, 3000 is 0.3%.
  return { pair: `${a} / ${b}`, fee: `${Number((Number(f) / 10_000).toFixed(3))}%` };
}
