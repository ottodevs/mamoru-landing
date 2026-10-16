/**
 * Renders /ops/settings (spec 006, otto/mamoru#147): the engine settings in effect per environment, a form to apply
 * a template or an edited set (bounds shown), a confirm step for risky changes, and the append-only history with
 * rollback. Pure string building; the worker does the D1 reads and writes.
 */

import { BOUNDS, DEFAULT_CAP_USDC, DEFAULT_SETTINGS, type EngineSettings } from "./engine-settings-model";
import type { Env, InEffect, TemplateRow, VersionRow } from "./engine-settings-store";
import { csrfField, noticeHtml, pageHead, type SectionView } from "./ops";
import { esc } from "./text";

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

/** One line a person reads: what this set makes the engine do. */
export function describeSettings(s: EngineSettings): string {
  const depth = s.depth
    ? `depth sizing on (${pct(s.depth.impactBps)} impact, ${pct(s.depth.shareBps)} of a pool${s.depth.stablesImpactBps !== undefined ? `, stables ${pct(s.depth.stablesImpactBps)}` : ""})`
    : "depth sizing off";
  const cap = `cap ${s.capUsdc ?? DEFAULT_CAP_USDC} USDC${s.capUsdc === null ? " (default)" : ""}`;
  const guard = s.guard.enabled
    ? `fall guard on (BTC ${pct(s.guard.btc.fallBps)} fall with ${pct(s.guard.btc.volBps)} vol, ETH ${pct(s.guard.eth.fallBps)} with ${pct(s.guard.eth.volBps)})`
    : "fall guard off";
  return `${cap}; ${depth}; ${guard}.`;
}

const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function activeBlock(active: Record<Env, InEffect>): string {
  const rows = (["prod", "beta"] as const)
    .map((env) => {
      const v = active[env].wide;
      // One canary at most is live per environment: the newest, if newer than the environment-wide version.
      const canaries = active[env].canary ? [active[env].canary!] : [];
      const main = v
        ? `<td>v${v.id}</td><td>${esc(v.template)}</td><td>${esc(describeSettings(v.settings))}</td><td>${esc(v.author)}<br><span class="dim">${esc(when(v.createdAt))}</span></td>`
        : `<td>none</td><td>code defaults</td><td>${esc(describeSettings(DEFAULT_SETTINGS))}</td><td></td>`;
      const extra = canaries
        .map((c) => `<tr><td></td><td>v${c.id} canary</td><td>${esc(c.template)}</td><td>${esc(describeSettings(c.settings))} <span class="dim">${c.accountKeys!.length} account(s)</span></td><td>${esc(c.author)}</td></tr>`)
        .join("");
      return `<tr><th scope="row">${env}</th>${main}</tr>${extra}`;
    })
    .join("");
  return `<section aria-labelledby="set-active"><h2 id="set-active">In effect</h2>
  <p class="soft">The operator pulls this every minute and applies it on each engine's next review. It shows what it applied in its metrics.</p>
  <table class="ledger"><thead><tr><th>Env</th><th>Version</th><th>Template</th><th>What it does</th><th>By</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

const num = (name: string, label: string, value: number | undefined, b: { min: number; max: number }, unit: string) =>
  `<label>${esc(label)} <input name="${name}" inputmode="numeric" pattern="[0-9]*" value="${value === undefined ? "" : value}" /> <span class="dim">${unit}, ${b.min} to ${b.max}</span></label>`;

function hiddenFields(env: Env, template: string, s: EngineSettings, canary: string, reason: string): string {
  const h = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}" />`;
  return [
    h("env", env),
    h("template", template),
    h("depth_on", s.depth ? "1" : "0"),
    h("depth_impact", s.depth ? String(s.depth.impactBps) : ""),
    h("depth_share", s.depth ? String(s.depth.shareBps) : ""),
    h("depth_stables", s.depth?.stablesImpactBps !== undefined ? String(s.depth.stablesImpactBps) : ""),
    h("cap", s.capUsdc === null ? "" : String(s.capUsdc)),
    h("guard_on", s.guard.enabled ? "1" : "0"),
    h("btc_fall", String(s.guard.btc.fallBps)),
    h("btc_vol", String(s.guard.btc.volBps)),
    h("eth_fall", String(s.guard.eth.fallBps)),
    h("eth_vol", String(s.guard.eth.volBps)),
    h("canary", canary),
    h("reason", reason),
  ].join("");
}

function editForm(csrf: string, templates: readonly TemplateRow[], draft: { env: Env; template: string; settings: EngineSettings; canary: string; reason: string }): string {
  const s = draft.settings;
  const options = templates
    .map((t) => `<option value="${esc(t.name)}"${t.name === draft.template ? " selected" : ""}>${esc(t.name)}${t.source === "lab" ? " (lab)" : ""}</option>`)
    .join("");
  return `<section aria-labelledby="set-edit"><h2 id="set-edit">Change</h2>
  <form method="get" action="/ops/settings" class="set-load">
    <label>Start from a template <select name="template">${options}</select></label>
    <label>for <select name="env"><option value="prod"${draft.env === "prod" ? " selected" : ""}>prod</option><option value="beta"${draft.env === "beta" ? " selected" : ""}>beta</option></select></label>
    <button class="link" type="submit">Load</button>
  </form>
  <form method="post" action="/ops/settings/apply" class="set-form" data-ops-form>
    ${csrfField(csrf)}
    <input type="hidden" name="template" value="${esc(draft.template)}" />
    <fieldset><legend>Where</legend>
      <label><input type="radio" name="env" value="prod"${draft.env === "prod" ? " checked" : ""} /> prod</label>
      <label><input type="radio" name="env" value="beta"${draft.env === "beta" ? " checked" : ""} /> beta</label>
      <label>Canary: only these account keys, one per line <textarea name="canary" rows="2">${esc(draft.canary)}</textarea> <span class="dim">empty: every account of the environment. One canary at a time: a new one replaces the previous.</span></label>
    </fieldset>
    <fieldset><legend>Cap per account</legend>
      ${num("cap", "USDC", s.capUsdc ?? undefined, BOUNDS.capUsdc, "whole USDC, blank for the default " + DEFAULT_CAP_USDC)}
    </fieldset>
    <fieldset><legend>Depth sizing</legend>
      <label><input type="checkbox" name="depth_on" value="1"${s.depth ? " checked" : ""} /> on</label>
      ${num("depth_impact", "Max price impact", s.depth?.impactBps, BOUNDS.impactBps, "bps")}
      ${num("depth_share", "Max share of a pool", s.depth?.shareBps, BOUNDS.shareBps, "bps")}
      ${num("depth_stables", "Max impact in the stables pool", s.depth?.stablesImpactBps, BOUNDS.stablesImpactBps, "bps, blank for the same as above")}
    </fieldset>
    <fieldset><legend>Fall guard</legend>
      <label><input type="checkbox" name="guard_on" value="1"${s.guard.enabled ? " checked" : ""} /> on: no new money into BTC or ETH while it falls with high volatility</label>
      ${num("btc_fall", "BTC 24 h fall", s.guard.btc.fallBps, BOUNDS.fallBps, "bps")}
      ${num("btc_vol", "BTC volatility", s.guard.btc.volBps, BOUNDS.volBps, "bps annualized")}
      ${num("eth_fall", "ETH 24 h fall", s.guard.eth.fallBps, BOUNDS.fallBps, "bps")}
      ${num("eth_vol", "ETH volatility", s.guard.eth.volBps, BOUNDS.volBps, "bps annualized")}
    </fieldset>
    <label>Why <input name="reason" required maxlength="500" value="${esc(draft.reason)}" /></label>
    <button type="submit">Apply</button>
  </form></section>`;
}

function historyBlock(csrf: string, versions: readonly VersionRow[]): string {
  if (!versions.length) return `<section aria-labelledby="set-hist"><h2 id="set-hist">History</h2><p class="empty">No version written yet. The operator runs the code defaults.</p></section>`;
  const rows = versions
    .map(
      (v) => `<tr><td>v${v.id}</td><td>${v.env}${v.accountKeys ? ` canary (${v.accountKeys.length})` : ""}</td><td>${esc(v.template)}${v.rollbackOf ? ` <span class="dim">rollback to v${v.rollbackOf}</span>` : ""}</td><td>${esc(describeSettings(v.settings))}</td><td>${esc(v.author)}<br><span class="dim">${esc(when(v.createdAt))}</span></td><td>${esc(v.reason)}</td>
      <td class="act"><form method="post" action="/ops/settings/rollback" data-ops-form>${csrfField(csrf)}<input type="hidden" name="id" value="${v.id}" /><input name="reason" required maxlength="500" placeholder="why" aria-label="Why roll back to v${v.id}" /><button class="link" type="submit">Roll back to this</button></form></td></tr>`,
    )
    .join("");
  return `<section aria-labelledby="set-hist"><h2 id="set-hist">History</h2>
  <p class="soft">Every change is a row: who, when, what and why. A rollback writes a new version that copies an older one.</p>
  <div class="exp-ledger-wrap"><table class="ledger"><thead><tr><th>Version</th><th>Env</th><th>Template</th><th>What it does</th><th>By</th><th>Why</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export type SettingsPage = {
  versions: readonly VersionRow[] | null;
  active: Record<Env, InEffect>;
  templates: readonly TemplateRow[] | null;
  csrf: string;
  draft: { env: Env; template: string; settings: EngineSettings; canary: string; reason: string };
  notice?: { text: string; tone?: "plain" | "bad" };
  /** A risky change waiting for a second yes: the lines to show and the exact set to confirm. */
  confirm?: { risks: string[]; draft: SettingsPage["draft"]; token: string; rollbackOf?: number };
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
  const confirm = p.confirm
    ? `<section aria-labelledby="set-confirm" class="set-confirm"><h2 id="set-confirm">Confirm this change</h2>
      <p>This change, to ${esc(p.confirm.draft.env)}${p.confirm.draft.canary ? " (canary)" : ""}:</p>
      <ul>${p.confirm.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <p class="soft">${esc(describeSettings(p.confirm.draft.settings))}</p>
      <form method="post" action="/ops/settings/apply" data-ops-form>${csrfField(p.csrf)}${hiddenFields(p.confirm.draft.env, p.confirm.draft.template, p.confirm.draft.settings, p.confirm.draft.canary, p.confirm.draft.reason)}<input type="hidden" name="confirm_token" value="${esc(p.confirm.token)}" />${p.confirm.rollbackOf ? `<input type="hidden" name="rollback_of" value="${p.confirm.rollbackOf}" />` : ""}<button type="submit">Yes, apply it</button> <a href="/ops/settings">Cancel</a></form></section>`
    : "";
  return {
    section: "settings",
    title: "Engine settings",
    html: `${head}
    <p class="lede">What the engine does with deposits: cap, depth sizing and the fall guard. Bounds are enforced again by the operator, which refuses anything outside them. Settings never change what an account's approval allows.</p>
    ${notice}${confirm}
    ${activeBlock(p.active)}
    ${editForm(p.csrf, p.templates, p.draft)}
    ${historyBlock(p.csrf, p.versions)}`,
  };
}
