import { describe, expect, test } from "bun:test";
import { sealSession } from "../src/ops";
import { STAGING_PROXY_HEADER } from "../src/staging-preview";
import worker, { type Env } from "../src/worker";

function assets(): Fetcher {
  return {
    fetch: async () =>
      new Response("asset", { status: 200, headers: { "content-type": "text/plain" } }),
  } as unknown as Fetcher;
}

function stagingFetcher(secret: string): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const header = req.headers.get(STAGING_PROXY_HEADER) ?? "";
      if (header !== secret) {
        return new Response("Not found.", { status: 403 });
      }
      if (url.pathname === "/" || url.pathname === "/open") {
        return new Response(
          "<!doctype html><html><head><title>Staged</title></head><body><h1>Staged copy</h1></body></html>",
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-mamoru-staging-sha": "abc1234567890",
              "x-mamoru-staging-deployed-at": "2026-10-01T00:00:00Z",
            },
          },
        );
      }
      if (url.pathname === "/_astro/site.css") {
        return new Response(".x{color:red}", {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }
      return new Response("Not found.", { status: 404 });
    },
  } as unknown as Fetcher;
}

function prodEnv(secret = "shh-secret"): Env {
  return {
    ASSETS: assets(),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    STAGING: stagingFetcher(secret),
    STAGING_PROXY_SECRET: secret,
    STAGING_BASE_URL: "https://mamoru-lol-staging.ottodevs.workers.dev",
  };
}

describe("/ops/preview gate", () => {
  test("a stranger is sent to Google, not the staged content", async () => {
    const env = prodEnv();
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/preview"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
  });

  test("a session for an address not on the allowlist gets nothing", async () => {
    const env = prodEnv();
    const token = await sealSession("k1", "someone@example.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/preview", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("an allowlisted session gets the staged page with a base href and a banner", async () => {
    const env = prodEnv();
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/preview", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('<base href="https://mamoru-lol-staging.ottodevs.workers.dev">');
    expect(html).toContain("Staged copy");
    expect(html).toContain("mamoru-staging-banner");
    expect(html).toContain("abc123456789");
    expect(html).toContain("2026-10-01T00:00:00Z");
  });

  test("a sub-path (/ops/preview/open) proxies to the matching staging path", async () => {
    const env = prodEnv();
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/preview/open", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Staged copy");
  });

  test("non-HTML assets pass through untouched, no banner", async () => {
    const env = prodEnv();
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/preview/_astro/site.css", {
        headers: { cookie: `mamoru_list=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe(".x{color:red}");
  });

  test("with no STAGING binding or URL configured, the preview reports unavailable, not a leak", async () => {
    const env: Env = {
      ASSETS: assets(),
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      OPS_SESSION_SECRET: "k1",
    };
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/preview", { headers: { cookie: `mamoru_list=${token}` } }),
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe("staging channel self-gate", () => {
  function stagingEnv(secret = "shh-secret"): Env {
    return {
      ASSETS: assets(),
      DEPLOY_CHANNEL: "staging",
      STAGING_PROXY_SECRET: secret,
      GIT_SHA: "deadbee",
      DEPLOYED_AT: "2026-10-01T00:00:00Z",
    };
  }

  test("refuses a document request without the shared secret", async () => {
    const env = stagingEnv();
    const res = await worker.fetch(new Request("https://mamoru-lol-staging.ottodevs.workers.dev/"), env);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  test("refuses a wrong secret", async () => {
    const env = stagingEnv();
    const res = await worker.fetch(
      new Request("https://mamoru-lol-staging.ottodevs.workers.dev/", {
        headers: { [STAGING_PROXY_HEADER]: "nope" },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  test("serves normally with the right secret, stamped with sha/deployed-at and noindex", async () => {
    const env = stagingEnv();
    const res = await worker.fetch(
      new Request("https://mamoru-lol-staging.ottodevs.workers.dev/", {
        headers: { [STAGING_PROXY_HEADER]: "shh-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("x-mamoru-staging-sha")).toBe("deadbee");
    expect(res.headers.get("x-mamoru-staging-deployed-at")).toBe("2026-10-01T00:00:00Z");
  });

  test("a prod deployment (no DEPLOY_CHANNEL) is never gated and carries no staging headers", async () => {
    const env = prodHomeEnv();
    const res = await worker.fetch(new Request("https://mamoru.lol/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.has("x-mamoru-staging-sha")).toBe(false);
  });

  function prodHomeEnv(): Env {
    return { ASSETS: assets() };
  }
});
