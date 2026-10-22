import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { D1Db } from "../src/d1-infra";
import { parseCapInput, validateAccountCapOverride } from "../src/account-cap-model";
import { appendCapOverride, CapConflict, CapOutcomeUnknown, newestOverrideOf, newestOverrides, resolveAccountKey } from "../src/account-caps-store";
import { checkCapConfirmToken, issueCapConfirmToken, CAP_CONFIRM_TTL_MS } from "../src/account-caps-confirm";
import { loadConsole, parseAuthorizations } from "../src/console-data";
import { accountsView } from "../src/console-views";
import { sealSession } from "../src/ops";
import worker, { type Env } from "../src/worker";

import { A, B, capsDb } from "./account-caps-fixture";

async function opsEnv(db: D1Db | undefined) {
  const env: Env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OPS_SESSION_SECRET: "k1",
    ...(db ? { MAMORU_DB: db } : {}),
  };
  const sealed = await sealSession("k1", "ottodevs@gmail.com");
  return { env, cookie: `mamoru_list=${sealed}` };
}

const get = (path: string, cookie = "") => new Request(`https://mamoru.lol${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, body: URLSearchParams, cookie = "", fragment = false) =>
  new Request(`https://mamoru.lol${path}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/x-www-form-urlencoded", ...(fragment ? { "x-ops-fragment": "1" } : {}) }, body: body.toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;
const unesc = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The confirm screen's form, submitted as the browser would. */
function confirmBodyOf(html: string): URLSearchParams {
  const form = html.slice(html.indexOf('class="c-sheet c-confirm"'));
  const end = form.indexOf("</form>");
  return new URLSearchParams([...form.slice(0, end).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)].map((m) => [m[1]!, unesc(m[2]!)]));
}
const rowsOf = (db: { raw: Database }) => db.raw.query("SELECT id, account_key, cap_usdc, author, reason FROM account_cap_overrides ORDER BY id").all() as { id: number; account_key: string; cap_usdc: number | null; author: string; reason: string }[];

describe("validateAccountCapOverride (port of packages/policy)", () => {
  test("whole USDC from 1 to 1,000,000, or null", () => {
    expect(validateAccountCapOverride({ accountKey: A, capUsdc: 2000 })).toEqual([]);
    expect(validateAccountCapOverride({ accountKey: A, capUsdc: null })).toEqual([]);
    expect(validateAccountCapOverride({ accountKey: A, capUsdc: 1 })).toEqual([]);
    expect(validateAccountCapOverride({ accountKey: A, capUsdc: 1_000_000 })).toEqual([]);
    for (const bad of [0, -5, 1_000_001, 12.5, NaN, "2000"]) expect(validateAccountCapOverride({ accountKey: A, capUsdc: bad }).length).toBe(1);
  });
  test("the account key is 1 to 128 letters, digits, - or _", () => {
    expect(validateAccountCapOverride({ accountKey: "", capUsdc: 5 }).length).toBe(1);
    expect(validateAccountCapOverride({ accountKey: "a b", capUsdc: 5 }).length).toBe(1);
    expect(validateAccountCapOverride({ accountKey: "x".repeat(129), capUsdc: 5 }).length).toBe(1);
    expect(validateAccountCapOverride({ accountKey: 7, capUsdc: 5 }).length).toBe(1);
  });
  test("the form amount takes thousands separators and nothing else", () => {
    expect(parseCapInput("2,000")).toBe(2000);
    expect(parseCapInput(" 2 000 ")).toBe(2000);
    expect(parseCapInput("1000000")).toBe(1_000_000);
    for (const bad of ["", "0", "1000001", "12.5", "-3", "2e3", "abc", "0x10"]) expect(parseCapInput(bad)).toBeNull();
  });
});

describe("account key resolution", () => {
  test("0, 1 and several matches", async () => {
    const db = capsDb();
    expect(await resolveAccountKey(db, "deadbeef")).toEqual({ kind: "none" });
    expect(await resolveAccountKey(db, "3F9A7C21")).toEqual({ kind: "one", accountKey: A, env: "prod", isTest: false });
    expect(await resolveAccountKey(db, "3f9a")).toEqual({ kind: "none" });
    expect(await resolveAccountKey(db, "3f9a7c2%")).toEqual({ kind: "none" });
    expect(await resolveAccountKey(capsDb({ dupe: true }), "3f9a7c21")).toEqual({ kind: "many", count: 2 });
  });
});

describe("confirm token", () => {
  test("commits to account, amount and the newest override id", async () => {
    const t = await issueCapConfirmToken("k1", "csrf", A, 2000, 4);
    expect(await checkCapConfirmToken("k1", "csrf", t, A, 2000, 4)).toBe(true);
    expect(await checkCapConfirmToken("k1", "csrf", t, A.toUpperCase(), 2000, 4)).toBe(true);
    expect(await checkCapConfirmToken("k1", "csrf", t, A, 2001, 4)).toBe(false);
    expect(await checkCapConfirmToken("k1", "csrf", t, A, null, 4)).toBe(false);
    expect(await checkCapConfirmToken("k1", "csrf", t, B, 2000, 4)).toBe(false);
    expect(await checkCapConfirmToken("k1", "csrf", t, A, 2000, 5)).toBe(false);
    expect(await checkCapConfirmToken("k1", "other", t, A, 2000, 4)).toBe(false);
    expect(await checkCapConfirmToken("k2", "csrf", t, A, 2000, 4)).toBe(false);
    expect(await checkCapConfirmToken("k1", "csrf", t, A, 2000, 4, Date.now() + CAP_CONFIRM_TTL_MS + 1000)).toBe(false);
    expect(await checkCapConfirmToken("", "csrf", t, A, 2000, 4)).toBe(false);
  });
});

describe("store", () => {
  test("newest row per account wins; a stale expected id is a conflict; an unclear result is unknown", async () => {
    const db = capsDb();
    expect((await newestOverrides(db))!.map((r) => r.capUsdc).sort()).toEqual([1500, 2000]);
    await appendCapOverride(db, { env: "prod", accountKey: A, capUsdc: null, author: "x", reason: "done", expectedMaxId: 1 });
    expect((await newestOverrideOf(db, A))!.capUsdc).toBeNull();
    expect(appendCapOverride(db, { env: "prod", accountKey: A, capUsdc: 10, author: "x", reason: "y", expectedMaxId: 1 })).rejects.toBeInstanceOf(CapConflict);
    expect(appendCapOverride(capsDb({ runResult: { meta: {} } }), { env: "prod", accountKey: A, capUsdc: 10, author: "x", reason: "y", expectedMaxId: 1 })).rejects.toBeInstanceOf(CapOutcomeUnknown);
    expect(await newestOverrides(capsDb({ table: false }))).toBeNull();
    expect(await newestOverrideOf(capsDb({ table: false }), A)).toBeUndefined();
  });
});

describe("/ops/accounts/cap", () => {
  const body = (o: Record<string, string>) => new URLSearchParams(o);

  test("no session: 404 and nothing written, fragment included", async () => {
    const db = capsDb();
    const { env } = await opsEnv(db);
    for (const fragment of [false, true]) {
      const res = await worker.fetch(post("/ops/accounts/cap", body({ csrf: "x", key: "9b0e41aa", action: "set", cap: "50", reason: "r", base: "2" }), "", fragment), env);
      expect(res.status).toBe(404);
    }
    expect(rowsOf(db).length).toBe(2);
  });

  test("a wrong CSRF token never writes", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const res = await worker.fetch(post("/ops/accounts/cap", body({ csrf: "wrong", key: "9b0e41aa", action: "set", cap: "50", reason: "r", base: "2" }), cookie), env);
    expect(res.status).toBe(403);
    expect(rowsOf(db).length).toBe(2);
  });

  test("lowering writes at once, with the session's email as author", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const res = await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "1,500", reason: "smaller test", base: "1" }), cookie), env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("may now run up to 1,500 USDC");
    expect(html).toContain("next settings poll");
    expect(rowsOf(db).at(-1)).toMatchObject({ account_key: A, cap_usdc: 1500, author: "ottodevs@gmail.com", reason: "smaller test" });
  });

  test("raising asks to confirm; the confirm writes; a stale confirm is refused", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "3000", reason: "bigger", base: "1" }), cookie), env)).text();
    expect(ask).toContain("Confirm: authorize 3f9a7c21 up to 3,000 USDC");
    expect(ask).toContain("It runs 2,000 USDC now");
    expect(rowsOf(db).length).toBe(2);
    // Someone else writes a row for this account in between: the confirm no longer matches.
    await appendCapOverride(db, { env: "prod", accountKey: A, capUsdc: 1800, author: "other", reason: "meanwhile", expectedMaxId: 1 });
    const stale = await worker.fetch(post("/ops/accounts/cap", confirmBodyOf(ask), cookie), env);
    expect(stale.status).toBe(409);
    expect(rowsOf(db).length).toBe(3);
    // A fresh ask against the new row, then its confirm, writes.
    const ask2 = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "3000", reason: "bigger", base: "3" }), cookie), env)).text();
    const done = await worker.fetch(post("/ops/accounts/cap", confirmBodyOf(ask2), cookie), env);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("may now run up to 3,000 USDC");
    expect(rowsOf(db).at(-1)).toMatchObject({ cap_usdc: 3000, author: "ottodevs@gmail.com" });
  });

  test("a confirm token for another amount is refused and asks again", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "3000", reason: "r", base: "1" }), cookie), env)).text();
    const forged = confirmBodyOf(ask);
    forged.set("cap", "900000");
    const res = await (await worker.fetch(post("/ops/accounts/cap", forged, cookie), env)).text();
    expect(res).toContain("The earlier confirmation is out of date");
    expect(rowsOf(db).length).toBe(2);
  });

  test("back to the general cap writes a null row; it is a raise here (100 in effect, 1,000 general) so it confirms", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const ask = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "9b0e41aa", action: "clear", reason: "test over", base: "2" }), cookie), env)).text();
    expect(ask).toContain("back to the general cap");
    await worker.fetch(post("/ops/accounts/cap", confirmBodyOf(ask), cookie), env);
    expect(rowsOf(db).at(-1)).toMatchObject({ account_key: B, cap_usdc: null });
    // From 2,000 back to 1,000 is lower: no confirm.
    const res = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "clear", reason: "done", base: "1" }), cookie), env)).text();
    expect(res).toContain("is back on the general cap (1,000 USDC)");
  });

  test("refusals: unknown key, ambiguous key, bad amount, no reason, stale form", async () => {
    const db = capsDb({ dupe: true });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const send = async (o: Record<string, string>) => {
      const r = await worker.fetch(post("/ops/accounts/cap", body({ csrf, action: "set", reason: "r", base: "2", ...o }), cookie), env);
      return { status: r.status, html: await r.text() };
    };
    expect(await send({ key: "deadbeef", cap: "50" })).toMatchObject({ status: 400 });
    const many = await send({ key: "3f9a7c21", cap: "50", base: "1" });
    expect(many.status).toBe(409);
    expect(many.html).toContain("2 accounts start with 3f9a7c21");
    expect((await send({ key: "9b0e41aa", cap: "12.5" })).html).toContain("whole number of USDC from 1 to 1,000,000");
    expect((await send({ key: "9b0e41aa", cap: "0" })).status).toBe(400);
    expect((await send({ key: "9b0e41aa", cap: "50", reason: " " })).html).toContain("say why");
    expect((await send({ key: "9b0e41aa", cap: "50", base: "0" })).status).toBe(409);
    expect(rowsOf(db).length).toBe(2);
  });

  test("an out-of-bounds reported cap counts as unknown: raising still confirms", async () => {
    const db = capsDb();
    db.raw.exec(`UPDATE operator_metrics_latest SET payload_json = '${JSON.stringify({ operator: {}, authorizations: [{ account: "3f9a7c21", active: true, capUsdc: 2_000_000, capSource: "override" }] })}'`);
    db.raw.exec(`UPDATE engine_settings_versions SET settings_json = replace(settings_json, '"capUsdc":1000', '"capUsdc":100')`);
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const res = await (await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "1000000", reason: "r", base: "1" }), cookie), env)).text();
    expect(res).toContain("Confirm: authorize 3f9a7c21 up to 1,000,000 USDC");
    expect(rowsOf(db).length).toBe(2);
  });

  test("an indeterminate D1 result says it is unknown, never 'not applied'", async () => {
    const db = capsDb({ runResult: { meta: {} } });
    const { env, cookie } = await opsEnv(db);
    const csrf = csrfOf(await (await worker.fetch(get("/ops/accounts", cookie), env)).text());
    const res = await worker.fetch(post("/ops/accounts/cap", body({ csrf, key: "3f9a7c21", action: "set", cap: "500", reason: "r", base: "1" }), cookie), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Unknown whether this was written");
  });

  test("without the table: no form, and a post says so without writing", async () => {
    const db = capsDb({ table: false });
    const { env, cookie } = await opsEnv(db);
    const page = await (await worker.fetch(get("/ops/accounts", cookie), env)).text();
    expect(page).not.toContain('action="/ops/accounts/cap');
    expect(page).toContain("account caps table is not on this database");
    const res = await worker.fetch(post("/ops/accounts/cap", new URLSearchParams({ csrf: csrfOf(page), key: "3f9a7c21", action: "set", cap: "500", reason: "r", base: "0" }), cookie), env);
    expect(res.status).toBe(503);
  });
});

describe("rendering", () => {
  const NOW = new Date("2026-10-22T10:00:00Z");

  test("with authorizations: cap in effect and its source in words, signed cap, refused cap explained, own-cap sheet", async () => {
    const m = await loadConsole(capsDb(), "prod", NOW, null);
    const html = accountsView(m, NOW, { csrf: "c" }).html;
    expect(html).toContain("Cap in effect");
    expect(html).toContain("its own cap");
    expect(html).toContain("signed for 1,000 USDC. The 2,000 USDC cap applies to approvals signed from now on");
    expect(html).toContain("Asked for 1,500 USDC, but the engine keeps the code default of 100 USDC");
    expect(html).toContain("conservador-live-v2, version 2");
    expect(html).toContain("Nov, 9 days left");
    expect(html).toContain("64% used");
    expect(html).toContain("Accounts with their own cap");
    expect(html).toContain("Not in effect");
    expect(html).toContain("renewal due");
    expect(html).toContain("Authorize up to");
    expect(html).toContain("Back to the general cap (1,000 USDC)");
    // 5c2d8e10: reported, no approval.
    expect(html).toContain("The engine reports no approval for this account.");
  });

  test("without authorizations or the table: a plain 'not reported yet', no invented figure, no form", async () => {
    const m = await loadConsole(capsDb({ table: false, auth: false }), "prod", NOW, null);
    expect(m.caps.reported).toBe(false);
    expect(m.caps.table).toBe(false);
    const html = accountsView(m, NOW, { csrf: "c" }).html;
    expect(html).toContain("Not reported yet");
    expect(html).not.toContain("Cap in effect");
    expect(html).not.toContain("No approval");
    expect(html).not.toContain('name="cap"');
  });

  test("other views show the block read-only and point to Accounts", async () => {
    const db = capsDb();
    const { env, cookie } = await opsEnv(db);
    const html = await (await worker.fetch(get("/ops/yield", cookie), env)).text();
    expect(html).toContain("Cap in effect");
    expect(html).not.toContain('action="/ops/accounts/cap');
    expect(html).toContain("open it from <a href=\"/ops/accounts\">Accounts</a>");
  });

  test("a malformed authorizations field degrades entry by entry", () => {
    expect(parseAuthorizations(undefined)).toBeNull();
    expect(parseAuthorizations({})).toBeNull();
    const parsed = parseAuthorizations([{ account: "abcdef12", capSource: "nonsense", capUsdc: "2000", signedCapUsdc: 1_000_001, grants: [{ grant: 5 }], pools: [1, "pool:A/B/500"] }, { nope: 1 }])!;
    expect(parsed.complete).toBe(false);
    expect(parsed.entries[0]).toMatchObject({ account: "abcdef12", active: null, capSource: null, capUsdc: null, signedCapUsdc: null, grants: [], pools: ["pool:A/B/500"] });
    expect(parseAuthorizations([{ account: "x", capUsdc: 12.5 }])!.entries[0]!.capUsdc).toBeNull();
  });

  test("an incomplete report never says 'no approval' for an account it left out", async () => {
    const db = capsDb();
    db.raw.exec(`UPDATE operator_metrics_latest SET payload_json = '${JSON.stringify({ operator: {}, authorizations: [{ account: "3f9a7c21", capUsdc: 2000, capSource: "override" }, { broken: true }] })}'`);
    const m = await loadConsole(db, "prod", NOW, null);
    const html = accountsView(m, NOW, { csrf: "c" }).html;
    expect(html).not.toContain("No approval");
    expect(html).not.toContain("The engine reports no approval");
    expect(html).toContain("State not reported");
    // A cap the parser refused is unknown: the own-cap sheet never calls it "In effect".
    db.raw.exec(`UPDATE operator_metrics_latest SET payload_json = '${JSON.stringify({ operator: {}, authorizations: [{ account: "3f9a7c21", active: true, capUsdc: 2_000_000, capSource: "override" }] })}'`);
    const sheet = accountsView(await loadConsole(db, "prod", NOW, null), NOW).html;
    expect(sheet).toContain("runs cap not reported");
    const own = sheet.slice(sheet.indexOf("Accounts with their own cap"));
    expect(own).toContain('<span class="c-chip dim">Not reported</span>');
    expect(own).not.toContain(">In effect<");
  });
});
