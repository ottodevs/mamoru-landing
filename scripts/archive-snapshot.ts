/**
 * Freezes past pages for /ops/archive (see src/archive.ts).
 *
 *   bun scripts/archive-snapshot.ts <id> [<id> ...]
 *
 * For each id: builds the entry's commit in a throwaway worktree, takes its built page,
 * inlines the stylesheet, copies every local image and font it uses into
 * public/ops/archive/assets/ and points the page there. Existing snapshots are not
 * overwritten unless --force is given.
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE, ARCHIVE_PREFIX, ASSET_NAME, type ArchiveSnapshot } from "../src/archive";

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const outRoot = join(root, "public", "ops", "archive");
const assetsDir = join(outRoot, "assets");
const args = process.argv.slice(2);
const force = args.includes("--force");
const ids = args.filter((a) => !a.startsWith("--"));
if (!ids.length) {
  console.error("usage: bun scripts/archive-snapshot.ts <id> [<id> ...] [--force]");
  process.exit(1);
}

const builds = new Map<string, string>();

/** Builds a commit once and returns its dist/ directory. */
async function distOf(commit: string): Promise<string> {
  const known = builds.get(commit);
  if (known) return known;
  const dir = join(tmpdir(), `mamoru-archive-${commit.slice(0, 12)}`);
  rmSync(dir, { recursive: true, force: true });
  await $`git -C ${root} worktree add -q --detach ${dir} ${commit}`;
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  await $`bun run build`.cwd(dir).quiet();
  builds.set(commit, join(dir, "dist"));
  return join(dir, "dist");
}

/** Copies one local file into the shared assets folder and returns its archive URL. */
function keepAsset(dist: string, ref: string): string {
  const clean = ref.split(/[?#]/)[0];
  const source = join(dist, clean);
  if (!existsSync(source)) throw new Error(`missing asset ${clean}`);
  const name = basename(clean);
  // The Worker serves only names it can match (src/archive.ts); anything else would 404 at runtime.
  if (!ASSET_NAME.test(name)) throw new Error(`asset name the archive cannot serve: ${name}`);
  const target = join(assetsDir, name);
  if (existsSync(target) && !readFileSync(target).equals(readFileSync(source))) {
    throw new Error(`asset name clash: ${name} differs from the one already archived`);
  }
  if (!existsSync(target)) copyFileSync(source, target);
  return `${ARCHIVE_PREFIX}/assets/${name}`;
}

/** Points every root-relative image/font URL (attributes and CSS) at the archived copy. */
function relink(text: string, dist: string): string {
  const local = /\.(png|webp|jpe?g|svg|ttf|woff2?)$/i;
  return text
    .replace(/(href|src)="(\/[^"/][^"]*)"/g, (all, attr: string, ref: string) =>
      local.test(ref.split(/[?#]/)[0]) ? `${attr}="${keepAsset(dist, ref)}"` : all,
    )
    .replace(/url\((["']?)(\/[^)"']+)\1\)/g, (all, q: string, ref: string) =>
      local.test(ref.split(/[?#]/)[0]) ? `url(${q}${keepAsset(dist, ref)}${q})` : all,
    );
}

async function snapshot(entry: ArchiveSnapshot): Promise<void> {
  const target = join(outRoot, entry.id, "index.html");
  if (existsSync(target) && !force) {
    console.log(`${entry.id}: kept (already archived)`);
    return;
  }
  const dist = await distOf(entry.commit);
  let html = readFileSync(join(dist, entry.page), "utf8");

  // One stylesheet per page in these builds: inline it so the snapshot does not depend on /_astro.
  html = html.replace(/<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"\s*\/?>/g, (_all, href: string) => {
    const css = readFileSync(join(dist, href), "utf8");
    return `<style>${css}</style>`;
  });

  if (entry.static) {
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    // Without an action a submit goes back to the snapshot's own URL, which only answers GET.
    html = html.replace(/<form\b([^>]*)\saction="[^"]*"/gi, "<form$1");
  }

  html = relink(html, dist);
  // Checked after relink: an inlined stylesheet may point at a bundled file that relink has just copied.
  if (/\/_astro\//.test(html)) throw new Error(`${entry.id}: a /_astro reference is left after inlining`);
  html = html.replace(/<head>/i, '<head><meta name="robots" content="noindex, nofollow">');

  mkdirSync(join(outRoot, entry.id), { recursive: true });
  writeFileSync(target, html);
  console.log(`${entry.id}: ${html.length} bytes from ${entry.commit.slice(0, 7)}:${entry.page}`);
}

mkdirSync(assetsDir, { recursive: true });
try {
  for (const id of ids) {
    const entry = ARCHIVE.find((s) => s.id === id);
    if (!entry) throw new Error(`unknown archive id: ${id}`);
    await snapshot(entry);
  }
} finally {
  for (const dist of builds.values()) {
    await $`git -C ${root} worktree remove --force ${join(dist, "..")}`.quiet().nothrow();
  }
}
