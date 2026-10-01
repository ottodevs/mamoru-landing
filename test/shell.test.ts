import { describe, expect, test } from "bun:test";
import type { D1Db, D1PreparedStatement } from "../src/d1-infra";
import { loadInfraReading } from "../src/infra-cache";
import type { InfraSnapshot } from "../src/infra-snapshot";
import { writeEntry } from "../src/list";
import { gateView, OPS_STYLE, renderDocument, sealSession, type SectionView } from "../src/ops";
import { opsRouterLogic, type OpsRouterLogic, type RouteClick, type RouteLink } from "../src/ops-router-logic";
import worker, { type Env } from "../src/worker";

const RELAYER = "0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0";
const SNAPSHOT: InfraSnapshot = {
  asOf: "2026-10-02T09:00:00.000Z",
  ethUsd: 2500,
  btcUsd: null,
  relayer: { address: RELAYER, basescanUrl: "https://basescan.org/address/" + RELAYER, ethBalance: 0.0251, usd: 62.75, status: "ok" },
  cost: { gasPriceGwei: 0.01, deployEth: 0.000004, deployUsd: 0.01, activationEth: 0.00014, activationUsd: 0.35, reserveEth: 0.0005, reserveUsd: 1.25, totalEth: 0.000644, totalUsd: 1.61, totalWei: "644000000000000", accountsFunded: 38 },
  accounts: { totalUsers: 39, totalAccounts: 39, last7d: 2, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0 },
};

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async (o: { prefix: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(o.prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
  };
}

function quietDb(): D1Db {
  return {
    prepare() {
      const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [], success: true }) };
      return stmt as unknown as D1PreparedStatement;
    },
  };
}

/** A console with a warm Infra reading, so no test ever reaches for an RPC. */
async function consoleEnv(opts: { list?: boolean } = {}) {
  const { kv, store } = memoryKv();
  store.set("ops:infra:v2", JSON.stringify({ snapshot: SNAPSHOT, storedAt: Date.now() }));
  await writeEntry(kv, { email: "keiko@example.com", at: "2026-09-28T10:00:00.000Z", note: "sent" });
  await writeEntry(kv, { email: "tomas@example.com", at: "2026-09-29T10:00:00.000Z", note: "pending" });
  const env: Env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    MAMORU_DB: quietDb(),
    ...(opts.list === false ? {} : { WAITLIST: kv }),
  };
  const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
  return { env, store, cookie };
}

const SECTIONS = [
  { path: "/ops", section: "overview", title: "Overview", marker: "Value held" },
  { path: "/ops/mails", section: "mails", title: "Mails", marker: "On the list" },
  { path: "/ops/infra", section: "infra", title: "Infra and costs", marker: "Relayer balance" },
  { path: "/ops/experiments", section: "experiments", title: "Experiments", marker: "hero_cta" },
] as const;

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://mamoru.lol${path}`, { headers });
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`https://mamoru.lol${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

function csrfOf(html: string): string {
  return html.match(/name="csrf" value="([^"]+)"/)![1];
}

/** The router logic exactly as the browser gets it, cut out of a rendered document. */
function shippedRouter(): OpsRouterLogic {
  const html = renderDocument({ section: "overview", title: "Overview", html: "<h1>x</h1>" }, { csrf: "c", nonce: "n" });
  const start = html.indexOf("/*router-logic*/") + "/*router-logic*/".length;
  const end = html.indexOf("/*end-router-logic*/");
  expect(end).toBeGreaterThan(start);
  return new Function(`var __name = function (fn) { return fn; }; return (${html.slice(start, end)})();`)() as OpsRouterLogic;
}

const ORIGIN = "https://mamoru.lol";
const link = (href: string, over: Partial<RouteLink> = {}): RouteLink => ({ href, origin: ORIGIN, current: "/ops", target: "", download: false, full: false, ...over });
const CLICK: RouteClick = { button: 0, meta: false, ctrl: false, shift: false, alt: false, prevented: false };

for (const [name, R] of [["module", opsRouterLogic()], ["shipped inline script", shippedRouter()]] as const) {
  describe(`router logic (${name})`, () => {
    test("URL to section", () => {
      expect(R.sectionOf("/ops")).toBe("overview");
      expect(R.sectionOf("/ops/")).toBe("overview");
      expect(R.sectionOf("/ops/mails")).toBe("mails");
      expect(R.sectionOf("/ops/infra/")).toBe("infra");
      expect(R.sectionOf("/ops/preview")).toBeNull();
      expect(R.sectionOf("/ops/infra/refresh")).toBeNull();
      expect(R.sectionOf("/ops/landing")).toBeNull();
      expect(R.sectionOf("/")).toBeNull();
      expect(R.routeKey("https://mamoru.lol/ops/infra?fresh=1", ORIGIN)).toBe("/ops/infra");
      expect(R.routeKey("/ops/mails/", ORIGIN)).toBe("/ops/mails");
      expect(R.routeKey("https://mamoru.lol/deck", ORIGIN)).toBeNull();
      expect(R.wantsFresh("/ops/infra?fresh=1", ORIGIN)).toBe(true);
      expect(R.wantsFresh("/ops/infra", ORIGIN)).toBe(false);
    });

    test("only plain clicks on same-origin section links are taken over", () => {
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), CLICK)).toBe(true);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops"), { ...CLICK })).toBe(true);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), { ...CLICK, meta: true })).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), { ...CLICK, ctrl: true })).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), { ...CLICK, shift: true })).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), { ...CLICK, button: 1 })).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra"), { ...CLICK, prevented: true })).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra", { target: "_blank" }), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra", { download: true }), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra", { full: true }), CLICK)).toBe(false);
      // Preview, the public site, other origins and wallet explorers all leave the console.
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/preview"), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/"), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://basescan.org/tx/0xabc"), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://evil.example/ops/infra"), CLICK)).toBe(false);
      // An in-page jump stays with the browser; the same hash on another section is a navigation.
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra#topup", { current: "/ops/infra" }), CLICK)).toBe(false);
      expect(R.shouldIntercept(link("https://mamoru.lol/ops/infra#topup", { current: "/ops" }), CLICK)).toBe(true);
    });

    test("cache policy: fresh is painted as is, stale is painted and revalidated, old is not painted", () => {
      const now = 1_000_000;
      expect(R.cacheState(null, now)).toBe("miss");
      expect(R.cacheState(undefined, now)).toBe("miss");
      expect(R.cacheState({ at: now }, now)).toBe("fresh");
      expect(R.cacheState({ at: now - R.FRESH_MS }, now)).toBe("fresh");
      expect(R.cacheState({ at: now - R.FRESH_MS - 1 }, now)).toBe("stale");
      expect(R.cacheState({ at: now - R.MAX_AGE_MS }, now)).toBe("stale");
      expect(R.cacheState({ at: now - R.MAX_AGE_MS - 1 }, now)).toBe("miss");
      expect(R.cacheState({ at: now + 5 }, now)).toBe("miss");
    });

    test("the cache stays small: the oldest entries go first", () => {
      const entries: Record<string, { at: number }> = {};
      for (let i = 0; i < R.MAX_ENTRIES + 2; i++) entries[`/k${i}`] = { at: 100 + i };
      expect(R.evict(entries)).toEqual(["/k0", "/k1"]);
      expect(R.evict({ "/ops": { at: 1 } })).toEqual([]);
    });

    test("fragment responses: render, sign in, or leave for a full navigation", () => {
      const json = "application/json; charset=utf-8";
      const base = { status: 200, type: json, auth: "", redirected: false, opaque: false };
      expect(R.classify(base)).toBe("render");
      expect(R.classify({ ...base, status: 403 })).toBe("render");
      expect(R.classify({ ...base, status: 503 })).toBe("render");
      expect(R.classify({ ...base, status: 401, auth: "required" })).toBe("login");
      expect(R.classify({ ...base, status: 401 })).toBe("full");
      expect(R.classify({ ...base, status: 404, type: "text/plain" })).toBe("full");
      expect(R.classify({ ...base, type: "text/html; charset=utf-8" })).toBe("full");
      expect(R.classify({ ...base, opaque: true, status: 0, type: "" })).toBe("full");
      expect(R.classify({ ...base, redirected: true })).toBe("full");
      expect(R.classify({ ...base, status: 500 })).toBe("full");
      expect(R.isView({ v: 1, section: "infra", title: "Infra", html: "<h1>x</h1>" })).toBe(true);
      expect(R.isView({ v: 1, login: true })).toBe(false);
      expect(R.isView({ v: 2, section: "infra", title: "Infra", html: "" })).toBe(false);
      expect(R.isView(null)).toBe(false);
    });
  });
}

describe("one frame for every section", () => {
  test("full document: the same header, nav state, title pattern, one stylesheet and one console script", async () => {
    const { env, cookie } = await consoleEnv();
    for (const s of SECTIONS) {
      const res = await worker.fetch(get(s.path, { cookie }), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain(`<title>${s.title} · Mamoru ops</title>`);
      expect(html).toContain(`<main id="ops-main" class="ops-page" data-section="${s.section}"`);
      expect(html).toContain(`data-section="${s.section}" aria-current="page"`);
      expect(html.match(/<a [^>]*aria-current="page"/g)?.length).toBe(1);
      expect(html).toContain(`<h1>${s.title}</h1>`);
      expect(html).toContain(s.marker);
      expect(html).toContain('<form class="ops-who" method="post" action="/ops/logout">');
      expect(html).toContain("ottodevs@gmail.com");
      expect(html.match(/<style>/g)?.length).toBe(1);
      expect(html.match(/<script /g)?.length).toBe(2);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = csp.match(/script-src 'nonce-([^']+)'/)![1];
      expect(html.match(new RegExp(`<script nonce="${nonce}">`, "g"))?.length).toBe(2);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
  });

  test("fragment: only the section body, as JSON, with no frame and no script", async () => {
    const { env, cookie } = await consoleEnv();
    for (const s of SECTIONS) {
      const res = await worker.fetch(get(s.path, { cookie, "x-ops-fragment": "1" }), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("vary")).toBe("x-ops-fragment");
      const view = (await res.json()) as { v: number; section: string; title: string; html: string };
      expect(view.v).toBe(1);
      expect(view.section).toBe(s.section);
      expect(view.title).toBe(s.title);
      expect(view.html).toContain(`<h1>${s.title}</h1>`);
      expect(view.html).toContain(s.marker);
      expect(view.html).not.toContain("<html");
      expect(view.html).not.toContain("<script");
      expect(view.html).not.toContain("ops-nav");
      expect(view.html).not.toContain("<style");
    }
  });

  test("the fragment and the document carry the same section body", async () => {
    const { env, cookie } = await consoleEnv();
    const doc = await (await worker.fetch(get("/ops/mails", { cookie }), env)).text();
    const view = (await (await worker.fetch(get("/ops/mails", { cookie, "x-ops-fragment": "1" }), env)).json()) as { html: string };
    expect(doc).toContain(view.html);
  });

  test("the list not being connected is a designed state inside the frame, not a bare line", async () => {
    const { env, cookie } = await consoleEnv({ list: false });
    env.BASE_RPC_URL = "http://127.0.0.1:9/";
    const res = await worker.fetch(get("/ops/mails", { cookie }), env);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('data-section="mails" aria-current="page"');
    expect(html).toContain("The list is not connected to this deployment");
    const fragment = await worker.fetch(get("/ops/mails", { cookie, "x-ops-fragment": "1" }), env);
    expect(fragment.status).toBe(503);
    expect(((await fragment.json()) as { section: string }).section).toBe("mails");
  });

  test("all console CSS lives in one stylesheet", () => {
    for (const rule of [".ops-top", ".pg-head", ".figs", ".notice", "table.ledger", "table.mails", ".tu-line", ".plot", "#ops-progress", "::view-transition-old(ops-main)"]) {
      expect(OPS_STYLE).toContain(rule);
    }
    expect(OPS_STYLE).toContain("prefers-reduced-motion: reduce");
  });
});

describe("the gate applies to fragments", () => {
  test("no session: a fragment request gets the sign-in signal and no data", async () => {
    const { env } = await consoleEnv();
    for (const s of SECTIONS) {
      const res = await worker.fetch(get(s.path, { "x-ops-fragment": "1" }), env);
      expect(res.status).toBe(401);
      expect(res.headers.get("x-ops-auth")).toBe("required");
      const body = await res.text();
      expect(body).toBe('{"v":1,"login":true}');
      expect(body).not.toContain(s.marker);
      expect(opsRouterLogic().classify({ status: res.status, type: res.headers.get("content-type") ?? "", auth: res.headers.get("x-ops-auth") ?? "", redirected: false, opaque: false })).toBe("login");
    }
  });

  test("no session: a plain request to a section starts Google and comes back to that section", async () => {
    const { env } = await consoleEnv();
    for (const s of SECTIONS) {
      const res = await worker.fetch(get(s.path), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
      expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_oauth=");
    }
  });

  test("an expired session is no session, for fragments too", async () => {
    const { env } = await consoleEnv();
    const { setSystemTime } = await import("bun:test");
    try {
      setSystemTime(new Date("2026-10-01T00:00:00Z"));
      const old = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
      setSystemTime(new Date("2026-10-02T00:00:00Z"));
      const res = await worker.fetch(get("/ops/infra", { cookie: old, "x-ops-fragment": "1" }), env);
      expect(res.status).toBe(401);
      expect(res.headers.get("x-ops-auth")).toBe("required");
    } finally {
      setSystemTime();
    }
  });

  test("a session off the allowlist, and posts without a session, get the bare 404 with or without the header", async () => {
    const { env } = await consoleEnv();
    const stranger = `mamoru_list=${await sealSession("k1", "someone@example.com")}`;
    for (const s of SECTIONS) {
      const res = await worker.fetch(get(s.path, { cookie: stranger, "x-ops-fragment": "1" }), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found.");
    }
    for (const path of ["/ops/remove", "/ops/send", "/ops/infra/refresh", "/ops/metrics/snapshot", "/ops/logout"]) {
      const res = await worker.fetch(post(path, "csrf=x", { "x-ops-fragment": "1" }), env);
      expect(res.status).toBe(404);
      // The router turns anything that is not a JSON view into a full navigation.
      expect(opsRouterLogic().classify({ status: 404, type: res.headers.get("content-type") ?? "", auth: "", redirected: false, opaque: false })).toBe("full");
    }
  });

  test("sign-in returns to the section that was asked for", async () => {
    const { env } = await consoleEnv();
    // The OAuth state cookie is sealed; what can be seen from outside is that each section starts its own flow.
    const infra = await worker.fetch(get("/ops/infra"), env);
    const mails = await worker.fetch(get("/ops/mails/"), env);
    expect(infra.status).toBe(302);
    expect(mails.status).toBe(302);
    expect(infra.headers.get("set-cookie")).not.toBe(mails.headers.get("set-cookie"));
  });
});

describe("forms posted by fetch", () => {
  test("remove: wrong CSRF token is a 403 with the reason, and nothing is removed", async () => {
    const { env, cookie, store } = await consoleEnv();
    const before = [...store.keys()].filter((k) => k.startsWith("e:")).length;
    const res = await worker.fetch(post("/ops/remove", "csrf=wrong&email=keiko%40example.com", { cookie, "x-ops-fragment": "1" }), env);
    expect(res.status).toBe(403);
    const view = (await res.json()) as { section: string; html: string };
    expect(view.section).toBe("mails");
    expect(view.html).toContain("That did not go through. Try again.");
    expect(view.html).toContain('class="notice bad"');
    expect([...store.keys()].filter((k) => k.startsWith("e:")).length).toBe(before);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("remove: the right token removes the address and returns the updated section in place", async () => {
    const { env, cookie, store } = await consoleEnv();
    const csrf = csrfOf(await (await worker.fetch(get("/ops/mails", { cookie }), env)).text());
    const res = await worker.fetch(post("/ops/remove", `csrf=${encodeURIComponent(csrf)}&email=keiko%40example.com`, { cookie, "x-ops-fragment": "1" }), env);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { section: string; html: string };
    expect(view.section).toBe("mails");
    expect(view.html).toContain("Removed from the list.");
    expect(view.html).not.toContain("keiko@example.com");
    expect(view.html).toContain("tomas@example.com");
    expect([...store.keys()].filter((k) => k.startsWith("e:")).length).toBe(1);
    // No flash cookie on this path: the notice is already in the section.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("without the header the same forms still post and redirect, flash and all", async () => {
    const { env, cookie } = await consoleEnv();
    const csrf = csrfOf(await (await worker.fetch(get("/ops/mails", { cookie }), env)).text());
    const res = await worker.fetch(post("/ops/remove", `csrf=${encodeURIComponent(csrf)}&email=keiko%40example.com`, { cookie }), env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ops/mails");
    expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_flash=removed");
    const landed = await worker.fetch(get("/ops/mails", { cookie: `${cookie}; mamoru_flash=removed` }), env);
    expect(await landed.text()).toContain("Removed from the list.");
  });

  test("refresh and snapshot: wrong token is refused on both paths, and the flash shows on the section it lands on", async () => {
    const { env, cookie } = await consoleEnv();
    for (const [path, section, back] of [["/ops/infra/refresh", "infra", "/ops/infra"], ["/ops/metrics/snapshot", "overview", "/ops"]] as const) {
      const fragment = await worker.fetch(post(path, "csrf=wrong", { cookie, "x-ops-fragment": "1" }), env);
      expect(fragment.status).toBe(403);
      const view = (await fragment.json()) as { section: string; html: string };
      expect(view.section).toBe(section);
      expect(view.html).toContain("That did not go through. Try again.");
      const plain = await worker.fetch(post(path, "csrf=wrong", { cookie }), env);
      expect(plain.status).toBe(303);
      expect(plain.headers.get("location")).toBe(back);
      const landed = await worker.fetch(get(back, { cookie: `${cookie}; mamoru_flash=bad` }), env);
      const html = await landed.text();
      expect(html).toContain("That did not go through. Try again.");
      expect(landed.headers.get("set-cookie") ?? "").toContain("mamoru_flash=;");
    }
  });

  test("every form in every section is one the router can post, and carries the session's token", async () => {
    const { env, cookie } = await consoleEnv();
    for (const s of SECTIONS) {
      const view = (await (await worker.fetch(get(s.path, { cookie, "x-ops-fragment": "1" }), env)).json()) as { html: string };
      const forms = view.html.match(/<form [^>]*>/g) ?? [];
      for (const form of forms) {
        expect(form).toContain('method="post"');
        expect(form).toContain("data-ops-form");
      }
      expect(view.html.match(/name="csrf"/g)?.length ?? 0).toBe(forms.length);
    }
  });
});

describe("render from cache first", () => {
  const aged = { snapshot: SNAPSHOT, storedAt: 1_000_000 };
  const later = 1_000_000 + 10 * 60_000;

  test("an aged reading is served at once and recomputed behind the response", async () => {
    const { kv, store } = memoryKv();
    store.set("ops:infra:v2", JSON.stringify(aged));
    const work: Promise<unknown>[] = [];
    let computes = 0;
    let finish = () => {};
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const compute = async () => {
      computes++;
      await gate;
      return { ...SNAPSHOT, asOf: "2026-10-02T09:30:00.000Z" };
    };
    const reading = await loadInfraReading({ kv }, false, compute, { waitUntil: (p) => void work.push(p), now: later });
    expect(reading.snapshot.asOf).toBe(SNAPSHOT.asOf);
    expect(reading.refreshing).toBe(true);
    expect(work).toHaveLength(1);
    // A second request while that runs does not start another recompute.
    const again = await loadInfraReading({ kv }, false, compute, { waitUntil: (p) => void work.push(p), now: later });
    expect(again.refreshing).toBe(true);
    expect(work).toHaveLength(1);
    finish();
    await Promise.all(work);
    expect(computes).toBe(1);
    const next = await loadInfraReading({ kv }, false, compute, { waitUntil: (p) => void work.push(p), now: later + 1000 });
    expect(next.snapshot.asOf).toBe("2026-10-02T09:30:00.000Z");
    expect(next.refreshing).toBeUndefined();
    expect(computes).toBe(1);
  });

  test("a current reading is served as is; without waitUntil an aged one is recomputed in line", async () => {
    const { kv, store } = memoryKv();
    store.set("ops:infra:v2", JSON.stringify(aged));
    const never = async () => {
      throw new Error("must not compute");
    };
    expect((await loadInfraReading({ kv }, false, never, { now: 1_000_000 + 60_000 })).refreshing).toBeUndefined();
    const inline = await loadInfraReading({ kv }, false, async () => ({ ...SNAPSHOT, asOf: "t2" }), { now: later });
    expect(inline.snapshot.asOf).toBe("t2");
    expect(inline.refreshing).toBeUndefined();
  });

  test("nothing current but a last complete reading: that one is shown while a new one is computed", async () => {
    const { kv, store } = memoryKv();
    store.set("ops:infra:v1:good", JSON.stringify(SNAPSHOT));
    const work: Promise<unknown>[] = [];
    const reading = await loadInfraReading({ kv }, false, async () => ({ ...SNAPSHOT, asOf: "t2" }), { waitUntil: (p) => void work.push(p), now: later });
    expect(reading.snapshot.asOf).toBe(SNAPSHOT.asOf);
    expect(reading.refreshing).toBe(true);
    await Promise.all(work);
    expect(JSON.parse(store.get("ops:infra:v2")!).snapshot.asOf).toBe("t2");
  });

  test("the worker marks a refreshing section in both the fragment and the document", async () => {
    const { env, cookie, store } = await consoleEnv();
    env.BASE_RPC_URL = "http://127.0.0.1:9/";
    store.set("ops:infra:v2", JSON.stringify({ snapshot: SNAPSHOT, storedAt: Date.now() - 10 * 60_000 }));
    const work: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void work.push(p) };
    const res = await worker.fetch(get("/ops/infra", { cookie, "x-ops-fragment": "1" }), env, ctx);
    const view = (await res.json()) as { refreshing?: boolean; html: string };
    expect(view.refreshing).toBe(true);
    expect(view.html).toContain(">0.0251<");
    expect(work).toHaveLength(1);
    const doc = await worker.fetch(get("/ops", { cookie }), env, ctx);
    expect(await doc.text()).toContain('data-section="overview" data-refreshing>');
    await Promise.allSettled(work);
  });
});

describe("states outside the console", () => {
  test("the access-denied page is in the same language and names nothing behind it", () => {
    const view: SectionView = gateView({
      title: "This account does not have access",
      lines: ["You signed in with Google as someone@example.com. That address is not on the list for this console."],
      link: { href: "/", label: "Back to mamoru.lol" },
    });
    expect(view.status).toBe(403);
    const html = renderDocument(view, { nonce: "n", chrome: false });
    expect(html).toContain("<title>This account does not have access · Mamoru ops</title>");
    expect(html).toContain("someone@example.com");
    expect(html).toContain('<a href="/">Back to mamoru.lol</a>');
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("/ops/mails");
    expect(html).not.toContain("/ops/infra");
    expect(html).not.toContain("router-logic");
    expect(html).not.toContain('name="csrf"');
  });

  test("signing out leaves the console for the public site", async () => {
    const { env, cookie } = await consoleEnv();
    const csrf = csrfOf(await (await worker.fetch(get("/ops", { cookie }), env)).text());
    const res = await worker.fetch(post("/ops/logout", `csrf=${encodeURIComponent(csrf)}`, { cookie }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://mamoru.lol/");
    expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_list=;");
  });
});
