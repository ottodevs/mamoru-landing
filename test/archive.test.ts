import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ARCHIVE, LIVE, archiveTarget } from "../src/archive";
import { archiveBar } from "../src/ops-archive";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

const SNAPSHOT_HTML = "<!doctype html><html><head></head><body><p>old page</p></body></html>";

async function archiveEnv() {
  const fetched: string[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        fetched.push(path);
        if (path.endsWith(".png")) return new Response("png", { headers: { "content-type": "image/png" } });
        return new Response(SNAPSHOT_HTML, { headers: { "content-type": "text/html" } });
      },
    } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
  };
  const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
  return { env, cookie, fetched };
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://mamoru.lol${path}`, { headers });
}

const TOKYO = "landing-v1";

describe("archive manifest", () => {
  test("every entry has a committed snapshot and a unique id", () => {
    const ids = ARCHIVE.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ARCHIVE) {
      expect(s.id).toBe(`${s.kind}-${s.version.replace(/\./g, "-")}`);
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.from <= s.to).toBe(true);
      expect(existsSync(`public/ops/archive/${s.id}/index.html`)).toBe(true);
    }
  });

  test("one version per number: no two entries share kind and version, one live page per kind", () => {
    const keys = [...ARCHIVE, ...LIVE].map((e) => `${e.kind}:${e.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(LIVE.filter((l) => l.kind === "landing").map((l) => l.href)).toEqual(["/"]);
    expect(LIVE.filter((l) => l.kind === "deck").map((l) => l.href)).toEqual(["/deck"]);
    expect(archiveBar(ARCHIVE.find((s) => s.id === "deck-v1-1")!)).toContain("Deck v1.1");
  });

  test("snapshots stand alone: no /_astro, every local file points at the archive", () => {
    for (const s of ARCHIVE) {
      const html = readFileSync(`public/ops/archive/${s.id}/index.html`, "utf8");
      expect(html).not.toContain("/_astro/");
      const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*\.(?:png|webp|svg|ttf|woff2?|jpe?g))"|url\((\/[^)]+)\)/g)].map((m) => m[1] ?? m[2]);
      for (const ref of refs) {
        expect(archiveTarget(ref)).toEqual({ kind: "asset", asset: ref });
        expect(existsSync(`public${ref}`)).toBe(true);
      }
      if (s.static) expect(html).not.toContain("<script");
      expect(html).toContain('content="noindex, nofollow"');
    }
  });

  test("paths resolve to the list, a page, an asset, or nothing", () => {
    expect(archiveTarget("/ops/archive")).toEqual({ kind: "list" });
    expect(archiveTarget("/ops/archive/")).toEqual({ kind: "list" });
    expect(archiveTarget(`/ops/archive/${TOKYO}`)).toMatchObject({ kind: "page", asset: `/ops/archive/${TOKYO}/index.html` });
    expect(archiveTarget(`/ops/archive/${TOKYO}/index.html`)).toMatchObject({ kind: "page" });
    expect(archiveTarget("/ops/archive/assets/mark-two-stones.png")).toEqual({ kind: "asset", asset: "/ops/archive/assets/mark-two-stones.png" });
    expect(archiveTarget("/ops/archive/assets/../worker.js")).toEqual({ kind: "missing" });
    expect(archiveTarget("/ops/archive/nope")).toEqual({ kind: "missing" });
    expect(archiveTarget("/ops/money/funding")).toBeNull();
  });
});

describe("archive behind the gate", () => {
  test("a stranger is sent to Google for a page, and gets nothing for a file", async () => {
    const { env, fetched } = await archiveEnv();
    const page = await worker.fetch(get(`/ops/archive/${TOKYO}`), env);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("accounts.google.com");
    const file = await worker.fetch(get("/ops/archive/assets/mark-two-stones.png"), env);
    expect(file.status).toBe(404);
    const list = await worker.fetch(get("/ops/archive"), env);
    expect(list.status).toBe(302);
    expect(fetched).toEqual([]);
  });

  test("the built file is never reachable by its own path without a session", async () => {
    const { env, fetched } = await archiveEnv();
    const res = await worker.fetch(get(`/ops/archive/${TOKYO}/index.html`), env);
    expect(res.status).toBe(302);
    expect(fetched).toEqual([]);
  });

  test("signed in, a page carries the archive bar and is not indexed", async () => {
    const { env, cookie } = await archiveEnv();
    const res = await worker.fetch(get(`/ops/archive/${TOKYO}`, { cookie }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("old page");
    expect(html).toContain("mamoru-archive-bar");
    expect(html).toContain("Back to the archive");
  });

  test("signed in, an asset passes through untouched", async () => {
    const { env, cookie } = await archiveEnv();
    const res = await worker.fetch(get("/ops/archive/assets/mark-two-stones.png", { cookie }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png");
  });

  test("signed in, an unknown id or a write is refused", async () => {
    const { env, cookie } = await archiveEnv();
    expect((await worker.fetch(get("/ops/archive/nope", { cookie }), env)).status).toBe(404);
    const post = new Request(`https://mamoru.lol/ops/archive/${TOKYO}`, { method: "POST", headers: { cookie } });
    expect((await worker.fetch(post, env)).status).toBe(404);
  });

  test("signed in, the list names every snapshot and what is live", async () => {
    const { env, cookie } = await archiveEnv();
    const html = await (await worker.fetch(get("/ops/archive", { cookie }), env)).text();
    for (const s of ARCHIVE) expect(html).toContain(`/ops/archive/${s.id}`);
    for (const s of ARCHIVE) expect(html).toContain(`<td>${s.version}</td>`);
    for (const l of LIVE) expect(html).toContain(`${l.version} &middot;`);
    expect(html).toContain('href="/deck"');
    expect(html).not.toContain('href="/deck-v2"');
    expect(html).not.toContain('href="/pitch"');
  });

  test("one landing and one deck: no second public route", async () => {
    expect(existsSync("src/pages/pitch.astro")).toBe(false);
    expect(existsSync("src/pages/deck-v2.astro")).toBe(false);
  });
});
