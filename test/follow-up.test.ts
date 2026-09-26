import { describe, expect, test } from "bun:test";
import { CUSTODY_LINE, FOLLOW_UP_LINES, FOLLOW_UP_TEXT, followUpHtml } from "../src/follow-up";
import { isAllowed } from "../src/google";
import { emailKey } from "../src/list";
import { maskEmail, openSession, renderList, sealSession } from "../src/ops";
import { esc, normalizeEmail } from "../src/text";

describe("follow-up", () => {
  test("keeps Brais's lines and the custody sentence", () => {
    for (const line of FOLLOW_UP_LINES) {
      expect(FOLLOW_UP_TEXT).toContain(line);
    }
    expect(FOLLOW_UP_TEXT).toContain(CUSTODY_LINE);
    expect(FOLLOW_UP_TEXT).not.toContain("Impermanent");
    const html = followUpHtml(true);
    expect(html).toContain("cid:mamoru-mark");
    expect(html).toContain(CUSTODY_LINE);
    expect(html).toContain("Welcome to Mamoru.");
  });
});

describe("addresses", () => {
  test("rejects a header break", () => {
    expect(normalizeEmail("a@b.co")).toBe("a@b.co");
    expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
    expect(normalizeEmail("a@b.co\nBcc: x@y.z")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
  });

  test("does not use the address as the key", async () => {
    const key = await emailKey("person@example.com");
    expect(key.startsWith("e:")).toBe(true);
    expect(key).not.toContain("person@example.com");
    expect(key).not.toContain("@");
  });

  test("escapes the list", () => {
    const html = renderList({
      entries: [
        {
          email: `evil<img>@example.com`,
          at: "2026-09-25T00:00:00.000Z",
          note: "pending",
        },
      ],
      truncated: false,
      csrf: `tok"en`,
      flash: "",
      mailReady: false,
    });
    expect(html).toContain(esc(`evil<img>@example.com`));
    expect(html).toContain(esc(maskEmail(`evil<img>@example.com`)));
    expect(html).toContain("Reveal mail addresses");
    expect(html).not.toContain("<img>@example.com");
    expect(html).toContain("tok&quot;en");
    expect(html).not.toContain("Enviar las que faltan");
    expect(html).toContain("<h1>The list</h1>");
    expect(html).toContain('rel="icon" href="/mark-two-stones.png"');
    expect(html).toContain('href="/ops/landing"');
    expect(html).not.toContain("La lista");
  });
});

describe("ops gate", () => {
  test("allowlist is exact and case-insensitive", () => {
    expect(isAllowed("ottodevs@gmail.com")).toBe(true);
    expect(isAllowed("otto.devs@gmail.com")).toBe(true);
    expect(isAllowed("Brais.Millarengo@gmail.com ")).toBe(true);
    expect(isAllowed("braismillarengo@gmail.com")).toBe(true);
    expect(isAllowed("brais.millarengo@googlemail.com")).toBe(true);
    expect(isAllowed("ottodevs+x@gmail.com")).toBe(false);
    expect(isAllowed("someone@example.com")).toBe(false);
    expect(isAllowed("")).toBe(false);
  });

  test("session round-trips and rejects a bad signature", async () => {
    const token = await sealSession("k1", "ottodevs@gmail.com");
    const ok = await openSession("k1", `mamoru_list=${token}`);
    expect(ok?.email).toBe("ottodevs@gmail.com");
    expect(ok?.csrf).toBeTruthy();
    expect(await openSession("k2", `mamoru_list=${token}`)).toBeNull();
    expect(await openSession("k1", `mamoru_list=${token}x`)).toBeNull();
  });
});
