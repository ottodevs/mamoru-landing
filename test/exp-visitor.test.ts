import { describe, expect, test } from "bun:test";
import {
  clearVisitorCookie,
  declinesTracking,
  eligibleForExperiments,
  isBot,
  newVisitorId,
  readVisitorId,
  VISITOR_COOKIE,
  visitorCookie,
} from "../src/exp-visitor";

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

  test("readVisitorId reads our own cookie shape and rejects garbage", () => {
    const id = newVisitorId();
    expect(readVisitorId(req({ cookie: `${VISITOR_COOKIE}=${id}` }))).toBe(id);
    expect(readVisitorId(req({ cookie: `${VISITOR_COOKIE}=<script>` }))).toBeNull();
    expect(readVisitorId(req({ cookie: `other=1` }))).toBeNull();
    expect(readVisitorId(req())).toBeNull();
  });

  test("visitorCookie is __Host-prefixed, Secure, Path=/, HttpOnly, SameSite=Lax, 90 days", () => {
    const id = newVisitorId();
    const cookie = visitorCookie(id, true)!;
    expect(cookie).toContain(`${VISITOR_COOKIE}=${id}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 90}`);
    expect(cookie).not.toContain("Domain=");
  });

  test("visitorCookie refuses to issue a __Host- cookie over an insecure request", () => {
    expect(visitorCookie(newVisitorId(), false)).toBeNull();
  });

  test("clearVisitorCookie expires immediately and keeps the __Host- shape", () => {
    const cookie = clearVisitorCookie();
    expect(cookie).toContain(`${VISITOR_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });
});
