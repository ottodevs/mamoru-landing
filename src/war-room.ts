/**
 * otto/mamoru-astro#55: /ops/war-room. One read-only page for "is the market moving, is the guard about to freeze
 * entries, what is exposed": server-rendered from D1 only (no external HTTP). The loader reads, `renderWarRoom` turns
 * plain data into markup (so tests and the preview script need no D1), `warRoomSection` wraps it as a SectionView.
 */

import type { D1Db } from "./d1-infra";
import { inEffect, type VersionRow } from "./engine-settings-store";
import { fmtCapitalUsd, fmtRelative } from "./ops-format";
import { pageHead, type SectionView, when } from "./ops";
import { esc } from "./text";
import {
  TWAP_WINDOW_SECONDS,
  WAR_POOLS,
  changePct,
  fallBpsOf,
  guardVerdict,
  marketOf,
  meanTick,
  priceOfTick,
  type CumulativePoint,
  type GuardThreshold,
  type GuardVerdict,
  type WarPool,
} from "./war-room-math";

const BASE = 8453;
const MONAD = 143;
const USDC = 1_000_000;
const DAY = 86_400;
const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

// ---- data shapes ----

export type MarketRow = {
  pool: string;
  asset: "ETH" | "BTC";
  /** Null when the pool has no snapshot at all. */
  price: number | null;
  /** Unix seconds of the newest snapshot. */
  snapshotTime: number | null;
  chg1h: number | null;
  chg24h: number | null;
  chg7d: number | null;
  low24h: number | null;
  high24h: number | null;
};

export type SettingsView = {
  id: number;
  createdAt: string;
  guardEnabled: boolean;
  eth: GuardThreshold;
  btc: GuardThreshold;
  rerange: { mode: string; maxPerWeek: number | null; maxWaitSeconds: number | null; edgeBufferBps: number | null; costTest: string | null } | null;
  /** Canary rows carry the number of accounts only, never their keys. */
  accounts: number | null;
};

export type GuardLive = {
  pool: string;
  asset: "ETH" | "BTC";
  fallBps: number | null;
  volBps: number | null;
  threshold: GuardThreshold;
  verdict: GuardVerdict;
  /** The newest pool snapshot is older than FEED_STALE_SECONDS: the reading is history, not the market now. */
  stale: boolean;
};

export type ExposurePool = { pool: string; positions: number; inRange: number; valueUsd: number };
export type ExposureChain = {
  chainId: number;
  accounts: number;
  idleUsd: number;
  lpUsd: number;
  feesUsd: number;
  /** ISO of the newest account read on this chain. */
  readAt: string | null;
  /** ISO of the oldest account read on this chain: the totals are only as fresh as this. */
  oldestReadAt: string | null;
  pools: ExposurePool[];
};
export type YieldToday = { chainId: number; pool: string; valueUsd: number; holdUsd: number; feesUsd: number };

export type WarRoomData = {
  /** ISO, the Worker clock when the page was read. */
  asOf: string;
  market: MarketRow[] | null;
  /** Null: the settings table is not there. wide null: no prod environment-wide version yet. */
  settings: { wide: SettingsView | null; canary: SettingsView | null } | null;
  guard: GuardLive[];
  exposure: ExposureChain[] | null;
  yieldToday: { day: string; rows: YieldToday[] } | null;
};

// ---- loading ----

type Snap = { block: number; block_time: number; tick: number; tick_cumulative: string | null };

/** The engine writes a snapshot every ~2 min; older than this, the market feed has stopped and no reading is current. */
export const FEED_STALE_SECONDS = 900;
/** An account snapshot older than this is reported apart, so a total never reads as fresher than its oldest part. */
export const ACCOUNT_STALE_MS = 3_600_000;

async function latestSnap(db: D1Db, pool: string): Promise<Snap | null> {
  return db
    .prepare("SELECT block, block_time, tick, tick_cumulative FROM pool_snapshots WHERE chain_id = ? AND pool_address = ? ORDER BY block DESC LIMIT 1")
    .bind(BASE, pool)
    .first<Snap>();
}

/**
 * The newest snapshot at or before `t`. The primary key walks back from the newest block and stops at the first match,
 * so the cost is the snapshots inside the lookback (~720 a day), with no assumption about block time.
 */
async function rowAtOrBefore(db: D1Db, pool: string, t: number): Promise<Snap | null> {
  return db
    .prepare("SELECT block, block_time, tick, tick_cumulative FROM pool_snapshots WHERE chain_id = ? AND pool_address = ? AND block_time <= ? ORDER BY block DESC LIMIT 1")
    .bind(BASE, pool, t)
    .first<Snap>();
}

/** `row` when it is close enough to `t` to stand for it, else null (a gap in the snapshots). */
export const closeTo = (row: Pick<Snap, "block_time"> | null, t: number, secsAgo: number) =>
  row && t - row.block_time <= Math.max(TWAP_WINDOW_SECONDS, secsAgo * 0.02) ? row : null;

async function readPool(db: D1Db, pool: (typeof WAR_POOLS)[number]): Promise<{ market: MarketRow; cumulative: CumulativePoint[] }> {
  const empty: MarketRow = { pool: pool.name, asset: pool.asset, price: null, snapshotTime: null, chg1h: null, chg24h: null, chg7d: null, low24h: null, high24h: null };
  const latest = await latestSnap(db, pool.address);
  if (!latest) return { market: empty, cumulative: [] };
  const now = latest.block_time;
  const segments = DAY / TWAP_WINDOW_SECONDS;
  const base = now - (segments + 1) * TWAP_WINDOW_SECONDS;
  // Exact block bounds from the snapshots themselves: the rows at or before the start of each range.
  const [r1h, r24h, r7d, rGrid] = await Promise.all([
    rowAtOrBefore(db, pool.address, now - 3600),
    rowAtOrBefore(db, pool.address, now - DAY),
    rowAtOrBefore(db, pool.address, now - 7 * DAY),
    rowAtOrBefore(db, pool.address, base - TWAP_WINDOW_SECONDS),
  ]);
  const h1 = closeTo(r1h, now - 3600, 3600);
  const h24 = closeTo(r24h, now - DAY, DAY);
  const d7 = closeTo(r7d, now - 7 * DAY, 7 * DAY);
  const [range, grid] = await Promise.all([
    db
      .prepare("SELECT MIN(tick) AS lo, MAX(tick) AS hi FROM pool_snapshots WHERE chain_id = ? AND pool_address = ? AND block >= ? AND block_time >= ?")
      .bind(BASE, pool.address, r24h?.block ?? 0, now - DAY)
      .first<{ lo: number | null; hi: number | null }>(),
    // The grid the guard reads: per TWAP window the newest snapshot at or before each grid time, summed in SQL (at most 50 rows).
    db
      .prepare(
        `SELECT MAX(block_time) AS time, tick_cumulative AS cum FROM pool_snapshots
         WHERE chain_id = ? AND pool_address = ? AND block >= ? AND block_time > ? AND block_time <= ?
         GROUP BY (block_time - ? + ${TWAP_WINDOW_SECONDS - 1}) / ${TWAP_WINDOW_SECONDS} ORDER BY time`,
      )
      .bind(BASE, pool.address, rGrid?.block ?? 0, base - TWAP_WINDOW_SECONDS, now, base)
      .all<{ time: number; cum: string | null }>(),
  ]);
  const price = priceOfTick(pool, latest.tick);
  const at = (s: Snap | null) => (s ? priceOfTick(pool, s.tick) : null);
  const ends = range && range.lo !== null && range.hi !== null ? [priceOfTick(pool, range.lo), priceOfTick(pool, range.hi)] : null;
  const cumulative: CumulativePoint[] = [];
  for (const r of grid.results) if (r.cum !== null) cumulative.push({ time: Number(r.time), tickCumulative: BigInt(r.cum) });
  return {
    market: {
      pool: pool.name,
      asset: pool.asset,
      price,
      snapshotTime: now,
      chg1h: changePct(price, at(h1)),
      chg24h: changePct(price, at(h24)),
      chg7d: changePct(price, at(d7)),
      low24h: ends ? Math.min(...ends) : null,
      high24h: ends ? Math.max(...ends) : null,
    },
    cumulative,
  };
}

/** The cumulative at time `t`: the newest grid point at or before it (the engine's cumulativeAt over its samples). */
export function cumulativeFrom(points: readonly CumulativePoint[]): (t: number) => CumulativePoint | null {
  return (t) => {
    let hit: CumulativePoint | null = null;
    for (const p of points) {
      if (p.time <= t) hit = p;
      else break;
    }
    return hit;
  };
}

/** The engine's guard metric for one pool, from the grid: null when history is insufficient. */
export function guardMetric(pool: WarPool, nowTime: number, points: readonly CumulativePoint[]): { fallBps: number; volBps: number } | null {
  const cum = cumulativeFrom(points);
  const m = marketOf(nowTime, TWAP_WINDOW_SECONDS, cum);
  if (m.twap24hAgoTick === null || m.realizedVol24hBps === null) return null;
  const a = cum(nowTime - TWAP_WINDOW_SECONDS);
  const b = cum(nowTime);
  const twap = a && b ? meanTick(a, b) : null;
  if (twap === null) return null;
  return { fallBps: fallBpsOf(pool.volatileIsToken0, m.twap24hAgoTick, twap), volBps: m.realizedVol24hBps };
}

function settingsView(v: VersionRow): SettingsView {
  const r = v.settings.rerange;
  return {
    id: v.id,
    createdAt: v.createdAt,
    guardEnabled: v.settings.guard.enabled,
    eth: v.settings.guard.eth,
    btc: v.settings.guard.btc,
    rerange: r
      ? {
          mode: String(r.mode),
          maxPerWeek: typeof r.maxPerWeek === "number" ? r.maxPerWeek : null,
          maxWaitSeconds: typeof r.maxWaitSeconds === "number" ? r.maxWaitSeconds : null,
          edgeBufferBps: typeof r.edgeBufferBps === "number" ? r.edgeBufferBps : null,
          costTest: typeof r.costTest === "string" ? r.costTest : null,
        }
      : null,
    accounts: v.accountKeys ? v.accountKeys.length : null,
  };
}

type RawSnapshot = { chain_id: number; read_at: string; idle_usdc: number; lp_usdc: number; fees_usdc: number; positions_json: string };

/** Names a position's pool the way the registry does when the snapshot stored an address. */
function poolLabel(raw: string): string {
  const hit = WAR_POOLS.find((p) => p.address.toLowerCase() === raw.toLowerCase());
  return hit ? hit.name : raw;
}

export function exposureOf(rows: readonly RawSnapshot[]): ExposureChain[] {
  const byChain = new Map<number, ExposureChain>();
  const pools = new Map<string, ExposurePool>();
  for (const r of rows) {
    const chainId = Number(r.chain_id);
    const c = byChain.get(chainId) ?? { chainId, accounts: 0, idleUsd: 0, lpUsd: 0, feesUsd: 0, readAt: null, oldestReadAt: null, pools: [] };
    c.accounts += 1;
    c.idleUsd += Number(r.idle_usdc) / USDC;
    c.lpUsd += Number(r.lp_usdc) / USDC;
    c.feesUsd += Number(r.fees_usdc) / USDC;
    if (!c.readAt || r.read_at > c.readAt) c.readAt = r.read_at;
    if (!c.oldestReadAt || r.read_at < c.oldestReadAt) c.oldestReadAt = r.read_at;
    byChain.set(chainId, c);
    try {
      const arr = JSON.parse(r.positions_json) as { pool?: unknown; inRange?: unknown; valueUsdc?: unknown }[];
      if (Array.isArray(arr)) {
        for (const p of arr) {
          const key = `${chainId}|${poolLabel(String(p.pool ?? ""))}`;
          const e = pools.get(key) ?? { pool: poolLabel(String(p.pool ?? "")), positions: 0, inRange: 0, valueUsd: 0 };
          e.positions += 1;
          if (p.inRange) e.inRange += 1;
          const v = Number(p.valueUsdc) / USDC;
          if (Number.isFinite(v)) e.valueUsd += v;
          pools.set(key, e);
        }
      }
    } catch {
      /* a malformed positions_json counts the account, not its positions */
    }
  }
  for (const [key, e] of pools) byChain.get(Number(key.split("|")[0]))?.pools.push(e);
  return [...byChain.values()].sort((a, b) => a.chainId - b.chainId);
}

/** Everything the page shows, read from D1 only. Each part degrades to null on its own when its table is missing. */
export async function loadWarRoom(db: D1Db, nowMs: number = Date.now()): Promise<WarRoomData> {
  const asOf = new Date(nowMs).toISOString();
  const day = asOf.slice(0, 10);
  const guarded = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      if (missingTable(e)) return null;
      throw e;
    }
  };
  const [pools, effect, snaps, yieldRows] = await Promise.all([
    guarded(() => Promise.all(WAR_POOLS.map((p) => readPool(db, p)))),
    inEffect(db).then((r) => r.prod).catch((e) => (missingTable(e) ? null : Promise.reject(e))),
    guarded(async () => {
      const { results } = await db
        .prepare(
          `SELECT asl.chain_id, asl.read_at, asl.idle_usdc, asl.lp_usdc, asl.fees_usdc, asl.positions_json
           FROM account_snapshot_latest asl JOIN accounts a ON a.chain_id = asl.chain_id AND a.account_key = asl.account_key
           WHERE a.env = 'prod'`,
        )
        .all<RawSnapshot>();
      return results;
    }),
    guarded(async () => {
      const { results } = await db
        .prepare(
          `SELECT chain_id, pool, SUM(value_usd) AS v, SUM(hold_value_usd) AS h, SUM(accrued_usd_close - accrued_usd_open) AS f
           FROM yield_ledger_position_daily WHERE day = ? AND env = 'prod' GROUP BY chain_id, pool ORDER BY v DESC`,
        )
        .bind(day)
        .all<{ chain_id: number; pool: string; v: number; h: number; f: number }>();
      return results;
    }),
  ]);
  const settings = effect ? { wide: effect.wide ? settingsView(effect.wide) : null, canary: effect.canary ? settingsView(effect.canary) : null } : null;
  const wide = settings?.wide ?? null;
  const guard: GuardLive[] = [];
  if (pools && wide) {
    pools.forEach((p, i) => {
      const spec = WAR_POOLS[i]!;
      const threshold = wide[spec.bucket];
      const metric = p.market.snapshotTime === null ? null : guardMetric(spec, p.market.snapshotTime, p.cumulative);
      const stale = p.market.snapshotTime === null || nowMs / 1000 - p.market.snapshotTime > FEED_STALE_SECONDS;
      guard.push({ pool: spec.name, asset: spec.asset, fallBps: metric?.fallBps ?? null, volBps: metric?.volBps ?? null, threshold, verdict: guardVerdict(metric, threshold), stale });
    });
  }
  return {
    asOf,
    market: pools ? pools.map((p) => p.market) : null,
    settings,
    guard,
    exposure: snaps ? exposureOf(snaps) : null,
    yieldToday: yieldRows
      ? { day, rows: yieldRows.map((r) => ({ chainId: Number(r.chain_id), pool: String(r.pool), valueUsd: Number(r.v) / USDC, holdUsd: Number(r.h) / USDC, feesUsd: Number(r.f) / USDC })) }
      : null,
  };
}

/** Under 10% of entry value: an exit-only pool that was emptied, or a real loss. The page shows the figure either way. */
export const isEmptied = (y: Pick<YieldToday, "valueUsd" | "holdUsd">) => y.holdUsd > 0 && y.valueUsd < y.holdUsd * 0.1;

// ---- rendering ----

/** `pool:WETH/USDC/3000` reads as `WETH/USDC 0.3%`, short enough for a phone column. */
export const poolDisplay = (name: string) => {
  const m = /^pool:([^/]+\/[^/]+)\/(\d+)$/.exec(name);
  return m ? `${m[1]} ${Number(m[2]) / 10_000}%` : name.replace(/^pool:/, "");
};

const CHAIN_LABEL: Record<number, string> = { [BASE]: "Base", [MONAD]: "Monad" };
const chainName = (id: number) => CHAIN_LABEL[id] ?? `Chain ${id}`;
const num = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number, d = 2) => `${n < 0 ? "−" : n > 0 ? "+" : ""}${num(Math.abs(n), d)}`;
const pct = (n: number | null) => (n === null ? "n/a" : `${signed(n, 2)}%`);
const bpsText = (n: number | null) => (n === null ? "n/a" : `${num(n)} bps`);
const usd = (n: number) => (n < 0 ? `−${fmtCapitalUsd(-n)}` : fmtCapitalUsd(n));
const priceText = (asset: "ETH" | "BTC", n: number | null) => (n === null ? "n/a" : `$${num(n, asset === "BTC" ? 0 : 2)}`);

/** Newest read, and the oldest one too when it is over an hour old, so a total never looks fresher than its parts. */
export function readSpan(c: Pick<ExposureChain, "readAt" | "oldestReadAt">, nowMs: number): string {
  if (!c.readAt) return "n/a";
  const newest = esc(ago(c.readAt, nowMs));
  return c.oldestReadAt && nowMs - Date.parse(c.oldestReadAt) > ACCOUNT_STALE_MS ? `${newest}; oldest ${esc(ago(c.oldestReadAt, nowMs))}` : newest;
}

function ago(iso: string, nowMs: number): string {
  return fmtRelative(iso, new Date(nowMs));
}

function table(head: string[], rows: string[][], opts: { total?: string[] } = {}): string {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  const total = opts.total ? `<tr class="total">${opts.total.map((c) => `<td>${c}</td>`).join("")}</tr>` : "";
  // The wrapper scrolls a wide table sideways on a phone instead of widening the page.
  return `<div class="exp-ledger-wrap"><table class="ledger"><thead><tr>${th}</tr></thead><tbody>${body}${total}</tbody></table></div>`;
}

const block = (title: string, asOf: string, inner: string) =>
  `<section class="sec full" style="--s:0ms"><div class="sec-head"><h2>${esc(title)}</h2><span class="soft">${asOf}</span></div>${inner}</section>`;
const note = (text: string) => `<p class="ledger-note">${esc(text)}</p>`;

function marketBlock(d: WarRoomData, nowMs: number): string {
  if (!d.market) return block("Market", "", note("Pool snapshots are not available."));
  const rows = d.market.map((m) => {
    const age = m.snapshotTime === null ? "none" : `${Math.max(0, Math.round((nowMs / 1000 - m.snapshotTime) / 60))} min`;
    const range = m.low24h === null || m.high24h === null ? "n/a" : `${priceText(m.asset, m.low24h)} to ${priceText(m.asset, m.high24h)}`;
    return [esc(m.asset), priceText(m.asset, m.price), pct(m.chg1h), pct(m.chg24h), pct(m.chg7d), esc(range), esc(age)];
  });
  const latest = d.market.map((m) => m.snapshotTime).filter((t): t is number => t !== null);
  const stamp = latest.length ? `As of <time datetime="${new Date(Math.max(...latest) * 1000).toISOString()}">${esc(when(new Date(Math.max(...latest) * 1000).toISOString()))}</time>` : "";
  return block(
    "Market on Base",
    stamp,
    table(["Asset", "Price", "1h", "24h", "7d", "24h range", "Snapshot age"], rows) +
      note("USDC per coin, from the WETH/USDC 0.3% and USDC/cbBTC 0.05% pools. Changes compare with the newest snapshot at or before each time; n/a means no snapshot that close."),
  );
}

function guardBlock(d: WarRoomData, nowMs: number): string {
  if (!d.settings) return block("Fall-freeze guard", "", note("Engine settings are not available."));
  const w = d.settings.wide;
  if (!w) return block("Fall-freeze guard", "", note("No production settings version yet."));
  const stamp = `Version ${w.id}, set <time datetime="${esc(w.createdAt)}">${esc(ago(w.createdAt, nowMs))}</time>`;
  const th = (t: GuardThreshold) => `fall ${num(t.fallBps)} / vol ${num(t.volBps)} bps`;
  const live = d.guard.map((g) => {
    const state = g.stale ? "Feed stopped" : g.verdict.metric === null ? "Data insufficient" : g.verdict.wouldTrigger ? "Would freeze entries" : "Clear";
    return [esc(g.asset), bpsText(g.fallBps), bpsText(g.volBps), esc(th(g.threshold)), esc(state)];
  });
  const canary = d.settings.canary;
  const canaryRow = canary
    ? note(
        `Canary ${canary.id} (${canary.accounts ?? 0} account${canary.accounts === 1 ? "" : "s"}): guard ${canary.guardEnabled ? "on" : "off"}, ETH ${th(canary.eth)}, BTC ${th(canary.btc)}.`,
      )
    : note("No canary row is live.");
  const status = note(w.guardEnabled ? "Guard is on: a bucket in a fall freezes new entries." : "Guard is off: the readings below do not stop entries. They show what would happen if it were on.");
  return block(
    "Fall-freeze guard",
    stamp,
    `<p>Guard ${w.guardEnabled ? "enabled" : "disabled"} for production. Thresholds: ETH ${esc(th(w.eth))}; BTC ${esc(th(w.btc))}.</p>` +
      status +
      table(["Asset", "24h TWAP fall", "24h volatility", "Threshold", "Reading"], live) +
      note("Both numbers must be at or over their threshold to trigger. Volatility is annualized from 30-minute mean ticks. Data insufficient means a snapshot is missing in the last 24 hours. Feed stopped means the newest pool snapshot is over 15 minutes old, so no reading is current.") +
      canaryRow,
  );
}

function exposureBlock(d: WarRoomData, nowMs: number): string {
  if (!d.exposure) return block("Exposure", "", note("Account snapshots are not available."));
  const chains = d.exposure.filter((c) => c.chainId === BASE);
  if (chains.length === 0) return block("Exposure on Base", "", note("No production account on Base has a snapshot."));
  const c = chains[0]!;
  const summary = table(
    ["Accounts", "Idle", "In pools", "Fees", "Last read"],
    [[num(c.accounts), usd(c.idleUsd), usd(c.lpUsd), usd(c.feesUsd), readSpan(c, nowMs)]],
  );
  const poolRows = c.pools.map((p) => [esc(poolDisplay(p.pool)), num(p.positions), `${num(p.inRange)} of ${num(p.positions)}`, usd(p.valueUsd)]);
  const poolTable = poolRows.length ? table(["Pool", "Positions", "In range", "Value"], poolRows) : "";
  const ys = (d.yieldToday?.rows ?? []).filter((r) => r.chainId === BASE);
  const vsHold = (y: YieldToday) =>
    `${usd(y.valueUsd - y.holdUsd)}${y.holdUsd > 0 ? ` (${pct(((y.valueUsd - y.holdUsd) / y.holdUsd) * 100)})` : ""}${isEmptied(y) ? `<br><span class="dim">under 10% of entry: emptied exit or a real loss</span>` : ""}`;
  const yieldPart = ys.length
    ? table(
        [`Today (${esc(d.yieldToday!.day)} UTC)`, "Value", "If held", "Value vs hold", "Fees accrued"],
        ys.map((y) => [esc(poolDisplay(y.pool)), usd(y.valueUsd), usd(y.holdUsd), vsHold(y), usd(y.feesUsd)]),
      )
    : note("No yield ledger rows for today yet.");
  return block(
    "Exposure on Base",
    c.readAt ? `As of <time datetime="${esc(c.readAt)}">${esc(when(c.readAt))}</time>` : "",
    summary +
      poolTable +
      note("Distance of the price to the nearest range edge is not shown: the account snapshots do not store the tick range of each position.") +
      yieldPart +
      note("Value vs hold compares each position with what its entry amounts would be worth now. A pool under 10% of its entry value is flagged: an exit-only pool emptied on the way out shows that way too, so check its positions before reading it as a loss. Fees accrued is closing minus opening accrued fees, so a harvest during the day lowers it."),
  );
}

function monadBlock(d: WarRoomData, nowMs: number): string {
  if (!d.exposure) return block("Monad", "", note("Account snapshots are not available."));
  const c = d.exposure.find((x) => x.chainId === MONAD);
  const price = note("Price not measured: no Monad pool snapshots.");
  if (!c) return block("Monad", "", note("No production account on Monad has a snapshot.") + price);
  const positions = c.pools.reduce((n, p) => n + p.positions, 0);
  const inRange = c.pools.reduce((n, p) => n + p.inRange, 0);
  const rows = c.pools.map((p) => [esc(poolDisplay(p.pool)), num(p.positions), `${num(p.inRange)} of ${num(p.positions)}`, usd(p.valueUsd)]);
  return block(
    "Monad",
    c.readAt ? `As of <time datetime="${esc(c.readAt)}">${esc(when(c.readAt))}</time>` : "",
    table(["Accounts", "Idle", "Positions", "In range", "In pools", "Last read"], [
      [num(c.accounts), usd(c.idleUsd), num(positions), `${num(inRange)} of ${num(positions)}`, usd(c.lpUsd), readSpan(c, nowMs)],
    ]) + (rows.length ? table(["Pool", "Positions", "In range", "Value"], rows) : "") + price,
  );
}

function rerangeBlock(d: WarRoomData): string {
  const w = d.settings?.wide;
  if (!w) return block("Re-range settings", "", note("No production settings version to read."));
  const r = w.rerange;
  if (!r) return block("Re-range settings", `Version ${w.id}`, note("This version sets no re-range rules: the engine runs its defaults."));
  const hours = (s: number) => `${num(s / 3600, s % 3600 === 0 ? 0 : 1)} h`;
  return block(
    "Re-range settings",
    `Version ${w.id}`,
    table(["Mode", "Max per week", "Max wait", "Edge buffer", "Cost test"], [
      [esc(r.mode), r.maxPerWeek === null ? "no cap" : num(r.maxPerWeek), r.maxWaitSeconds === null ? "n/a" : hours(r.maxWaitSeconds), r.edgeBufferBps === null ? "n/a" : `${num(r.edgeBufferBps)} bps`, esc(r.costTest ?? "n/a")],
    ]),
  );
}

/** The page body: pure, data in and markup out. */
export function renderWarRoom(d: WarRoomData, nowMs: number = Date.parse(d.asOf)): string {
  return [pageHead({ title: "War room", asOf: d.asOf }), marketBlock(d, nowMs), guardBlock(d, nowMs), exposureBlock(d, nowMs), monadBlock(d, nowMs), rerangeBlock(d)].join("\n");
}

export function warRoomSection(d: WarRoomData): SectionView {
  return { section: "war-room", title: "War room", html: renderWarRoom(d) };
}
