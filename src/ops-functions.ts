/**
 * Renders /ops/functions (otto/mamoru-astro#20): the runtime flags of packages/policy/src/ops-flags.ts
 * (ops-flags-model.ts's local copy), one row per flag in the registry, a form to flip each one, a confirm
 * step for turning one on (ops-flags-confirm.ts, same pattern as engine settings' spec 006), and the
 * append-only history. Pure string building; the worker does the D1 reads and writes.
 */

import type { FlagChangeRow } from "./ops-flags-store";
import { OPS_FLAG_NAMES, OPS_FLAGS, type OpsFlagName } from "./ops-flags-model";
import { fmtDateUtc, fmtRelative } from "./ops-format";
import { csrfField, noticeHtml, pageHead, type SectionView } from "./ops";
import { esc } from "./text";

function pill(enabled: boolean): string {
  return `<span class="pill ${enabled ? "pill-on" : "pill-off"}">${enabled ? "On" : "Off"}</span>`;
}

function lastChange(row: FlagChangeRow | undefined): string {
  if (!row) return `<span class="dim">No change recorded. Off by default.</span>`;
  return `${esc(row.author)}<br><span class="dim">${esc(fmtDateUtc(row.createdAt))} · ${esc(row.reason)}</span>`;
}

function toggleForm(csrf: string, flag: OpsFlagName, enabled: boolean): string {
  const next = enabled ? "0" : "1";
  const label = enabled ? "Turn off" : "Turn on";
  return `<form method="post" action="/ops/functions/apply" class="fn-toggle" data-ops-form data-ops-no-retry>
    ${csrfField(csrf)}
    <input type="hidden" name="flag" value="${esc(flag)}" />
    <input type="hidden" name="enabled" value="${next}" />
    <label class="sr-only" for="fn-reason-${esc(flag)}">Why ${label.toLowerCase()} ${esc(OPS_FLAGS[flag].label)}</label>
    <input id="fn-reason-${esc(flag)}" name="reason" required maxlength="500" placeholder="why" />
    <button type="submit">${label}</button>
  </form>`;
}

function flagsTable(csrf: string, states: Map<string, FlagChangeRow>): string {
  const rows = OPS_FLAG_NAMES.map((flag) => {
    const def = OPS_FLAGS[flag];
    const state = states.get(flag);
    const enabled = state?.enabled ?? false;
    return `<tr>
      <td>${esc(def.label)}</td>
      <td>${pill(enabled)}</td>
      <td>${esc(def.description)}</td>
      <td>${lastChange(state)}</td>
      <td class="act">${toggleForm(csrf, flag, enabled)}</td>
    </tr>`;
  }).join("");
  return `<table class="ledger"><thead><tr><th>Function</th><th>State</th><th>What it does</th><th>Last change</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table>
  <p class="ledger-note">The operator picks up a change within a minute; the Worker's next 10-minute cron starts storing rows.</p>`;
}

function historyBlock(rows: readonly FlagChangeRow[]): string {
  if (!rows.length) return `<section aria-labelledby="fn-hist"><h2 id="fn-hist">History</h2><p class="empty">No change written yet. Every flag runs off.</p></section>`;
  const body = rows
    .map(
      (r) => `<tr><td>${esc(OPS_FLAGS[r.flag as OpsFlagName]?.label ?? r.flag)}</td><td>${pill(r.enabled)}</td><td>${esc(r.author)}<br><span class="dim">${esc(fmtDateUtc(r.createdAt))}</span></td><td>${esc(r.reason)}</td></tr>`,
    )
    .join("");
  return `<section aria-labelledby="fn-hist"><h2 id="fn-hist">History</h2>
  <p class="soft">Every change is a row: who, when and why. Newest first, last 20.</p>
  <table class="ledger"><thead><tr><th>Function</th><th>State</th><th>By</th><th>Why</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function confirmBlock(csrf: string, confirm: NonNullable<FunctionsPage["confirm"]>): string {
  const def = OPS_FLAGS[confirm.flag];
  return `<section aria-labelledby="fn-confirm" class="set-confirm"><h2 id="fn-confirm">Confirm this change</h2>
  <p>Turning ${esc(def.label)} on:</p>
  <ul><li>${esc(def.description)}</li></ul>
  <form method="post" action="/ops/functions/apply" data-ops-form data-ops-no-retry>
    ${csrfField(csrf)}
    <input type="hidden" name="flag" value="${esc(confirm.flag)}" />
    <input type="hidden" name="enabled" value="1" />
    <input type="hidden" name="reason" value="${esc(confirm.reason)}" />
    <input type="hidden" name="confirm_token" value="${esc(confirm.token)}" />
    <button type="submit">Yes, turn it on</button> <a href="/ops/functions">Cancel</a>
  </form></section>`;
}

export type FunctionsPage = {
  /** Null when migration 0012 is not applied: nothing can be switched. */
  states: Map<string, FlagChangeRow> | null;
  /** Newest first, last 20 overall, merged across every flag in the registry. */
  history: readonly FlagChangeRow[];
  csrf: string;
  notice?: { text: string; tone?: "plain" | "bad" };
  confirm?: { flag: OpsFlagName; reason: string; token: string };
};

export function functionsSection(p: FunctionsPage): SectionView {
  const head = pageHead({ title: "Functions" });
  if (p.states === null) {
    return {
      section: "functions",
      title: "Functions",
      html: `${head}${noticeHtml("Migration 0012 is not applied yet; nothing can be switched.", { tone: "bad" })}`,
    };
  }
  const notice = p.notice ? noticeHtml(p.notice.text, { tone: p.notice.tone ?? "plain" }) : "";
  const confirm = p.confirm ? confirmBlock(p.csrf, p.confirm) : "";
  return {
    section: "functions",
    title: "Functions",
    html: `${head}
    <p class="lede">Engine behavior that is switched here, not deployed. A reason is required for every change; turning one on asks again before it writes.</p>
    ${notice}${confirm}
    ${flagsTable(p.csrf, p.states)}
    ${historyBlock(p.history)}`,
  };
}
