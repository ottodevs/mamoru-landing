import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import worker, { NOTIFY_COPY, type Env } from "../src/worker";
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

type LoopsMock = { sent: string[]; status: number; success: boolean };
let loops: LoopsMock;
let originalFetch: typeof fetch;

beforeEach(() => {
  loops = { sent: [], status: 200, success: true };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("app.loops.so/api/v1/transactional")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.email) loops.sent.push(body.email);
      return new Response(JSON.stringify({ success: loops.success }), { status: loops.status });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function loopsEnv(kv: WaitlistKv): Env {
  return {
    ASSETS,
    WAITLIST: kv,
    LOOPS_API_KEY: "test-key",
    LOOPS_TRANSACTIONAL_ID: "test-tx-id",
  };
}

describe("/api/notify dedupe", () => {
  test("new then already; the note goes out once", async () => {
    const kv = fakeKv();
    const env = loopsEnv(kv);
    const email = "dedupe-one@example.com";

    const first = await worker.fetch(post({ email, leave_blank: "" }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, status: "new" });
    expect(loops.sent).toEqual([email]);
    const addresses = [...kv.store.keys()].filter((k) => k.startsWith("e:"));
    expect(addresses.length).toBe(1);
    const saved = JSON.parse(kv.store.get(addresses[0])!);
    expect(saved.note).toBe("sent");

    const second = await worker.fetch(post({ email: email.toUpperCase() }), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, status: "already" });
    expect(loops.sent).toEqual([email]);
    expect(JSON.parse(kv.store.get(addresses[0])!)).toEqual(saved);
  });

  test("without Loops secrets the signup still saves as pending", async () => {
    const kv = fakeKv();
    const env: Env = { ASSETS, WAITLIST: kv };
    const email = "pending-one@example.com";
    const res = await worker.fetch(post({ email }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "new" });
    expect(loops.sent).toEqual([]);
    const addresses = [...kv.store.keys()].filter((k) => k.startsWith("e:"));
    const saved = JSON.parse(kv.store.get(addresses[0])!);
    expect(saved.note).toBe("pending");
  });

  test("Loops failure marks failed but signup is ok", async () => {
    const kv = fakeKv();
    const env = loopsEnv(kv);
    loops.status = 502;
    loops.success = false;
    const email = "fail-one@example.com";
    const res = await worker.fetch(post({ email }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "new" });
    const addresses = [...kv.store.keys()].filter((k) => k.startsWith("e:"));
    const saved = JSON.parse(kv.store.get(addresses[0])!);
    expect(saved.note).toBe("failed");
  });

  test("form post and honeypot", async () => {
    const kv = fakeKv();
    const env = loopsEnv(kv);
    const ok = await worker.fetch(postForm("form-one@example.com"), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain(esc(NOTIFY_COPY.new));

    const honey = await worker.fetch(
      post({ email: "bot@example.com", leave_blank: "x" }),
      env,
    );
    expect(honey.status).toBe(200);
    expect(await honey.json()).toEqual({ ok: true });
    expect(loops.sent).toEqual(["form-one@example.com"]);
  });
});
