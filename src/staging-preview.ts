/**
 * Staging preview channel.
 *
 * The `staging` branch deploys a second Worker, `mamoru-lol-staging`
 * (wrangler env `staging`), on workers.dev only. It never serves eyeball
 * traffic on its own: every response is noindexed, and any document request
 * must carry STAGING_PROXY_SECRET in the X-Mamoru-Staging-Secret header.
 * This Worker (prod) is the only caller that holds that secret, and it
 * attaches it on every request it proxies in, whether over the STAGING
 * service binding or the STAGING_URL fallback fetch.
 *
 * `/ops/preview` and `/ops/preview/*` sit behind the exact Google session
 * gate `handleOps()` already enforces for `/ops` (see worker.ts), then proxy
 * to staging and rewrite the response:
 *
 *   - Non-HTML (assets) pass through unchanged.
 *   - HTML gets a cross-origin `<base href="https://<staging>.workers.dev/">`
 *     prepended to <head>, so the browser loads the staged build's own
 *     CSS/JS/fonts/images straight from the staging Worker by their
 *     original, unprefixed paths. Rewriting every absolute href/src (and
 *     url() inside CSS) the `staging` branch might ever emit is not robust
 *     to future changes there; <base> sidesteps that entirely.
 *   - A fixed "STAGING preview · <sha> · <deployed at>" banner is appended
 *     to <body> via HTMLRewriter.
 *
 * Trade-off from the <base> approach: asset requests (css/js/fonts/images)
 * go directly to the staging workers.dev origin and do not carry the
 * secret, so the staging Worker's self-gate exempts plain static-asset
 * paths by extension. Only generic build output is reachable that way,
 * nothing from the page itself (copy, markup, data) — every HTML/document
 * route on staging, including `/`, still requires the secret. Reaching the
 * rendered page at all still requires the prod Google session.
 */

import { sameSecret } from "./text";

export const STAGING_PROXY_HEADER = "x-mamoru-staging-secret";
const SHA_HEADER = "x-mamoru-staging-sha";
const DEPLOYED_HEADER = "x-mamoru-staging-deployed-at";
export const PREVIEW_PREFIX = "/ops/preview";

const ASSET_EXTENSIONS =
  /\.(css|m?js|map|png|jpe?g|webp|gif|avif|svg|ico|woff2?|ttf|otf|json|txt|webmanifest)$/i;

export interface StagingSelfEnv {
  DEPLOY_CHANNEL?: string;
  STAGING_PROXY_SECRET?: string;
  GIT_SHA?: string;
  DEPLOYED_AT?: string;
}

function isStagingChannel(env: StagingSelfEnv): boolean {
  return env.DEPLOY_CHANNEL === "staging";
}

function isStaticAsset(pathname: string): boolean {
  return ASSET_EXTENSIONS.test(pathname);
}

function refused(): Response {
  return new Response("Not found.", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * Call first in fetch(), on every deployment. A no-op unless this
 * deployment is the staging channel (DEPLOY_CHANNEL === "staging"); on
 * staging, refuses any document request without the shared secret.
 */
export async function selfGate(request: Request, env: StagingSelfEnv): Promise<Response | null> {
  if (!isStagingChannel(env)) return null;
  const pathname = new URL(request.url).pathname;
  if (isStaticAsset(pathname)) return null;
  const secret = env.STAGING_PROXY_SECRET;
  const provided = request.headers.get(STAGING_PROXY_HEADER) ?? "";
  if (!secret || !(await sameSecret(provided, secret))) return refused();
  return null;
}

/** Marks every response leaving the staging channel. A no-op for prod. */
export function withStagingMeta(response: Response, env: StagingSelfEnv): Response {
  if (!isStagingChannel(env)) return response;
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set(SHA_HEADER, env.GIT_SHA || "unknown");
  headers.set(DEPLOYED_HEADER, env.DEPLOYED_AT || "unknown");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isPreviewPath(pathname: string): boolean {
  return pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`);
}

/** The OAuth `next` to return to after sign-in, for any preview sub-path. */
export function previewReturnUrl(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return `https://mamoru.lol${trimmed || PREVIEW_PREFIX}`;
}

export interface ProxyEnv {
  STAGING?: Fetcher;
  STAGING_URL?: string;
  STAGING_PROXY_SECRET?: string;
  STAGING_BASE_URL?: string;
}

async function fetchStaging(env: ProxyEnv, path: string, method: string): Promise<Response | null> {
  const secret = env.STAGING_PROXY_SECRET;
  if (!secret) return null;
  const headers = new Headers({ [STAGING_PROXY_HEADER]: secret });
  const init = { method, headers } as RequestInit;
  if (env.STAGING) {
    return env.STAGING.fetch(new URL(path, "https://staging.internal/").toString(), init);
  }
  if (env.STAGING_URL) {
    return fetch(new URL(path, env.STAGING_URL).toString(), init);
  }
  return null;
}

const BANNER_STYLE =
  ".mamoru-staging-banner{position:fixed;left:0;right:0;top:0;z-index:2147483647;" +
  "display:flex;justify-content:center;padding:.4rem .8rem;background:#1c1c1c;" +
  "color:#f4f0e6;font:12px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.02em}";

function injectBase(href: string) {
  return {
    element(el: { prepend: (content: string, opts: { html: boolean }) => void }) {
      el.prepend(`<base href="${href}">`, { html: true });
    },
  };
}

function injectBanner(label: string) {
  return {
    element(el: { append: (content: string, opts: { html: boolean }) => void }) {
      el.append(`<style>${BANNER_STYLE}</style><div class="mamoru-staging-banner">${label}</div>`, {
        html: true,
      });
    },
  };
}

function unavailable(): Response {
  return new Response("The staging preview is not configured.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * Proxies an already-authenticated, allowlisted request under /ops/preview
 * to the staging Worker. Call only after the same checks `/ops` itself uses
 * (session + isAllowed) have passed.
 */
export async function proxyPreview(request: Request, env: ProxyEnv, url: URL): Promise<Response> {
  const inner = (url.pathname.slice(PREVIEW_PREFIX.length) || "/") + url.search;
  const upstream = await fetchStaging(env, inner, request.method);
  if (!upstream) return unavailable();

  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.delete("content-length");

  const type = headers.get("content-type") || "";
  if (!type.includes("text/html")) {
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  headers.delete("content-encoding");
  if (request.method === "HEAD") {
    return new Response(null, { status: upstream.status, headers });
  }

  const sha = (upstream.headers.get(SHA_HEADER) || "unknown").slice(0, 12);
  const deployedAt = upstream.headers.get(DEPLOYED_HEADER) || "unknown";
  const base = env.STAGING_BASE_URL || env.STAGING_URL || "/";
  return new HTMLRewriter()
    .on("head", injectBase(base))
    .on("body", injectBanner(`STAGING preview &middot; ${sha} &middot; ${deployedAt}`))
    .transform(new Response(upstream.body, { status: upstream.status, headers }));
}
