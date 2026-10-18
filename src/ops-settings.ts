/**
 * Renders /ops/settings (spec 006, otto/mamoru#147): the engine settings in effect per environment, a form to change
 * them, a confirm step for risky changes, and the append-only history with rollback. Pure string building; the worker
 * does the D1 reads and writes.
 *
 * The form starts from what runs (or the recommended set when nothing is written yet), so a change touches only the
 * fields a person edits. Every value is shown and typed in the unit a person thinks in: percent and whole USDC, never
 * basis points; settingsFromForm converts back.
 */

import { BOUNDS, DEFAULT_CAP_USDC, DEFAULT_SETTINGS, RECOMMENDED_SETTINGS, pctOf, usdcOf, type EngineSettings } from "./engine-settings-model";
import type { Env, InEffect, TemplateRow, VersionRow } from "./engine-settings-store";
import { csrfField, noticeHtml, pageHead, type SectionView } from "./ops";
import { esc } from "./text";

const pct = (bps: number) => `${pctOf(bps)}%`;
const usdc = (n: number) => `${usdcOf(n)} USDC`;
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
const ENVS = ["prod", "beta"] as const;

const capText = (s: EngineSettings) => (s.capUsdc === null ? `${usdc(DEFAULT_CAP_USDC)} (default)` : usdc(s.capUsdc));
const depthText = (s: EngineSettings) =>
  s.depth ? `${pct(s.depth.impactBps)} price impact, ${pct(s.depth.shareBps)} of a pool, stables ${pct(s.depth.stablesImpactBps ?? s.depth.impactBps)}` : "off";
const guardText = (s: EngineSettings) =>
  s.guard.enabled
    ? `BTC ${pct(s.guard.btc.fallBps)} fall at ${pct(s.guard.btc.volBps)} vol, ETH ${pct(s.guard.eth.fallBps)} at ${pct(s.guard.eth.volBps)}`
    : "off";

/** One line a person reads: what this set makes the engine do. */
export function describeSettings(s: EngineSettings): string {
  return `Cap ${capText(s)}; depth sizing ${depthText(s)}; fall guard ${guardText(s)}.`;
}

// ---- in effect ----

function nowRow(env: string, v: VersionRow | null, extra = ""): string {
  const s = v?.settings ?? DEFAULT_SETTINGS;
  const version = v
    ? `v${v.id} <span class="dim">${esc(v.template)}</span><br><span class="dim">${esc(v.author)}, ${esc(when(v.createdAt))}</span>`
    : `<span class="dim">none written: code defaults</span>`;
  return `<tr><th scope="row">${env}${extra}</th><td data-k="Cap">${esc(capText(s))}</td><td data-k="Depth">${esc(depthText(s))}</td><td data-k="Guard">${esc(guardText(s))}</td><td data-k="Version">${version}</td></tr>`;
}

function activeBlock(active: Record<Env, InEffect>): string {
  const rows = ENVS.map((env) => {
    const c = active[env].canary;
    // One canary at most is live per environment: the newest, if newer than the environment-wide version.
    const canary = c ? nowRow("", c, `<span class="dim">canary, ${c.accountKeys!.length} account${c.accountKeys!.length === 1 ? "" : "s"}</span>`) : "";
    return nowRow(env, active[env].wide) + canary;
  }).join("");
  return `<section class="sec" aria-labelledby="set-active"><h2 id="set-active">In effect</h2>
  <div class="exp-ledger-wrap"><table class="ledger set-now"><thead><tr><th>Env</th><th>Cap per account</th><th>Depth sizing</th><th>Fall guard</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="ledger-note">The operator pulls this every minute and applies it on each engine's next review.</p></section>`;
}

// ---- the form ----

type Field = {
  name: string;
  label: string;
  unit: string;
  value: string;
  range: string;
  recommended: string;
  /** What runs now, when it differs from the value in the field. */
  was?: string;
  placeholder?: string;
};

function field(f: Field): string {
  const hint = `${f.range}. Recommended ${f.recommended}.${f.was === undefined ? "" : ` <b class="set-was">Now ${esc(f.was)}.</b>`}`;
  return `<div class="set-fld${f.was === undefined ? "" : " changed"}">
    <label for="f-${f.name}">${esc(f.label)}</label>
    <span class="set-in"><input id="f-${f.name}" name="${f.name}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(f.value)}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""} aria-describedby="h-${f.name}" /><span class="unit">${esc(f.unit)}</span></span>
    <span class="set-hint" id="h-${f.name}">${hint}</span>
  </div>`;
}

const pctRange = (b: { min: number; max: number }) => `${pctOf(b.min)} to ${pctOf(b.max)}%`;

/** A percent field over basis points; `was` only when what runs differs from the draft. */
function pctField(name: string, label: string, unit: string, bps: number | undefined, b: { min: number; max: number }, rec: number, now: number | undefined | "off", placeholder?: string): string {
  return field({
    name,
    label,
    unit,
    value: bps === undefined ? "" : pctOf(bps),
    range: pctRange(b),
    recommended: `${pctOf(rec)}%`,
    ...(now !== bps ? { was: now === "off" ? "off" : now === undefined ? "blank" : `${pctOf(now)}%` } : {}),
    ...(placeholder ? { placeholder } : {}),
  });
}

function toggle(name: string, on: boolean, what: string): string {
  return `<label class="set-tgl"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""} /> <span class="when-on">On</span><span class="when-off">Off</span><span class="sr-only"> ${esc(what)}</span></label>`;
}

function group(id: string, title: string, explain: string, body: string, tgl = ""): string {
  return `<div class="set-grp${tgl ? " has-tgl" : ""}" role="group" aria-labelledby="g-${id}">
    <div class="set-grp-head"><h3 id="g-${id}">${esc(title)}</h3><p class="soft">${explain}</p>${tgl}</div>
    <div class="set-grp-body">${body}</div>
  </div>`;
}

type Draft = { env: Env; template: string; settings: EngineSettings; canary: string; reason: string };

function editForm(csrf: string, templates: readonly TemplateRow[], draft: Draft, running: EngineSettings, runningLabel: string | null): string {
  const s = draft.settings;
  const r = RECOMMENDED_SETTINGS;
  const envLinks = ENVS.map((e) => `<a href="/ops/settings?env=${e}"${e === draft.env ? ' aria-current="page"' : ""}>${e}</a>`).join("");
  const options = [
    runningLabel ? `<option value="">${esc(runningLabel)}</option>` : "",
    ...templates.map((t) => `<option value="${esc(t.name)}"${t.name === draft.template ? " selected" : ""}>${esc(t.name)}${t.source === "lab" ? " (lab)" : ""}</option>`),
  ].join("");
  const depthOn = s.depth !== null;
  const d = s.depth ?? r.depth!;
  // What runs, per depth field: nothing to compare while the draft keeps it off.
  const nowDepth = (k: "impactBps" | "shareBps" | "stablesImpactBps") => (!depthOn ? d[k] : running.depth ? running.depth[k] : ("off" as const));
  const capWas = (running.capUsdc ?? null) !== (s.capUsdc ?? null) ? (running.capUsdc === null ? `blank, default ${usdcOf(DEFAULT_CAP_USDC)}` : `${usdcOf(running.capUsdc)} USDC`) : undefined;

  const cap = group(
    "cap",
    "Cap per account",
    `The most USDC one account puts to work. Above ${DEFAULT_CAP_USDC} needs depth sizing on.`,
    field({
      name: "cap",
      label: "Cap",
      unit: "USDC",
      value: s.capUsdc === null ? "" : usdcOf(s.capUsdc),
      placeholder: `${DEFAULT_CAP_USDC} (default)`,
      range: `${usdcOf(BOUNDS.capUsdc.min)} to ${usdcOf(BOUNDS.capUsdc.max)}, blank for the default ${DEFAULT_CAP_USDC}`,
      recommended: `${usdcOf(r.capUsdc!)}`,
      ...(capWas === undefined ? {} : { was: capWas }),
    }),
  );

  // With depth off the fields still show the recommended thresholds, ready for the moment it is switched on.
  const depth = group(
    "depth",
    "Depth sizing",
    "Sizes each entry to the pool it goes into, so a deposit never moves the price more than this.",
    `<div class="set-grid">
      ${pctField("depth_impact_pct", "Max price impact", "%", d.impactBps, BOUNDS.impactBps, r.depth!.impactBps, nowDepth("impactBps"))}
      ${pctField("depth_share_pct", "Max share of a pool", "%", d.shareBps, BOUNDS.shareBps, r.depth!.shareBps, nowDepth("shareBps"))}
      ${pctField("depth_stables_pct", "Max impact, stables pool", "%", d.stablesImpactBps, BOUNDS.stablesImpactBps, r.depth!.stablesImpactBps!, nowDepth("stablesImpactBps"), "same as price impact")}
    </div>`,
    toggle("depth_on", depthOn, "depth sizing"),
  );

  const g = s.guard;
  const rg = running.guard;
  const guard = group(
    "guard",
    "Fall guard",
    "No new money into BTC or ETH while it falls this much in 24 h with volatility above this.",
    `<div class="set-grid two">
      ${pctField("btc_fall_pct", "BTC 24 h fall", "%", g.btc.fallBps, BOUNDS.fallBps, r.guard.btc.fallBps, rg.btc.fallBps)}
      ${pctField("btc_vol_pct", "BTC volatility", "% a year", g.btc.volBps, BOUNDS.volBps, r.guard.btc.volBps, rg.btc.volBps)}
      ${pctField("eth_fall_pct", "ETH 24 h fall", "%", g.eth.fallBps, BOUNDS.fallBps, r.guard.eth.fallBps, rg.eth.fallBps)}
      ${pctField("eth_vol_pct", "ETH volatility", "% a year", g.eth.volBps, BOUNDS.volBps, r.guard.eth.volBps, rg.eth.volBps)}
    </div>`,
    toggle("guard_on", g.enabled, "fall guard"),
  );

  return `<section class="sec" aria-labelledby="set-edit">
  <div class="sec-head"><h2 id="set-edit">Change</h2><nav class="set-seg" aria-label="Environment">${envLinks}</nav></div>
  <form method="get" action="/ops/settings" class="set-load">
    <input type="hidden" name="env" value="${draft.env}" />
    <label for="f-template">Start from</label>
    <span class="set-sel"><select id="f-template" name="template">${options}</select></span>
    <button class="link" type="submit">Load</button>
  </form>
  <form method="post" action="/ops/settings/apply" class="set-form" data-ops-form data-ops-no-retry>
    ${csrfField(csrf)}
    <input type="hidden" name="env" value="${draft.env}" />
    <input type="hidden" name="template" value="${esc(draft.template)}" />
    ${cap}${depth}${guard}
    <details class="set-more"${draft.canary ? " open" : ""}><summary>Only some accounts (canary)</summary>
      <label for="f-canary">Account keys, one per line</label>
      <textarea id="f-canary" name="canary" rows="3" spellcheck="false">${esc(draft.canary)}</textarea>
      <p class="set-hint">Empty: every account of ${draft.env}. One canary at a time; a new one replaces the previous.</p>
    </details>
    <div class="set-go">
      <label for="f-reason">Why</label>
      <span class="set-in wide"><input id="f-reason" name="reason" required maxlength="500" autocomplete="off" value="${esc(draft.reason)}" placeholder="what this change is for" /></span>
      <button type="submit">Apply to ${draft.env}</button>
    </div>
    <p class="set-hint">The operator checks every bound again and refuses anything outside it. Settings never change what an account's approval allows.</p>
  </form></section>`;
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
    h("canary", canary),
    h("reason", reason),
  ].join("");
}

/** Before and after, only for what changes. */
function diffRows(from: EngineSettings, to: EngineSettings): string {
  const rows: Array<[string, string, string]> = [
    ["Cap per account", capText(from), capText(to)],
    ["Depth sizing", depthText(from), depthText(to)],
    ["Fall guard", guardText(from), guardText(to)],
  ];
  return rows
    .filter(([, a, b]) => a !== b)
    .map(([what, a, b]) => `<tr><th scope="row">${what}</th><td class="dim">${esc(a)}</td><td>${esc(b)}</td></tr>`)
    .join("");
}

// ---- history ----

function historyBlock(csrf: string, versions: readonly VersionRow[]): string {
  if (!versions.length)
    return `<section class="sec" aria-labelledby="set-hist"><h2 id="set-hist">History</h2><p class="empty">No version written yet. The operator runs the code defaults.</p></section>`;
  const rows = versions
    .map(
      (v) => `<tr><td>v${v.id}</td><td>${v.env}${v.accountKeys ? `<br><span class="dim">canary, ${v.accountKeys.length}</span>` : ""}</td>
      <td data-k="Settings">${esc(describeSettings(v.settings))}<br><span class="dim">${esc(v.template)}${v.rollbackOf ? `, rollback to v${v.rollbackOf}` : ""}</span></td>
      <td data-k="Why">${esc(v.reason)}<br><span class="dim">${esc(v.author)}, ${esc(when(v.createdAt))}</span></td>
      <td class="act"><details class="set-rb"><summary>Roll back</summary><form method="post" action="/ops/settings/rollback" data-ops-form data-ops-no-retry>${csrfField(csrf)}<input type="hidden" name="id" value="${v.id}" /><span class="set-in wide"><input name="reason" required maxlength="500" placeholder="why" aria-label="Why roll back to v${v.id}" /></span><button class="link" type="submit">Roll back to v${v.id}</button></form></details></td></tr>`,
    )
    .join("");
  return `<section class="sec" aria-labelledby="set-hist"><h2 id="set-hist">History</h2>
  <div class="exp-ledger-wrap"><table class="ledger set-hist"><thead><tr><th>Version</th><th>Env</th><th>Settings</th><th>Why</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="ledger-note">Every change is a row. A rollback writes a new version that copies an older one.</p></section>`;
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
  const runningOf = (env: Env) => p.active[env].wide;
  let confirm = "";
  if (p.confirm) {
    const c = p.confirm.draft;
    const diff = diffRows(runningOf(c.env)?.settings ?? DEFAULT_SETTINGS, c.settings);
    confirm = `<section class="sec set-confirm" aria-labelledby="set-confirm"><h2 id="set-confirm">Confirm this change</h2>
      <p>To ${esc(c.env)}${c.canary ? " (canary)" : ""}. What it allows:</p>
      <ul class="set-risks">${p.confirm.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      ${diff ? `<table class="ledger set-diff"><thead><tr><th></th><th>Now</th><th>After</th></tr></thead><tbody>${diff}</tbody></table>` : ""}
      <form method="post" action="/ops/settings/apply" class="set-go" data-ops-form data-ops-no-retry>${csrfField(p.csrf)}${hiddenFields(c.env, c.template, c.settings, c.canary, c.reason)}<input type="hidden" name="confirm_token" value="${esc(p.confirm.token)}" />${p.confirm.rollbackOf ? `<input type="hidden" name="rollback_of" value="${p.confirm.rollbackOf}" />` : ""}<button type="submit">Yes, apply it</button> <a href="/ops/settings?env=${c.env}">Cancel</a></form></section>`;
  }
  const running = runningOf(p.draft.env);
  const runningLabel = running ? `what runs now (v${running.id})` : null;
  return {
    section: "settings",
    title: "Engine settings",
    html: `${head}
    <p class="lede">What the engine does with deposits. Change only what you need; everything else stays as it runs.</p>
    ${notice}${confirm}
    ${activeBlock(p.active)}
    ${editForm(p.csrf, p.templates, p.draft, running?.settings ?? DEFAULT_SETTINGS, runningLabel)}
    ${historyBlock(p.csrf, p.versions)}`,
  };
}
