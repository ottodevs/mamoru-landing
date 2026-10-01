import { describe, expect, test } from "bun:test";
import type { InfraSnapshot } from "../src/infra-snapshot";
import { sealSession } from "../src/ops";
import { renderInfra } from "../src/ops-infra";
import { type TopupContext, type TopupLogic, topupLogic, type TopupState } from "../src/topup-logic";
import worker, { type Env } from "../src/worker";

const RELAYER = "0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0";
const WALLET = "0xb343880dc01517dcfcbb528864d567e3389753e1";
const SNAPSHOT: InfraSnapshot = { asOf: "2026-10-02T09:00:00.000Z", ethUsd: 2686.63, btcUsd: null, relayer: null, cost: null, accounts: null };

/**
 * The logic exactly as the browser gets it: cut out of the rendered page's inline
 * script and evaluated on its own, with nothing from this module in scope.
 */
function shippedLogic(): TopupLogic {
  const html = renderInfra({ reading: { snapshot: SNAPSHOT }, csrf: "c", nonce: "n" });
  const start = html.indexOf("/*topup-logic*/") + "/*topup-logic*/".length;
  const end = html.indexOf("/*end-topup-logic*/");
  expect(start).toBeGreaterThan(100);
  expect(end).toBeGreaterThan(start);
  // The bundler wraps functions in __name(); the page must define it before the logic runs.
  expect(html.indexOf("var __name = function (fn) { return fn; };")).toBeGreaterThan(0);
  expect(html.indexOf("var __name = function (fn) { return fn; };")).toBeLessThan(start);
  const source = html.slice(start, end);
  return new Function(`var __name = function (fn) { return fn; }; return (${source})();`)() as TopupLogic;
}

const eth = (text: string): bigint => {
  const parsed = topupLogic().parseEth(text);
  if (!parsed.ok) throw new Error(`bad fixture ${text}`);
  return parsed.wei;
};

const CTX: TopupContext = { relayer: RELAYER, costWei: 644_000_000_000_000n, ethUsd: 2686.63 };
const GAS_PRICE = 5_000_000n; // 0.005 gwei

function state(over: Partial<TopupState> = {}): TopupState {
  return { phase: "ready", account: WALLET, balance: eth("0.05"), fee: topupLogic().estimateFee(GAS_PRICE), amountText: "", hash: null, error: "", slow: false, failedTo: "idle", ...over };
}

for (const [name, L] of [["module", topupLogic()], ["shipped inline script", shippedLogic()]] as const) {
  describe(`topup logic (${name})`, () => {
    test("parses both decimal marks to exact wei", () => {
      expect(L.parseEth("0,005")).toEqual({ ok: true, wei: 5_000_000_000_000_000n });
      expect(L.parseEth("0.005")).toEqual({ ok: true, wei: 5_000_000_000_000_000n });
      expect(L.parseEth(".5")).toEqual({ ok: true, wei: 500_000_000_000_000_000n });
      expect(L.parseEth("5.")).toEqual({ ok: true, wei: 5_000_000_000_000_000_000n });
      expect(L.parseEth("  1  ")).toEqual({ ok: true, wei: 1_000_000_000_000_000_000n });
      // No float rounding: 0.1 + 0.2 style values stay exact, down to the last wei.
      expect(L.parseEth("0.300000000000000001")).toEqual({ ok: true, wei: 300_000_000_000_000_001n });
      expect(L.parseEth("0.000000000000000001")).toEqual({ ok: true, wei: 1n });
    });

    test("rejects exponents, signs, separators, too many decimals, zero and empty", () => {
      expect(L.parseEth("1e3")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("-0.005")).toEqual({ ok: false, reason: "negative" });
      expect(L.parseEth("−0,005")).toEqual({ ok: false, reason: "negative" });
      expect(L.parseEth("+1")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("0.0000000000000000001")).toEqual({ ok: false, reason: "decimals" });
      expect(L.parseEth("1,000.5")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("1.000,5")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("0,0,5")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("1 000")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("0x10")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth(".")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("abc")).toEqual({ ok: false, reason: "format" });
      expect(L.parseEth("0")).toEqual({ ok: false, reason: "zero" });
      expect(L.parseEth("0,000")).toEqual({ ok: false, reason: "zero" });
      expect(L.parseEth("")).toEqual({ ok: false, reason: "empty" });
      expect(L.parseEth(null)).toEqual({ ok: false, reason: "empty" });
    });

    test("formatEth trims zeros, floors by default and can round up", () => {
      expect(L.formatEth(2_500_000_000_000_000n)).toBe("0.0025");
      expect(L.formatEth(1_000_000_000_000_000_000n)).toBe("1");
      expect(L.formatEth(5_002_210_000_000_000n, 5, true)).toBe("0.00501");
      expect(L.formatEth(5_002_210_000_000_000n, 5)).toBe("0.005");
      expect(L.formatEth(0n)).toBe("0");
      expect(L.formatEth(300_000_000_000_000_001n, 18)).toBe("0.300000000000000001");
    });

    test("fee: 21000 gas at twice the gas price plus the L1 margin", () => {
      expect(L.estimateFee(GAS_PRICE)).toBe(21000n * GAS_PRICE * 2n + 2_000_000_000_000n);
      expect(L.estimateFee(0n)).toBe(2_000_000_000_000n);
      expect(L.estimateFee(-5n)).toBe(2_000_000_000_000n);
    });

    test("affordability: amount plus fee against the balance, and the most it can send", () => {
      const fee = L.estimateFee(GAS_PRICE);
      const short = L.afford(eth("0.0025"), eth("0.005"), fee);
      expect(short.ok).toBe(false);
      expect(short.need).toBe(eth("0.005") + fee);
      expect(short.max).toBe(eth("0.002497"));
      expect(L.afford(eth("0.05"), eth("0.005"), fee).ok).toBe(true);
      // Exactly balance = amount + fee is affordable; one wei more is not.
      expect(L.afford(eth("0.005") + fee, eth("0.005"), fee).ok).toBe(true);
      expect(L.afford(eth("0.005") + fee - 1n, eth("0.005"), fee).ok).toBe(false);
      expect(L.maxSend(fee, fee)).toBe(0n);
      expect(L.maxSend(1n, fee)).toBe(0n);
      // Max always leaves the fee behind.
      const most = L.maxSend(eth("0.0025"), fee);
      expect(L.afford(eth("0.0025"), most, fee).ok).toBe(true);
    });

    test("live hint: dollars and accounts funded, each only when known", () => {
      expect(L.amountHint("0,005", CTX)).toBe("$13.43 · funds 7 more accounts");
      expect(L.amountHint("0.000644", CTX)).toBe("$1.73 · funds 1 more account");
      expect(L.amountHint("0.005", { ...CTX, ethUsd: null })).toBe("funds 7 more accounts");
      expect(L.amountHint("0.005", { ...CTX, costWei: null })).toBe("$13.43");
      expect(L.amountHint("1e3", CTX)).toBe("");
      expect(L.fundsAccounts(eth("0.005"), null)).toBeNull();
    });

    test("wallet errors become plain sentences", () => {
      expect(L.explain({ code: 4001, message: "User rejected the request." })).toBe("You declined the request in the wallet. Nothing was sent.");
      expect(L.explain({ message: "MetaMask Tx Signature: User denied transaction signature." })).toContain("declined");
      expect(L.explain({ code: -32002, message: "Request already pending" })).toContain("already has a request waiting");
      expect(L.explain({ code: -32000, message: "insufficient funds for gas * price + value" })).toContain("does not have enough ETH");
      expect(L.explain({ code: 4902, message: "Unrecognized chain ID" })).toContain("not on Base");
      expect(L.explain({ code: 4100, message: "Unauthorized" })).toContain("locked");
      expect(L.explain({ code: -32603, message: "Internal JSON-RPC error." })).toBe("The wallet returned an error: Internal JSON-RPC error.");
      expect(L.explain({ message: "x".repeat(400) }).length).toBeLessThan(200);
      expect(L.explain(undefined)).toContain("without saying why");
      expect(L.explain(null)).toContain("Nothing was sent");
    });

    test("hex helpers round-trip", () => {
      expect(L.toHex(eth("0.005"))).toBe("0x11c37937e08000");
      expect(L.fromHex("0x11c37937e08000")).toBe(eth("0.005"));
      expect(L.fromHex("nope")).toBeNull();
      expect(L.shortAddress(WALLET)).toBe("0xb343…53e1");
    });

    describe("view, state by state", () => {
      test("no wallet found", () => {
        const v = L.view(state({ phase: "nowallet", account: null }), CTX);
        expect(v).toMatchObject({ step: 1, line: "No wallet found in this browser.", wallet: "", primary: { action: "detect", enabled: true } });
        expect(v.detail).toContain("address below");
      });

      test("not connected: one Connect action, and the hint already works", () => {
        const v = L.view(state({ phase: "idle", account: null, balance: null, fee: null, amountText: "0,01" }), CTX);
        expect(v).toMatchObject({ step: 1, wallet: "", primary: { label: "Connect wallet", action: "connect" }, amountLocked: false });
        expect(v.hint).toBe("$26.87 · funds 15 more accounts");
      });

      test("connecting has a way back", () => {
        expect(L.view(state({ phase: "connecting", account: null }), CTX)).toMatchObject({ primary: null, secondary: { action: "reset" } });
      });

      test("wrong network: no Connect button any more, the wallet is named, Switch is the action", () => {
        const v = L.view(state({ phase: "wrongnet", balance: null }), CTX);
        expect(v).toMatchObject({ step: 1, tone: "warn", primary: { label: "Switch to Base", action: "switch" } });
        expect(v.wallet).toBe("0xb343…53e1 · not on Base");
      });

      test("ready: short address and balance replace Connect; Send is off until the amount is valid", () => {
        const empty = L.view(state(), CTX);
        expect(empty).toMatchObject({ step: 2, line: "Choose how much to send.", primary: { label: "Send to relayer", action: "review", enabled: false } });
        expect(empty.wallet).toBe("0xb343…53e1 · 0.05 ETH on Base");
        const bad = L.view(state({ amountText: "1e3" }), CTX);
        expect(bad).toMatchObject({ tone: "warn", line: "That is not an amount. Use digits, like 0.005.", primary: { enabled: false } });
        expect(L.view(state({ amountText: "-1" }), CTX).line).toBe("The amount cannot be negative.");
        expect(L.view(state({ amountText: "0.0000000000000000001" }), CTX).line).toBe("ETH has 18 decimal places at most.");
        expect(L.view(state({ amountText: "0" }), CTX).line).toBe("The amount has to be more than zero.");
        const reading = L.view(state({ amountText: "0.01", balance: null, fee: null }), CTX);
        expect(reading).toMatchObject({ line: "Reading the wallet's balance on Base.", primary: { enabled: false } });
        expect(reading.wallet).toContain("reading balance");
        const ok = L.view(state({ amountText: "0,01" }), CTX);
        expect(ok).toMatchObject({ tone: "plain", line: "Ready to send 0.01 ETH to the relayer.", primary: { enabled: true }, offer: null });
      });

      test("insufficient balance: the exact sentence, Send off, and the largest sendable amount offered", () => {
        const v = L.view(state({ balance: eth("0.0025"), amountText: "0,005" }), CTX);
        expect(v.line).toBe("This wallet has 0.0025 ETH on Base. Sending 0.005 ETH needs about 0.00501.");
        expect(v).toMatchObject({ step: 2, tone: "warn", primary: { action: "review", enabled: false }, offer: { label: "Use 0.002497 ETH", amountText: "0.002497" } });
        expect(L.view(state({ balance: eth("0.0025"), amountText: v.offer!.amountText }), CTX).primary?.enabled).toBe(true);
        const dust = L.view(state({ balance: 1000n, amountText: "0.005" }), CTX);
        expect(dust.offer).toBeNull();
        expect(dust.detail).toContain("cannot cover the network fee");
      });

      test("confirm shows amount, the full address and the network, and can go back", () => {
        const v = L.view(state({ phase: "confirm", amountText: "0,02" }), CTX);
        expect(v).toMatchObject({ step: 3, amountLocked: true, line: "Send 0.02 ETH to the relayer on Base?", primary: { label: "Confirm in wallet", action: "send" }, secondary: { action: "back" } });
        expect(v.detail).toBe(`To ${RELAYER}. From 0xb343…53e1. Network: Base.`);
      });

      test("waiting for signature is never a dead end", () => {
        expect(L.view(state({ phase: "signing", amountText: "0.02" }), CTX)).toMatchObject({ line: "Waiting for your signature.", primary: null, secondary: { action: "back" } });
      });

      test("sent links the hash; slow confirmation offers Check again and Start over", () => {
        const hash = "0x9f3c2a7be1d04c5f8a6b0e2d4c6f8a1b3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f1a";
        const sent = L.view(state({ phase: "sent", amountText: "0.02", hash }), CTX);
        expect(sent).toMatchObject({ step: 3, primary: null, secondary: { action: "restart" }, link: { href: `https://basescan.org/tx/${hash}` } });
        const slow = L.view(state({ phase: "sent", amountText: "0.02", hash, slow: true }), CTX);
        expect(slow).toMatchObject({ line: "Still waiting for Base to confirm.", primary: { action: "check" }, secondary: { action: "restart" } });
      });

      test("confirmed", () => {
        expect(L.view(state({ phase: "confirmed", amountText: "0.02", hash: "0xabc" }), CTX)).toMatchObject({ tone: "good", line: "Confirmed. The relayer has the funds.", primary: { action: "reload" } });
      });

      test("failed or rejected: the sentence, Try again and Start over, amount editable again", () => {
        const v = L.view(state({ phase: "failed", amountText: "0.02", error: L.explain({ code: 4001 }), failedTo: "ready" }), CTX);
        expect(v).toMatchObject({ tone: "bad", amountLocked: false, line: "You declined the request in the wallet. Nothing was sent.", primary: { action: "retry" }, secondary: { action: "reset" } });
      });

      test("every state offers at least one way forward or back", () => {
        const phases = ["nowallet", "idle", "connecting", "wrongnet", "ready", "confirm", "signing", "sent", "confirmed", "failed"] as const;
        for (const phase of phases) {
          const v = L.view(state({ phase, amountText: "0.01", hash: "0xabc" }), CTX);
          expect(Boolean(v.primary || v.secondary)).toBe(true);
          expect(v.line.length).toBeGreaterThan(0);
        }
      });
    });
  });
}

describe("the gate, on every /ops route", () => {
  function opsEnv(): Env {
    return {
      ASSETS: { fetch: async () => new Response("asset", { status: 200, headers: { "content-type": "text/html" } }) } as unknown as Fetcher,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      OPS_SESSION_SECRET: "k1",
    };
  }
  const ROUTES = [
    ["GET", "/ops"],
    ["GET", "/ops/mails"],
    ["GET", "/ops/infra"],
    ["GET", "/ops/infra?fresh=1"],
    ["POST", "/ops/infra/refresh"],
    ["POST", "/ops/metrics/snapshot"],
    ["POST", "/ops/send"],
    ["POST", "/ops/remove"],
    ["POST", "/ops/logout"],
    ["GET", "/ops/anything-else"],
  ] as const;

  test("no session: nothing is served, only the sign-in redirect or a bare 404", async () => {
    for (const [method, path] of ROUTES) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`, { method }), opsEnv());
      const body = await res.text();
      expect([302, 404]).toContain(res.status);
      if (res.status === 302) expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
      expect(body).not.toContain(RELAYER);
      expect(body).not.toContain("Relayer");
      expect(body).not.toContain("csrf");
    }
  });

  test("a session whose address left the allowlist gets a 404 everywhere", async () => {
    const cookie = `mamoru_list=${await sealSession("k1", "someone@example.com")}`;
    for (const [method, path] of ROUTES) {
      const res = await worker.fetch(new Request(`https://mamoru.lol${path}`, { method, headers: { cookie } }), opsEnv());
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(RELAYER);
    }
  });

  test("a forged session cookie is no session", async () => {
    const forged = `mamoru_list=${await sealSession("another-secret", "ottodevs@gmail.com")}`;
    const res = await worker.fetch(new Request("https://mamoru.lol/ops/infra", { headers: { cookie: forged } }), opsEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("https://accounts.google.com/");
    expect(await res.text()).not.toContain("Relayer");
  });

  test("POST /ops/infra/refresh refuses a wrong CSRF token", async () => {
    const cookie = `mamoru_list=${await sealSession("k1", "ottodevs@gmail.com")}`;
    const res = await worker.fetch(
      new Request("https://mamoru.lol/ops/infra/refresh", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "csrf=wrong",
      }),
      opsEnv(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie") ?? "").toContain("mamoru_flash=bad");
  });
});
