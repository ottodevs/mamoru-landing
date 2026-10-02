import { describe, expect, test } from "bun:test";
import { homeDocument } from "../src/open-at";
import { PITCH } from "../src/pitch-copy";

describe("pitch route", () => {
  test("/pitch is a plain public asset, like /deck", () => {
    expect(homeDocument("/pitch")).toBe("asset");
    expect(homeDocument("/pitch/")).toBe("asset");
  });
});

describe("pitch copy", () => {
  test("no dash punctuation", () => {
    const blob = JSON.stringify(PITCH);
    expect(blob).not.toContain("—");
    expect(blob).not.toContain("–");
  });

  // "Agents" is on purpose in the intercepta module heading; every other
  // field stays clear of pitch-deck words that do not belong in this one.
  test("banned words stay out, except Agents in the intercepta heading", () => {
    const { intercepta, ...otherModules } = PITCH.modules;
    const scoped = JSON.stringify({ ...PITCH, modules: otherModules }).toLowerCase();
    expect(scoped).not.toContain("apy");
    expect(/\bagent\b/.test(scoped)).toBe(false);
    expect(scoped).not.toContain("decentralized");
    expect(scoped).not.toContain("guarantee");
    expect(intercepta.heading.toLowerCase()).toContain("agent");
  });

  test("exactly four attempts", () => {
    expect(PITCH.attacks.attempts.length).toBe(4);
  });

  test("module keys are exactly uniswap, curvegrid, intercepta", () => {
    expect(Object.keys(PITCH.modules)).toEqual(["uniswap", "curvegrid", "intercepta"]);
  });
});
