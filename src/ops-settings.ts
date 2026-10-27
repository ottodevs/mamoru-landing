/**
 * Renders /ops/engine/settings (spec 006, otto/mamoru#147; redesign otto/mamoru-astro#22): what each environment runs, said
 * in sentences; a form that starts from what runs, one group per decision, every value in the unit a person thinks
 * in (percent, whole USDC, times its gas) on a scale that shows its bounds, the recommended value and what runs now;
 * a confirm step with Now and After for risky changes; and the append-only history as a list of what each version
 * changed. Pure string building; the worker does the D1 reads and writes. The `settings` module of the console script
 * only marks what changed as it is typed: without JavaScript the form works the same.
 */

import { BOUNDS, DEFAULT_CAP_USDC, DEFAULT_SETTINGS, RECOMMENDED_SETTINGS, pctOf, usdcOf, type EngineSettings } from "./engine-settings-model";
import type { Env, InEffect, TemplateRow, VersionRow } from "./engine-settings-store";
import { csrfField, maskEmail, noticeHtml, pageHead, type SectionView } from "./ops";
import { esc } from "./text";

export const RECOMMENDED_TEMPLATE = "recommended";

const pct = (bps: number) => `${pctOf(bps)}%`;
const usdc = (n: number) => `${usdcOf(n)} USDC`;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
const ENVS = ["prod", "beta"] as const;

// ---- the same set, said four ways: a sentence each, a short value each ----

const capOf = (s: EngineSettings) => s.capUsdc ?? DEFAULT_CAP_USDC;

/** One sentence per decision, for the "in effect" block. */
function sentences(s: EngineSettings): Array<[string, string]> {
  const d = s.depth;
  return [
    ["Cap", `Each account puts up to ${usdc(capOf(s))} to work${s.capUsdc === null ? " (the code default)" : ""}.`],
    [
      "Depth",
      d
        ? `An entry never moves a pool's price more than ${pct(d.impactBps)} (stables ${pct(d.stablesImpactBps ?? d.impactBps)}) or takes more than ${pct(d.shareBps)} of it.`
        : "Off: entries are not sized to the pool they go into.",
    ],
    ["Smallest entry", s.minEntry ? `At least ${s.minEntry.gasMultiple} times what its swap and mint cost in gas, and never under 0.10 USDC.` : "0.10 USDC, whatever the gas."],
    [
      "Fall guard",
      s.guard.enabled
        ? `No new money into BTC after a ${pct(s.guard.btc.fallBps)} fall in 24 h at ${pct(s.guard.btc.volBps)} volatility, or into ETH after ${pct(s.guard.eth.fallBps)} at ${pct(s.guard.eth.volBps)}.`
        : "Off: entries go on while prices fall.",
    ],
  ];
}

/** Short values, for diffs and history. */
function shorts(s: EngineSettings): Array<[string, string]> {
  const d = s.depth;
  return [
    ["Cap", s.capUsdc === null ? `${usdc(DEFAULT_CAP_USDC)} (default)` : usdc(s.capUsdc)],
    ["Depth", d ? `${pct(d.impactBps)} impact, ${pct(d.shareBps)} of a pool, stables ${pct(d.stablesImpactBps ?? d.impactBps)}` : "off"],
    ["Smallest entry", s.minEntry ? `${s.minEntry.gasMultiple}× its gas` : "0.10 USDC"],
    ["Fall guard", s.guard.enabled ? `BTC ${pct(s.guard.btc.fallBps)} at ${pct(s.guard.btc.volBps)} vol, ETH ${pct(s.guard.eth.fallBps)} at ${pct(s.guard.eth.volBps)}` : "off"],
  ];
}

/** One line a person reads: what this set makes the engine do. */
export function describeSettings(s: EngineSettings): string {
  return shorts(s).map(([k, v]) => `${k} ${v}`).join("; ") + ".";
}

/** What changes between two sets, as [what, before, after]. */
export function changesOf(from: EngineSettings, to: EngineSettings): Array<[string, string, string]> {
  const a = shorts(from);
  const b = shorts(to);
  return a.flatMap(([k, v], i) => (v === b[i]![1] ? [] : [[k, v, b[i]![1]] as [string, string, string]]));
}

// ---- in effect ----

function envNow(env: Env, inEffect: InEffect): string {
  const v = inEffect.wide;
  const s = v?.settings ?? DEFAULT_SETTINGS;
  const lines = sentences(s)
    .map(([k, line]) => `<div class="set-say"><dt>${esc(k)}</dt><dd>${esc(line)}</dd></div>`)
    .join("");
  const version = v
    ? `<p class="set-ver">v${v.id} · ${esc(v.template)}<br>${esc(maskEmail(v.author))}, ${esc(when(v.createdAt))}</p>`
    : `<p class="set-ver">No version written: the code defaults.</p>`;
  // One canary at most is live per environment: the newest, if newer than the environment-wide version.
  const c = inEffect.canary;
  const canary = c
    ? `<p class="set-canary">Canary v${c.id} · ${esc(c.template)} on ${c.accountKeys!.length} account${c.accountKeys!.length === 1 ? "" : "s"}: ${esc(changesOf(s, c.settings).map(([k, , after]) => `${k} ${after}`).join("; ") || "same as the rest")}.</p>`
    : "";
  return `<div class="set-env">
    <h3><a href="/ops/engine/settings?env=${env}">${env}</a></h3>
    <dl>${lines}</dl>
    ${canary}${version}
  </div>`;
}

function activeBlock(active: Record<Env, InEffect>): string {
  return `<section class="sec set-now" aria-labelledby="set-active">
  <div class="sec-head"><h2 id="set-active">What runs now</h2><p class="asof">The operator reads this every minute and applies it on each engine's next review.</p></div>
  <div class="set-envs">${ENVS.map((env) => envNow(env, active[env])).join("")}</div>
  </section>`;
}

// ---- the form ----

type Scale = { min: number; max: number; rec: number; now: number | null };

/** Where a value sits on a field's scale, 0 to 100, on a log axis: the bounds span three or more orders of magnitude. */
export function scalePos(v: number, min: number, max: number): number {
  if (!(v > 0)) return 0;
  const p = ((Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))) * 100;
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
}

function scale(sc: Scale, value: number | null, fmt: (n: number) => string): string {
  const at = (n: number) => `left:${scalePos(n, sc.min, sc.max)}%`;
  const now = sc.now === null ? "" : `<span class="set-mk now" style="${at(sc.now)}" title="Now ${esc(fmt(sc.now))}"></span>`;
  return `<span class="set-scale" data-min="${sc.min}" data-max="${sc.max}" aria-hidden="true">
    <span class="set-track"></span>
    <span class="set-mk rec" style="${at(sc.rec)}" title="Recommended ${esc(fmt(sc.rec))}"></span>${now}
    <span class="set-mk val" style="${value === null ? "display:none" : at(value)}"></span>
    <span class="set-end lo">${esc(fmt(sc.min))}</span><span class="set-end hi">${esc(fmt(sc.max))}</span>
  </span>`;
}

type Field = {
  name: string;
  label: string;
  unit: string;
  /** As typed: "0.3", "1,000". */
  value: string;
  /** The same number the scale uses, or null when blank. */
  num: number | null;
  /** What runs now, as typed; "" when blank or off. The script compares the field against it. */
  now: string;
  nowText: string;
  recText: string;
  sc: Scale;
  fmt: (n: number) => string;
  kind: "pct" | "usdc" | "int";
  placeholder?: string;
  note?: string;
};

function field(f: Field): string {
  const changed = f.value.replace(/[\s,']/g, "") !== f.now.replace(/[\s,']/g, "");
  return `<div class="set-fld${changed ? " changed" : ""}" data-now="${esc(f.now)}" data-kind="${f.kind}">
    <label for="f-${f.name}">${esc(f.label)}</label>
    <span class="set-in"><input id="f-${f.name}" name="${f.name}" inputmode="${f.kind === "pct" ? "decimal" : "numeric"}" autocomplete="off" spellcheck="false" value="${esc(f.value)}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""} aria-describedby="h-${f.name}" /><span class="unit">${esc(f.unit)}</span></span>
    ${scale(f.sc, f.num, f.fmt)}
    <span class="set-hint" id="h-${f.name}"><span class="k-rec">Recommended ${esc(f.recText)}</span><span class="k-now">Now ${esc(f.nowText)}</span>${f.note ? `<span>${esc(f.note)}</span>` : ""}</span>
  </div>`;
}

/** A percent field over basis points. */
function pctField(name: string, label: string, unit: string, bps: number | null, b: { min: number; max: number }, rec: number, now: number | null, placeholder?: string, nowText?: string): string {
  return field({
    name,
    label,
    unit,
    value: bps === null ? "" : pctOf(bps),
    num: bps === null ? null : bps / 100,
    now: now === null ? "" : pctOf(now),
    nowText: nowText ?? (now === null ? "off" : pct(now)),
    recText: pct(rec),
    sc: { min: b.min / 100, max: b.max / 100, rec: rec / 100, now: now === null ? null : now / 100 },
    fmt: (n) => `${n}%`,
    kind: "pct",
    ...(placeholder ? { placeholder } : {}),
  });
}

function toggle(name: string, on: boolean, nowOn: boolean, what: string): string {
  return `<label class="set-tgl" data-now="${nowOn ? "1" : "0"}"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""} /><span class="set-sw" aria-hidden="true"></span><span class="when-on">On</span><span class="when-off">Off</span><span class="sr-only"> ${esc(what)}</span></label>`;
}

function group(id: string, n: number, title: string, explain: string, body: string, tgl = ""): string {
  return `<fieldset class="set-grp${tgl ? " has-tgl" : ""}" aria-labelledby="g-${id}">
    <div class="set-grp-head"><p class="set-n">${n}</p><h3 id="g-${id}">${esc(title)}</h3>${tgl}<p class="soft">${explain}</p></div>
    <div class="set-grp-body">${body}</div>
  </fieldset>`;
}

type Draft = { env: Env; template: string; settings: EngineSettings; canary: string; reason: string };

function presets(templates: readonly TemplateRow[], draft: Draft, running: VersionRow | null): string {
  const link = (label: string, sub: string, href: string, current: boolean) =>
    `<a class="set-pre" href="${esc(href)}"${current ? ' aria-current="true"' : ""}><b>${esc(label)}</b><span>${esc(sub)}</span></a>`;
  const base = `/ops/engine/settings?env=${draft.env}`;
  const items = [
    link("What runs now", running ? `v${running.id}, ${running.template}` : "code defaults", base, !!running && draft.template === running.template && draft.reason === ""),
    ...templates.map((t) =>
      link(t.name === RECOMMENDED_TEMPLATE ? "Recommended" : t.name, t.name === RECOMMENDED_TEMPLATE ? describeSettings(t.settings) : t.source === "lab" ? "from the Lab" : t.note ?? "template", `${base}&template=${encodeURIComponent(t.name)}`, t.name === draft.template && (!running || running.template !== t.name)),
    ),
  ];
  return `<nav class="set-pres" aria-label="Start from">${items.join("")}</nav>`;
}

function editForm(csrf: string, templates: readonly TemplateRow[], draft: Draft, runningRow: VersionRow | null): string {
  const s = draft.settings;
  const running = runningRow?.settings ?? DEFAULT_SETTINGS;
  const r = RECOMMENDED_SETTINGS;
  const envLinks = ENVS.map((e) => `<a href="/ops/engine/settings?env=${e}"${e === draft.env ? ' aria-current="page"' : ""}>${e}</a>`).join("");

  const cap = group(
    "cap",
    1,
    "Cap per account",
    `The most USDC one account puts to work; anything above it waits as USDC. Above ${DEFAULT_CAP_USDC} needs depth sizing on.`,
    `<div class="set-grid one">${field({
      name: "cap",
      label: "Cap",
      unit: "USDC",
      value: s.capUsdc === null ? "" : usdcOf(s.capUsdc),
      num: s.capUsdc,
      now: running.capUsdc === null ? "" : usdcOf(running.capUsdc),
      nowText: running.capUsdc === null ? `${usdcOf(DEFAULT_CAP_USDC)} (default)` : usdc(running.capUsdc),
      recText: usdc(r.capUsdc!),
      sc: { min: BOUNDS.capUsdc.min, max: BOUNDS.capUsdc.max, rec: r.capUsdc!, now: running.capUsdc ?? DEFAULT_CAP_USDC },
      fmt: (n) => usdcOf(n),
      kind: "usdc",
      placeholder: `${DEFAULT_CAP_USDC} (default)`,
    })}</div>
    <p class="set-eg" data-eg="cap">${esc(capExample(capOf(s)))}</p>`,
  );

  // With depth off the fields keep the recommended thresholds, ready for the moment it is switched on.
  const depthOn = s.depth !== null;
  const d = s.depth ?? r.depth!;
  const rd = running.depth;
  const depth = group(
    "depth",
    2,
    "Depth sizing",
    "Sizes each entry to the pool it goes into, so one deposit never moves the price or crowds a pool more than this.",
    `<div class="set-grid">
      ${pctField("depth_impact_pct", "Max price impact", "%", d.impactBps, BOUNDS.impactBps, r.depth!.impactBps, rd ? rd.impactBps : null)}
      ${pctField("depth_share_pct", "Max share of a pool", "%", d.shareBps, BOUNDS.shareBps, r.depth!.shareBps, rd ? rd.shareBps : null)}
      ${pctField("depth_stables_pct", "Max impact, stables pool", "%", d.stablesImpactBps ?? null, BOUNDS.stablesImpactBps, r.depth!.stablesImpactBps!, rd?.stablesImpactBps ?? null, "same as price impact", !rd ? "off" : rd.stablesImpactBps === undefined ? `${pct(rd.impactBps)} (same as price impact)` : undefined)}
    </div>`,
    toggle("depth_on", depthOn, rd !== null, "depth sizing"),
  );

  const minOn = s.minEntry !== undefined;
  const k = s.minEntry?.gasMultiple ?? r.minEntry!.gasMultiple;
  const rk = running.minEntry?.gasMultiple ?? null;
  const minEntry = group(
    "min",
    3,
    "Smallest entry",
    "An entry that would spend too much of itself on gas waits as USDC instead. Off, anything from 0.10 USDC goes in.",
    `<div class="set-grid one">${field({
      name: "min_entry_gas",
      label: "At least",
      unit: "× its gas",
      value: String(k),
      num: k,
      now: rk === null ? "" : String(rk),
      nowText: rk === null ? "off" : `${rk}×`,
      recText: `${r.minEntry!.gasMultiple}×`,
      sc: { min: BOUNDS.gasMultiple.min, max: BOUNDS.gasMultiple.max, rec: r.minEntry!.gasMultiple, now: rk },
      fmt: (n) => `${n}×`,
      kind: "int",
    })}</div>
    <p class="set-eg">${esc(`At ${k}×, an entry whose swap and mint cost 0.02 USDC in gas needs at least ${(Math.max(0.1, k * 0.02)).toFixed(2)} USDC.`)}</p>`,
    toggle("min_entry_on", minOn, rk !== null, "smallest entry by gas"),
  );

  const g = s.guard;
  const rg = running.guard;
  const guard = group(
    "guard",
    4,
    "Fall guard",
    "Pauses new money into BTC or ETH while it falls this much in 24 h with volatility above this. Money already placed stays.",
    `<div class="set-grid two">
      ${pctField("btc_fall_pct", "BTC 24 h fall", "%", g.btc.fallBps, BOUNDS.fallBps, r.guard.btc.fallBps, rg.btc.fallBps)}
      ${pctField("btc_vol_pct", "BTC volatility", "% a year", g.btc.volBps, BOUNDS.volBps, r.guard.btc.volBps, rg.btc.volBps)}
      ${pctField("eth_fall_pct", "ETH 24 h fall", "%", g.eth.fallBps, BOUNDS.fallBps, r.guard.eth.fallBps, rg.eth.fallBps)}
      ${pctField("eth_vol_pct", "ETH volatility", "% a year", g.eth.volBps, BOUNDS.volBps, r.guard.eth.volBps, rg.eth.volBps)}
    </div>`,
    toggle("guard_on", g.enabled, rg.enabled, "fall guard"),
  );

  const n = changesOf(running, s).length;
  return `<section class="sec set-edit" aria-labelledby="set-edit">
  <div class="sec-head"><h2 id="set-edit">Change ${draft.env}</h2><nav class="set-seg" aria-label="Environment">${envLinks}</nav></div>
  <p class="set-lead soft">Start from what runs, the recommended set or a template. Only what you change moves.</p>
  ${presets(templates, draft, runningRow)}
  <form method="post" action="/ops/engine/settings/apply" class="set-form" data-ops-form data-ops-no-retry data-env="${draft.env}">
    ${csrfField(csrf)}
    <input type="hidden" name="env" value="${draft.env}" />
    <input type="hidden" name="template" value="${esc(draft.template)}" />
    ${cap}${depth}${minEntry}${guard}
    <details class="set-more"${draft.canary ? " open" : ""}><summary>Try it on some accounts first (canary)</summary>
      <label for="f-canary">Account keys, one per line</label>
      <textarea id="f-canary" name="canary" rows="3" spellcheck="false">${esc(draft.canary)}</textarea>
      <p class="set-hint">Empty: every account of ${draft.env}. One canary at a time; a new one replaces the previous.</p>
    </details>
    <div class="set-bar">
      <p class="set-count" id="set-count" aria-live="polite">${countText(n, draft.env)}</p>
      <div class="set-why"><label for="f-reason">Why</label><span class="set-in wide"><input id="f-reason" name="reason" required maxlength="500" autocomplete="off" value="${esc(draft.reason)}" placeholder="what this change is for" /></span></div>
      <button type="submit">Apply to ${draft.env}</button>
    </div>
    <p class="set-hint set-foot">The operator checks every bound again and refuses anything outside it. Settings never change what an account's approval allows.</p>
  </form></section>`;
}

const countText = (n: number, env: Env) => (n === 0 ? `Same as what runs on ${env}.` : `${n} change${n === 1 ? "" : "s"} from what runs on ${env}.`);

function capExample(cap: number): string {
  const dep = cap >= 5000 ? cap * 2 : 5000;
  return `An account that deposits ${usdcOf(dep)} USDC puts ${usdcOf(Math.min(cap, dep))} to work${dep > cap ? ` and keeps ${usdcOf(dep - cap)} as USDC` : ""}.`;
}

// ---- confirm ----

function hiddenFields(env: Env, template: string, s: EngineSettings, canary: string, reason: string): string {
  const h = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}" />`;
  return [
    h("env", env),
    h("template", template),
    h("depth_on", s.depth ? "1" : "0"),
    h("depth_impact_pct", s.depth ? pctOf(s.depth.impactBps) : ""),
    h("depth_share_pct", s.depth ? pctOf(s.depth.shareBps) : ""),
    h("depth_stables_pct", s.depth?.stablesImpactBps !== undefined ? pctOf(s.depth.stablesImpactBps) : ""),
    h("cap", s.capUsdc === null ? "" : String(s.capUsdc)),
    h("guard_on", s.guard.enabled ? "1" : "0"),
    h("btc_fall_pct", pctOf(s.guard.btc.fallBps)),
    h("btc_vol_pct", pctOf(s.guard.btc.volBps)),
    h("eth_fall_pct", pctOf(s.guard.eth.fallBps)),
    h("eth_vol_pct", pctOf(s.guard.eth.volBps)),
    h("min_entry_on", s.minEntry ? "1" : "0"),
    h("min_entry_gas", s.minEntry ? String(s.minEntry.gasMultiple) : ""),
    h("canary", canary),
    h("reason", reason),
  ].join("");
}

function diffTable(from: EngineSettings, to: EngineSettings): string {
  const rows = changesOf(from, to)
    .map(([what, a, b]) => `<tr><th scope="row">${esc(what)}</th><td class="dim">${esc(a)}</td><td>${esc(b)}</td></tr>`)
    .join("");
  return rows ? `<table class="ledger set-diff"><thead><tr><th></th><th>Now</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>` : "";
}

// ---- history ----

function historyBlock(csrf: string, versions: readonly VersionRow[]): string {
  if (!versions.length)
    return `<section class="sec" aria-labelledby="set-hist"><h2 id="set-hist">History</h2><p class="empty">No version written yet. The operator runs the code defaults.</p></section>`;
  // What each version changed against the one before it in the same place (env, and canary or not); the oldest
  // shown against the code defaults.
  const prevOf = (i: number): EngineSettings => {
    const v = versions[i]!;
    for (let j = i + 1; j < versions.length; j++) {
      const w = versions[j]!;
      if (w.env === v.env && !!w.accountKeys === !!v.accountKeys) return w.settings;
    }
    return DEFAULT_SETTINGS;
  };
  const items = versions
    .map((v, i) => {
      const ch = changesOf(prevOf(i), v.settings);
      const what = ch.length
        ? `<ul class="set-ch">${ch.map(([k, a, b]) => `<li>${esc(k)} <span class="dim">${esc(a)}</span> → ${esc(b)}</li>`).join("")}</ul>`
        : `<p class="set-ch dim">No change in values.</p>`;
      return `<li class="set-h">
        <p class="set-h-id">v${v.id}<span>${v.env}${v.accountKeys ? `, canary of ${v.accountKeys.length}` : ""}</span></p>
        <div class="set-h-body">
          <p class="set-h-why">${esc(v.reason)}</p>
          ${what}
          <p class="set-h-meta">${esc(v.template)}${v.rollbackOf ? `, rollback to v${v.rollbackOf}` : ""} · ${esc(maskEmail(v.author))}, ${esc(when(v.createdAt))}</p>
        </div>
        <details class="set-rb"><summary>Roll back to v${v.id}</summary><form method="post" action="/ops/engine/settings/rollback" data-ops-form data-ops-no-retry>${csrfField(csrf)}<input type="hidden" name="id" value="${v.id}" /><span class="set-in wide"><input name="reason" required maxlength="500" placeholder="why" aria-label="Why roll back to v${v.id}" /></span><button class="link" type="submit">Roll back</button></form></details>
      </li>`;
    })
    .join("");
  return `<section class="sec" aria-labelledby="set-hist"><div class="sec-head"><h2 id="set-hist">History</h2><p class="asof">Every change is a row. A rollback writes a new version that copies an older one.</p></div>
  <ol class="set-hist">${items}</ol></section>`;
}

export type SettingsPage = {
  versions: readonly VersionRow[] | null;
  active: Record<Env, InEffect>;
  templates: readonly TemplateRow[] | null;
  csrf: string;
  draft: Draft;
  notice?: { text: string; tone?: "plain" | "bad" };
  /** A risky change waiting for a second yes: the lines to show and the exact set to confirm. */
  confirm?: { risks: string[]; draft: Draft; token: string; rollbackOf?: number };
};

export function settingsSection(p: SettingsPage): SectionView {
  const head = pageHead({ title: "Engine settings" });
  if (p.versions === null || p.templates === null) {
    return {
      section: "settings",
      title: "Engine settings",
      html: `${head}${noticeHtml("Engine settings are not set up in D1 yet (migration 0011). The operator runs the code defaults.", { tone: "bad" })}`,
    };
  }
  const notice = p.notice ? noticeHtml(p.notice.text, { tone: p.notice.tone ?? "plain" }) : "";
  let confirm = "";
  if (p.confirm) {
    const c = p.confirm.draft;
    confirm = `<section class="sec set-confirm" aria-labelledby="set-confirm"><h2 id="set-confirm">Confirm this change</h2>
      <p>To ${esc(c.env)}${c.canary ? " (canary)" : ""}. What it allows:</p>
      <ul class="set-risks">${p.confirm.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      ${diffTable(p.active[c.env].wide?.settings ?? DEFAULT_SETTINGS, c.settings)}
      <form method="post" action="/ops/engine/settings/apply" class="set-go" data-ops-form data-ops-no-retry>${csrfField(p.csrf)}${hiddenFields(c.env, c.template, c.settings, c.canary, c.reason)}<input type="hidden" name="confirm_token" value="${esc(p.confirm.token)}" />${p.confirm.rollbackOf ? `<input type="hidden" name="rollback_of" value="${p.confirm.rollbackOf}" />` : ""}<button type="submit">Yes, apply it</button> <a href="/ops/engine/settings?env=${c.env}">Cancel</a></form></section>`;
  }
  return {
    section: "settings",
    title: "Engine settings",
    html: `${head}
    <p class="lede">How the engine places each deposit: how much per account, how big an entry may be against its pool, the smallest entry worth its gas, and when to stop buying into a fall.</p>
    ${notice}${confirm}
    ${activeBlock(p.active)}
    ${editForm(p.csrf, p.templates, p.draft, p.active[p.draft.env].wide)}
    ${historyBlock(p.csrf, p.versions)}`,
  };
}
