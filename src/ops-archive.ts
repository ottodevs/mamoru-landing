/** Renders /ops/archive: the live version of the landing and the deck, and every past version. Read-only. */

import { ARCHIVE, ARCHIVE_PREFIX, LIVE, type ArchiveKind, type ArchiveSnapshot } from "./archive";
import { pageHead, type SectionView } from "./ops";
import { esc } from "./text";

const KIND_LABEL: Record<ArchiveKind, string> = { landing: "Landing", deck: "Deck" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Sep 2026" from an ISO date. */
function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function span(from: string, to: string): string {
  return `<time datetime="${esc(from)}">${esc(day(from))}</time> to <time datetime="${esc(to)}">${esc(day(to))}</time>`;
}

function snapshotRow(s: ArchiveSnapshot): string {
  return `<tr>
    <td>${esc(s.version)}</td>
    <td><a href="${ARCHIVE_PREFIX}/${esc(s.id)}" target="_blank" rel="noopener">${esc(s.title)}</a><br><span class="soft">${esc(s.note)}</span></td>
    <td class="archive-wide">${esc(s.servedAt)}</td>
    <td>${span(s.from, s.to)}</td>
    <td class="archive-wide"><code title="${esc(s.commit)}">${esc(s.commit.slice(0, 7))}</code></td>
  </tr>`;
}

function kindBlock(kind: ArchiveKind): string {
  const live = LIVE.filter((l) => l.kind === kind)
    .map(
      (l) =>
        `<li>${esc(l.version)} &middot; <a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.title)}</a> <span class="soft">at ${esc(l.href)}, since ${esc(day(l.since))}</span></li>`,
    )
    .join("");
  const rows = ARCHIVE.filter((s) => s.kind === kind)
    .slice()
    .sort((a, b) => b.from.localeCompare(a.from) || b.version.localeCompare(a.version))
    .map(snapshotRow)
    .join("");
  return `<section class="archive-kind" aria-labelledby="archive-${kind}">
    <h2 id="archive-${kind}">${esc(KIND_LABEL[kind])}</h2>
    <p class="soft">Live now</p>
    <ul>${live}</ul>
    <table>
      <thead><tr><th>Version</th><th>Past version</th><th class="archive-wide">Served at</th><th>Live</th><th class="archive-wide">Commit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function archiveSection(): SectionView {
  return {
    section: "archive",
    title: "Archive",
    html: `${pageHead({ title: "Archive" })}
    <p class="lede">Production serves one landing and one deck. Each version has a number here, and every past one is frozen as it was built and opens in its own tab, behind this same sign-in. To retire a version: an entry in src/archive.ts, <code>bun scripts/archive-snapshot.ts &lt;id&gt;</code>, then replace the page.</p>
    <div class="cols" style="grid-template-columns:1fr">
      ${kindBlock("landing")}
      ${kindBlock("deck")}
    </div>`,
  };
}

const BAR_STYLE =
  ".mamoru-archive-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;" +
  "padding:.45rem .9rem;background:#1c1c1c;color:#f4f0e6;font:12px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.02em}" +
  ".mamoru-archive-bar a{color:#f4f0e6}";

/** The bar every archived page carries, so a snapshot is never mistaken for the live site. */
export function archiveBar(s: ArchiveSnapshot): string {
  const label = `ARCHIVE &middot; ${esc(KIND_LABEL[s.kind])} ${esc(s.version)} &middot; ${esc(s.title)} &middot; ${esc(day(s.from))} to ${esc(day(s.to))} &middot; ${esc(s.commit.slice(0, 7))}`;
  return `<style>${BAR_STYLE}</style><div class="mamoru-archive-bar"><span>${label}</span><a href="${ARCHIVE_PREFIX}">Back to the archive</a></div>`;
}
