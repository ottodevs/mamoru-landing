import { describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import type { AccountView, InfraSnapshot } from "../src/infra-snapshot";
import { renderBars, renderFunnel, renderTally, renderTimeChart } from "../src/metrics-charts";
import {
  addDays,
  atOrBefore,
  cumulativeGrowth,
  dauAverage,
  dauSlots,
  dayRange,
  delta,
  fmtUsd,
  funnel,
  niceCeil,
  niceCeilInt,
  shortDay,
} from "../src/metrics-math";
import { buildOverview, loadOverview } from "../src/metrics-overview";
import {
  BACKFILL_MARK,
  backfillRows,
  captureDaily,
  type DailyRow,
  hasChainData,
  PARTIAL_MARK,
  readActivity,
  readDaily,
  readSignupDays,
  rowFromSnapshot,
  upsertSql,
} from "../src/metrics-store";
import { sealSession } from "../src/ops";
import { changeLine, renderOverview } from "../src/ops-metrics";
import worker, { type Env } from "../src/worker";

const NOW = new Date("2026-10-01T14:05:00Z");
const TODAY = "2026-10-01";

function acct(i: number, usdcIdle: number, lpUsd: number, positions: number, inRange: number): AccountView {
  return {
    accountKey: `acc${i}`,
    address: `0x${String(i).padStart(40, "0")}`,
    basescanUrl: "#",
    ethBalance: 0,
    usdcIdle,
    lpUsd,
    positions,
    inRange,
  };
}

const ROWS = [acct(1, 2, 21.4, 2, 2), acct(2, 0.5, 14.1, 1, 1), acct(3, 0, 9.18, 1, 0), acct(4, 5, 0, 0, 0), acct(5, 0, 0, 0, 0)];

function snap(over: Partial<InfraSnapshot> = {}): InfraSnapshot {
  const idle = ROWS.reduce((s, r) => s + r.usdcIdle, 0);
  const lp = ROWS.reduce((s, r) => s + r.lpUsd, 0);
  return {
    asOf: NOW.toISOString(),
    ethUsd: 2500,
    btcUsd: 60000,
    relayer: { address: "0xrelayer", basescanUrl: "#", ethBalance: 0.0112, usd: 28, status: "ok" },
    cost: {
      gasPriceGwei: 0.01,
      deployEth: 0,
      deployUsd: 0,
      activationEth: 0,
      activationUsd: 0,
      reserveEth: 0.0005,
      reserveUsd: 1.25,
      totalEth: 0.00065,
      totalUsd: 1.6,
      accountsFunded: 17,
    },
    accounts: { totalUsers: 39, totalAccounts: 39, last7d: 39, rows: ROWS, tvlUsd: idle + lp, idleUsdcUsd: idle, lpUsd: lp, gasReservesEth: 0 },
    ...over,
  };
}

const SIGNUPS = {
  users: [{ day: "2026-09-26", n: 30 }, { day: "2026-09-27", n: 7 }, { day: "2026-09-28", n: 1 }, { day: "2026-09-29", n: 1 }],
  accounts: [{ day: "2026-09-26", n: 30 }, { day: "2026-09-27", n: 7 }, { day: "2026-09-28", n: 1 }, { day: "2026-09-29", n: 1 }],
};

function daily(day: string, over: Partial<DailyRow> = {}): DailyRow {
  return {
    day,
    users: 30,
    accounts: 30,
    funded_accounts: 2,
    active_accounts: 1,
    dau: 1,
    tvl_usd: 40,
    idle_usdc_usd: 10,
    lp_usd: 30,
    positions: 2,
    in_range: 1,
    relayer_eth: 0.01,
    eth_usd: 2500,
    captured_at: `${day}T00:05:00Z`,
    ...over,
  };
}

type Call = { sql: string; args: unknown[]; kind: "first" | "all" | "run" };

/** Scripted D1: `missing` tables throw like SQLite does; writes are recorded, never executed. */
function fakeDb(opts: { missing?: string[]; tables?: Record<string, unknown[]>; first?: (sql: string) => unknown } = {}) {
  const calls: Call[] = [];
  const check = (sql: string) => {
    for (const name of opts.missing ?? []) {
      if (sql.includes(name)) throw new Error(`D1_ERROR: no such table: ${name}`);
    }
  };
  const db: D1Db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async first<T>() {
          calls.push({ sql, args, kind: "first" });
          check(sql);
          return (opts.first?.(sql) ?? null) as T | null;
        },
        async all<T>() {
          calls.push({ sql, args, kind: "all" });
          check(sql);
          const table = Object.keys(opts.tables ?? {}).find((name) => sql.includes(`FROM ${name}`));
          return { results: ((table ? opts.tables?.[table] : []) ?? []) as T[], success: true };
        },
        async run() {
          calls.push({ sql, args, kind: "run" });
          check(sql);
          return { success: true };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, calls };
}

/** Every tag opened is closed, and no number leaked through as NaN, Infinity or undefined. */
function expectSoundMarkup(html: string) {
  expect(html).not.toMatch(/NaN|Infinity|undefined|null/);
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, tag, rest] = m;
    if (rest.trimEnd().endsWith("/")) continue;
    if (close) expect(stack.pop()).toBe(tag);
    else stack.push(tag);
  }
  expect(stack).toEqual([]);
}

describe("metrics-math.ts", () => {
  test("days: range, shifting across a month, short labels", () => {
    expect(addDays("2026-10-01", -7)).toBe("2026-09-24");
    expect(dayRange("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(dayRange("2026-10-02", "2026-10-01")).toEqual([]);
    expect(shortDay("2026-09-26")).toBe("26 Sep");
  });

  test("delta: sign, percentage, and no past means no delta", () => {
    expect(delta(52, 40)).toEqual({ abs: 12, pct: 30, dir: "up" });
    expect(delta(30, 40)).toEqual({ abs: -10, pct: -25, dir: "down" });
    expect(delta(5, 5)?.dir).toBe("flat");
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null, dir: "up" });
    expect(delta(5, null)).toBeNull();
    expect(delta(5, undefined)).toBeNull();
    expect(delta(5, Number.NaN)).toBeNull();
  });

  test("funnel: share of the top step and conversion from the step above", () => {
    const steps = funnel([
      { id: "a", label: "Signed up", count: 39 },
      { id: "b", label: "Funded", count: 5 },
      { id: "c", label: "Activated", count: 3 },
      { id: "d", label: "In range", count: 2 },
    ]);
    expect(steps[0]).toMatchObject({ share: 1, rate: null });
    expect(steps[1].share).toBeCloseTo(5 / 39, 6);
    expect(steps[1].rate).toBeCloseTo((5 / 39) * 100, 6);
    expect(steps[2].rate).toBeCloseTo(60, 6);
    expect(steps[3].rate).toBeCloseTo((2 / 3) * 100, 6);
  });

  test("funnel: empty and broken counts never divide by zero", () => {
    const steps = funnel([
      { id: "a", label: "A", count: 0 },
      { id: "b", label: "B", count: Number.NaN },
      { id: "c", label: "C", count: -4 },
    ]);
    expect(steps.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(steps.map((s) => s.share)).toEqual([0, 0, 0]);
    expect(steps.map((s) => s.rate)).toEqual([null, null, null]);
    expect(funnel([])).toEqual([]);
  });

  test("cumulativeGrowth fills quiet days and runs through today", () => {
    const growth = cumulativeGrowth(SIGNUPS.users, SIGNUPS.accounts, TODAY);
    expect(growth.map((g) => g.users)).toEqual([30, 37, 38, 39, 39, 39]);
    expect(growth[0].day).toBe("2026-09-26");
    expect(growth[growth.length - 1].day).toBe(TODAY);
    expect(cumulativeGrowth([], [], TODAY)).toEqual([]);
    expect(atOrBefore(growth, "2026-09-27")?.users).toBe(37);
    expect(atOrBefore(growth, "2026-09-24")).toBeNull();
  });

  test("dauSlots keeps days before tracking as null, and the average only counts tracked days", () => {
    const slots = dauSlots(new Map([["2026-09-30", 1], [TODAY, 2]]), "2026-09-30", TODAY, 14);
    expect(slots).toHaveLength(14);
    expect(slots[11].n).toBeNull();
    expect(slots[12].n).toBe(1);
    expect(slots[13].n).toBe(2);
    expect(dauAverage(slots, 7)).toEqual({ avg: 1.5, days: 2 });
    expect(dauAverage(dauSlots(new Map(), null, TODAY, 14), 7)).toBeNull();
  });

  test("axis ceilings are round, and whole for counts", () => {
    expect(niceCeil(52.2)).toBe(100);
    expect(niceCeil(14600)).toBe(20000);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeilInt(39)).toBe(40);
    expect(niceCeilInt(1)).toBe(2);
    expect(niceCeilInt(273)).toBe(400);
    expect(fmtUsd(52.2)).toBe("$52.20");
    expect(fmtUsd(1284)).toBe("$1,284");
    expect(fmtUsd(14600)).toBe("$14.6K");
  });
});

describe("metrics-store.ts", () => {
  test("missing tables degrade to null instead of throwing", async () => {
    const { db } = fakeDb({ missing: ["metrics_daily", "account_activity"] });
    expect(await readDaily(db, "2026-09-01")).toBeNull();
    expect(await readActivity(db, "2026-09-18")).toBeNull();
    expect(await readSignupDays(db)).toEqual({ users: [], accounts: [] });
  });

  test("loadOverview still renders from created_at when both metrics tables are missing", async () => {
    const { db } = fakeDb({
      missing: ["metrics_daily", "account_activity"],
      tables: { users: SIGNUPS.users, accounts: SIGNUPS.accounts },
    });
    const overview = await loadOverview(db, snap(), NOW);
    expect(overview.dau).toBeNull();
    expect(overview.dauToday).toBeNull();
    expect(overview.value).toEqual([{ day: TODAY, idle: 7.5, lp: expect.closeTo(44.68, 5) }]);
    expect(overview.growth).toHaveLength(6);
    expect(overview.changes.tvl).toBeNull();
    expectSoundMarkup(renderOverview({ overview, csrf: "c", nonce: "n" }).split('<main class="wide">')[1].split("<script")[0]);
  });

  test("rowFromSnapshot: funded, active, positions and totals", () => {
    const row = rowFromSnapshot(snap(), TODAY, 2);
    expect(row).toMatchObject({
      day: TODAY,
      users: 39,
      accounts: 39,
      funded_accounts: 4,
      active_accounts: 3,
      dau: 2,
      positions: 4,
      in_range: 3,
      relayer_eth: 0.0112,
      eth_usd: 2500,
      captured_at: NOW.toISOString(),
    });
    expect(row.idle_usdc_usd).toBeCloseTo(7.5, 6);
    expect(row.lp_usd).toBeCloseTo(44.68, 6);
    expect(row.tvl_usd).toBeCloseTo(52.18, 6);
    expect(hasChainData(row)).toBe(true);
  });

  test("a snapshot without Base keeps the counts and marks the row partial", () => {
    const row = rowFromSnapshot(
      snap({
        rpcError: "Base RPC is unreachable right now.",
        relayer: null,
        cost: null,
        ethUsd: null,
        accounts: { totalUsers: 39, totalAccounts: 39, last7d: 39, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "x" },
      }),
      TODAY,
      1,
    );
    expect(row).toMatchObject({ users: 39, accounts: 39, dau: 1, tvl_usd: 0, captured_at: PARTIAL_MARK });
    expect(hasChainData(row)).toBe(false);
    // A partial write must not overwrite value fields captured earlier that day.
    expect(upsertSql(row)).not.toContain("tvl_usd = excluded.tvl_usd");
    expect(upsertSql(rowFromSnapshot(snap(), TODAY, 1))).toContain("tvl_usd = excluded.tvl_usd");
  });

  test("backfillRows: one counts-only row per past day, never today", () => {
    const rows = backfillRows(SIGNUPS, TODAY);
    expect(rows.map((r) => r.day)).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(rows.map((r) => r.users)).toEqual([30, 37, 38, 39, 39]);
    expect(rows.every((r) => r.captured_at === BACKFILL_MARK && r.tvl_usd === 0)).toBe(true);
  });

  test("captureDaily: backfills an empty table, then upserts today's row; only metrics_daily is written", async () => {
    const { db, calls } = fakeDb({
      tables: { users: SIGNUPS.users, accounts: SIGNUPS.accounts },
      first: (sql) => (sql.includes("FROM metrics_daily") ? { n: 0 } : sql.includes("account_activity") ? { n: 2 } : null),
    });
    const outcome = await captureDaily({ db }, { now: NOW, settleYesterday: true, load: async () => ({ snapshot: snap() }) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backfilled).toBe(5);
    expect(outcome.row).toMatchObject({ day: TODAY, dau: 2, active_accounts: 3 });
    const writes = calls.filter((c) => c.kind === "run");
    expect(writes).toHaveLength(7);
    expect(writes.every((c) => /^(INSERT( OR IGNORE)? INTO|UPDATE) metrics_daily\b/.test(c.sql))).toBe(true);
    const upsert = writes[5];
    expect(upsert.sql).toContain("ON CONFLICT(day) DO UPDATE");
    expect(upsert.args[0]).toBe(TODAY);
    expect(upsert.args).toHaveLength(14);
    expect(writes[6].args).toEqual([2, "2026-09-30"]);
  });

  test("captureDaily: a table with rows is not backfilled again", async () => {
    const { db, calls } = fakeDb({ first: (sql) => (sql.includes("FROM metrics_daily") ? { n: 12 } : { n: 0 }) });
    const outcome = await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: snap() }) });
    expect(outcome.ok && outcome.backfilled).toBe(0);
    expect(calls.filter((c) => c.kind === "run")).toHaveLength(1);
  });

  test("captureDaily reports instead of throwing: no D1, unreadable counts, missing table", async () => {
    expect(await captureDaily({}, { now: NOW })).toMatchObject({ ok: false, reason: "no-db" });
    const { db } = fakeDb({ missing: ["metrics_daily"] });
    expect(await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: snap() }) })).toMatchObject({ ok: false, reason: "write-failed" });
    const blind = snap({ accounts: { totalUsers: 0, totalAccounts: 0, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "Could not read the accounts database." } });
    expect(await captureDaily({ db }, { now: NOW, load: async () => ({ snapshot: blind }) })).toMatchObject({ ok: false, reason: "no-counts" });
  });
});

describe("metrics-overview.ts", () => {
  test("deltas compare with the row seven days back, and say so when it is not exact", () => {
    const overview = buildOverview(
      snap(),
      {
        daily: [daily("2026-09-22", { tvl_usd: 30, active_accounts: 1 }), daily("2026-09-30", { tvl_usd: 48 })],
        activity: null,
        signups: { users: [{ day: "2026-09-20", n: 30 }, { day: "2026-09-27", n: 9 }], accounts: [{ day: "2026-09-20", n: 30 }, { day: "2026-09-27", n: 9 }] },
      },
      NOW,
    );
    expect(overview.changes.tvl).toMatchObject({ since: "2026-09-22", exact: false });
    expect(overview.changes.tvl?.delta.abs).toBeCloseTo(22.18, 6);
    expect(overview.changes.activated?.delta.abs).toBe(2);
    expect(overview.changes.users).toMatchObject({ since: "2026-09-24", exact: true });
    expect(overview.changes.users?.delta.abs).toBe(9);
    expect(changeLine(overview.changes.users, "int")).toBe("+9 in 7 days");
    expect(changeLine(overview.changes.tvl, "usd")).toBe("+$22.18 (+74%) since 22 Sep");
    expect(changeLine(null, "int")).toBe("");
  });

  test("backfilled rows never feed the value chart or the value delta", () => {
    const overview = buildOverview(
      snap(),
      { daily: [daily("2026-09-24", { captured_at: BACKFILL_MARK, tvl_usd: 0 }), daily("2026-09-30")], activity: null, signups: SIGNUPS },
      NOW,
    );
    expect(overview.value.map((p) => p.day)).toEqual(["2026-09-30", TODAY]);
    expect(overview.changes.tvl).toBeNull();
  });

  test("funnel counts accounts, and Base being down falls back to the last capture", () => {
    const live = buildOverview(snap(), { daily: null, activity: null, signups: SIGNUPS }, NOW);
    expect(live.funnel.map((s) => s.count)).toEqual([39, 4, 3, 2]);
    expect(live.positionsInRange).toBe(3);
    expect(live.positions).toBe(4);

    const down = buildOverview(
      snap({ rpcError: "Base RPC is unreachable right now.", relayer: null, cost: null, accounts: { totalUsers: 39, totalAccounts: 39, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "x" } }),
      { daily: [daily("2026-09-30", { tvl_usd: 48, idle_usdc_usd: 8, lp_usd: 40, active_accounts: 3, funded_accounts: 4 })], activity: null, signups: SIGNUPS },
      NOW,
    );
    expect(down.chainOk).toBe(false);
    expect(down.tvl).toBe(48);
    expect(down.activated).toBe(3);
    expect(down.relayer).toBeNull();
    expect(down.notes.join(" ")).toContain("last capture");
    expectSoundMarkup(renderOverview({ overview: down, csrf: "c", nonce: "n" }).split('<main class="wide">')[1].split("<script")[0]);
  });
});

describe("metrics-charts.ts", () => {
  function chart(n: number, stacked: boolean) {
    const days = Array.from({ length: n }, (_, i) => addDays(TODAY, i - (n - 1)));
    return renderTimeChart({
      id: "t",
      title: "Value <held>",
      days,
      series: [
        { label: "Idle", tone: "stone", values: days.map((_, i) => 5 + i) },
        { label: "LP", tone: "emerald", values: days.map((_, i) => 20 + i * 3), dashed: !stacked },
      ],
      stacked,
      format: stacked ? "usd" : "int",
      emptyNote: "Nothing yet.",
      singleNote: "History starts today.",
    });
  }

  for (const stacked of [true, false]) {
    test(`time chart (${stacked ? "stacked" : "lines"}) is sound for 0, 1 and 30 points`, () => {
      for (const n of [0, 1, 2, 30]) {
        const html = chart(n, stacked);
        expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
        expect(html).toContain("<title");
        expect(html).toContain("Value &lt;held&gt;");
        const data = JSON.parse(html.match(/data-chart="([^"]*)"/)![1].replaceAll("&quot;", '"'));
        expect(data.p).toHaveLength(n);
        for (const p of data.p) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(100);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(100);
        }
      }
    });
  }

  test("zero points says so, one point stands alone, many points draw paths", () => {
    expect(chart(0, true)).toContain("Nothing yet.");
    expect(chart(0, true)).not.toContain("<path");
    const single = chart(1, true);
    expect(single).toContain("History starts today.");
    expect(single).toContain('class="stem s-emerald"');
    expect(single).not.toContain("<path");
    const many = chart(30, true);
    expect(many).not.toContain("History starts today.");
    expect(many.match(/<path /g)?.length).toBe(4);
    expect(many).toMatch(/d="M0,[\d.]+ L[\d.]+,/);
    expect(many.match(/class="dot /g)?.length).toBe(1);
  });

  test("all-zero values still draw on the baseline", () => {
    const html = renderTimeChart({
      id: "z",
      title: "Zero",
      days: ["2026-09-30", TODAY],
      series: [{ label: "A", tone: "ink", values: [0, 0] }],
      format: "usd",
      emptyNote: "",
      singleNote: "",
    });
    expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
    expect(html).toContain('d="M0,100 L100,100"');
  });

  test("bars: tracked, zero and untracked days; an empty set shows the note", () => {
    const html = renderBars({
      id: "d",
      title: "Active",
      slots: dauSlots(new Map([["2026-09-30", 0], [TODAY, 2]]), "2026-09-30", TODAY, 14),
      emptyNote: "Not recorded.",
    });
    expectSoundMarkup(html.replace(/data-chart="[^"]*"/, ""));
    expect(html.match(/class="bar rest"/g)?.length).toBe(12);
    expect(html).toContain('class="bar zero"');
    expect(html).toContain('class="bar today"');
    expect(html).not.toContain("Not recorded.");
    const empty = renderBars({ id: "d", title: "Active", slots: dauSlots(new Map(), null, TODAY, 14), emptyNote: "Not recorded." });
    expectSoundMarkup(empty.replace(/data-chart="[^"]*"/, ""));
    expect(empty).toContain("Not recorded.");
    expect(empty).not.toContain("tabindex");
  });

  test("funnel and tally render for empty and full inputs", () => {
    const html = renderFunnel(funnel([{ id: "a", label: "Signed up", count: 39 }, { id: "b", label: "Funded", count: 5 }, { id: "c", label: "In range", count: 0 }]));
    expectSoundMarkup(html);
    expect(html).toContain("13% of signed up");
    expect(html).toContain("0% of funded");
    expect(html).toContain("width:0%");
    expectSoundMarkup(renderFunnel(funnel([])));
    expect(renderTally(0)).toBe("");
    expect(renderTally(3).match(/class="tick/g)?.length).toBe(3);
    expect(renderTally(128)).toContain("and 78 more");
  });
});

describe("ops-metrics.ts render", () => {
  test("the page carries real text values, the nonce on both scripts, and the CSRF token", () => {
    const overview = buildOverview(snap(), { daily: null, activity: null, signups: SIGNUPS }, NOW);
    const html = renderOverview({ overview, csrf: "tok<en", nonce: "abc123", who: "ot@example.com" });
    expect(html).toContain("<strong>Overview</strong>");
    expect(html).toContain('<a href="/ops/mails">Mails</a>');
    expect(html).toContain(">$52.18<");
    expect(html).toContain("History starts today");
    expect(html).toContain("Activity is not being recorded yet.");
    expect(html).toContain('action="/ops/metrics/snapshot"');
    expect(html).toContain('value="tok&lt;en"');
    expect(html).toContain('href="/ops/infra"');
    expect(html.match(/<script nonce="abc123">/g)?.length).toBe(2);
    expect(html.match(/<script/g)?.length).toBe(2);
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("worker.ts gate for the overview", () => {
  function opsEnv(extra: Partial<Env> = {}): Env {
    return {
      ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      OPS_SESSION_SECRET: "k1",
      ...extra,
    };
  }

  test("no session: /ops goes to Google, /ops/mails and the snapshot POST do not exist", async () => {
    const env = opsEnv();
    const overview = await worker.fetch(new Request("https://mamoru.lol/ops"), env);
    expect(overview.status).toBe(302);
    expect(overview.headers.get("location") ?? "").toContain("https://accounts.google.com/");
    const mails = await worker.fetch(new Request("https://mamoru.lol/ops/mails"), env);
    expect(mails.status).toBe(404);
    expect(await mails.text()).not.toContain("The list");
    const post = await worker.fetch(new Request("https://mamoru.lol/ops/metrics/snapshot", { method: "POST" }), env);
    expect(post.status).toBe(404);
  });

  test("a session removed from the allowlist is denied on all three", async () => {
    const env = opsEnv();
    const cookie = `mamoru_list=${await sealSession("k1", "someone@example.com")}`;
    for (const [path, method] of [["/ops", "GET"], ["/ops/mails", "GET"], ["/ops/metrics/snapshot", "POST"]] as const) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`, { method, headers: { cookie } }), env);
      expect(res.status).toBe(404);
    }
  });

  test("the snapshot POST needs the CSRF token and writes nothing without it", async () => {
    const { db, calls } = fakeDb();
    const env = opsEnv({ MAMORU_DB: db });
    const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/metrics/snapshot", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "csrf=wrong",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ops/mails");
    expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_flash=bad");
    expect(calls).toHaveLength(0);
  });

  test("mail actions land back on /ops/mails, and the list is served there", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
    };
    const env = opsEnv({ WAITLIST: kv });
    const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
    const page = await worker.fetch(new Request("https://mamoru.lol/ops/mails", { headers: { cookie } }), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("The list");
    expect(html).toContain("<strong>Mails</strong>");
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const removed = await worker.fetch(
      new Request("https://mamoru.lol/ops/remove", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: `csrf=${encodeURIComponent(csrf)}&email=a%40b.co`,
      }),
      env,
    );
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/ops/mails");
  });
});
