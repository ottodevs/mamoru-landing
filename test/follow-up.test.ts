import { describe, expect, test } from "bun:test";
import { CUSTODY_LINE, FOLLOW_UP_LINES, FOLLOW_UP_TEXT, followUpHtml } from "../src/follow-up";
import { emailKey } from "../src/list";
import { renderList } from "../src/ops";
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
    expect(html).not.toContain("<img>@example.com");
    expect(html).toContain("tok&quot;en");
    expect(html).not.toContain("Enviar las que faltan");
  });
});
