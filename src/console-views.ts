// otto/mamoru-astro#24: the console's five views as server-rendered sections (SectionView), in Mamoru's own style:
// washi paper, ink, one emerald accent, Noto Serif figures and IBM Plex Mono labels. Charts ship their data as a
// `data-c` attribute and are drawn by the console client at the container's real width (console-client.ts);
// without script every chart still has its figures in a <details> table.
import { type ConsoleEnv, type ConsoleModel, type AccountYield, money, pct, poolLabel } from "./console-data";
import type { SectionId, SectionView } from "./ops";
import { esc } from "./text";

const int = (n: number) => n.toLocaleString("en-US");
const dayLabel = (d: string) => new Date(d.length === 10 ? d + "T00:00:00Z" : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const timeLabel = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
function ago(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const attr = (v: unknown) => esc(JSON.stringify(v));

type Chart =
  | { t: "line"; points: { l: string; y: number }[]; fmt: "money" | "k"; color?: "emerald" | "ink" | "umber"; threshold?: { y: number; label: string } }
  | { t: "bars"; points: { l: string; y?: number; s?: Record<string, number> }[]; fmt: "int" | "money"; color?: "emerald" | "ink"; stack?: { key: string; name: string; color: string }[] };

function chart(spec: Chart, caption: string, rowsFor: () => [string, string][], height = 180): string {
  const table = rowsFor()
    .map(([a, b]) => `<tr><td>${esc(a)}</td><td class="n">${esc(b)}</td></tr>`)
    .join("");
  return `<div class="c-chart" data-c="${attr(spec)}" style="--h:${height}px" role="img" aria-label="${esc(caption)}"></div>
<details class="c-data"><summary>Figures</summary><table><tbody>${table}</tbody></table></details>`;
}

function sheet(title: string, sub: string | null, body: string, cls = ""): string {
  return `<section class="c-sheet ${cls}"><header class="c-sheet-h"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</header>${body}</section>`;
}

function fig(label: string, value: string, note: string, extra = ""): string {
  return `<div class="c-fig"><span class="c-k">${esc(label)}</span><span class="c-v">${esc(value)}</span><span class="c-note">${esc(note)}</span>${extra}</div>`;
}

function seal(tone: "bad" | "warn" | "info" | "good"): string {
  return `<i class="c-seal ${tone}" aria-hidden="true"></i>`;
}

function chip(text: string, tone: "good" | "warn" | "bad" | "dim" | "em" = "dim"): string {
  return `<span class="c-chip ${tone}">${esc(text)}</span>`;
}

/** Scope bar shared by every money view: the environment switch (links, so it works without script) and freshness. */
function head(title: string, path: string, m: ConsoleModel): string {
  const link = (env: ConsoleEnv, label: string) =>
    `<a href="${path}${env === "all" ? "?env=all" : ""}" ${m.env === env ? 'aria-current="true"' : ""}>${label}</a>`;
  const read = m.ledgerReadAt ? `Ledger read ${timeLabel(m.ledgerReadAt)}` : "Ledger has no reading yet";
  return `<header class="c-head"><h1 tabindex="-1">${esc(title)}</h1>
<nav class="c-seg" aria-label="Environment">${link("prod", "Production")}${link("all", "All, with test")}</nav>
<span class="c-fresh"><i aria-hidden="true"></i>${esc(read)}</span></header>`;
}

function view(section: SectionId, title: string, html: string): SectionView {
  return { section, title, html: `<div class="c-view">${html}</div>` };
}

function alertsList(m: ConsoleModel): string {
  if (!m.alerts.length) return `<p class="c-empty">Nothing needs attention.</p>`;
  return `<ul class="c-alerts">${m.alerts
    .map(
      (a) => `<li>${seal(a.tone)}<div><b>${esc(a.title)}</b><span>${esc(a.detail)}</span></div>${a.account ? `<button type="button" class="c-open" data-account="${esc(a.account)}">Open</button>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

/** One hidden template per account: the drawer the client opens from any view. */
function drawers(m: ConsoleModel, now: Date): string {
  return m.accounts
    .map((a) => {
      const pos = a.positions
        .slice()
        .sort((x, y) => y.value - x.value)
        .map((p) => {
          const n = poolLabel(p.pool);
          return `<li class="c-pos"><div><b>${esc(n.pair)}</b><span>${esc(n.fee)} fee tier</span></div>${chip(p.inRange ? "In range" : "Out of range", p.inRange ? "good" : "warn")}<span class="n">${esc(money(p.value))} placed</span><span class="n">${esc(money(p.fees))} earned</span></li>`;
        })
        .join("");
      const ops = (m.operator?.ops ?? [])
        .filter((o) => o.accountKey === a.key)
        .slice(0, 8)
        .map((o) => `<li><span>${esc(o.kind)}</span>${chip(`${o.state}, ${ago(o.at, now)}`, o.state === "confirmed" ? "good" : o.state === "failed" ? "bad" : "dim")}</li>`)
        .join("");
      return `<template id="c-acct-${esc(a.key)}"><div class="c-drawer-in">
<p class="c-k">Account ${a.env !== "prod" ? esc(a.env) : ""}</p><h2 class="c-acct">${esc(a.key)}</h2>
<div class="c-figs two">${fig("Earned", money(a.fees), a.since ? `since ${dayLabel(a.since)}` : "")}${fig("Fee APR", pct(a.apr), `${money(a.lp)} placed, before gas`)}</div>
${sheet("Positions", `${a.positions.filter((p) => p.inRange).length} of ${a.positions.length} in range`, a.positions.length ? `<ul class="c-poslist">${pos}</ul>` : `<p class="c-empty">No position open. ${a.idle >= 0.01 ? money(a.idle) + " is waiting to be placed." : ""}</p>`)}
${sheet("Engine activity", m.operator ? "Newest first" : "Not connected yet", ops ? `<ul class="c-feed">${ops}</ul>` : `<p class="c-empty">No recent operations reported.</p>`)}
</div></template>`;
    })
    .join("");
}

function poolStack(m: ConsoleModel): string {
  const sum = m.pools.reduce((x, p) => x + p.fees, 0);
  if (!sum) return `<p class="c-empty">No fees yet.</p>`;
  const tones = ["emerald", "ink", "stone"];
  const bar = m.pools.map((p, i) => `<span class="${tones[i % 3]}" style="width:${Math.max(1.5, (p.fees / sum) * 100).toFixed(2)}%"></span>`).join("");
  const legend = m.pools
    .map((p, i) => {
      const n = poolLabel(p.pool);
      return `<li><i class="${tones[i % 3]}" aria-hidden="true"></i><b>${esc(n.pair)}</b> <span>${esc(n.fee)}</span><span class="n">${esc(money(p.fees))}</span><span class="n">${esc(pct(p.apr))}</span></li>`;
    })
    .join("");
  return `<div class="c-stack" aria-hidden="true">${bar}</div><ul class="c-legend">${legend}</ul>`;
}

const capitalChart = (m: ConsoleModel) =>
  m.capital.length > 1
    ? chart({ t: "line", points: m.capital.map((c) => ({ l: dayLabel(c.day), y: c.value })), fmt: "money" }, "Capital held per day", () => m.capital.map((c) => [c.day, money(c.value)]), 170)
    : `<p class="c-empty">No daily capital recorded yet.</p>`;

const signupChart = (m: ConsoleModel, h = 140) =>
  chart({ t: "bars", points: m.signups.map((s) => ({ l: dayLabel(s.day), y: s.value })), fmt: "int", color: "ink" }, "Sign-ups per day", () => m.signups.map((s) => [s.day, String(s.value)]), h);

export function pulseSection(m: ConsoleModel, now: Date): SectionView {
  const t = m.totals;
  const hero = `<section class="c-sheet c-hero"><p class="c-k">Earned for users so far</p>
<p class="c-big">${esc(money(t.fees))}</p>
<p class="c-line"><span>${t.apr != null ? `at least <b>${esc(pct(t.apr))}</b> fee APR, before gas` : "fee APR shows once the engine reports first entries"}</span><span><b>${esc(money(t.lp))}</b> placed in ${t.positions} positions</span><span><b>${t.earning}</b> accounts earning</span></p>
${capitalChart(m)}
<p class="c-foot">Capital held per day, every account including test: that daily table has no environment yet. A dip is a withdrawal as often as a price move.</p></section>`;
  const attention = sheet("Needs attention", m.alerts.length ? `${m.alerts.length} open` : null, alertsList(m), "c-attn");
  const figs = `<div class="c-figs">
${fig("Placed and earning", money(t.lp), `${money(t.idle)} waiting to be placed`)}
${fig("Positions in range", `${t.inRange} of ${t.positions}`, t.inRange === t.positions ? "All earning fees" : `${t.positions - t.inRange} paused out of range`)}
${fig("Accounts", int(m.lifecycle.total), `${m.lifecycle.earning} earning, ${m.lifecycle.signedUp} signed up only`)}
${fig("Projected fee", money(t.fees * 0.1), "10% of the yield, once harvested")}
</div>`;
  const bottom = `<div class="c-grid two">${sheet("Where the yield comes from", "Uncollected fees by pool, and each pool's fee APR", poolStack(m))}${sheet("Sign-ups per day", `${int(m.lifecycle.total)} accounts so far`, signupChart(m))}</div>`;
  return view("overview", "Pulse", head("Pulse", "/ops", m) + `<div class="c-grid hero">${hero}${attention}</div>` + figs + bottom + drawers(m, now));
}

function leaderboard(m: ConsoleModel): string {
  const earning = m.accounts.filter((a) => a.lp > 0.01 || a.fees > 0);
  if (!earning.length) return `<p class="c-empty">No account has capital placed yet.</p>`;
  const max = Math.max(...earning.map((a) => a.fees), 1e-9);
  const row = (a: AccountYield) =>
    `<li><button type="button" class="c-lb-row" data-account="${esc(a.key)}"><span class="c-mono">${esc(a.key)}${a.env !== "prod" ? ` <em>${esc(a.env)}</em>` : ""}</span><span class="c-bar"><i style="width:${((a.fees / max) * 100).toFixed(1)}%"></i><small>${esc(money(a.fees))}</small></span><span class="n">${esc(pct(a.apr))}</span><span class="n wide">${esc(money(a.lp))}</span><span class="n wide">${a.positions.filter((p) => p.inRange).length}/${a.positions.length}</span></button></li>`;
  return `<div class="c-lb-head"><span>Account</span><span>Fees earned</span><span class="n">APR</span><span class="n wide">Placed</span><span class="n wide">In range</span></div><ul class="c-lb">${earning.map(row).join("")}</ul>`;
}

function poolCards(m: ConsoleModel): string {
  if (!m.pools.length) return `<p class="c-empty">No positions open.</p>`;
  return `<ul class="c-pools">${m.pools
    .map((p) => {
      const n = poolLabel(p.pool);
      return `<li><div class="c-pool-top"><div><b>${esc(n.pair)}</b><span>${esc(n.fee)} fee tier</span></div><span class="c-pool-apr">${esc(pct(p.apr))}</span></div><dl><dt>Fees earned</dt><dd>${esc(money(p.fees))}</dd><dt>Placed</dt><dd>${esc(money(p.value))}</dd><dt>In range</dt><dd>${p.inRange} of ${p.positions}</dd></dl></li>`;
    })
    .join("")}</ul>`;
}

/** Harvests counted from the operator's own confirmed operations; unknown without them, never a typed-in zero. */
function harvestFig(m: ConsoleModel): string {
  if (!m.operator) return fig("Harvests", "n/a", "engine data not connected yet");
  const n = m.operator.ops.filter((o) => o.state === "confirmed" && /harvest|collect/.test(o.kind)).length;
  return fig("Harvests", String(n), n ? `in the last ${m.operator.ops.length} operations` : "none in the recent operations: a harvest waits until fees beat 3 times its gas");
}

export function yieldView(m: ConsoleModel, now: Date): SectionView {
  const t = m.totals;
  const best = m.accounts.filter((a) => a.apr != null).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  const figs = `<div class="c-figs">
${fig("Earned to date", money(t.fees), "uncollected fees, every position")}
${fig("Fee APR", pct(t.apr), "at least: since first entry, weighted by capital, before gas")}
${fig("Best account", best ? pct(best.apr) : "n/a", best ? `${best.key}, ${money(best.lp)} placed` : "")}
${harvestFig(m)}
</div>`;
  const body = `<div class="c-grid hero">${sheet("Yield by account", "Bar length is fees earned. Open an account for its positions.", leaderboard(m))}${sheet("Pools", "What each pool earns per dollar placed", poolCards(m))}</div>`;
  const daily = sheet("Daily yield", "Fees earned, gas paid and the net per day, on one axis in dollars", `<p class="c-empty">The ledger started on 18 Oct. This fills in as each day closes; gas per account is recorded once the operator writes it (ottodevs/mamoru#129).</p>`);
  return view("yield", "Yield", head("Yield", "/ops/yield", m) + figs + body + daily + drawers(m, now));
}

export function accountsView(m: ConsoleModel, now: Date): SectionView {
  const l = m.lifecycle;
  const part = (n: number, cls: string) => (n ? `<span class="${cls}" style="width:${((n / Math.max(1, l.total)) * 100).toFixed(2)}%"></span>` : "");
  const stand = `<div class="c-stack tall" aria-hidden="true">${part(l.earning, "emerald")}${part(l.waiting, "umber")}${part(l.signedUp, "wash")}</div>
<ul class="c-legend"><li><i class="emerald"></i><b>Earning</b><span class="n">${l.earning}</span></li><li><i class="umber"></i><b>Funds waiting</b><span class="n">${l.waiting}</span></li><li><i class="wash"></i><b>Signed up, no deposit</b><span class="n">${l.signedUp}</span></li></ul>`;
  const steps: [string, number][] = [["Signed up", l.total], ["Deposited", l.earning + l.waiting], ["Earning", l.earning]];
  const funnel = `<ul class="c-funnel">${steps.map(([n, c]) => `<li><span>${esc(n)}</span><span class="c-meter"><i style="width:${((c / Math.max(1, l.total)) * 100).toFixed(1)}%"></i></span><span class="n">${c}</span><span class="n dim">${l.total ? pct((c / l.total) * 100, 0) : ""}</span></li>`).join("")}</ul>`;
  const shown = m.accounts.filter((a) => a.total >= 0.01);
  const folded = m.accounts.length - shown.length;
  const list = m.accounts.length
    ? `<ul class="c-lb plain">${shown
        .map((a) => {
          const state = a.lp > 0.01 ? chip("Earning", "good") : a.idle >= 0.2 ? chip("Funds waiting", "warn") : chip("No deposit");
          return `<li><button type="button" class="c-lb-row compact" data-account="${esc(a.key)}"><span class="c-mono">${esc(a.key)}</span>${state}<span class="n">${esc(money(a.total))}</span><span class="n wide">${esc(ago(a.readAt, now))}</span></button></li>`;
        })
        .join("")}</ul>${folded ? `<p class="c-foot">${folded} more Safe${folded === 1 ? "" : "s"} with nothing deposited yet.</p>` : ""}`
    : `<p class="c-empty">No account has been read yet.</p>`;
  return view(
    "accounts",
    "Accounts",
    head("Accounts", "/ops/accounts", m) +
      `<div class="c-grid two">${sheet("Where every account stands", `${int(l.total)} accounts`, stand)}${sheet("From sign-up to earning", "Conversion so far", funnel)}</div>` +
      `<div class="c-grid hero">${sheet("Sign-ups per day", "Since launch", signupChart(m, 170))}${sheet("Accounts with money in", "Every Safe the ledger reads that holds funds", list)}</div>` +
      drawers(m, now),
  );
}

export function engineView(m: ConsoleModel, now: Date): SectionView {
  const ops = m.operator?.ops ?? [];
  if (!m.operator) {
    return view("engine", "Engine", head("Engine", "/ops/engine", m) + sheet("Engine", "Not connected yet", `<p class="c-empty">The engine view reads the operator's metrics from D1 (operator_metrics_latest, migration 0013 in ottodevs/mamoru). It fills in on the next 10-minute pull once that is live.</p>`));
  }
  const conf = ops.filter((o) => o.state === "confirmed");
  const failed = ops.filter((o) => o.state === "failed");
  const harvests = conf.filter((o) => /harvest|collect/.test(o.kind)).length;
  const figs = `<div class="c-figs">
${fig("Confirmed", int(conf.length), `of the last ${ops.length} operations`)}
${fig("Success rate", pct((conf.length / Math.max(1, conf.length + failed.length)) * 100, 0), `${failed.length} failed, then retried or replaced`)}
${fig("Harvests", String(harvests), harvests ? "" : "none yet: fees are still below 3 times the gas")}
${fig("In range now", `${m.totals.inRange} of ${m.totals.positions}`, "positions")}
</div>`;
  const kinds = [
    { key: "enter", name: "Enter", color: "emerald" },
    { key: "activate", name: "Activate", color: "ink" },
    { key: "renew", name: "Renew", color: "stone" },
    { key: "other", name: "Other", color: "wash" },
  ];
  const byDay = new Map<string, Record<string, number>>();
  for (const o of conf) {
    const d = o.at.slice(0, 10);
    const k = ["enter", "activate", "renew"].includes(o.kind) ? o.kind : "other";
    const rec = byDay.get(d) ?? {};
    rec[k] = (rec[k] ?? 0) + 1;
    byDay.set(d, rec);
  }
  const first = [...byDay.keys()].sort()[0];
  const days: string[] = [];
  if (first) for (let d = new Date(first + "T00:00:00Z"); d <= now; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const perDay = sheet(
    "Confirmed operations per day",
    "What the engine did on chain",
    `<ul class="c-legend inline">${kinds.map((k) => `<li><i class="${k.color}"></i>${k.name}</li>`).join("")}</ul>` +
      chart({ t: "bars", points: days.map((d) => ({ l: dayLabel(d), s: byDay.get(d) ?? {} })), fmt: "int", stack: kinds }, "Confirmed operations per day", () => days.map((d) => [d, String(Object.values(byDay.get(d) ?? {}).reduce((a, b) => a + b, 0))]), 180),
  );
  const codes = new Map<string, number>();
  for (const f of failed) codes.set(f.code ?? "no code", (codes.get(f.code ?? "no code") ?? 0) + 1);
  const maxCode = Math.max(1, ...codes.values());
  const why = sheet(
    "Why operations failed",
    "Grouped by the code the engine recorded",
    codes.size
      ? `<ul class="c-funnel codes">${[...codes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<li><span class="c-mono">${esc(c)}</span><span class="c-meter bad"><i style="width:${((n / maxCode) * 100).toFixed(1)}%"></i></span><span class="n">${n}</span></li>`).join("")}</ul>`
      : `<p class="c-empty">No failures in the recent operations.</p>`,
  );
  const feed = sheet(
    "Latest operations",
    "Newest first",
    `<ul class="c-feed">${ops
      .slice(0, 10)
      .map((o) => `<li><button type="button" class="c-linkish" data-account="${esc(o.accountKey)}">${esc(o.accountKey)}</button><span>${esc(o.kind)}</span>${chip(`${o.state}, ${ago(o.at, now)}`, o.state === "confirmed" ? "good" : o.state === "failed" ? "bad" : "dim")}</li>`)
      .join("")}</ul>`,
  );
  return view("engine", "Engine", head("Engine", "/ops/engine", m) + figs + perDay + `<div class="c-grid two">${why}${feed}</div>` + drawers(m, now));
}

export function costsView(m: ConsoleModel, now: Date): SectionView {
  const r = m.relayer;
  const rpc = m.operator?.rpc ?? [];
  const last24 = rpc.slice(-24).reduce((a, h) => a + h.cu, 0);
  const runway = r?.runway ?? null;
  const meter = runway != null ? `<span class="c-meter ${runway < 3 ? "bad" : runway < 10 ? "warn" : ""}"><i style="width:${Math.min(100, (runway / 20) * 100).toFixed(0)}%"></i></span>` : "";
  const figs = `<div class="c-figs">
${fig("Relayer balance", r ? money(r.usd) : "n/a", r ? `${r.eth.toFixed(4)} ETH, funds ${runway ?? "?"} more accounts` : "not read", meter)}
${fig("Cost of a new account", money(r?.costPerAccountUsd ?? null), "Safe deploy, activation and gas reserve")}
${fig("RPC, last 24 h", rpc.length ? `${Math.round(last24 / 1000)}K CU` : "n/a", rpc.length ? `${(last24 / 24 / 1000).toFixed(1)}K CU per hour on average` : "operator metrics not connected")}
${fig("Fee revenue to date", money(m.totals.fees * 0.1), "10% of the yield, projected")}
</div>`;
  const rpcSheet = rpc.length
    ? sheet(
        "RPC compute units per hour",
        "Last 48 hours, as the operator counts them",
        chart(
          { t: "line", points: rpc.map((h) => ({ l: new Date(h.hour).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }), y: h.cu })), fmt: "k", color: "umber", threshold: { y: 40000, label: "Alert threshold, 40K per hour" } },
          "RPC compute units per hour",
          () => rpc.map((h) => [h.hour, int(h.cu)]),
          190,
        ),
      )
    : sheet("RPC compute units per hour", null, `<p class="c-empty">Appears once the app Worker stores the operator metrics (migration 0013).</p>`);
  const apr = m.totals.apr != null ? m.totals.apr / 100 : null;
  const monthly = 60;
  const need = apr && apr > 0 ? (monthly * 12) / (apr * 0.1) : null;
  const be = sheet(
    "Break-even",
    "Capital Mamoru must manage for a 10% fee on the yield to cover a fixed monthly cost",
    need
      ? `<p class="c-prose">At the current fee APR of <b>${esc(pct((apr ?? 0) * 100))}</b> and <b>$60</b> a month of fixed costs, the fee covers costs from <b>${esc(money(need))}</b> under management. Today: <b>${esc(money(m.totals.lp))}</b>.</p><span class="c-meter"><i style="width:${Math.max(0.8, (m.totals.lp / need) * 100).toFixed(2)}%"></i></span>`
      : `<p class="c-empty">Needs a fee APR, which needs capital placed and a first entry reported by the engine.</p>`,
  );
  const topup = `<p class="c-prose"><a href="/ops/infra">Top up the relayer, and see what one new account costs</a></p>`;
  return view("costs", "Costs", head("Costs", "/ops/costs", m) + figs + rpcSheet + `<div class="c-grid two">${be}${sheet("Relayer", r?.address ? r.address.slice(0, 6) + "…" + r.address.slice(-4) + " on Base" : null, topup)}</div>` + drawers(m, now));
}

/** The phone's "More" tab: everything that is not one of the five views, grouped as on the rail. */
export function moreView(sections: readonly { id: string; label: string; href: string; group?: string; out?: boolean }[]): SectionView {
  const groups = new Map<string, typeof sections[number][]>();
  for (const s of sections) if (s.group) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const html = [...groups.entries()]
    .map(([g, items]) => sheet(g, null, `<ul class="c-feed">${items.map((i) => `<li><a href="${esc(i.href)}"${i.out ? ' target="_blank" rel="noopener" data-ops-full' : ` data-section="${esc(i.id)}"`}>${esc(i.label)}</a><span></span><span></span></li>`).join("")}</ul>`))
    .join("");
  return view("more", "More", `<header class="c-head"><h1 tabindex="-1">More</h1></header>${html}`);
}
