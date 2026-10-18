import { describe, expect, test } from "bun:test";
import { fmtAccountKey, fmtApr, fmtCapitalUsd, fmtDateUtc, fmtMoneyUsd, fmtRelative } from "../src/ops-format";

describe("fmtCapitalUsd", () => {
  test("2 decimals under $10,000", () => {
    expect(fmtCapitalUsd(0)).toBe("$0.00");
    expect(fmtCapitalUsd(1234.5)).toBe("$1,234.50");
    expect(fmtCapitalUsd(9999.99)).toBe("$9,999.99");
    expect(fmtCapitalUsd(-42.1)).toBe("-$42.10");
  });

  test("compact K/M at and above $10,000", () => {
    expect(fmtCapitalUsd(12_900)).toBe("$12.9K");
    expect(fmtCapitalUsd(10_000)).toBe("$10.0K");
    expect(fmtCapitalUsd(4_200_000)).toBe("$4.2M");
  });
});

describe("fmtMoneyUsd", () => {
  test("4 significant digits below $1, no trailing zeros", () => {
    expect(fmtMoneyUsd(0.0712)).toBe("$0.0712");
    expect(fmtMoneyUsd(0.5)).toBe("$0.5");
    expect(fmtMoneyUsd(0.00009999)).toBe("$0.00009999");
    expect(fmtMoneyUsd(-0.0712)).toBe("-$0.0712");
  });

  test("matches fmtUsd at and above $1", () => {
    expect(fmtMoneyUsd(0)).toBe("$0.00");
    expect(fmtMoneyUsd(5.5)).toBe("$5.50");
    expect(fmtMoneyUsd(1284)).toBe("$1,284");
    expect(fmtMoneyUsd(12_345)).toBe("$12.3K");
  });
});

describe("fmtApr", () => {
  test("one decimal with a percent sign", () => {
    expect(fmtApr(12.34)).toBe("12.3%");
    expect(fmtApr(0)).toBe("0.0%");
    expect(fmtApr(-1.25)).toBe("-1.3%");
  });

  test("not-a-number reads as an em dash", () => {
    expect(fmtApr(Number.NaN)).toBe("—");
  });
});

describe("fmtAccountKey", () => {
  test("kept whole under 10 characters, else truncated with an ellipsis", () => {
    expect(fmtAccountKey("abc123")).toBe("abc123");
    expect(fmtAccountKey("0123456789abcdef")).toBe("01234567…");
  });
});

describe("fmtDateUtc", () => {
  test("day, short month, hour:minute, UTC", () => {
    expect(fmtDateUtc("2026-10-18T09:02:00Z")).toBe("18 Oct 09:02 UTC");
    expect(fmtDateUtc("2026-01-05T23:59:00Z")).toBe("5 Jan 23:59 UTC");
  });

  test("an unparsable date is returned as-is", () => {
    expect(fmtDateUtc("not-a-date")).toBe("not-a-date");
  });
});

describe("fmtRelative", () => {
  const now = new Date("2026-10-18T10:00:00Z");

  test("buckets by minute, hour and day", () => {
    expect(fmtRelative("2026-10-18T09:59:45Z", now)).toBe("just now");
    expect(fmtRelative("2026-10-18T09:57:00Z", now)).toBe("3 min ago");
    expect(fmtRelative("2026-10-18T08:00:00Z", now)).toBe("2 h ago");
    expect(fmtRelative("2026-10-13T10:00:00Z", now)).toBe("5 d ago");
  });

  test("never goes negative on clock skew", () => {
    expect(fmtRelative("2026-10-18T10:05:00Z", now)).toBe("just now");
  });
});
