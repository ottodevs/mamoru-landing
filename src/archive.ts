/**
 * Versions of the landing and the deck, kept for /ops/archive.
 *
 * Production serves one landing (/) and one deck (/deck). Every version gets a number here
 * (landing v2, deck v1.1, ...); that number lives only in this list, never on the public page.
 * Retiring a version: freeze it (below), then replace the page. No second public route.
 *
 * Each snapshot is the built page of one commit, frozen as a single HTML file under
 * public/ops/archive/<id>/index.html, its stylesheet inlined and its images and fonts
 * copied once into public/ops/archive/assets/. Everything under /ops goes through the
 * Google gate in worker.ts, so these files are never public.
 *
 * Adding one: append an entry here (id = `<kind>-v<version>` with dots as hyphens), then
 * `bun scripts/archive-snapshot.ts <id>`, then move LIVE to the new version.
 * A snapshot is never rebuilt once committed: it is the record of what was live.
 */

export type ArchiveKind = "landing" | "deck";

export interface ArchiveSnapshot {
  /** Folder name under /ops/archive. Lowercase, digits and hyphens. */
  id: string;
  kind: ArchiveKind;
  /** "v1", "v1.1": the version number shown in the archive. */
  version: string;
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
    id: "landing-v0",
    version: "v0",
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
    id: "landing-v1",
    version: "v1",
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
    id: "deck-v1",
    version: "v1",
    kind: "deck",
    title: "Tokyo deck",
    note: "The pitch deck of the ETHGlobal Tokyo submission. Replaced at /deck by v2 on 16 Oct.",
    servedAt: "/deck",
    from: "2026-09-26",
    to: "2026-10-16",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "deck/index.html",
  },
  {
    id: "deck-v1-1",
    version: "v1.1",
    kind: "deck",
    title: "Attack-first pitch",
    note: "A variant of v1 that opens with a refused attack, served beside it at /pitch. Retired on 16 Oct.",
    servedAt: "/pitch",
    from: "2026-10-02",
    to: "2026-10-16",
    commit: "676e0c610a9f336a7f554a3fda7acb10aa9610b3",
    page: "pitch/index.html",
  },
  {
    id: "landing-v2",
    version: "v2",
    kind: "landing",
    title: "Savings, automated",
    note: "Flat washi paper, the three-step how it works (Fund / Mamoru works / You save) and the allocation before slide 3 v3. Replaced by v3 on 27 Oct.",
    servedAt: "/",
    from: "2026-10-16",
    to: "2026-10-27",
    commit: "b7ec70f57a8e6da34837a178e6d46b1f1fc95ac8",
    page: "open/index.html",
  },
  {
    id: "deck-v2",
    version: "v2",
    kind: "deck",
    title: "Savings, automated",
    note: "The deck on flat washi paper, before Kami A and the 守 seal. Replaced at /deck by v3 on 26 Oct.",
    servedAt: "/deck",
    from: "2026-10-16",
    to: "2026-10-26",
    commit: "55ead8035308f5baaef9716953177a997ce36c2e",
    page: "deck/index.html",
  },
  {
    id: "landing-v3",
    version: "v3",
    kind: "landing",
    title: "Kami A, the film's flow and the 守 seal",
    note: "Kami A paper, how it works as the launch film's canvas scene (USDC into the column, yield into Stables) and the flat allocation column below it. Shown without its script, so the canvas stays blank. Replaced by v4 on 27 Oct.",
    servedAt: "/",
    from: "2026-10-27",
    to: "2026-10-27",
    commit: "9667ad83a337d49ccbfbde280d7dbf793f3b783c",
    page: "open/index.html",
    static: true,
  },
];

/** What is live today, listed beside the archive so the two read as one history. */
export const LIVE: readonly { kind: ArchiveKind; version: string; title: string; href: string; since: string }[] = [
  { kind: "landing", version: "v4", title: "One deposit, one column: how it works pinned to the allocation", href: "/", since: "2026-10-27" },
  { kind: "deck", version: "v3", title: "Kami A and the 守 seal", href: "/deck", since: "2026-10-26" },
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
