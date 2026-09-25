/**
 * Assets, the landing waitlist, and the private list.
 * Addresses are stored. They are not logged.
 *
 *   WAITLIST   KV. Required for /api/notify.
 *   LIST_GATE  secret. Required for /ops.
 *   EMAIL      Cloudflare Email binding. One welcome note, from notify@mamoru.lol.
 */

import {
  CUSTODY_LINE,
  FOLLOW_UP_LINES,
  FOLLOW_UP_SUBJECT,
  FOLLOW_UP_TEXT,
  MAIL_FROM,
  followUpHtml,
} from "./follow-up";
import {
  bumpedLimit,
  deleteEntry,
  listEntries,
  readEntry,
  writeEntry,
  type Entry,
  type WaitlistKv,
} from "./list";
import {
  clearSessionCookie,
  flashCookie,
  openSession,
  opsHeaders,
  readFlash,
  renderList,
  renderLogin,
  sealSession,
  sessionCookie,
  type Flash,
} from "./ops";
import { esc, normalizeEmail, sameSecret } from "./text";

export interface OutboundMail {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    attachments?: {
      content: ArrayBuffer;
      filename: string;
      type: string;
      disposition: "inline" | "attachment";
      contentId?: string;
    }[];
  }): Promise<{ messageId: string }>;
}

export interface Env {
  ASSETS: Fetcher;
  WAITLIST?: WaitlistKv;
  LIST_GATE?: string;
  EMAIL?: OutboundMail;
}

type NotifyInput = { email: string; honey: string };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

async function readNotify(request: Request): Promise<NotifyInput | null> {
  const ctype = request.headers.get("content-type") || "";
  try {
    if (ctype.includes("application/json")) {
      const body = (await request.json()) as { email?: unknown; leave_blank?: unknown };
      return {
        email: String(body.email ?? ""),
        honey: String(body.leave_blank ?? ""),
      };
    }
    if (
      ctype.includes("application/x-www-form-urlencoded") ||
      ctype.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      return {
        email: String(form.get("email") ?? ""),
        honey: String(form.get("leave_blank") ?? ""),
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function markBytes(request: Request, env: Env): Promise<ArrayBuffer | null> {
  try {
    const url = new URL("/mark-two-stones.png", request.url);
    const res = await env.ASSETS.fetch(new Request(url.toString()));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function deliver(
  request: Request,
  env: Env,
  email: string,
): Promise<"sent" | "failed" | "unlinked"> {
  if (!env.EMAIL) return "unlinked";
  const mark = await markBytes(request, env);
  try {
    await env.EMAIL.send({
      to: email,
      from: { email: MAIL_FROM.email, name: MAIL_FROM.name },
      subject: FOLLOW_UP_SUBJECT,
      text: FOLLOW_UP_TEXT,
      html: followUpHtml(mark != null),
      attachments: mark
        ? [
            {
              content: mark,
              filename: "mamoru.png",
              type: "image/png",
              disposition: "inline",
              contentId: "mamoru-mark",
            },
          ]
        : undefined,
    });
    return "sent";
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "error";
    console.error("followup_failed", code);
    return "failed";
  }
}

async function saveAndNote(
  request: Request,
  env: Env,
  kv: WaitlistKv,
  email: string,
): Promise<void> {
  const existing = await readEntry(kv, email);
  const now = new Date().toISOString();
  const base: Entry = existing ?? { email, at: now, note: "pending" };
  if (base.note === "sent") return;
  if (!existing) await writeEntry(kv, base);
  const result = await deliver(request, env, email);
  if (result === "unlinked") return;
  await writeEntry(kv, {
    ...base,
    note: result === "sent" ? "sent" : "failed",
    noteAt: new Date().toISOString(),
  });
}

function htmlPage(title: string, lines: readonly string[]): Response {
  const body = lines.map((line) => `<p>${esc(line)}</p>`).join("");
  return new Response(
    `<!DOCTYPE html><html lang="en"><meta charset="utf-8" /><title>${title}</title><body style="background:#F8F5EF;color:#0F0F0E;font-family:Georgia,serif;padding:3rem">${body}</body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  const input = await readNotify(request);
  const wantsHtml = !(request.headers.get("content-type") || "").includes("json");
  if (!input) {
    return wantsHtml
      ? htmlPage("Mamoru", ["That did not come through."])
      : json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (input.honey.trim()) {
    return wantsHtml
      ? htmlPage("Mamoru", [...FOLLOW_UP_LINES])
      : json({ ok: true });
  }
  const email = normalizeEmail(input.email);
  if (!email) {
    return wantsHtml
      ? htmlPage("Mamoru", ["Enter an email."])
      : json({ ok: false, error: "Invalid email" }, 400);
  }
  if (!env.WAITLIST) {
    console.error("waitlist_unbound");
    return wantsHtml
      ? htmlPage("Mamoru", ["Could not save that. Try again."])
      : json({ ok: false, error: "Could not save that. Try again." }, 503);
  }
  if (await bumpedLimit(env.WAITLIST, "rl", clientIp(request), 8)) {
    return wantsHtml
      ? htmlPage("Mamoru", ["Try again later."])
      : json({ ok: false, error: "Try again later" }, 429);
  }
  try {
    await saveAndNote(request, env, env.WAITLIST, email);
  } catch {
    console.error("waitlist_write_failed");
    return wantsHtml
      ? htmlPage("Mamoru", ["Could not save that. Try again."])
      : json({ ok: false, error: "Could not save that. Try again." }, 503);
  }
  return wantsHtml
    ? htmlPage("Mamoru", [...FOLLOW_UP_LINES, CUSTODY_LINE])
    : json({ ok: true });
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function opsResponse(html: string, cookies: string[] = [], status = 200): Response {
  const headers = opsHeaders();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status, headers });
}

function redirectOps(request: Request, flash: Flash, cookies: string[]): Response {
  const headers = opsHeaders();
  headers.set("location", "/ops");
  const secure = secureRequest(request);
  headers.append("set-cookie", flashCookie(flash, secure));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

async function handleOps(request: Request, env: Env): Promise<Response> {
  if (!env.LIST_GATE) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const secure = secureRequest(request);
  const session = await openSession(
    env.LIST_GATE,
    request.headers.get("cookie"),
  );
  const flash = readFlash(request.headers.get("cookie"));

  if (url.pathname === "/ops/login" && request.method === "POST") {
    if (!env.WAITLIST) return opsResponse(renderLogin("limited"), [], 503);
    if (await bumpedLimit(env.WAITLIST, "gl", clientIp(request), 8)) {
      return opsResponse(renderLogin("limited"), [], 429);
    }
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!(await sameSecret(password, env.LIST_GATE))) {
      return opsResponse(renderLogin("bad"), [], 401);
    }
    const token = await sealSession(env.LIST_GATE);
    return redirectOps(request, "", [sessionCookie(token, secure)]);
  }

  if (!session) {
    if (url.pathname !== "/ops" || request.method !== "GET") {
      return opsResponse(renderLogin(flash), [flashCookie("", secure)], 401);
    }
    return opsResponse(renderLogin(flash), [flashCookie("", secure)]);
  }

  if (url.pathname === "/ops/logout" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    return redirectOps(request, "", [clearSessionCookie(secure)]);
  }

  if (!env.WAITLIST) {
    return opsResponse("<p>La lista no está conectada.</p>", [], 503);
  }

  if (url.pathname === "/ops/remove" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    const email = normalizeEmail(String(form.get("email") ?? ""));
    if (email) await deleteEntry(env.WAITLIST, email);
    return redirectOps(request, "removed", []);
  }

  if (url.pathname === "/ops/send" && request.method === "POST") {
    const form = await request.formData();
    if (!(await sameSecret(String(form.get("csrf") ?? ""), session.csrf))) {
      return redirectOps(request, "bad", []);
    }
    if (!env.EMAIL) return redirectOps(request, "waiting", []);
    const { entries } = await listEntries(env.WAITLIST);
    let failed = false;
    let sent = 0;
    for (const entry of entries) {
      if (entry.note === "sent" || sent >= 25) continue;
      const result = await deliver(request, env, entry.email);
      if (result === "sent") {
        sent += 1;
        await writeEntry(env.WAITLIST, {
          ...entry,
          note: "sent",
          noteAt: new Date().toISOString(),
        });
      } else if (result === "failed") {
        failed = true;
        await writeEntry(env.WAITLIST, {
          ...entry,
          note: "failed",
          noteAt: new Date().toISOString(),
        });
      }
    }
    return redirectOps(request, failed ? "failed" : sent ? "sent" : "waiting", []);
  }

  if (url.pathname === "/ops" && request.method === "GET") {
    const { entries, truncated } = await listEntries(env.WAITLIST);
    return opsResponse(
      renderList({
        entries,
        truncated,
        csrf: session.csrf,
        flash,
        mailReady: Boolean(env.EMAIL),
      }),
      [flashCookie("", secure)],
    );
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/notify") return handleNotify(request, env);
    if (url.pathname === "/ops" || url.pathname.startsWith("/ops/")) {
      return handleOps(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
