// otto/mamoru-astro#24: one model for the console's five views (Pulse, Yield, Accounts, Engine, Costs), read from
// D1 only: the yield ledger (ottodevs/mamoru#129), accounts and users, the legacy daily metrics, and the operator's
// own /metrics as the app Worker stores it in operator_metrics_latest (ottodevs/mamoru migration 0013). Every
// figure says where it comes from, and a source that is not there yet is null, never a guessed zero.
import type { D1Db } from "./d1-infra";
import type { InfraSnapshot } from "./infra-snapshot";

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
  positions: Position[];
  readAt: string;
};

export type PoolYield = { pool: string; value: number; fees: number; positions: number; inRange: number; apr: number | null };

export type EngineOp = { accountKey: string; kind: string; state: string; at: string; code: string | null };

export type EngineHealth = { accountKey?: string; [field: string]: unknown };

export type Alert = { tone: "bad" | "warn" | "info"; title: string; detail: string; account?: string };

export type DayPoint = { day: string; value: number };

export interface ConsoleModel {
  env: ConsoleEnv;
  asOf: string;
  /** Read time of the newest ledger row, or null before the ledger has written one. */
  ledgerReadAt: string | null;
  accounts: AccountYield[];
  totals: { fees: number; lp: number; idle: number; apr: number | null; positions: number; inRange: number; earning: number };
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

type SnapRow = { account_key: string; env: string; read_at: string; idle_usdc: number; lp_usdc: number; fees_usdc: number; total_usdc: number; positions_json: string };
type AccountRow = { account_key: string; env: string | null; is_test: number | null; created_at: string };
type MetricsRow = { day: string; lp_usd: number; idle_usdc_usd: number };
type OperatorRow = { payload_json: string; generated_at: string };

type StoredOperatorMetrics = {
  operator?: { gitSha?: string; relayer?: { balanceWei?: string } };
  /** As the operator serves it (apps/mamoru-operator/src/metrics.ts): ISO hour start, per provider, per method. */
  rpc?: { last48h?: { hourStart: string; data?: Record<string, Record<string, { cuEstimate?: number }>> }[] };
  engines?: EngineHealth[];
  opsRecent?: EngineOp[];
};

/** Compute units of one hour: the operator's static per-method estimate, summed over providers and methods. */
function cuOf(data: Record<string, Record<string, { cuEstimate?: number }>> | undefined): number {
  let total = 0;
  for (const methods of Object.values(data ?? {})) for (const m of Object.values(methods ?? {})) total += Number(m?.cuEstimate ?? 0);
  return total;
}

function parseOperator(row: OperatorRow | undefined): ConsoleModel["operator"] {
  if (!row) return null;
  let p: StoredOperatorMetrics;
  try {
    p = JSON.parse(row.payload_json) as StoredOperatorMetrics;
  } catch {
    return null;
  }
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
    totals: { fees: 0, lp: 0, idle: 0, apr: null, positions: 0, inRange: 0, earning: 0 },
    pools: [],
    lifecycle: { total: 0, earning: 0, waiting: 0, signedUp: 0 },
    capital: [],
    signups: [],
    operator: null,
    relayer: relayerOf(infra, null),
    alerts: [],
  };
  if (!db) return empty;

  const [snaps, accounts, metrics, operatorRows] = await Promise.all([
    rows<SnapRow>(db, `SELECT account_key, env, read_at, idle_usdc, lp_usdc, fees_usdc, total_usdc, positions_json FROM account_snapshot_latest`),
    rows<AccountRow>(db, `SELECT account_key, env, is_test, created_at FROM accounts ORDER BY created_at`),
    rows<MetricsRow>(db, `SELECT day, lp_usd, idle_usdc_usd FROM metrics_daily ORDER BY day`),
    rows<OperatorRow>(db, `SELECT payload_json, generated_at FROM operator_metrics_latest WHERE id = 1`),
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
      positions,
      readAt: s.read_at,
    });
  }
  yields.sort((a, b) => b.fees - a.fees || b.lp - a.lp);

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
      lp: working.reduce((x, a) => x + a.lp, 0),
      idle: yields.reduce((x, a) => x + a.idle, 0),
      apr: capDays > 0 ? (datedFees / capDays) * 365 * 100 : null,
      positions: positions.length,
      inRange: positions.filter((p) => p.inRange).length,
      earning: working.length,
    },
    pools,
    lifecycle,
    capital,
    signups,
    operator,
    relayer: relayerOf(infra, operator?.relayerWei ?? null),
    alerts: [],
  };
  model.alerts = alertsOf(model, now, snaps === null);
  return model;
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
