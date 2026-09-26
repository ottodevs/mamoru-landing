import { describe, expect, test } from "bun:test";
import { OPEN_AT_MS, homeDocument, isOpen } from "../src/open-at";
import { OPEN_COPY } from "../src/open-copy";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

describe("open instant", () => {
  test("flips at 2026-09-27 09:00 JST and not a millisecond before", () => {
    expect(isOpen(OPEN_AT_MS - 1)).toBe(false);
    expect(isOpen(OPEN_AT_MS)).toBe(true);
    expect(homeDocument("/", OPEN_AT_MS - 1)).toBe("teaser");
    expect(homeDocument("/index.html", OPEN_AT_MS - 1)).toBe("teaser");
    expect(homeDocument("/", OPEN_AT_MS)).toBe("site");
    expect(homeDocument("/index.html", OPEN_AT_MS)).toBe("site");
  });

  test("the built site file is never a public path", () => {
    expect(homeDocument("/open", OPEN_AT_MS)).toBe("hidden");
    expect(homeDocument("/open/", OPEN_AT_MS - 1)).toBe("hidden");
    expect(homeDocument("/OPEN/index.html", OPEN_AT_MS)).toBe("hidden");
    expect(homeDocument("/mark-two-stones.png", OPEN_AT_MS)).toBe("asset");
  });

  test("public copy has no dash punctuation", () => {
    const blob = JSON.stringify(OPEN_COPY);
    expect(blob).not.toContain("\u2014");
    expect(blob).not.toContain("\u2013");
    expect(OPEN_COPY.hero.lede).toBe("The principal keeps working. The yield gets set aside.");
    expect(OPEN_COPY.works.moves.map((m) => m.title)).toEqual(["Connect", "Fund", "Harvest"]);
    expect(OPEN_COPY.spend.heading).toBe("DeFi yields you can actually spend");
    expect(OPEN_COPY.questions.heading).toBe("FAQs");
    expect("split" in OPEN_COPY).toBe(false);
    expect("enter" in OPEN_COPY).toBe(false);
    expect("plain" in OPEN_COPY.works).toBe(false);
  });
});

function siteAssets(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname === "/app/index.html") {
        return new Response("<!doctype html><title>Mamoru — App</title><h1>APY.</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/open/index.html") {
        return new Response("<!doctype html><html><head></head><body><h1>APY.</h1></body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": "4",
            "content-encoding": "gzip",
          },
        });
      }
      return new Response("teaser", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  } as unknown as Fetcher;
}

function opsEnv(): Env {
  return {
    ASSETS: siteAssets(),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
  };
}

describe("site gate", () => {
  test("strangers and the raw file never see the page", async () => {
    const env = opsEnv();
    const stranger = await worker.fetch(new Request("https://mamoru.lol/ops/landing"), env);
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get("location")).toBe("https://mamoru.lol/");
    expect(stranger.headers.get("x-robots-tag")).toContain("noindex");

    const raw = await worker.fetch(new Request("https://mamoru.lol/open"), env);
    expect(raw.status).toBe(404);
    const rawFile = await worker.fetch(new Request("https://mamoru.lol/open/index.html"), env);
    expect(rawFile.status).toBe(404);
  });

  test("an allowlisted session gets the preview, and / stays the teaser until the instant", async () => {
    const env = opsEnv();
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const preview = await worker.fetch(
      new Request("https://mamoru.lol/ops/landing", {
        headers: { cookie: `mamoru_list=${token}` },
      }),
      env,
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("x-robots-tag")).toContain("noindex");
    expect(preview.headers.get("cache-control")).toBe("no-store");
    const html = await preview.text();
    expect(html).toContain("APY.");
    expect(html).toContain("This becomes the front page when the countdown ends.");
    expect(html).toContain('href="/ops"');
    expect(preview.headers.get("content-encoding")).toBeNull();

    const home = await worker.fetch(new Request("https://mamoru.lol/"), env);
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("teaser");
  });

  test("a removed address loses the preview", async () => {
    const env = opsEnv();
    const token = await sealSession("k1", "someone@example.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/landing", {
        headers: { cookie: `mamoru_list=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://mamoru.lol/");
  });
});

describe("hosts", () => {
  test("www is a canonical redirect and /app is not a public path", async () => {
    const env = opsEnv();
    const www = await worker.fetch(new Request("https://www.mamoru.lol/ops/landing"), env);
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe("https://mamoru.lol/ops/landing");

    const slop = await worker.fetch(new Request("https://app.mamoru.lol/app"), env);
    expect(slop.status).toBe(308);
    expect(slop.headers.get("location")).toBe("https://app.mamoru.lol/");

    const apex = await worker.fetch(new Request("https://mamoru.lol/app/onboarding"), env);
    expect(apex.status).toBe(308);
    expect(apex.headers.get("location")).toBe("https://app.mamoru.lol/onboarding");
  });

  test("the app stays behind the same Google allowlist until the countdown ends", async () => {
    const env = opsEnv();
    const stranger = await worker.fetch(new Request("https://app.mamoru.lol/onboarding"), env);
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get("location")).toContain("https://mamoru.lol/ops/login?next=");
    expect(stranger.headers.get("location")).toContain("app.mamoru.lol");

    const token = await sealSession("k1", "ottodevs@gmail.com");
    const home = await worker.fetch(
      new Request("https://app.mamoru.lol/", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(home.status).toBe(200);
    expect(home.headers.get("location")).toBeNull();
    expect(await home.text()).toContain("Mamoru — App");
  });
});
