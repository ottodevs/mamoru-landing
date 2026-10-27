// otto/mamoru-astro#24: the console's five views as server-rendered sections (SectionView), in Mamoru's own style:
// washi paper, ink, one emerald accent, Noto Serif figures and IBM Plex Mono labels. Charts ship their data as a
// `data-c` attribute and are drawn by the console client at the container's real width (console-client.ts);
// without script every chart still has its figures in a <details> table.
import { type ConsoleEnv, type ConsoleModel, type AccountYield, type AccountCap, capNow, money, pct, poolLabel } from "./console-data";
import { capSourceWords, DEFAULT_CAP_USDC, usdc } from "./account-cap-model";
import { csrfField, maskEmail, type SectionId, type SectionView } from "./ops";
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

// ---- authorization and cap per account (otto/mamoru-astro#25) ----

/** What the confirm screen shows and re-submits when a cap is raised. */
export type CapConfirm = { key: string; env: string; capUsdc: number | null; reason: string; base: number; token: string; lines: string[]; from: number | null; to: number | null };

/** Options of the Accounts view: the session's CSRF token turns the cap form on. */
export type AccountsOpts = { csrf?: string; confirm?: CapConfirm };

const HOLD_WORDS: Record<string, string> = {
  SESSION_EXPIRED: "approval expired",
  SESSION_RENEWAL_DUE: "renewal due",
  SESSION_MISSING: "grants missing",
  SESSION_USAGE_SPENT: "allowance used up",
};
const holdWords = (h: string) => HOLD_WORDS[h] ?? h.toLowerCase().replace(/_/g, " ");

/** The approval's state in one chip, or null before the operator reports approvals at all. */
function authChip(m: ConsoleModel, c: AccountCap | undefined): string {
  if (!m.caps.reported) return "";
  const a = c?.authorization;
  if (!a) return m.caps.complete ? chip("No approval") : "";
  if (a.deactivated) return chip("Stopped", "bad");
  if (a.holds.includes("SESSION_EXPIRED")) return chip("Approval expired", "bad");
  if (a.holds.length) return chip(holdWords(a.holds[0]!), "warn");
  return a.active === true ? chip("Approved", "good") : a.active === false ? chip("Not active") : chip("State not reported");
}

function untilWords(iso: string, now: Date): string {
  const days = (new Date(iso).getTime() - now.getTime()) / 864e5;
  const when = dayLabel(iso);
  if (days < 0) return `${when}, ended ${Math.max(1, Math.round(-days))} day${Math.round(-days) === 1 ? "" : "s"} ago`;
  if (days < 1) return `${when}, ends within a day`;
  return `${when}, ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} left`;
}

function grantName(g: string): string {
  const [kind = g] = g.split(":");
  return kind.replace(/-/g, " ");
}

/** Pools the approval names, each with the grants on it and how much of each grant's allowance is used. */
function poolsWithGrants(a: NonNullable<AccountCap["authorization"]>): string {
  const poolOf = (g: string) => {
    const rest = g.split(":").slice(1).join(":");
    return rest.startsWith("pool:") ? rest : null;
  };
  const pools = [...new Set([...a.pools, ...a.grants.map((g) => poolOf(g.grant)).filter((p): p is string => !!p)])];
  const grantRow = (g: { grant: string; usedBps: number }) => {
    const used = Math.max(0, Math.min(100, g.usedBps / 100));
    return `<li><span>${esc(grantName(g.grant))}</span><span class="c-meter${used >= 90 ? " bad" : used >= 60 ? " warn" : ""}"><i style="width:${used.toFixed(1)}%"></i></span><span class="n">${esc(pct(used, 0))} used</span></li>`;
  };
  const blocks = pools.map((p) => {
    const n = poolLabel(p);
    const gs = a.grants.filter((g) => poolOf(g.grant) === p);
    return `<li class="c-pos"><div><b>${esc(n.pair)}</b><span>${esc(n.fee)} fee tier</span></div>${gs.length ? `<ul class="c-grants">${gs.map(grantRow).join("")}</ul>` : `<span class="dim">no grant reported</span>`}</li>`;
  });
  const loose = a.grants.filter((g) => !poolOf(g.grant));
  if (loose.length) blocks.push(`<li class="c-pos"><div><b>Other grants</b><span>not tied to one pool</span></div><ul class="c-grants">${loose.map(grantRow).join("")}</ul></li>`);
  return blocks.length ? `<ul class="c-poslist">${blocks.join("")}</ul>` : `<p class="c-empty">The approval names no pool.</p>`;
}

/** The plain lines under the cap: what was asked, what runs, why they differ. */
function capLines(m: ConsoleModel, c: AccountCap): string[] {
  const out: string[] = [];
  const a = c.authorization;
  const o = c.override;
  const asked = o ? `${o.capUsdc == null ? "Back to the general cap" : `Its own cap of ${usdc(o.capUsdc)}`}, set by ${maskEmail(o.author)} on ${timeLabel(o.createdAt)}: ${o.reason}` : null;
  if (asked) out.push(asked);
  if (!a) return out;
  const reportedAfter = m.operator && o ? m.operator.generatedAt >= o.createdAt : false;
  if (o && o.capUsdc != null && (a.capSource !== "override" || a.capUsdc !== o.capUsdc)) {
    if (!reportedAfter) out.push(`Not picked up yet: the engine has not reported since. It still runs ${a.capUsdc != null ? usdc(a.capUsdc) : "an unknown cap"}.`);
    else if (a.capSource === "default" && o.capUsdc > DEFAULT_CAP_USDC)
      out.push(`Asked for ${usdc(o.capUsdc)}, but the engine keeps the code default of ${a.capUsdc != null ? usdc(a.capUsdc) : usdc(DEFAULT_CAP_USDC)}: a cap above ${DEFAULT_CAP_USDC} needs depth sizing and a target-weights policy on this account.`);
    else out.push(`Asked for ${usdc(o.capUsdc)}, but the engine runs ${a.capUsdc != null ? usdc(a.capUsdc) : "an unknown cap"} (${a.capSource ? capSourceWords(a.capSource) : "source not reported"}).`);
  }
  if (o && o.capUsdc == null && a.capSource === "override") out.push(reportedAfter ? "The engine still reports its own cap." : "Not picked up yet: the engine has not reported since.");
  if (a.capUsdc != null && a.signedCapUsdc != null && a.capUsdc > a.signedCapUsdc)
    out.push(`The approval it holds was signed for ${usdc(a.signedCapUsdc)}. The ${usdc(a.capUsdc)} cap applies to approvals signed from now on, at the next renewal.`);
  return out;
}

function capForms(m: ConsoleModel, c: AccountCap, csrf: string): string {
  if (!m.caps.table) return `<p class="c-empty">An own cap can be set here once the account caps table exists on this database (ottodevs/mamoru#109).</p>`;
  const action = `/ops/accounts/cap${m.env === "all" ? "?env=all" : ""}`;
  const base = c.override?.id ?? 0;
  const hidden = (act: string) => `${csrfField(csrf)}<input type="hidden" name="key" value="${esc(c.key)}" /><input type="hidden" name="base" value="${base}" /><input type="hidden" name="action" value="${act}" />`;
  const id = esc(c.key);
  const set = `<form method="post" action="${action}" class="c-capform" data-ops-form data-ops-no-retry>${hidden("set")}
<label for="cap-${id}">Authorize up to</label><span class="c-capin"><input id="cap-${id}" name="cap" inputmode="numeric" autocomplete="off" required maxlength="9" placeholder="e.g. 2,000" /> USDC</span>
<label for="cap-why-${id}">Why</label><input id="cap-why-${id}" name="reason" required maxlength="500" autocomplete="off" placeholder="what this test needs" />
<button type="submit">Apply</button></form>`;
  const back = c.override && c.override.capUsdc != null
    ? `<form method="post" action="${action}" class="c-capform back" data-ops-form data-ops-no-retry>${hidden("clear")}
<label for="cap-back-${id}">Why</label><input id="cap-back-${id}" name="reason" required maxlength="500" autocomplete="off" placeholder="test finished" />
<button type="submit" class="quiet">Back to the general cap${c.general ? ` (${esc(usdc(c.general.capUsdc))})` : ""}</button></form>`
    : "";
  return `${set}${back}<p class="c-foot">Whole USDC from 1 to 1,000,000. Raising it asks again before it writes. The operator picks a change up on its next settings poll, and it only affects approvals signed after it.</p>`;
}

/** The Authorization block of one account's drawer. */
function authorizationSheet(m: ConsoleModel, c: AccountCap | undefined, now: Date, csrf: string | undefined): string {
  if (!c) return sheet("Authorization", null, `<p class="c-empty">Not reported yet.</p>`);
  const a = c.authorization;
  const general = c.general
    ? `General cap for ${c.env}: ${usdc(c.general.capUsdc)}, settings version ${c.general.version}${c.general.canary ? " (canary)" : ""}${c.general.depth ? ", with depth sizing" : ", without depth sizing"}.`
    : "General cap: not read (no engine settings in effect for this environment).";
  const lines = capLines(m, c);
  const linesHtml = lines.length ? `<ul class="c-caplines">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
  const form = csrf ? capForms(m, c, csrf) : `<p class="c-foot">To change this account's cap, open it from <a href="/ops/accounts${m.env === "all" ? "?env=all" : ""}">Accounts</a>.</p>`;
  if (!a) {
    const why = m.caps.reported && m.caps.complete ? "The engine reports no approval for this account." : "Not reported yet: the engine's approvals show here once it reports them (ottodevs/mamoru#109).";
    return sheet("Authorization", null, `<p class="c-empty">${esc(why)}</p>${linesHtml}<p class="c-foot">${esc(general)}</p>${form}`);
  }
  const state = [authChip(m, c), ...a.holds.slice(1).map((h) => chip(holdWords(h), "warn")), a.deactivated ? chip(`code ${a.deactivated}`, "bad") : ""].join(" ");
  const figs = `<div class="c-figs two">${fig("Cap in effect", a.capUsdc != null ? usdc(a.capUsdc) : "n/a", a.capSource ? capSourceWords(a.capSource) : "source not reported")}${fig("Signed for", a.signedCapUsdc != null ? usdc(a.signedCapUsdc) : "n/a", "the approval it holds now")}</div>`;
  const policy = `${a.policyId ?? "policy not reported"}${a.policyVersion ? `, version ${a.policyVersion}` : ""}`;
  const meta = `<dl class="c-dl"><dt>Policy</dt><dd>${esc(policy)}</dd><dt>Valid until</dt><dd>${esc(a.validUntil ? untilWords(a.validUntil, now) : "no grant held")}</dd><dt>State</dt><dd>${state}</dd></dl>`;
  return sheet("Authorization", m.operator ? `As the engine reported it ${ago(m.operator.generatedAt, now)}` : null, `${figs}${linesHtml}${meta}${poolsWithGrants(a)}<p class="c-foot">${esc(general)}</p>${form}`);
}

/** Accounts with a cap of their own (the newest row is not a removal), for the Accounts view. */
function ownCapsSheet(m: ConsoleModel, drawerKeys: Set<string>): string {
  if (!m.caps.table) return sheet("Accounts with their own cap", null, `<p class="c-empty">Not set up yet: the account caps table is not on this database (ottodevs/mamoru#109).</p>`);
  const own = [...m.caps.byKey.values()].filter((c) => c.override && c.override.capUsdc != null).sort((x, y) => y.override!.id - x.override!.id);
  if (!own.length) return sheet("Accounts with their own cap", null, `<p class="c-empty">None. Every account runs the general cap of its environment.</p>`);
  const row = (c: AccountCap) => {
    const o = c.override!;
    const a = c.authorization;
    const running = a?.capUsdc != null ? `${usdc(a.capUsdc)}, ${a.capSource ? capSourceWords(a.capSource) : "source not reported"}` : a ? "cap not reported" : m.caps.reported && m.caps.complete ? "no approval reported" : "not reported yet";
    const keyHtml = drawerKeys.has(c.key) ? `<button type="button" class="c-linkish" data-account="${esc(c.key)}">${esc(c.key)}</button>` : `<span class="c-mono">${esc(c.key)}</span>`;
    return `<li>${keyHtml}<div><b>${esc(usdc(o.capUsdc!))} asked</b><span>${esc(`runs ${running}`)}${c.env !== "prod" ? ` · ${esc(c.env)}` : ""}</span><span>${esc(`${maskEmail(o.author)}, ${timeLabel(o.createdAt)}`)}</span></div>${!a && m.caps.reported && m.caps.complete ? chip("No approval") : a?.capUsdc == null ? chip("Not reported") : a.capSource === "override" && a.capUsdc === o.capUsdc ? chip("In effect", "good") : chip("Not in effect", "warn")}</li>`;
  };
  return sheet("Accounts with their own cap", `${own.length} account${own.length === 1 ? "" : "s"} above or below the general cap`, `<ul class="c-feed c-owncaps">${own.map(row).join("")}</ul>`);
}

/** The confirm screen for a raise: what changes, and the same fields again with the token. */
function capConfirmSheet(m: ConsoleModel, c: CapConfirm, csrf: string): string {
  const action = `/ops/accounts/cap${m.env === "all" ? "?env=all" : ""}`;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}" />`;
  const what = c.capUsdc == null ? "back to the general cap" : `up to ${usdc(c.capUsdc)}`;
  return `<section class="c-sheet c-confirm" aria-labelledby="cap-confirm"><header class="c-sheet-h"><h2 id="cap-confirm">Confirm: authorize ${esc(c.key)} ${esc(what)}</h2><p>${esc(`It runs ${c.from != null ? usdc(c.from) : "an unknown cap"} now; this allows ${c.to != null ? usdc(c.to) : "an unknown cap"}.`)}</p></header>
<ul class="c-caplines">${c.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<form method="post" action="${action}" data-ops-form data-ops-no-retry>${csrfField(csrf)}${hidden("key", c.key)}${hidden("action", c.capUsdc == null ? "clear" : "set")}${c.capUsdc == null ? "" : hidden("cap", String(c.capUsdc))}${hidden("reason", c.reason)}${hidden("base", String(c.base))}${hidden("confirm_token", c.token)}
<button type="submit">Yes, authorize ${esc(what)}</button> <a href="/ops/accounts${m.env === "all" ? "?env=all" : ""}">Cancel</a></form></section>`;
}

/** One hidden template per account: the drawer the client opens from any view. */
function drawers(m: ConsoleModel, now: Date, csrf?: string): string {
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
${authorizationSheet(m, m.caps.byKey.get(a.key.toLowerCase()), now, csrf)}
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

export function accountsView(m: ConsoleModel, now: Date, opts: AccountsOpts = {}): SectionView {
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
          const cap = m.caps.byKey.get(a.key.toLowerCase());
          const own = cap?.override?.capUsdc != null ? chip(`Own cap ${cap.override.capUsdc.toLocaleString("en-US")}`, "em") : "";
          return `<li><button type="button" class="c-lb-row compact" data-account="${esc(a.key)}"><span class="c-mono">${esc(a.key)}</span><span class="c-chips">${state}${authChip(m, cap)}${own}</span><span class="n">${esc(money(a.total))}</span><span class="n wide">${esc(ago(a.readAt, now))}</span></button></li>`;
        })
        .join("")}</ul>${folded ? `<p class="c-foot">${folded} more Safe${folded === 1 ? "" : "s"} with nothing deposited yet.</p>` : ""}`
    : `<p class="c-empty">No account has been read yet.</p>`;
  return view(
    "accounts",
    "Accounts",
    head("Accounts", "/ops/accounts", m) +
      (opts.confirm && opts.csrf ? capConfirmSheet(m, opts.confirm, opts.csrf) : "") +
      `<div class="c-grid two">${sheet("Where every account stands", `${int(l.total)} accounts`, stand)}${sheet("From sign-up to earning", "Conversion so far", funnel)}</div>` +
      `<div class="c-grid hero">${sheet("Sign-ups per day", "Since launch", signupChart(m, 170))}${sheet("Accounts with money in", "Every Safe the ledger reads that holds funds", list)}</div>` +
      ownCapsSheet(m, new Set(m.accounts.map((a) => a.key))) +
      drawers(m, now, opts.csrf),
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
