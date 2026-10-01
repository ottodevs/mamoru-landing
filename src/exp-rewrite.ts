/**
 * Serves experiment variants at the edge. Static Astro pages carry
 * `data-exp="<id>"` hooks (and, on the element that completes a goal,
 * `data-exp-goal="<goal>"`); this file is the only place that rewrites them,
 * with HTMLRewriter, so the build output itself never changes per variant —
 * only the response does. No flicker: the swap happens before any byte
 * reaches the browser.
 */

import type { D1Db } from "./d1-infra";
import {
  assignVariant,
  controlVariantId,
  type ExperimentDef,
  type ExperimentVariant,
  experimentsForPath,
  variantById,
  variesPerVisitor,
} from "./experiments";
import { expNonce } from "./exp-events";
import { recordExpEvent } from "./exp-store";
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
  return `<script>(function(){var A=${payload};var N=${n};document.addEventListener("click",function(ev){var t=ev.target&&ev.target.closest?ev.target.closest("[data-exp][data-exp-goal]"):null;if(!t)return;var exp=t.getAttribute("data-exp");var v=A[exp];if(!v)return;var body=JSON.stringify({experiment:exp,variant:v,event:t.getAttribute("data-exp-goal"),nonce:N});try{if(navigator.sendBeacon){navigator.sendBeacon("/api/exp/event",new Blob([body],{type:"text/plain"}));}else if(window.fetch){fetch("/api/exp/event",{method:"POST",body:body,headers:{"content-type":"text/plain"},keepalive:true});}}catch(e){}},true);})();</script>`;
}

/**
 * Resolves, rewrites, and (for a real visit) logs exposure for every
 * experiment registered on `path`. A no-op — original response untouched —
 * when nothing is registered there or the response is not HTML.
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

  const url = new URL(request.url);
  const qa = opts.qaAllowed ? parseQaOverride(url) : null;
  const eligible = eligibleForExperiments(request);
  const existingId = readVisitorId(request);
  // A QA preview is a one-off look, not a counted visit: no id is read, minted, or stored for it.
  const visitorId = qa ? null : eligible ? (existingId ?? newVisitorId()) : null;

  const assignments: Assignment[] = [];
  for (const def of defs) {
    if (qa && qa.experimentId === def.id) {
      const v = variantById(def, qa.variantId);
      if (v) {
        assignments.push({ def, variant: v, forced: true });
        continue;
      }
    }
    const assignedId = visitorId ? assignVariant(def, visitorId) : controlVariantId(def);
    const v = variantById(def, assignedId) ?? def.variants[0];
    if (v) assignments.push({ def, variant: v, forced: false });
  }
  if (!assignments.length) return response;

  const day = utcDay(new Date());
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
  if (visitorId) {
    const script = clickScript(assignments, nonce);
    rewriter = rewriter.on("body", {
      element(el: { append(content: string, opts: { html: boolean }): void }) {
        el.append(script, { html: true });
      },
    });
  }

  const rewritten = rewriter.transform(response);
  const headers = new Headers(rewritten.headers);

  // Only a running experiment with live weight across more than one variant can differ by visitor;
  // draft, stopped, and winner-pinned states are identical for everyone and stay as cacheable as before.
  if (!qa && assignments.some((a) => variesPerVisitor(a.def))) {
    headers.set("cache-control", "private, no-store");
    headers.append("vary", "Cookie");
  }

  if (visitorId && !existingId) {
    const cookie = visitorCookie(visitorId, url.protocol === "https:");
    if (cookie) headers.append("set-cookie", cookie);
  }

  // Exposure: once per visitor per experiment per day, only for a real visit to a currently running experiment.
  if (visitorId && opts.db && opts.ctx) {
    const at = new Date().toISOString();
    for (const a of assignments) {
      if (a.def.status !== "running") continue;
      opts.ctx.waitUntil(
        recordExpEvent(opts.db, { experiment: a.def.id, variant: a.variant.id, visitor: visitorId, event: "exposure", day, at }),
      );
    }
  }

  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}
