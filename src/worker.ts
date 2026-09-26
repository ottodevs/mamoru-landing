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
 *
 * /ops is Google sign-in only, allowlisted by exact email (src/google.ts).
 * Anything without a valid allowlisted session is sent to the root.
 * /ops/landing is that same gate, showing the page that replaces / at OPEN_AT.
 * /ops/app is that same gate, showing the UI mockup. It does not open at OPEN_AT.
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
  oauthCookie,
  openOauthState,
  openSession,
  opsHeaders,
  readFlash,
  renderList,
  sealOauthState,
  sealSession,
  sessionCookie,
  type Flash,
} from "./ops";
import { homeDocument, isOpen } from "./open-at";
import { esc, normalizeEmail, sameSecret } from "./text";

export interface Env {
  ASSETS: Fetcher;
  WAITLIST?: WaitlistKv;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPS_SESSION_SECRET?: string;
  LOOPS_API_KEY?: string;
  LOOPS_TRANSACTIONAL_ID?: string;
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

async function handleNotify(request: Request, env: Env): Promise<Response> {
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
  return wantsHtml
    ? htmlPage("Mamoru", [NOTIFY_COPY[status]])
    : json({ ok: true, status });
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function opsResponse(html: string, cookies: string[] = [], status = 200): Response {
  const headers = opsHeaders();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status, headers });
}

function redirectOps(request: Request, flash: Flash, cookies: string[]): Response {
  const headers = opsHeaders();
  headers.set("location", "/ops");
  const secure = secureRequest(request);
  headers.append("set-cookie", flashCookie(flash, secure));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

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

async function handleOps(request: Request, env: Env): Promise<Response> {
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

  // /ops itself starts Google when there is no session. There is no /ops/login.
  if (!session && url.pathname === "/ops" && request.method === "GET") {
    return beginGoogle(oauth, secure, url.hostname, redirectUri, "https://mamoru.lol/ops");
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
    if (!identity || !isAllowed(identity.email)) return toRoot(request, clear);
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
    return redirectOps(request, "", [...clear, sessionSet]);
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
    return serveSite(request, env, true);
  }

  if (mock && (request.method === "GET" || request.method === "HEAD")) {
    return serveMock(request, env, mock);
  }

  if (url.pathname === "/ops/logout" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    return toRoot(request, [clearSessionCookie(secure, url.hostname)]);
  }

  if (!env.WAITLIST) {
    return opsResponse("<p>The list is not connected.</p>", [], 503);
  }

  if (url.pathname === "/ops/remove" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    const email = normalizeEmail(String(form.get("email") ?? ""));
    if (email) await deleteEntry(env.WAITLIST, email);
    return redirectOps(request, "removed", []);
  }

  if (url.pathname === "/ops/send" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    if (!loopsReady(env)) return redirectOps(request, "waiting", []);
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
    return redirectOps(request, failed ? "failed" : sent ? "sent" : "waiting", []);
  }

  if (url.pathname === "/ops" && request.method === "GET") {
    const { entries, truncated } = await listEntries(env.WAITLIST);
    return opsResponse(
      renderList({
        entries,
        truncated,
        csrf: session.csrf,
        flash,
        mailReady: loopsReady(env),
        who: session.email,
      }),
      [flashCookie("", secure)],
    );
  }

  return new Response("Not found.", { status: 404 });
}

const PREVIEW_STYLE =
  ".mamoru-preview{padding-bottom:3.25rem}" +
  ".mamoru-preview-bar{position:fixed;left:0;right:0;bottom:0;z-index:4;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding:.7rem 1.25rem;background:#f4f0e6;color:#0f0f0e;border-top:1px solid #d9d2c3;font:16px/1.4 Georgia,serif}" +
  ".mamoru-preview-bar a{color:#2f5d50}";

const PREVIEW_BAR =
  '<div class="mamoru-preview-bar"><span>Preview. This becomes the front page when the countdown ends.</span><a href="/ops">The list</a></div>';

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

/** The post-countdown page. Preview adds a private bar and noindex. */
async function serveSite(request: Request, env: Env, preview: boolean): Promise<Response> {
  const assetUrl = new URL("/open/index.html", request.url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!asset.ok) return notFound();
  const headers = new Headers(asset.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.delete("content-length");
  if (preview) {
    headers.set("cache-control", "no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.delete("content-encoding");
    let html = await asset.text();
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
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  if (request.method === "HEAD") {
    return new Response(null, { status: asset.status, headers });
  }
  return new Response(asset.body, { status: asset.status, headers });
}

const APP_HOST = "app.mamoru.lol";

const RETURN_TO = new Set([
  "https://mamoru.lol/ops",
  "https://mamoru.lol/ops/landing",
  "https://mamoru.lol/ops/app",
  "https://mamoru.lol/ops/app/onboarding",
  "https://mamoru.lol/ops/app/dashboard",
]);

function allowedReturn(raw: string | null | undefined): string | null {
  if (!raw || !RETURN_TO.has(raw)) return null;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    return finish(await dispatch(request, env));
  },
};

async function dispatch(request: Request, env: Env): Promise<Response> {
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
      return handleOps(request, env);
    }

    if (path === "/api/notify") return handleNotify(request, env);

    const doc = homeDocument(path);
    if (doc === "hidden") return notFound();
    if (doc === "site" && (request.method === "GET" || request.method === "HEAD")) {
      return markHome(await serveSite(request, env, false), "site");
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
