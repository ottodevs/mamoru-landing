/**
 * Past versions of the landing and the deck, kept for /ops/archive.
 *
 * Each snapshot is the built page of one commit, frozen as a single HTML file under
 * public/ops/archive/<id>/index.html, its stylesheet inlined and its images and fonts
 * copied once into public/ops/archive/assets/. Everything under /ops goes through the
 * Google gate in worker.ts, so these files are never public.
 *
 * Adding one: append an entry here, then `bun scripts/archive-snapshot.ts <id>`.
 * A snapshot is never rebuilt once committed: it is the record of what was live.
 */

export type ArchiveKind = "landing" | "deck";

export interface ArchiveSnapshot {
  /** Folder name under /ops/archive. Lowercase, digits and hyphens. */
  id: string;
  kind: ArchiveKind;
  title: string;
  /** What it was, in one line. */
  note: string;
  /** Public path it was served at. */
  servedAt: string;
  /** First and last day it was live (ISO dates). */
  from: string;
  to: string;
  /** Commit the snapshot was built from. */
  commit: string;
  /** Built file inside that commit's dist/. */
  page: string;
  /** Drop every <script> and every form action: for pages whose script would leave the archive or write data. */
  static?: boolean;
}

export const ARCHIVE: readonly ArchiveSnapshot[] = [
  {
    id: "2026-09-25-teaser",
    kind: "landing",
    title: "Countdown teaser",
    note: "The page before ETHGlobal Tokyo closed: mark, countdown and the email bar. Shown without its script, so the countdown stands still.",
    servedAt: "/",
    from: "2026-09-25",
    to: "2026-09-27",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "index.html",
    static: true,
  },
  {
    id: "2026-09-27-landing-tokyo",
    kind: "landing",
    title: "Tokyo landing (APY delivered)",
    note: "The landing judges and the first users saw: APY delivered, the harvest flow, allocation and FAQ.",
    servedAt: "/",
    from: "2026-09-27",
    to: "2026-10-16",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "open/index.html",
  },
  {
    id: "2026-09-26-deck-tokyo",
    kind: "deck",
    title: "Tokyo deck",
    note: "The pitch deck of the ETHGlobal Tokyo submission. Still live at /deck; frozen here so /deck can change.",
    servedAt: "/deck",
    from: "2026-09-26",
    to: "2026-10-16",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "deck/index.html",
  },
  {
    id: "2026-10-02-pitch",
    kind: "deck",
    title: "Attack-first pitch",
    note: "The deck variant that opens with a refused attack. Retired from /pitch on 16 Oct.",
    servedAt: "/pitch",
    from: "2026-10-02",
    to: "2026-10-16",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "pitch/index.html",
  },
];

/** What is live today, listed beside the archive so the two read as one history. */
export const LIVE: readonly { kind: ArchiveKind; title: string; href: string; since: string }[] = [
  { kind: "landing", title: "Savings, automated", href: "/", since: "2026-10-16" },
  { kind: "deck", title: "Tokyo deck", href: "/deck", since: "2026-09-26" },
  { kind: "deck", title: "Deck v2 (working copy)", href: "/deck-v2", since: "2026-10-16" },
];

export const ARCHIVE_PREFIX = "/ops/archive";

export const ASSET_NAME = /^[a-z0-9][a-z0-9._-]*\.(css|png|webp|jpe?g|svg|ttf|woff2?)$/i;

export type ArchiveTarget = { kind: "list" } | { kind: "missing" } | { kind: "page"; snapshot: ArchiveSnapshot; asset: string } | { kind: "asset"; asset: string };

/** What a path under /ops/archive points at, or null when it is not an archive path at all. */
export function archiveTarget(pathname: string): ArchiveTarget | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === ARCHIVE_PREFIX) return { kind: "list" };
  if (!path.startsWith(`${ARCHIVE_PREFIX}/`)) return null;
  const rest = path.slice(ARCHIVE_PREFIX.length + 1);
  if (rest.startsWith("assets/")) {
    const name = rest.slice("assets/".length);
    return ASSET_NAME.test(name) ? { kind: "asset", asset: `${ARCHIVE_PREFIX}/assets/${name}` } : { kind: "missing" };
  }
  const id = rest.endsWith("/index.html") ? rest.slice(0, -"/index.html".length) : rest;
  const snapshot = ARCHIVE.find((s) => s.id === id);
  if (!snapshot) return { kind: "missing" };
  return { kind: "page", snapshot, asset: `${ARCHIVE_PREFIX}/${snapshot.id}/index.html` };
}
