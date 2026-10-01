/**
 * Assets, the landing waitlist, and the private list.
 * Addresses are stored. They are not logged.
 *
 *   WAITLIST              KV. Required for /api/notify.
 *   GOOGLE_CLIENT_ID      secret. Google OAuth client for /ops.
 *   GOOGLE_CLIENT_SECRET  secret. Same client.
 *   OPS_SESSION_SECRET    secret. Signs the /ops session and OAuth state cookies.
 *   LOOPS_API_KEY         secret. Loops Free API — welcome note send.
 *   LOOPS_TRANSACTIONAL_ID vars. Published Loops transactional template id.
 *   MAMORU_DB             D1. Read-only for accounts, users and account_activity;
 *                         written in metrics_daily (one row per UTC day) and
 *                         in exp_events (see src/exp-store.ts), both additive.
 *   BASE_RPC_URL          secret, optional. Tried before the public Base RPCs.
 *
 * /ops is Google sign-in only, allowlisted by exact email (src/google.ts).
 * Anything without a valid allowlisted session is sent to the root.
 * /ops/landing is that same gate, showing the page that replaces / at OPEN_AT.
 * /ops/app is that same gate, showing the UI mockup. It does not open at OPEN_AT.
 * /ops is the metrics overview; /ops/mails is the list. Every section is one
 * SectionView: a full document normally, a JSON fragment (body only) when the
 * console's router asks with `x-ops-fragment: 1`. The gate is the same for both.
 * /ops/infra is that same gate, showing relayer, cost, and accounts + TVL.
 * /ops/experiments is that same gate, read-only: the A/B ledger declared in
 * src/experiments.ts. Variants are served at serveSite() via src/exp-rewrite.ts;
 * POST /api/exp/event is the client goal beacon (src/exp-events.ts).
 * The cron (hourly, plus 00:05 UTC) upserts today's metrics_daily row.
 * /open is the built file for that page. Browsers never fetch it by path.
 */

import {
  bumpedLimit,
  deleteEntry,
  listEntries,
  readEntry,
  writeEntry,
  type Entry,
  type WaitlistKv,
} from "./list";
import {
  authorizeUrl,
  exchangeCode,
  isAllowed,
  pkceChallenge,
  randomToken,
  verifyIdToken,
} from "./google";
import {
  clearOauthCookie,
  clearSessionCookie,
  flashCookie,
  FLASH_COPY,
  fragmentBody,
  gateView,
  mailsSection,
  noticeHtml,
  oauthCookie,
  openOauthState,
  openSession,
  opsHeaders,
  readFlash,
  renderDocument,
  sealOauthState,
  sealSession,
  type SectionView,
  sessionCookie,
  type Flash,
} from "./ops";
import { infraSection } from "./ops-infra";
import { loadInfraReading } from "./infra-cache";
import { captureDaily } from "./metrics-store";
import { loadOverview } from "./metrics-overview";
import { overviewSection } from "./ops-metrics";
import type { D1Db } from "./d1-infra";
import { homeDocument, isOpen } from "./open-at";
import { applyExperiments } from "./exp-rewrite";
import { handleExpEvent, recordWaitlistSubmit } from "./exp-events";
import { loadExperimentReports } from "./exp-report";
import { experimentsSection } from "./ops-experiments";
import {
  isPreviewPath,
  previewReturnUrl,
  proxyPreview,
  selfGate,
  withStagingMeta,
} from "./staging-preview";
import { esc, normalizeEmail, sameSecret } from "./text";

export interface Env {
  ASSETS: Fetcher;
  WAITLIST?: WaitlistKv;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPS_SESSION_SECRET?: string;
  LOOPS_API_KEY?: string;
  LOOPS_TRANSACTIONAL_ID?: string;
  MAMORU_DB?: D1Db;
  BASE_RPC_URL?: string;
  // Staging preview channel (/ops/preview). See src/staging-preview.ts.
  DEPLOY_CHANNEL?: string;
  STAGING?: Fetcher;
  STAGING_URL?: string;
  STAGING_PROXY_SECRET?: string;
  STAGING_BASE_URL?: string;
  GIT_SHA?: string;
  DEPLOYED_AT?: string;
}

function loopsReady(env: Env): boolean {
  return Boolean(env.LOOPS_API_KEY && env.LOOPS_TRANSACTIONAL_ID);
}

type NotifyInput = { email: string; honey: string };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

async function readNotify(request: Request): Promise<NotifyInput | null> {
  const ctype = request.headers.get("content-type") || "";
  try {
    if (ctype.includes("application/json")) {
      const body = (await request.json()) as { email?: unknown; leave_blank?: unknown };
      return {
        email: String(body.email ?? ""),
        honey: String(body.leave_blank ?? ""),
      };
    }
    if (
      ctype.includes("application/x-www-form-urlencoded") ||
      ctype.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      return {
        email: String(form.get("email") ?? ""),
        honey: String(form.get("leave_blank") ?? ""),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Welcome note via Loops Free transactional API.
 * Template copy lives in Loops (Brais lines + custody). Worker only triggers send.
 * @see https://loops.so/docs/api-reference/send-transactional-email
 */
async function deliver(
  env: Env,
  email: string,
): Promise<"sent" | "failed" | "unlinked"> {
  const apiKey = env.LOOPS_API_KEY;
  const transactionalId = env.LOOPS_TRANSACTIONAL_ID;
  if (!apiKey || !transactionalId) return "unlinked";
  try {
    const res = await fetch("https://app.loops.so/api/v1/transactional", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": `mamoru-welcome:${email}`,
      },
      body: JSON.stringify({
        email,
        transactionalId,
        addToAudience: false,
      }),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (data && data.success === false) {
        console.error("loops_followup_failed", res.status);
        return "failed";
      }
      return "sent";
    }
    // 409 = idempotency replay within 24h → treat as already sent
    if (res.status === 409) return "sent";
    console.error("loops_followup_failed", res.status);
    return "failed";
  } catch {
    console.error("loops_followup_failed", "network");
    return "failed";
  }
}

export type NotifyStatus = "new" | "already";

/**
 * Save once. An address already on the list is left exactly as it is:
 * no rewrite, no second note. The welcome note only goes out when Loops is
 * wired; without it the entry stays "pending" and the signup still counts.
 */
export async function saveAndNote(
  _request: Request,
  env: Env,
  kv: WaitlistKv,
  email: string,
): Promise<NotifyStatus> {
  const existing = await readEntry(kv, email);
  if (existing) return "already";
  const entry: Entry = { email, at: new Date().toISOString(), note: "pending" };
  await writeEntry(kv, entry);
  if (!loopsReady(env)) return "new";
  const result = await deliver(env, email);
  if (result === "unlinked") return "new";
  try {
    await writeEntry(kv, {
      ...entry,
      note: result === "sent" ? "sent" : "failed",
      noteAt: new Date().toISOString(),
    });
  } catch {
    // The address is already saved; a lost note state is not a failed signup.
    console.error("note_state_write_failed");
  }
  return "new";
}

/** Short landing copy per outcome. The email body stays in follow-up.ts. */
export const NOTIFY_COPY = {
  new: "You're in.",
  already: "You're already on the list.",
  failed: "Could not save that. Try again.",
} as const;

function htmlPage(title: string, lines: readonly string[], status = 200): Response {
  const body = lines.map((line) => `<p>${esc(line)}</p>`).join("");
  return new Response(
    `<!DOCTYPE html><html lang="en"><meta charset="utf-8" /><title>${title}</title><body style="background:#F8F5EF;color:#0F0F0E;font-family:Georgia,serif;padding:3rem">${body}<p><a href="/">Back</a></p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function handleNotify(request: Request, env: Env, ctx?: Background): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  const input = await readNotify(request);
  const wantsHtml = !(request.headers.get("content-type") || "").includes("json");
  if (!input) {
    return wantsHtml
      ? htmlPage("Mamoru", ["That did not come through."])
      : json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (input.honey.trim()) {
    return wantsHtml ? htmlPage("Mamoru", [NOTIFY_COPY.new]) : json({ ok: true });
  }
  const email = normalizeEmail(input.email);
  if (!email) {
    return wantsHtml
      ? htmlPage("Mamoru", ["Enter an email."], 400)
      : json({ ok: false, error: "Invalid email" }, 400);
  }
  if (!env.WAITLIST) {
    console.error("waitlist_unbound");
    return wantsHtml
      ? htmlPage("Mamoru", [NOTIFY_COPY.failed], 503)
      : json({ ok: false, error: NOTIFY_COPY.failed }, 503);
  }
  if (await bumpedLimit(env.WAITLIST, "rl", clientIp(request), 8)) {
    return wantsHtml
      ? htmlPage("Mamoru", ["Try again later."], 429)
      : json({ ok: false, error: "Try again later" }, 429);
  }
  let status: NotifyStatus;
  try {
    status = await saveAndNote(request, env, env.WAITLIST, email);
  } catch {
    console.error("waitlist_write_failed");
    return wantsHtml
      ? htmlPage("Mamoru", [NOTIFY_COPY.failed], 503)
      : json({ ok: false, error: NOTIFY_COPY.failed }, 503);
  }
  // Server-side only: a genuinely new signup, never client-reported, so this goal cannot be spoofed.
  if (status === "new") recordWaitlistSubmit(request, env, ctx);
  return wantsHtml
    ? htmlPage("Mamoru", [NOTIFY_COPY[status]])
    : json({ ok: true, status });
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function opsResponse(
  html: string,
  cookies: string[] = [],
  status = 200,
  scriptNonce?: string,
): Response {
  const headers = opsHeaders(undefined, scriptNonce ? { scriptNonce } : undefined);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status, headers });
}

function redirectOps(request: Request, flash: Flash, cookies: string[], to = "/ops/mails"): Response {
  const headers = opsHeaders();
  headers.set("location", to);
  const secure = secureRequest(request);
  headers.append("set-cookie", flashCookie(flash, secure));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

const FRAGMENT_HEADER = "x-ops-fragment";

/** True when the console's router is asking for a section body instead of a document. */
function wantsFragment(request: Request): boolean {
  return request.headers.get(FRAGMENT_HEADER) === "1";
}

function fragmentHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    vary: FRAGMENT_HEADER,
  });
}

/**
 * A fragment request with no session. It carries no data, only the signal the
 * router turns into a real navigation, which then goes through Google.
 */
function fragmentSignIn(): Response {
  const headers = fragmentHeaders();
  headers.set("x-ops-auth", "required");
  return new Response(JSON.stringify({ v: 1, login: true }), { status: 401, headers });
}

/** Puts a notice line right under the page heading of a section. */
function withNotice(view: SectionView, text: string, tone: "plain" | "bad" = "plain"): SectionView {
  const mark = "</header>";
  const at = view.html.indexOf(mark);
  if (at < 0) return { ...view, html: noticeHtml(text, { tone }) + view.html };
  const cut = at + mark.length;
  return { ...view, html: view.html.slice(0, cut) + noticeHtml(text, { tone }) + view.html.slice(cut) };
}

/** Sections a stranger is sent to Google from, and returned to after signing in. */
const SECTION_PATHS = new Set(["/ops", "/ops/mails", "/ops/infra", "/ops/experiments"]);

/** Anyone who is not signed in and allowlisted sees the landing. Nothing else. */
function toRoot(request: Request, cookies: string[] = []): Response {
  const headers = new Headers({
    location: new URL("/", request.url).toString(),
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

type Oauth = { clientId: string; clientSecret: string; sessionSecret: string };

function oauthConfig(env: Env): Oauth | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OPS_SESSION_SECRET) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env.OPS_SESSION_SECRET,
  };
}

async function beginGoogle(
  oauth: Oauth,
  secure: boolean,
  host: string,
  redirectUri: string,
  next: string,
): Promise<Response> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const sealed = await sealOauthState(oauth.sessionSecret, {
    state,
    nonce,
    verifier,
    next,
  });
  const headers = new Headers({
    location: authorizeUrl({
      clientId: oauth.clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge: await pkceChallenge(verifier),
    }),
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", oauthCookie(sealed, secure, host));
  return new Response(null, { status: 302, headers });
}

type Background = { waitUntil(work: Promise<unknown>): void };

async function handleOps(request: Request, env: Env, ctx?: Background): Promise<Response> {
  const oauth = oauthConfig(env);
  // Not configured: fail closed. The list is unreachable, the landing is all anyone sees.
  if (!oauth) return toRoot(request);

  const url = new URL(request.url);
  const secure = secureRequest(request);
  const cookieHeader = request.headers.get("cookie");
  // Must match the URI registered on the Google client byte for byte.
  const callback = new URL("/ops/callback", request.url);
  if (callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") {
    callback.protocol = "https:";
  }
  const redirectUri = callback.toString();
  const session = await openSession(oauth.sessionSecret, cookieHeader);
  const flash = readFlash(cookieHeader);

  // A section starts Google when there is no session, and returns to that same section.
  // There is no /ops/login. The router's fragment requests get a bare signal instead:
  // a sign-in page is never rendered inside the console.
  const sectionPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (!session && SECTION_PATHS.has(sectionPath) && request.method === "GET") {
    if (wantsFragment(request)) return fragmentSignIn();
    return beginGoogle(oauth, secure, url.hostname, redirectUri, `https://mamoru.lol${sectionPath}`);
  }
  if (
    !session &&
    (url.pathname === "/ops/landing" || url.pathname === "/ops/landing/") &&
    request.method === "GET"
  ) {
    if (isOpen()) return notFound();
    return beginGoogle(
      oauth,
      secure,
      url.hostname,
      redirectUri,
      "https://mamoru.lol/ops/landing",
    );
  }

  const mock = mockPageAsset(url.pathname);
  if (!session && mock && request.method === "GET") {
    return beginGoogle(oauth, secure, url.hostname, redirectUri, mockReturn(url.pathname));
  }

  // /ops/preview is the staging channel preview. Same gate as everything else in /ops.
  if (!session && isPreviewPath(url.pathname) && request.method === "GET") {
    return beginGoogle(oauth, secure, url.hostname, redirectUri, previewReturnUrl(url.pathname));
  }

  // Return from Google. Any doubt sends to the root with no session.
  if (url.pathname === "/ops/callback" && request.method === "GET") {
    const clear = [clearOauthCookie(secure, url.hostname)];
    const stored = await openOauthState(oauth.sessionSecret, cookieHeader);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!stored || !code || !state) return toRoot(request, clear);
    if (!(await sameSecret(state, stored.state))) return toRoot(request, clear);
    const idToken = await exchangeCode({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      redirectUri,
      code,
      codeVerifier: stored.verifier,
    });
    if (!idToken) return toRoot(request, clear);
    const identity = await verifyIdToken(idToken, oauth.clientId, stored.nonce);
    if (!identity) return toRoot(request, clear);
    if (!isAllowed(identity.email)) {
      // Only reachable after a completed Google sign-in. It names no section and holds no data.
      const denied = gateView({
        title: "This account does not have access",
        lines: [
          `You signed in with Google as ${identity.email}. That address is not on the list for this console.`,
          "If it should be, ask for it to be added, then sign in again.",
        ],
        link: { href: "/", label: "Back to mamoru.lol" },
      });
      const nonce = randomToken(16);
      return opsResponse(renderDocument(denied, { nonce, chrome: false }), clear, 403, nonce);
    }
    const token = await sealSession(oauth.sessionSecret, identity.email);
    const next = allowedReturn(stored.next);
    const sessionSet = sessionCookie(token, secure, url.hostname);
    if (next) {
      const headers = new Headers({
        location: next,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "referrer-policy": "no-referrer",
      });
      for (const item of [...clear, sessionSet]) headers.append("set-cookie", item);
      return new Response(null, { status: 303, headers });
    }
    return redirectOps(request, "", [...clear, sessionSet], "/ops");
  }

  if (!session) return notFound();

  // A stale session whose address was later removed from the allowlist ends here.
  if (!isAllowed(session.email)) {
    return notFound();
  }

  if (
    (url.pathname === "/ops/landing" || url.pathname === "/ops/landing/") &&
    request.method === "GET"
  ) {
    if (isOpen()) return notFound();
    return serveSite(request, env, true, ctx);
  }

  if (mock && (request.method === "GET" || request.method === "HEAD")) {
    return serveMock(request, env, mock);
  }

  if (isPreviewPath(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
    return proxyPreview(request, env, url);
  }

  const fragment = wantsFragment(request);
  const sources = { rpcUrl: env.BASE_RPC_URL, db: env.MAMORU_DB, kv: env.WAITLIST };
  // With ctx, an aged reading is served at once and recomputed behind the response.
  const behind = ctx ? { waitUntil: (work: Promise<unknown>) => ctx.waitUntil(work) } : {};

  /** A section as a full document, or as the JSON fragment the router swaps in. */
  const respond = (view: SectionView, cookies: string[] = []): Response => {
    if (fragment) {
      const headers = fragmentHeaders();
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(fragmentBody(view), { status: view.status ?? 200, headers });
    }
    const nonce = randomToken(16);
    return opsResponse(
      renderDocument(view, { csrf: session.csrf, who: session.email, nonce }),
      cookies,
      view.status ?? 200,
      nonce,
    );
  };
  /** A flash left by a redirect is shown once, on whichever section the reader lands. */
  const flashed = (view: SectionView): Response => {
    if (!flash) return respond(view);
    return respond(withNotice(view, FLASH_COPY[flash], flash === "bad" || flash === "failed" ? "bad" : "plain"), [
      flashCookie("", secure),
    ]);
  };
  const overviewView = async (fresh: boolean): Promise<SectionView> => {
    const reading = await loadInfraReading(sources, fresh, undefined, behind);
    const overview = await loadOverview(env.MAMORU_DB, reading.snapshot, new Date(), reading.stale);
    return { ...overviewSection(overview, session.csrf), ...(reading.refreshing ? { refreshing: true } : {}) };
  };
  const infraView = async (fresh: boolean): Promise<SectionView> =>
    infraSection(await loadInfraReading(sources, fresh, undefined, behind), session.csrf);
  const experimentsView = async (): Promise<SectionView> => experimentsSection(await loadExperimentReports(env.MAMORU_DB));
  const mailsView = async (notice: Flash): Promise<SectionView> => {
    if (!env.WAITLIST) {
      return mailsSection({ entries: [], truncated: false, csrf: session.csrf, flash: notice, mailReady: false, connected: false });
    }
    const { entries, truncated } = await listEntries(env.WAITLIST);
    return mailsSection({ entries, truncated, csrf: session.csrf, flash: notice, mailReady: loopsReady(env) });
  };

  const form = request.method === "POST" ? await request.formData().catch(() => null) : null;
  const csrfOk = form ? await sameSecret(String(form.get("csrf") ?? ""), session.csrf) : false;
  /** After an action: the updated section in place for the router, a redirect with a flash otherwise. */
  const settle = async (to: "/ops" | "/ops/mails" | "/ops/infra", outcome: Flash, view: () => Promise<SectionView>): Promise<Response> => {
    if (!fragment) {
      if (!outcome) return new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
      return redirectOps(request, outcome, [], to);
    }
    if (to === "/ops/mails") return respond(await view());
    const fresh = await view();
    if (!outcome) return respond(fresh);
    return respond(withNotice(fresh, FLASH_COPY[outcome], outcome === "bad" ? "bad" : "plain"));
  };
  /** A wrong CSRF token never runs the action. The router gets a 403 with the section and the reason. */
  const refuse = async (to: "/ops" | "/ops/mails" | "/ops/infra", view: () => Promise<SectionView>): Promise<Response> => {
    if (!fragment) return redirectOps(request, "bad", [], to);
    const base = await view();
    return respond({ ...(to === "/ops/mails" ? base : withNotice(base, FLASH_COPY.bad, "bad")), status: 403 });
  };

  if (url.pathname === "/ops/logout" && request.method === "POST") {
    if (!csrfOk) return redirectOps(request, "bad", [], "/ops");
    return toRoot(request, [clearSessionCookie(secure, url.hostname)]);
  }

  if (url.pathname === "/ops/infra/refresh" && request.method === "POST") {
    if (!csrfOk) return refuse("/ops/infra", () => infraView(false));
    const view = await infraView(true);
    return settle("/ops/infra", "", async () => view);
  }

  if (sectionPath === "/ops/infra" && request.method === "GET") {
    return flashed(await infraView(url.searchParams.get("fresh") === "1"));
  }

  if (sectionPath === "/ops/experiments" && request.method === "GET") {
    return flashed(await experimentsView());
  }

  if (url.pathname === "/ops/metrics/snapshot" && request.method === "POST") {
    if (!csrfOk) return refuse("/ops", () => overviewView(false));
    // Without D1 there is no row to write; the Infra cache is still refreshed.
    const outcome = await captureDaily(sources);
    if (!outcome.snapshot) await loadInfraReading(sources, true);
    return settle("/ops", "", () => overviewView(false));
  }

  if (sectionPath === "/ops" && request.method === "GET") {
    return flashed(await overviewView(false));
  }

  if (url.pathname === "/ops/remove" && request.method === "POST") {
    if (!csrfOk) return refuse("/ops/mails", () => mailsView("bad"));
    if (!env.WAITLIST) return respond(await mailsView(""));
    const email = normalizeEmail(String(form?.get("email") ?? ""));
    if (email) await deleteEntry(env.WAITLIST, email);
    return settle("/ops/mails", "removed", () => mailsView("removed"));
  }

  if (url.pathname === "/ops/send" && request.method === "POST") {
    if (!csrfOk) return refuse("/ops/mails", () => mailsView("bad"));
    if (!env.WAITLIST) return respond(await mailsView(""));
    if (!loopsReady(env)) return settle("/ops/mails", "waiting", () => mailsView("waiting"));
    const { entries } = await listEntries(env.WAITLIST);
    let failed = false;
    let sent = 0;
    for (const entry of entries) {
      if (entry.note === "sent" || sent >= 25) continue;
      const result = await deliver(env, entry.email);
      if (result === "sent") {
        sent += 1;
        await writeEntry(env.WAITLIST, {
          ...entry,
          note: "sent",
          noteAt: new Date().toISOString(),
        });
      } else if (result === "failed") {
        failed = true;
        await writeEntry(env.WAITLIST, {
          ...entry,
          note: "failed",
          noteAt: new Date().toISOString(),
        });
      }
    }
    const outcome: Flash = failed ? "failed" : sent ? "sent" : "waiting";
    return settle("/ops/mails", outcome, () => mailsView(outcome));
  }

  if (sectionPath === "/ops/mails" && request.method === "GET") {
    const view = await mailsView(flash);
    return respond(view, flash ? [flashCookie("", secure)] : []);
  }

  return notFound();
}

const PREVIEW_STYLE =
  ".mamoru-preview{padding-bottom:3.25rem}" +
  ".mamoru-preview-bar{position:fixed;left:0;right:0;bottom:0;z-index:4;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding:.7rem 1.25rem;background:#f4f0e6;color:#0f0f0e;border-top:1px solid #d9d2c3;font:16px/1.4 Georgia,serif}" +
  ".mamoru-preview-bar a{color:#2f5d50}";

const PREVIEW_BAR =
  '<div class="mamoru-preview-bar"><span>Preview. This becomes the front page when the countdown ends.</span><a href="/ops">Back to ops</a></div>';

function notFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * HTML only. `no-transform` stops Cloudflare from injecting the Web Analytics
 * beacon. A short Permissions-Policy keeps the browser from appending feature
 * names it no longer understands.
 */
function finish(response: Response): Response {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  const cache = headers.get("cache-control") ?? "no-store";
  if (!/\bno-transform\b/i.test(cache)) {
    headers.set("cache-control", `${cache}, no-transform`);
  }
  if (!headers.has("permissions-policy")) {
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveMark(request: Request, env: Env): Promise<Response> {
  const assetUrl = new URL("/mark-two-stones.png", request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  const type = asset.headers.get("content-type") || "";
  if (!asset.ok || !type.startsWith("image/")) return notFound();
  const headers = new Headers(asset.headers);
  headers.set("content-type", type);
  headers.set("cache-control", "public, max-age=86400");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(asset.body, { status: 200, headers });
}

/**
 * True only for a verified, allowlisted /ops session — the same check
 * handleOps() itself requires before it ever reaches a section. Since `/`
 * is the real public homepage once OPEN_AT has passed, this is what lets a
 * signed-in operator force the QA override there; a stranger never has one.
 */
async function hasOpsSession(request: Request, env: Env): Promise<boolean> {
  const oauth = oauthConfig(env);
  if (!oauth) return false;
  const session = await openSession(oauth.sessionSecret, request.headers.get("cookie"));
  return Boolean(session && isAllowed(session.email));
}

/**
 * The post-countdown page. Preview adds a private bar and noindex.
 * Before either, experiment variants are applied at the edge (see
 * src/exp-rewrite.ts). The QA override (`?exp=<id>:<variant>`) is allowed in
 * preview (always behind the /ops Google gate), on the staging channel's own
 * public "/" (staging exists precisely to look at something before it is
 * real), and — since this same function serves the real public "/" once
 * OPEN_AT has passed — for a request carrying a verified, allowlisted /ops
 * session even there. A stranger gets none of that: assignment, not override.
 */
async function serveSite(request: Request, env: Env, preview: boolean, ctx?: Background): Promise<Response> {
  const assetUrl = new URL("/open/index.html", request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!asset.ok) return notFound();
  const baseHeaders = new Headers(asset.headers);
  baseHeaders.set("content-type", "text/html; charset=utf-8");
  baseHeaders.set("x-content-type-options", "nosniff");
  baseHeaders.set("referrer-policy", "strict-origin-when-cross-origin");
  baseHeaders.delete("content-length");

  const qaAllowed = preview || env.DEPLOY_CHANNEL === "staging" || (await hasOpsSession(request, env));
  const expResponse = await applyExperiments(
    new Response(asset.body, { status: asset.status, headers: baseHeaders }),
    request,
    "/",
    { qaAllowed, db: env.MAMORU_DB, ctx, secret: env.OPS_SESSION_SECRET },
  );
  const headers = new Headers(expResponse.headers);

  if (preview) {
    headers.set("cache-control", "no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.delete("content-encoding");
    let html = await expResponse.text();
    const style = `<style>${PREVIEW_STYLE}</style>`;
    html = html.includes("</head>")
      ? html.replace("</head>", `${style}</head>`)
      : style + html;
    if (html.includes("<body>")) {
      html = html.replace("<body>", `<body class="mamoru-preview">${PREVIEW_BAR}`);
    } else if (/<body\s[^>]*>/i.test(html)) {
      html = html.replace(/<body\s[^>]*>/i, (tag) => `${tag}${PREVIEW_BAR}`);
    } else {
      html = PREVIEW_BAR + html;
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(html, { status: 200, headers });
  }
  // applyExperiments only adds Vary when a running experiment can differ by visitor; otherwise this stays publicly cacheable.
  if (!headers.has("vary")) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: expResponse.status, headers });
  }
  return new Response(expResponse.body, { status: expResponse.status, headers });
}

const APP_HOST = "app.mamoru.lol";

const RETURN_TO = new Set([
  "https://mamoru.lol/ops",
  "https://mamoru.lol/ops/mails",
  "https://mamoru.lol/ops/infra",
  "https://mamoru.lol/ops/experiments",
  "https://mamoru.lol/ops/landing",
  "https://mamoru.lol/ops/app",
  "https://mamoru.lol/ops/app/onboarding",
  "https://mamoru.lol/ops/app/dashboard",
]);

function allowedReturn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith("https://mamoru.lol/ops/preview")) return raw;
  if (!RETURN_TO.has(raw)) return null;
  if (raw === "https://mamoru.lol/ops/landing" && isOpen()) return null;
  return raw;
}

/** The UI mockup, kept private under /ops/app for design iteration. */
function mockPageAsset(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/ops/app") return "/app/index.html";
  if (path === "/ops/app/onboarding") return "/app/onboarding/index.html";
  if (path === "/ops/app/dashboard") return "/app/dashboard/index.html";
  return null;
}

function mockReturn(pathname: string): string {
  return `https://mamoru.lol${pathname.replace(/\/+$/, "")}`;
}

async function serveMock(request: Request, env: Env, assetPath: string): Promise<Response> {
  const assetUrl = new URL(assetPath, request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!asset.ok) return notFound();
  const headers = new Headers(asset.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(asset.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx?: Background): Promise<Response> {
    const blocked = await selfGate(request, env);
    if (blocked) return blocked;
    return withStagingMeta(finish(await dispatch(request, env, ctx)), env);
  },

  /** Cron: upserts today's metrics_daily row. The 00:05 UTC run also settles yesterday's DAU. */
  async scheduled(event: { cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const sources = { rpcUrl: env.BASE_RPC_URL, db: env.MAMORU_DB, kv: env.WAITLIST };
    ctx.waitUntil(
      captureDaily(sources, { settleYesterday: event.cron === "5 0 * * *" }).then((outcome) => {
        if (!outcome.ok && outcome.reason !== "no-db") console.error("metrics_capture_failed", outcome.reason);
      }),
    );
  },
};

async function dispatch(request: Request, env: Env, ctx?: Background): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const path = url.pathname;
    const lower = path.toLowerCase();

    if (host === "www.mamoru.lol") {
      const dest = new URL(request.url);
      dest.protocol = "https:";
      dest.hostname = "mamoru.lol";
      return Response.redirect(dest.toString(), 308);
    }

    if (lower === "/favicon.ico" && (request.method === "GET" || request.method === "HEAD")) {
      return serveMark(request, env);
    }

    // /app does not exist. Not on the apex, not on the app host.
    if (lower === "/app" || lower.startsWith("/app/")) return notFound();

    // app.mamoru.lol belongs to the mamoru-app Worker. Nothing here answers it.
    if (host === APP_HOST) return notFound();

    if (path === "/ops" || path.startsWith("/ops/")) {
      return handleOps(request, env, ctx);
    }

    if (path === "/api/notify") return handleNotify(request, env, ctx);

    if (path === "/api/exp/event") return handleExpEvent(request, env, ctx);

    const doc = homeDocument(path);
    if (doc === "hidden") return notFound();
    if (doc === "site" && (request.method === "GET" || request.method === "HEAD")) {
      return markHome(await serveSite(request, env, false, ctx), "site");
    }
    const asset = await env.ASSETS.fetch(request);
    return doc === "teaser" ? markHome(asset, "teaser", true) : asset;
}

/** Tells the countdown which page / serves right now, so it reloads on the server's clock. */
function markHome(response: Response, doc: "site" | "teaser", noStore = false): Response {
  const headers = new Headers(response.headers);
  headers.set("x-mamoru-home", doc);
  if (noStore) headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
