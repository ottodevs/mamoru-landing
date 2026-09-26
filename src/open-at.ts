/** The instant the countdown page is retired. Opened 2026-09-26 (was 2026-09-27 09:00 JST). */
export const OPEN_AT_ISO = "2026-09-26T11:00:00Z";

export const OPEN_AT_MS = Date.parse(OPEN_AT_ISO);

export function isOpen(now = Date.now()): boolean {
  return Number.isFinite(OPEN_AT_MS) && now >= OPEN_AT_MS;
}

export type HomeDoc = "teaser" | "site" | "hidden" | "asset";

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/**
 * What `/` serves. `hidden` is the built file for the site page:
 * the worker reads it, and never lets a browser request it by path.
 */
export function homeDocument(pathname: string, now = Date.now()): HomeDoc {
  const path = normalizePath(pathname);
  const lower = path.toLowerCase();
  if (lower === "/open" || lower === "/open/index.html") return "hidden";
  if (path === "/" || lower === "/index.html") return isOpen(now) ? "site" : "teaser";
  return "asset";
}
