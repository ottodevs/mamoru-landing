/**
 * Serves experiment variants at the edge. Static Astro pages carry
 * `data-exp="<id>"` hooks (and, on the element that completes a goal,
 * `data-exp-goal="<goal>"`); this file is the only place that rewrites them,
 * with HTMLRewriter, so the build output itself never changes per variant —
 * only the response does. No flicker: the swap happens before any byte
 * reaches the browser.
 *
 * Byte-identical guarantee: when nothing registered on `path` is effectively
 * running (draft, stopped, or past its `endedAt`) and no QA override applies,
 * `applyExperiments` returns the exact Response it was given — no rewriter
 * pass, no cookie, no Vary, no cache-control change, no script. A visitor who
 * never meets a running experiment never gets an identifier: nothing here
 * sets a cookie, computes a nonce, or touches a header unless there is a real
 * reason to.
 */

import type { D1Db } from "./d1-infra";
import {
  assignVariant,
  controlVariantId,
  type ExperimentDef,
  type ExperimentVariant,
  experimentsForPath,
  isRunning,
  variantById,
  variesPerVisitor,
} from "./experiments";
import { expNonce } from "./exp-events";
import { recordExpEvent } from "./exp-store";
import { randomToken } from "./google";
import { eligibleForExperiments, newVisitorId, readVisitorId, visitorCookie } from "./exp-visitor";
import { utcDay } from "./metrics-math";

export interface Background {
  waitUntil(work: Promise<unknown>): void;
}

export interface ExpContext {
  /** Allowed to force a variant with `?exp=<id>:<variant>` — a verified ops session, or the staging channel. */
  qaAllowed: boolean;
  db?: D1Db;
  ctx?: Background;
  /** OPS_SESSION_SECRET, reused to derive the beacon nonce. Optional: without it the nonce check in exp-events.ts is skipped. */
  secret?: string;
  /** Overridable for tests. Defaults to the real clock. */
  now?: Date;
}

interface QaOverride {
  experimentId: string;
  variantId: string;
}

/** `?exp=<id>:<variant>`. Malformed or absent, this is null and assignment proceeds normally. */
function parseQaOverride(url: URL): QaOverride | null {
  const raw = url.searchParams.get("exp");
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep < 1 || sep === raw.length - 1) return null;
  return { experimentId: raw.slice(0, sep), variantId: raw.slice(sep + 1) };
}

interface Assignment {
  def: ExperimentDef;
  variant: ExperimentVariant;
  /** True when a QA override picked this variant: never counted, never persisted. */
  forced: boolean;
}

function escapeForSelector(value: string): string {
  // Experiment ids are our own registry strings ([a-z0-9_]+ by convention); this is a defensive quote-escape, not a parser.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function clickScript(assignments: readonly Assignment[], nonce: string): string {
  const variantOf: Record<string, string> = {};
  for (const a of assignments) variantOf[a.def.id] = a.variant.id;
  const payload = JSON.stringify(variantOf);
  const n = JSON.stringify(nonce);
  return `(function(){var A=${payload};var N=${n};document.addEventListener("click",function(ev){var t=ev.target&&ev.target.closest?ev.target.closest("[data-exp][data-exp-goal]"):null;if(!t)return;var exp=t.getAttribute("data-exp");var v=A[exp];if(!v)return;var body=JSON.stringify({experiment:exp,variant:v,event:t.getAttribute("data-exp-goal"),nonce:N});try{if(navigator.sendBeacon){navigator.sendBeacon("/api/exp/event",new Blob([body],{type:"text/plain"}));}else if(window.fetch){fetch("/api/exp/event",{method:"POST",body:body,headers:{"content-type":"text/plain"},keepalive:true});}}catch(e){}},true);})();`;
}

/**
 * Resolves, rewrites, and (for a real visit) logs exposure for every
 * experiment registered on `path`. Returns the original `response` untouched
 * whenever nothing registered there is effectively running and no valid QA
 * override applies — see the byte-identical guarantee above.
 */
export async function applyExperiments(
  response: Response,
  request: Request,
  path: string,
  opts: ExpContext,
): Promise<Response> {
  const defs = experimentsForPath(path);
  if (!defs.length) return response;
  if (!(response.headers.get("content-type") || "").includes("text/html")) return response;

  const now = opts.now ?? new Date();
  const url = new URL(request.url);
  const qa = opts.qaAllowed ? parseQaOverride(url) : null;
  const qaDef = qa ? defs.find((d) => d.id === qa.experimentId) : undefined;
  const qaVariant = qaDef && qa ? variantById(qaDef, qa.variantId) : undefined;
  const qaActive = Boolean(qaDef && qaVariant);

  const hasPinnedWinner = (def: ExperimentDef) => Boolean(def.winner && variantById(def, def.winner));
  // "Active" = still running, or has a winner pinned (a winner is a terminal decision: it keeps showing
  // even after the experiment later stops or its endedAt passes — only a truly dead experiment, draft or
  // stopped/expired with no winner ever called, gets the byte-identical pass-through below).
  const anyActive = defs.some((d) => isRunning(d, now) || hasPinnedWinner(d));
  if (!anyActive && !qaActive) return response;

  const eligible = eligibleForExperiments(request);
  const existingId = readVisitorId(request);
  // A cookie is only ever worth minting when some running experiment actually differs by visitor.
  const needsVisitor = !qaActive && defs.some((d) => variesPerVisitor(d, now));
  const visitorId = needsVisitor && eligible ? (existingId ?? newVisitorId()) : eligible ? existingId : null;

  const assignments: Assignment[] = [];
  for (const def of defs) {
    if (qaActive && qaDef!.id === def.id) {
      assignments.push({ def, variant: qaVariant!, forced: true });
      continue;
    }
    if (!isRunning(def, now) && !hasPinnedWinner(def)) continue; // truly dead: this hook is left exactly as authored.
    // Ineligible (GPC/DNT/bot) always reads as control. Otherwise assignVariant() itself resolves a pinned
    // winner regardless of visitorId — a winner needs no identifier, so visitorId may legitimately be null here.
    const assignedId = eligible ? assignVariant(def, visitorId ?? "", now) : controlVariantId(def);
    const v = variantById(def, assignedId) ?? def.variants[0];
    if (v) assignments.push({ def, variant: v, forced: false });
  }
  if (!assignments.length) return response;

  const day = utcDay(now);
  const nonce = visitorId ? await expNonce(opts.secret, visitorId, day) : "";

  let rewriter = new HTMLRewriter();
  for (const a of assignments) {
    rewriter = rewriter.on(`[data-exp="${escapeForSelector(a.def.id)}"]`, {
      element(el: { setAttribute(name: string, value: string): void; setInnerContent(content: string, opts: { html: boolean }): void }) {
        el.setAttribute("data-exp-variant", a.variant.id);
        if (a.variant.text !== undefined) el.setInnerContent(a.variant.text, { html: false });
      },
    });
  }
  // A CSP nonce on the script tag itself: public pages carry no Content-Security-Policy today (nothing
  // to loosen), so this is a forward-compatible attribute, not an active defense yet.
  const scriptNonce = randomToken(16);
  const script = `<script nonce="${scriptNonce}">${clickScript(assignments, nonce)}</script>`;
  rewriter = rewriter.on("body", {
    element(el: { append(content: string, opts: { html: boolean }): void }) {
      el.append(script, { html: true });
    },
  });

  const rewritten = rewriter.transform(response);
  const headers = new Headers(rewritten.headers);

  // Only a running, un-pinned experiment can differ by visitor; a pinned winner (or one still draft/stopped
  // elsewhere on the same path) is identical for everyone and stays as cacheable as before.
  if (qaActive || assignments.some((a) => !a.forced && variesPerVisitor(a.def, now))) {
    headers.set("cache-control", "private, no-store");
    headers.append("vary", "Cookie");
  }

  if (needsVisitor && visitorId && !existingId) {
    const cookie = visitorCookie(visitorId, url.protocol === "https:");
    if (cookie) headers.append("set-cookie", cookie);
  }

  // Exposure: once per visitor per experiment per day, only for a real (non-forced) visit to a running experiment.
  if (visitorId && opts.db && opts.ctx) {
    const at = now.toISOString();
    for (const a of assignments) {
      if (a.forced || !isRunning(a.def, now)) continue;
      opts.ctx.waitUntil(
        recordExpEvent(opts.db, { experiment: a.def.id, variant: a.variant.id, visitor: visitorId, event: "exposure", day, at }),
      );
    }
  }

  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}
