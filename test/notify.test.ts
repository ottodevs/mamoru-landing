import { describe, expect, test } from "bun:test";
import worker, { NOTIFY_COPY, type Env, type OutboundMail } from "../src/worker";
import type { WaitlistKv } from "../src/list";
import { esc } from "../src/text";

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
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function fakeMail(): OutboundMail & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message.to);
      return { messageId: `m${sent.length}` };
    },
  };
}

const ASSETS = {
  fetch: async () => new Response("not found", { status: 404 }),
} as unknown as Fetcher;

function post(body: unknown, accept = "application/json"): Request {
  return new Request("https://mamoru.lol/api/notify", {
    method: "POST",
    headers: { "content-type": "application/json", accept, "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

function postForm(email: string): Request {
  return new Request("https://mamoru.lol/api/notify", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: new URLSearchParams({ email, leave_blank: "" }).toString(),
  });
}

describe("/api/notify dedupe", () => {
  test("new then already; the note goes out once", async () => {
    const kv = fakeKv();
    const mail = fakeMail();
    const env: Env = { ASSETS, WAITLIST: kv, EMAIL: mail };
    const email = "dedupe-one@example.com";

    const first = await worker.fetch(post({ email, leave_blank: "" }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, status: "new" });
    expect(mail.sent).toEqual([email]);
    const addresses = [...kv.store.keys()].filter((k) => k.startsWith("e:"));
    expect(addresses.length).toBe(1);
    const saved = JSON.parse(kv.store.get(addresses[0])!);
    expect(saved.note).toBe("sent");

    const second = await worker.fetch(post({ email: email.toUpperCase() }), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, status: "already" });
    expect(mail.sent).toEqual([email]);
    expect(JSON.parse(kv.store.get(addresses[0])!)).toEqual(saved);
  });

  test("already does not retry a failed note", async () => {
    const kv = fakeKv();
    const mail = fakeMail();
    mail.send = async () => {
      throw Object.assign(new Error("nope"), { code: "unavailable" });
    };
    const env: Env = { ASSETS, WAITLIST: kv, EMAIL: mail };
    const email = "dedupe-two@example.com";

    expect(await (await worker.fetch(post({ email }), env)).json()).toEqual({
      ok: true,
      status: "new",
    });
    const key = [...kv.store.keys()].find((k) => k.startsWith("e:"))!;
    expect(JSON.parse(kv.store.get(key)!).note).toBe("failed");

    let calls = 0;
    mail.send = async () => {
      calls += 1;
      return { messageId: "x" };
    };
    expect(await (await worker.fetch(post({ email }), env)).json()).toEqual({
      ok: true,
      status: "already",
    });
    expect(calls).toBe(0);
    expect(JSON.parse(kv.store.get(key)!).note).toBe("failed");
  });

  test("without EMAIL the entry stays pending and is still new", async () => {
    const kv = fakeKv();
    const env: Env = { ASSETS, WAITLIST: kv };
    const res = await worker.fetch(post({ email: "unlinked@example.com" }), env);
    expect(await res.json()).toEqual({ ok: true, status: "new" });
    const key = [...kv.store.keys()].find((k) => k.startsWith("e:"))!;
    expect(JSON.parse(kv.store.get(key)!).note).toBe("pending");
  });

  test("a failed save never claims success", async () => {
    const kv = fakeKv();
    kv.put = async (key: string, value: string) => {
      if (key.startsWith("e:")) throw new Error("kv down");
      kv.store.set(key, value);
    };
    const env: Env = { ASSETS, WAITLIST: kv, EMAIL: fakeMail() };
    const res = await worker.fetch(post({ email: "broken@example.com" }), env);
    expect(res.status).toBe(503);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe(NOTIFY_COPY.failed);

    const unbound = await worker.fetch(post({ email: "broken@example.com" }), { ASSETS });
    expect(unbound.status).toBe(503);
    expect(((await unbound.json()) as { ok: boolean }).ok).toBe(false);
  });

  test("invalid email is 400 and honeypot is a quiet ok", async () => {
    const env: Env = { ASSETS, WAITLIST: fakeKv(), EMAIL: fakeMail() };
    const bad = await worker.fetch(post({ email: "not-an-email" }), env);
    expect(bad.status).toBe(400);
    const honey = await worker.fetch(post({ email: "bot@example.com", leave_blank: "x" }), env);
    expect(honey.status).toBe(200);
    expect(await honey.json()).toEqual({ ok: true });
    expect((env.EMAIL as ReturnType<typeof fakeMail>).sent).toEqual([]);
  });

  test("html fallback shows the short line, not the email body", async () => {
    const env: Env = { ASSETS, WAITLIST: fakeKv(), EMAIL: fakeMail() };
    const first = await worker.fetch(postForm("form@example.com"), env);
    const html1 = await first.text();
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(html1).toContain(esc(NOTIFY_COPY.new));
    expect(html1).not.toContain("Welcome to Mamoru");
    const second = await worker.fetch(postForm("form@example.com"), env);
    expect(await second.text()).toContain(esc(NOTIFY_COPY.already));
  });
});
