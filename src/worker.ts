/**
 * Cloudflare Worker entry: static assets plus POST /api/notify.
 *
 * Optional bindings (set via wrangler; never commit real values):
 *   WAITLIST        KV namespace, one key per email
 *   RESEND_API_KEY  wrangler secret, sends the on-the-list email
 *   MAIL_FROM       sender address for that email
 */

export interface Env {
  ASSETS: Fetcher;
  WAITLIST?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

type NotifyBody = {
  email?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const FOLLOW_UP =
  "You're on the list. We'll write when mamoru.lol opens.";

async function handleNotify(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Invalid email" }, 400);
  }

  if (env.WAITLIST) {
    const key = `waitlist:${email}`;
    const existing = await env.WAITLIST.get(key);
    if (!existing) {
      await env.WAITLIST.put(
        key,
        JSON.stringify({ email, at: new Date().toISOString() }),
      );
    }
  }

  const from = env.MAIL_FROM;
  const resend = env.RESEND_API_KEY;
  if (from && resend) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resend}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "You're on the list",
        text: [
          "Hello.",
          "",
          FOLLOW_UP,
          "",
          "Stay tuned to discover the future of savings.",
          "",
          "The Impermanent loss Killer.",
          "",
          "Mamoru",
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("resend_failed", res.status);
    }
  }

  return json({ ok: true, message: FOLLOW_UP });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/notify") {
      return handleNotify(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
