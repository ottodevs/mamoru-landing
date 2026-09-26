import { b64url, b64urlDecode } from "./google";
import type { Entry } from "./list";
import { esc, sameSecret } from "./text";

const COOKIE = "mamoru_list";
const FLASH = "mamoru_flash";
const OAUTH = "mamoru_oauth";
const MAX_AGE = 60 * 60 * 12;
const OAUTH_MAX_AGE = 60 * 10;

export type Session = { exp: number; csrf: string; email: string };
export type OauthState = {
  exp: number;
  state: string;
  nonce: string;
  verifier: string;
  next?: string;
};

export type Flash = "sent" | "waiting" | "failed" | "removed" | "bad" | "";

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return new Uint8Array(sig);
}

async function seal(secret: string, data: unknown): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(data)));
  const mac = b64url(await hmac(secret, payload));
  return `${payload}.${mac}`;
}

async function open<T>(secret: string, raw: string): Promise<Partial<T> | null> {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = b64url(await hmac(secret, payload));
  if (!(await sameSecret(mac, expected))) return null;
  const bytes = b64urlDecode(payload);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Partial<T>;
  } catch {
    return null;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function openSession(
  secret: string,
  cookieHeader: string | null,
): Promise<Session | null> {
  const data = await open<Session>(secret, readCookie(cookieHeader, COOKIE));
  if (!data) return null;
  if (typeof data.exp !== "number" || data.exp < now()) return null;
  if (typeof data.csrf !== "string" || typeof data.email !== "string") return null;
  return { exp: data.exp, csrf: data.csrf, email: data.email };
}

export async function sealSession(secret: string, email: string): Promise<string> {
  const session: Session = {
    exp: now() + MAX_AGE,
    csrf: crypto.randomUUID(),
    email,
  };
  return seal(secret, session);
}

export async function openOauthState(
  secret: string,
  cookieHeader: string | null,
): Promise<OauthState | null> {
  const data = await open<OauthState>(secret, readCookie(cookieHeader, OAUTH));
  if (!data) return null;
  if (typeof data.exp !== "number" || data.exp < now()) return null;
  if (
    typeof data.state !== "string" ||
    typeof data.nonce !== "string" ||
    typeof data.verifier !== "string"
  ) {
    return null;
  }
  return { exp: data.exp, state: data.state, nonce: data.nonce, verifier: data.verifier };
}

export async function sealOauthState(
  secret: string,
  state: Omit<OauthState, "exp">,
): Promise<string> {
  return seal(secret, { ...state, exp: now() + OAUTH_MAX_AGE } satisfies OauthState);
}

export function readCookie(header: string | null, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

export function readFlash(header: string | null): Flash {
  const value = readCookie(header, FLASH);
  if (
    value === "sent" ||
    value === "waiting" ||
    value === "failed" ||
    value === "removed" ||
    value === "bad"
  ) {
    return value;
  }
  return "";
}

/** Lax, not Strict: the cookie must survive the top-level redirect back from Google. */
function cookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
  path = "/ops",
  domain?: string,
): string {
  const bits = [
    `${name}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (domain) bits.push(`Domain=${domain}`);
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/** Shared by mamoru.lol and app.mamoru.lol. Host-only on any other host. */
function sessionDomain(host: string): string | undefined {
  return host === "mamoru.lol" || host.endsWith(".mamoru.lol") ? ".mamoru.lol" : undefined;
}

export function sessionCookie(token: string, secure: boolean, host = ""): string {
  return cookie(COOKIE, token, secure, MAX_AGE, "/", sessionDomain(host));
}

export function clearSessionCookie(secure: boolean, host = ""): string {
  return cookie(COOKIE, "", secure, 0, "/", sessionDomain(host));
}

export function oauthCookie(token: string, secure: boolean, host = ""): string {
  return cookie(OAUTH, token, secure, OAUTH_MAX_AGE, "/ops", sessionDomain(host));
}

export function clearOauthCookie(secure: boolean, host = ""): string {
  return cookie(OAUTH, "", secure, 0, "/ops", sessionDomain(host));
}

export function flashCookie(flash: Flash, secure: boolean): string {
  return cookie(FLASH, flash, secure, flash ? 60 : 0);
}

const FLASH_COPY: Record<Exclude<Flash, "">, string> = {
  sent: "Notes sent.",
  waiting: "Still waiting. Loops is not wired yet.",
  failed: "Some notes did not go out. The address stays on the list.",
  removed: "Removed from the list.",
  bad: "That did not go through. Try again.",
};

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)}</title>
  <style>
    @font-face {
      font-family: "Noto Serif";
      src: url("/fonts/NotoSerif-400.ttf") format("truetype");
      font-weight: 400;
      font-style: normal;
    }
    body {
      margin: 0;
      background: #f8f5ef url("/rice-washi-tile.webp") repeat;
      background-size: 256px 256px;
      color: #0f0f0e;
      font-family: "Noto Serif", Georgia, "Times New Roman", serif;
    }
    main { max-width: 40rem; padding: 3rem 1.5rem 4rem; }
    img.mark { width: 56px; height: 56px; display: block; }
    h1 { font-weight: 400; font-size: 1.6rem; margin: 0.8rem 0 0.6rem; }
    p { line-height: 1.45; margin: 0 0 0.8rem; }
    .quiet { color: #8a8578; }
    .flash { margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.4rem; }
    th, td { text-align: left; font-weight: 400; padding: 0.55rem 0.4rem 0.55rem 0; vertical-align: baseline; border-bottom: 1px solid #e4dfd4; }
    th { color: #8a8578; font-size: 0.85rem; }
    form.inline { display: inline; }
    a { color: #2f5d50; }
    button, input {
      font: inherit;
      color: inherit;
    }
    button {
      background: #0f0f0e;
      color: #f4f0e6;
      border: 0;
      padding: 0.45rem 0.9rem;
      cursor: pointer;
    }
    button.quiet {
      background: transparent;
      color: #8a8578;
      padding: 0;
    }
    .row-actions { white-space: nowrap; }
  </style>
</head>
<body>
  <main>
    <img class="mark" src="/mark-two-stones.png" width="56" height="56" alt="Mamoru" />
    ${body}
  </main>
</body>
</html>`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

const NOTE_LABEL: Record<Entry["note"], string> = {
  sent: "Sent",
  pending: "Waiting",
  failed: "Failed",
};

export function renderList(opts: {
  entries: Entry[];
  truncated: boolean;
  csrf: string;
  flash: Flash;
  mailReady: boolean;
  who?: string;
}): string {
  const sent = opts.entries.filter((e) => e.note === "sent").length;
  const waiting = opts.entries.length - sent;
  const flash = opts.flash ? `<p class="flash">${FLASH_COPY[opts.flash]}</p>` : "";
  const mail = opts.mailReady
    ? `<p class="quiet">The note goes out once via Loops (Welcome to Mamoru). If it says Failed, Loops rejected the send. The address is still saved.</p>`
    : `<p class="quiet">The list is saved. The note cannot go out yet: sending from the domain is not connected.</p>`;
  const more = opts.truncated
    ? `<p class="quiet">There are more. These are the first ${opts.entries.length}.</p>`
    : "";
  const rows = opts.entries
    .map(
      (entry) => `<tr>
        <td>${esc(entry.email)}</td>
        <td>${esc(when(entry.at))}</td>
        <td>${NOTE_LABEL[entry.note]}</td>
        <td class="row-actions">
          <form class="inline" method="post" action="/ops/remove">
            <input type="hidden" name="csrf" value="${esc(opts.csrf)}" />
            <input type="hidden" name="email" value="${esc(entry.email)}" />
            <button class="quiet" type="submit">Remove</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");
  const table = opts.entries.length
    ? `<table>
        <thead><tr><th>Email</th><th>When</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p>Nobody yet.</p>`;
  const send =
    waiting > 0 && opts.mailReady
      ? `<form method="post" action="/ops/send">
          <input type="hidden" name="csrf" value="${esc(opts.csrf)}" />
          <button type="submit">Send the missing ones</button>
        </form>`
      : "";
  const who = opts.who ? `<span class="quiet">Signed in as ${esc(opts.who)} · </span>` : "";
  return shell(
    "The list",
    `<h1>The list</h1>
    <p>These emails stay here. We hold them the way we hold funds: they do not leave this house, and we send nothing else.</p>
    ${mail}
    <p>${opts.entries.length} on the list · ${sent} notes sent · ${waiting} without a note</p>
    ${flash}
    ${more}
    ${send}
    ${table}
    <p><a href="/ops/landing">The site</a></p>
    <form method="post" action="/ops/logout">
      <input type="hidden" name="csrf" value="${esc(opts.csrf)}" />
      <p>${who}<button class="quiet" type="submit">Sign out</button></p>
    </form>`,
  );
}

export function opsHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'",
  );
  return headers;
}
