/**
 * Serves experiment variants at the edge. Static Astro pages carry
 * `data-exp="<id>"` hooks (and, on the element that completes a goal,
 * `data-exp-goal="<goal>"`); this file is the only place that rewrites them,
 * with HTMLRewriter, so the build output itself never changes per variant —
 * only the response does. No flicker: the swap happens before any byte
 * reaches the browser.
 *
 * Byte-identical guarantee: when nothing registered on `path` is effectively
 * active (no experiment running, no winner ever pinned) and no QA override
 * applies, `applyExperiments` returns the exact Response it was given — no
 * rewriter pass, no cookie, no Vary, no cache-control change, no script. A
 * visitor who never meets an active experiment never gets an identifier.
 *
 * A pinned winner is no longer an experiment: it is the page, for everyone,
 * including an opted-out visitor or a bot — no identifier, no events, and
 * the response stays publicly cacheable because it is identical for all.
 * A running experiment with no winner yet is the opposite: it can differ by
 * visitor (an opted-out visitor reads as control, others get their bucket),
 * so every response for that path is private, no-store, for every visitor —
 * opted out or not — because a shared cache cannot tell which is which.
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
  winnerVariant,
} from "./experiments";
import { expNonce } from "./exp-events";
import { recordExpEvent } from "./exp-store";
import { randomToken } from "./google";
import { eligibleForExperiments, newIdentityAllowed, newVisitorId, readVisitorId, visitorCookie } from "./exp-visitor";
import type { WaitlistKv } from "./list";
import { utcDay } from "./metrics-math";

export interface Background {
  waitUntil(work: Promise<unknown>): void;
}

export interface ExpContext {
  /** Allowed to force a variant with `?exp=<id>:<variant>` — a verified ops session, or the staging channel. */
  qaAllowed: boolean;
  db?: D1Db;
  ctx?: Background;
  /** EXP_VISITOR_SECRET: signs the visitor cookie and derives the beacon nonce. Without it, no visitor is ever identified. */
  secret?: string;
  /** WAITLIST KV, reused to cap new-identity minting per IP prefix per day. */
  kv?: WaitlistKv;
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
  /** True when this came from a pinned winner: identical for everyone, no identifier, no events. */
  uniform: boolean;
}

function escapeForSelector(value: string): string {
  // Registry ids are validated against ID_PATTERN ([a-z0-9_]{1,40}) at module load (src/experiments.ts),
  // so this can never actually need to escape anything; it stays as a defensive quote-escape, not a parser.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Escapes what would let embedded JSON break out of an inline <script> tag or inject markup: <, >, &, U+2028/9. */
export function escapeForInlineScript(json: string): string {
  return json
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

function clickScript(assignments: readonly Assignment[], nonce: string): string {
  const variantOf: Record<string, string> = {};
  for (const a of assignments) variantOf[a.def.id] = a.variant.id;
  const payload = escapeForInlineScript(JSON.stringify(variantOf));
  const n = escapeForInlineScript(JSON.stringify(nonce));
  return `(function(){var A=${payload};var N=${n};document.addEventListener("click",function(ev){var t=ev.target&&ev.target.closest?ev.target.closest("[data-exp][data-exp-goal]"):null;if(!t)return;var exp=t.getAttribute("data-exp");var v=A[exp];if(!v)return;var body=JSON.stringify({experiment:exp,variant:v,event:t.getAttribute("data-exp-goal"),nonce:N});try{if(navigator.sendBeacon){navigator.sendBeacon("/api/exp/event",new Blob([body],{type:"text/plain"}));}else if(window.fetch){fetch("/api/exp/event",{method:"POST",body:body,headers:{"content-type":"text/plain"},keepalive:true});}}catch(e){}},true);})();`;
}

/**
 * Resolves, rewrites, and (for a real visit) logs exposure for every
 * experiment registered on `path`. Returns the original `response` untouched
 * whenever nothing registered there is active (no experiment running, no
 * winner pinned) and no valid QA override applies.
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
  const day = utcDay(now);
  const url = new URL(request.url);
  const qa = opts.qaAllowed ? parseQaOverride(url) : null;
  const qaDef = qa ? defs.find((d) => d.id === qa.experimentId) : undefined;
  const qaVariant = qaDef && qa ? variantById(qaDef, qa.variantId) : undefined;
  const qaActive = Boolean(qaDef && qaVariant);

  // "Active" = still running, or has a winner pinned (a winner is a terminal decision: it keeps showing
  // even after the experiment later stops or its endedAt passes). A truly dead experiment — draft, or
  // stopped/expired with no winner ever called — contributes nothing and falls through below.
  const anyActive = defs.some((d) => isRunning(d, now) || Boolean(winnerVariant(d)));
  if (!anyActive && !qaActive) return response;

  // A running experiment with no winner is the only thing that can actually differ by visitor (a pinned
  // winner is uniform for everyone, QA is a one-off). This is a path-level fact, not a per-request one:
  // it governs both whether a cookie is ever worth minting and whether the response may be cached.
  const anyRunningNoWinner = defs.some((d) => isRunning(d, now) && !winnerVariant(d));
  const needsVisitor = !qaActive && anyRunningNoWinner;

  const eligible = eligibleForExperiments(request);
  const existingId = await readVisitorId(request, opts.secret);
  let visitorId: string | null = null;
  if (eligible) {
    if (existingId) {
      visitorId = existingId;
    } else if (needsVisitor && opts.secret && (await newIdentityAllowed(opts.kv, request, day))) {
      visitorId = newVisitorId();
    }
  }

  const assignments: Assignment[] = [];
  for (const def of defs) {
    if (qaActive && qaDef!.id === def.id) {
      assignments.push({ def, variant: qaVariant!, forced: true, uniform: false });
      continue;
    }
    const winner = winnerVariant(def);
    if (winner) {
      // Uniform for everyone, not an experiment any more: no eligibility check, no identifier, no events.
      assignments.push({ def, variant: winner, forced: false, uniform: true });
      continue;
    }
    if (!isRunning(def, now)) continue; // dead: this hook is left exactly as authored.
    const assignedId = eligible && visitorId ? assignVariant(def, visitorId, now) : controlVariantId(def);
    const v = variantById(def, assignedId) ?? def.variants[0];
    if (v) assignments.push({ def, variant: v, forced: false, uniform: false });
  }
  if (!assignments.length) return response;

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

  if (qaActive || anyRunningNoWinner) {
    headers.set("cache-control", "private, no-store");
    headers.append("vary", "Cookie");
  }

  if (needsVisitor && visitorId && !existingId) {
    const cookie = await visitorCookie(opts.secret, visitorId, url.protocol === "https:");
    if (cookie) headers.append("set-cookie", cookie);
  }

  // Exposure: once per visitor per experiment per day, only for a real (non-forced, non-uniform) visit
  // to a running experiment — a pinned winner needs no identifier and gets no exposure row.
  if (visitorId && opts.db && opts.ctx) {
    const at = now.toISOString();
    for (const a of assignments) {
      if (a.forced || a.uniform || !isRunning(a.def, now)) continue;
      opts.ctx.waitUntil(
        recordExpEvent(opts.db, { experiment: a.def.id, variant: a.variant.id, visitor: visitorId, event: "exposure", day, at }),
      );
    }
  }

  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}
