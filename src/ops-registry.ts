/**
 * /ops/money/registry (otto/mamoru#296): what the MamoruRegistry lets the policy use on each chain, what is queued
 * and when it takes effect, and the last twenty changes that ended. Read only: queuing, executing and cancelling are
 * done by the team Safe (2 of 2) and the guardian outside /ops, so each pending change carries the exact calldata
 * a signer needs, as text to copy. Pure string building over `ChainReading`s.
 */

import { fmtInt } from "./metrics-math";
import { pageHead, type SectionView } from "./ops";
import { CCTP_DOMAINS } from "./registry-config";
import type { ChainReading, HistoryView, PendingView } from "./registry-read";
import { fmtSeconds, keyAddress, keyDomain, pct, poolLabel, timeLeft, type Kind, type Params, type PoolParams } from "./registry-model";
import { esc } from "./text";

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (t: number) => {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};
const ticks = (n: number) => `${fmtInt(n)} ${n === 1 ? "tick" : "ticks"}`;

export const CHAIN_CHOICES = ["all", "base", "monad"] as const;
export type ChainChoice = (typeof CHAIN_CHOICES)[number];
export const parseChain = (v: string | null): ChainChoice => (CHAIN_CHOICES as readonly string[]).includes(v ?? "") ? (v as ChainChoice) : "all";

const domainName = (d: number | null) => (d === null ? "an unknown domain" : (CCTP_DOMAINS[d] ?? `domain ${d}`));

/** A copy button with its feedback line beside it. The text travels in `data-copy`; the page script does the rest. */
function copyButton(text: string, label: string): string {
  return `<button type="button" class="rg-copy" data-copy="${esc(text)}">${esc(label)}</button><span class="rg-fb" role="status" aria-live="polite"></span>`;
}

function poolWords(v: PoolParams): string {
  return `band ${ticks(v.bandTicks)}, windows ${fmtSeconds(v.twapWindow)} and ${fmtSeconds(v.twapShortWindow)}, anchor tick ${fmtInt(v.anchorTick)} with band ${ticks(v.anchorBand)}, ${pct(v.ratioBps)} of the bucket`;
}

function paramsWords(p: Params | null): string {
  if (!p) return "Parameters could not be decoded";
  if (p.kind === "pool") return poolWords(p.v);
  if (p.kind === "vault") return `${pct(p.ratioBps)} of the bucket`;
  return "on";
}

/** The fields that differ between the entry in force and the queued one, as "band 20 ticks → 40 ticks". */
function changes(from: Params, to: Params): string[] {
  if (from.kind === "pool" && to.kind === "pool") {
    const rows: [string, string, string][] = [
      ["band", ticks(from.v.bandTicks), ticks(to.v.bandTicks)],
      ["long window", fmtSeconds(from.v.twapWindow), fmtSeconds(to.v.twapWindow)],
      ["short window", fmtSeconds(from.v.twapShortWindow), fmtSeconds(to.v.twapShortWindow)],
      ["anchor tick", fmtInt(from.v.anchorTick), fmtInt(to.v.anchorTick)],
      ["anchor band", ticks(from.v.anchorBand), ticks(to.v.anchorBand)],
      ["share", pct(from.v.ratioBps), pct(to.v.ratioBps)],
    ];
    return rows.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n} ${a} → ${b}`);
  }
  if (from.kind === "vault" && to.kind === "vault" && from.ratioBps !== to.ratioBps) return [`share ${pct(from.ratioBps)} → ${pct(to.ratioBps)}`];
  return [];
}

const entryName = (kind: Kind, key: string | null, chainId: number): string => {
  if (key === null) return kind;
  if (kind === "route") return `route to ${domainName(keyDomain(key))}`;
  const a = keyAddress(key);
  if (!a) return kind;
  return `${kind} ${(kind === "pool" ? poolLabel(chainId, a) : null) ?? shortAddr(a)}`;
};

function pendingHtml(p: PendingView, r: Extract<ChainReading, { state: "ok" }>, now: number): string {
  const c = p.change;
  const left = timeLeft(p.eta, now);
  const name = entryName(c.kind, c.key, r.chain.chainId);
  const diff = p.current && p.params ? changes(p.current, p.params) : [];
  const verb = c.kind === "route" ? `Opens the ${name}` : p.current ? `Changes ${name}` : `Adds ${name}, or turns it back on`;
  const detail = p.current && p.params && diff.length ? diff.join("; ") : paramsWords(p.params);
  return `<article class="rg-pend" aria-label="${esc(`${verb}, ${left.text.toLowerCase()}`)}">
    <p class="rg-when${left.ready ? " ready" : ""}">${esc(left.text)}</p>
    <h4>${esc(verb)}</h4>
    <dl class="rg-kv">
      <div><dt>What it sets</dt><dd>${esc(detail)}</dd></div>
      <div><dt>Queued by</dt><dd>the admin Safe <span class="rg-addr">${esc(shortAddr(r.admin))}</span>${p.queuedAt ? `, ${esc(utc(p.queuedAt))}` : ""}</dd></div>
      <div><dt>Executable from</dt><dd>${esc(utc(p.eta))}</dd></div>
      <div><dt>Change id</dt><dd><span class="rg-addr">${esc(shortAddr(c.id))}</span> · nonce ${esc(c.nonce.toString())}</dd></div>
    </dl>
    <div class="rg-cd">
      <p class="rg-cd-h">Execute <span class="soft">(team Safe, 2 of 2${left.ready ? "" : `, only after ${esc(utc(p.eta))}`})</span></p>
      <p class="rg-cd-to soft">To <span class="rg-addr">${esc(r.address)}</span> on ${esc(r.chain.name)}, value 0</p>
      <code class="rg-data">${esc(p.executeData)}</code>
      <div class="rg-act">${copyButton(p.executeData, "Copy execute calldata")}</div>
    </div>
    <div class="rg-cd">
      <p class="rg-cd-h">Cancel <span class="soft">(team Safe or guardian ${esc(shortAddr(r.guardian))}, any time before it executes)</span></p>
      <p class="rg-cd-to soft">To <span class="rg-addr">${esc(r.address)}</span> on ${esc(r.chain.name)}, value 0</p>
      <code class="rg-data">${esc(p.cancelData)}</code>
      <div class="rg-act">${copyButton(p.cancelData, "Copy cancel calldata")}</div>
    </div>
  </article>`;
}

function active(r: Extract<ChainReading, { state: "ok" }>): string {
  const pools = r.pools.length
    ? `<div class="rg-scroll"><table class="rg-t"><thead><tr><th>Pool</th><th>Band</th><th>Windows</th><th>Anchor</th><th>Share</th></tr></thead><tbody>${r.pools
        .map(
          (p) =>
            `<tr><td>${p.label ? `${esc(p.label)} ` : ""}<span class="rg-addr">${esc(shortAddr(p.address))}</span></td><td>${esc(ticks(p.v.bandTicks))}</td><td>${esc(fmtSeconds(p.v.twapWindow))} / ${esc(fmtSeconds(p.v.twapShortWindow))}</td><td>${esc(fmtInt(p.v.anchorTick))} ± ${esc(fmtInt(p.v.anchorBand))}</td><td>${esc(pct(p.v.ratioBps))}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="soft">No pool is active.</p>`;
  const vaults = r.vaults.length
    ? `<div class="rg-scroll"><table class="rg-t"><thead><tr><th>Vault</th><th>Share</th></tr></thead><tbody>${r.vaults.map((v) => `<tr><td><span class="rg-addr">${esc(shortAddr(v.address))}</span></td><td>${esc(pct(v.ratioBps))}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="soft">No vault is active.</p>`;
  const routes = r.routes.length
    ? `<div class="rg-scroll"><table class="rg-t"><thead><tr><th>Route to</th></tr></thead><tbody>${r.routes.map((x) => `<tr><td>${esc(domainName(x.domain))} <span class="soft">(CCTP domain ${x.domain})</span></td></tr>`).join("")}</tbody></table></div>`
    : `<p class="soft">No route is open.</p>`;
  return `<div class="rg-kinds">
    <div><h4>Pools</h4>${pools}</div>
    <div><h4>Vaults</h4>${vaults}</div>
    <div><h4>Routes</h4>${routes}</div>
  </div>`;
}

function historyHtml(r: Extract<ChainReading, { state: "ok" }>): string {
  if (!r.history.length) return `<p class="soft">Nothing has been executed or cancelled yet.</p>`;
  const row = (h: HistoryView) => {
    const f = h.f;
    const what = f.kind ? entryName(f.kind, f.key, r.chain.chainId) : "an entry";
    const by = f.how === "cancelled" ? (f.by && f.by.toLowerCase() === r.guardian.toLowerCase() ? "the guardian" : "the admin Safe") : "the admin Safe";
    return `<tr><td>${h.time ? esc(utc(h.time)) : "—"}</td><td>${f.how === "executed" ? "Executed" : "Cancelled"}</td><td>${esc(what)}${h.params && h.params.kind !== "route" ? ` <span class="soft">${esc(paramsWords(h.params))}</span>` : ""}</td><td>${esc(by)}</td></tr>`;
  };
  return `<div class="rg-scroll"><table class="rg-t"><thead><tr><th>When</th><th>Outcome</th><th>Entry</th><th>By</th></tr></thead><tbody>${r.history.map(row).join("")}</tbody></table></div>`;
}

function chainHtml(r: ChainReading, now: number, chainParam: ChainChoice): string {
  const head = `<div class="sec-head"><h2>${esc(r.chain.name)}</h2>`;
  if (r.state === "unset") {
    return `<section class="sec rg" aria-label="${esc(r.chain.name)}">${head}</div><p class="soft rg-empty">Registry not deployed yet.</p></section>`;
  }
  const where = `<span class="rg-addr">${esc(shortAddr(r.address))}</span>`;
  const link = `<a href="${esc(r.chain.explorerAddress + r.address)}">${esc(r.chain.explorerName)}</a>`;
  if (r.state === "error") {
    return `<section class="sec rg" aria-label="${esc(r.chain.name)}">${head}<span class="soft">${where} · ${link}</span></div>
      <p class="rg-empty">The registry could not be read just now (${esc(r.why)}). Nothing is shown rather than a partial list.</p>
      <form method="get" action="/ops/money/registry"><input type="hidden" name="chain" value="${esc(chainParam)}" /><button type="submit">Retry</button></form></section>`;
  }
  const pending = r.pending.length
    ? r.pending
        .slice()
        .sort((a, b) => a.eta - b.eta)
        .map((p) => pendingHtml(p, r, now))
        .join("")
    : `<p class="soft">Nothing is waiting.</p>`;
  return `<section class="sec rg" aria-label="${esc(r.chain.name)}">${head}<span class="soft">${where} · ${link} ${copyButton(r.address, "Copy address")}</span></div>
    <p class="soft rg-facts">Admin ${esc(shortAddr(r.admin))} (the team Safe) · guardian ${esc(shortAddr(r.guardian))} · every addition waits ${esc(fmtSeconds(r.delaySeconds))}; removals and tightening take effect at once.</p>
    <h3 class="rg-h">Waiting to take effect${r.pending.length ? ` (${r.pending.length})` : ""}</h3>
    ${pending}
    <h3 class="rg-h">In force</h3>
    ${active(r)}
    <h3 class="rg-h">Executed and cancelled (last 20)</h3>
    ${historyHtml(r)}
  </section>`;
}

export function registrySection(readings: readonly ChainReading[], now: number, chain: ChainChoice = "all"): SectionView {
  const shown = readings.filter((r) => chain === "all" || r.chain.name.toLowerCase() === chain);
  const options = CHAIN_CHOICES.map((c) => `<option value="${c}"${c === chain ? " selected" : ""}>${c === "all" ? "All chains" : c === "base" ? "Base" : "Monad"}</option>`).join("");
  return {
    section: "registry",
    title: "Registry",
    html: `${pageHead({ title: "Registry", asOf: new Date(now * 1000).toISOString() })}
    <p class="rg-lead">What the policy may use on each chain, read from the registry contract. Read only: adding, executing and cancelling are done by the team Safe and the guardian, outside this console.</p>
    <form class="rg-pick" method="get" action="/ops/money/registry"><label>Chain<select name="chain">${options}</select></label><button type="submit">Show</button></form>
    ${shown.map((r) => chainHtml(r, now, chain)).join("")}`,
  };
}
