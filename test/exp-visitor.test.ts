import { describe, expect, test } from "bun:test";
import {
  clearVisitorCookie,
  declinesTracking,
  eligibleForExperiments,
  isBot,
  newIdentityAllowed,
  NEW_IDENTITY_DAILY_CAP,
  newVisitorId,
  readVisitorId,
  signVisitorId,
  VISITOR_COOKIE,
  visitorCookie,
} from "../src/exp-visitor";
import type { WaitlistKv } from "../src/list";

const SECRET = "test-visitor-secret";

function fakeKv(): WaitlistKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://mamoru.lol/", { headers });
}

describe("bot and consent gate", () => {
  test("common crawlers and link previews read as bots", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "curl/8.4.0",
      "python-requests/2.31.0",
    ]) {
      expect(isBot(ua)).toBe(true);
    }
  });

  test("a missing or empty User-Agent is treated as a bot, not a real visitor", () => {
    expect(isBot(null)).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot("   ")).toBe(true);
  });

  test("an ordinary browser UA is not a bot", () => {
    expect(
      isBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  test("Sec-GPC: 1 declines tracking", () => {
    expect(declinesTracking(req({ "sec-gpc": "1" }))).toBe(true);
  });

  test("DNT: 1 declines tracking", () => {
    expect(declinesTracking(req({ dnt: "1" }))).toBe(true);
  });

  test("neither header present: tracking is not declined", () => {
    expect(declinesTracking(req())).toBe(false);
  });

  test("eligibleForExperiments is false for GPC, DNT, or a bot UA; true for a plain browser", () => {
    const browserUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    expect(eligibleForExperiments(req({ "sec-gpc": "1", "user-agent": browserUa }))).toBe(false);
    expect(eligibleForExperiments(req({ dnt: "1", "user-agent": browserUa }))).toBe(false);
    expect(eligibleForExperiments(req({ "user-agent": "Googlebot" }))).toBe(false);
    expect(eligibleForExperiments(req({ "user-agent": browserUa }))).toBe(true);
  });
});

describe("visitor id cookie", () => {
  test("newVisitorId is url-safe and long enough not to collide in practice", () => {
    const a = newVisitorId();
    const b = newVisitorId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(a).not.toBe(b);
  });

  test("readVisitorId accepts a properly signed cookie and rejects garbage", async () => {
    const id = newVisitorId();
    const signed = await signVisitorId(SECRET, id);
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${signed}` }), SECRET)).toBe(id);
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=<script>` }), SECRET)).toBeNull();
    expect(await readVisitorId(req({ cookie: `other=1` }), SECRET)).toBeNull();
    expect(await readVisitorId(req(), SECRET)).toBeNull();
  });

  test("readVisitorId rejects an unsigned id (bare, no mac at all)", async () => {
    const id = newVisitorId();
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${id}` }), SECRET)).toBeNull();
  });

  test("readVisitorId rejects a cookie signed under a different secret", async () => {
    const id = newVisitorId();
    const signed = await signVisitorId("wrong-secret", id);
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${signed}` }), SECRET)).toBeNull();
  });

  test("readVisitorId rejects a client-grafted mac onto an attacker-chosen id", async () => {
    // An attacker cannot compute a valid mac without the secret, so grafting any mac onto a chosen id fails.
    const chosenId = "a".repeat(32);
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${chosenId}.not-a-real-mac` }), SECRET)).toBeNull();
  });

  test("without a secret configured, every cookie reads as null — no visitor is ever identified", async () => {
    const id = newVisitorId();
    const signed = await signVisitorId(SECRET, id);
    expect(await readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${signed}` }), undefined)).toBeNull();
  });

  test("visitorCookie is __Host-prefixed, Secure, Path=/, HttpOnly, SameSite=Lax, 90 days, signed", async () => {
    const id = newVisitorId();
    const cookie = (await visitorCookie(SECRET, id, true))!;
    const signed = await signVisitorId(SECRET, id);
    expect(cookie).toContain(`${VISITOR_COOKIE}=${signed}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 90}`);
    expect(cookie).not.toContain("Domain=");
  });

  test("visitorCookie refuses to issue a __Host- cookie over an insecure request", async () => {
    expect(await visitorCookie(SECRET, newVisitorId(), false)).toBeNull();
  });

  test("visitorCookie refuses to issue a cookie with no secret to sign it", async () => {
    expect(await visitorCookie(undefined, newVisitorId(), true)).toBeNull();
  });

  test("clearVisitorCookie expires immediately and keeps the __Host- shape", () => {
    const cookie = clearVisitorCookie();
    expect(cookie).toContain(`${VISITOR_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });
});

describe("newIdentityAllowed: per-IP-prefix daily cap on fresh identities", () => {
  function reqFrom(ip: string): Request {
    return new Request("https://mamoru.lol/", { headers: { "cf-connecting-ip": ip } });
  }

  test("allows new identities below the cap, then refuses at the cap", async () => {
    const kv = fakeKv();
    for (let i = 0; i < NEW_IDENTITY_DAILY_CAP; i++) {
      expect(await newIdentityAllowed(kv, reqFrom("203.0.113.9"), "2026-10-02")).toBe(true);
    }
    expect(await newIdentityAllowed(kv, reqFrom("203.0.113.9"), "2026-10-02")).toBe(false);
  });

  test("a custom, lower cap is honored", async () => {
    const kv = fakeKv();
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.4"), "2026-10-02", 2)).toBe(true);
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.4"), "2026-10-02", 2)).toBe(true);
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.4"), "2026-10-02", 2)).toBe(false);
  });

  test("IPv4 addresses sharing a /24 share the same counter", async () => {
    const kv = fakeKv();
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.1"), "2026-10-02", 2)).toBe(true);
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.254"), "2026-10-02", 2)).toBe(true);
    expect(await newIdentityAllowed(kv, reqFrom("198.51.100.77"), "2026-10-02", 2)).toBe(false);
  });

  test("a different day resets the counter", async () => {
    const kv = fakeKv();
    expect(await newIdentityAllowed(kv, reqFrom("203.0.113.5"), "2026-10-02", 1)).toBe(true);
    expect(await newIdentityAllowed(kv, reqFrom("203.0.113.5"), "2026-10-02", 1)).toBe(false);
    expect(await newIdentityAllowed(kv, reqFrom("203.0.113.5"), "2026-10-03", 1)).toBe(true);
  });

  test("no raw IP is ever stored as a KV key or value", async () => {
    const kv = fakeKv();
    await newIdentityAllowed(kv, reqFrom("203.0.113.42"), "2026-10-02");
    for (const [key, value] of kv.store.entries()) {
      expect(key).not.toContain("203.0.113.42");
      expect(value).not.toContain("203.0.113.42");
    }
  });

  test("with no KV bound (staging), every request is allowed — nothing to meter, nothing written", async () => {
    expect(await newIdentityAllowed(undefined, reqFrom("203.0.113.9"), "2026-10-02")).toBe(true);
  });
});

import { ipPrefix as prefixOf, newIdentityAllowed as allowed } from "../src/exp-visitor";

describe("ipPrefix", () => {
  test("expands :: before taking the /64", () => {
    expect(prefixOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(prefixOf("2001:db8:0:0:1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(prefixOf("2001:db8:a::")).toBe("2001:db8:a:0::/64");
    expect(prefixOf("::1")).toBe("0:0:0:0::/64");
  });
  test("two addresses in one /64 share a prefix; another /64 does not", () => {
    expect(prefixOf("2001:db8:1:2::9")).toBe(prefixOf("2001:db8:1:2:ffff::1"));
    expect(prefixOf("2001:db8:1:3::9")).not.toBe(prefixOf("2001:db8:1:2::9"));
  });
  test("IPv4 is a /24", () => {
    expect(prefixOf("203.0.113.77")).toBe("203.0.113.0/24");
  });
});

describe("newIdentityAllowed with a failing KV", () => {
  test("mints nothing and does not throw", async () => {
    const kv = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
    const req = new Request("https://mamoru.lol/", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    expect(await allowed(kv as never, req, "2026-10-02")).toBe(false);
  });
});
