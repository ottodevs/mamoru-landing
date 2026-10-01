/**
 * Pure logic of the /ops console router: which URLs are sections, which clicks
 * to take over, when a cached section is fresh, and what to do with a fragment
 * response.
 *
 * One self-contained factory, like topupLogic(): the shell script embeds
 * `opsRouterLogic.toString()` and the tests call the same function. Nothing in
 * here may reference anything outside the function.
 */

export interface RouteLink {
  /** Absolute URL of the link. */
  href: string;
  /** Origin of the current document. */
  origin: string;
  /** Path + search of the current document. */
  current: string;
  target: string;
  download: boolean;
  /** The link opted out (data-ops-full): it leaves the console. */
  full: boolean;
}

export interface RouteClick {
  button: number;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  prevented: boolean;
}

export interface CacheEntry {
  at: number;
}

export function opsRouterLogic() {
  var SECTIONS = [
    { id: "overview", path: "/ops" },
    { id: "mails", path: "/ops/mails" },
    { id: "infra", path: "/ops/infra" },
  ];
  /** A section this recent is painted without asking the server again. */
  var FRESH_MS = 15000;
  /** Past this it is not painted at all: the reader would be looking at old numbers. */
  var MAX_AGE_MS = 300000;
  var MAX_ENTRIES = 6;
  /** A navigation slower than this shows the progress line. */
  var PROGRESS_AFTER_MS = 150;

  var trim = function (pathname: string) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  };

  /** The section a path belongs to, or null when the path is not part of the console. */
  var sectionOf = function (pathname: string): string | null {
    var path = trim(String(pathname || ""));
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].path === path) return SECTIONS[i].id;
    }
    return null;
  };

  var parse = function (href: string, base: string): URL | null {
    try {
      return new URL(href, base);
    } catch (err) {
      return null;
    }
  };

  /** Cache key: the path only. `?fresh=1` asks the server to recompute, it is not another page. */
  var routeKey = function (href: string, base: string): string | null {
    var url = parse(href, base);
    if (!url || !sectionOf(url.pathname)) return null;
    return trim(url.pathname);
  };

  /** True when the URL asks for a recompute and so must skip the cache. */
  var wantsFresh = function (href: string, base: string) {
    var url = parse(href, base);
    return Boolean(url && url.searchParams.get("fresh") === "1");
  };

  /** Whether a click on a link is taken over by the router. Anything doubtful is left to the browser. */
  var shouldIntercept = function (link: RouteLink, click: RouteClick) {
    if (click.prevented || click.button !== 0) return false;
    if (click.meta || click.ctrl || click.shift || click.alt) return false;
    if (link.full || link.download) return false;
    if (link.target && link.target !== "_self") return false;
    var url = parse(link.href, link.origin);
    if (!url || url.origin !== link.origin) return false;
    if (!sectionOf(url.pathname)) return false;
    // Same page with a hash: an in-page jump, the browser scrolls.
    var here = parse(link.current, link.origin);
    if (url.hash && here && trim(here.pathname) === trim(url.pathname) && here.search === url.search) return false;
    return true;
  };

  var cacheState = function (entry: CacheEntry | null | undefined, now: number): "miss" | "fresh" | "stale" {
    if (!entry) return "miss";
    var age = now - entry.at;
    if (age < 0 || age > MAX_AGE_MS) return "miss";
    return age <= FRESH_MS ? "fresh" : "stale";
  };

  /** Keys to drop so the cache holds at most MAX_ENTRIES, oldest first. */
  var evict = function (entries: Record<string, CacheEntry>) {
    var keys = Object.keys(entries).sort(function (a, b) {
      return entries[a].at - entries[b].at;
    });
    return keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES));
  };

  /**
   * What a fragment response means. "login" and "full" both end in a real
   * navigation: a sign-in page is never rendered inside the console.
   */
  var classify = function (res: { status: number; type: string; auth: string; redirected: boolean; opaque: boolean }) {
    if (res.opaque || res.redirected) return "full";
    if (res.status === 401 && res.auth === "required") return "login";
    if (res.type.indexOf("application/json") === -1) return "full";
    if (res.status === 200 || res.status === 403 || res.status === 503) return "render";
    return "full";
  };

  /** A fragment body the router is willing to paint. */
  var isView = function (body: unknown) {
    var view = (body || {}) as { v?: unknown; section?: unknown; title?: unknown; html?: unknown };
    return view.v === 1 && typeof view.section === "string" && typeof view.title === "string" && typeof view.html === "string";
  };

  return {
    SECTIONS: SECTIONS,
    FRESH_MS: FRESH_MS,
    MAX_AGE_MS: MAX_AGE_MS,
    MAX_ENTRIES: MAX_ENTRIES,
    PROGRESS_AFTER_MS: PROGRESS_AFTER_MS,
    sectionOf: sectionOf,
    routeKey: routeKey,
    wantsFresh: wantsFresh,
    shouldIntercept: shouldIntercept,
    cacheState: cacheState,
    evict: evict,
    classify: classify,
    isView: isView,
  };
}

export type OpsRouterLogic = ReturnType<typeof opsRouterLogic>;
