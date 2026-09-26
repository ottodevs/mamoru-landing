/**
 * Google OpenID Connect for /ops.
 * Authorization code + PKCE. The only claim we keep is the email.
 * Nothing from Google is logged.
 */

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * Exact addresses that may open the list.
 * Match is case-insensitive. For gmail.com and googlemail.com only, dots in
 * the local part are ignored. Plus-tags stay part of the address.
 */
function canonicalizeForAllowlist(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

export const OPS_ALLOWLIST: ReadonlySet<string> = new Set(
  ["ottodevs@gmail.com", "brais.millarengo@gmail.com"].map(canonicalizeForAllowlist),
);

export function isAllowed(email: string): boolean {
  return OPS_ALLOWLIST.has(canonicalizeForAllowlist(email));
}

export type Identity = { email: string };

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const bin = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Swap the code for an ID token. Null on any failure. */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  try {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id_token?: unknown };
    return typeof data.id_token === "string" ? data.id_token : null;
  } catch {
    return null;
  }
}

type Jwk = JsonWebKey & { kid?: string; alg?: string };

async function googleKey(kid: string): Promise<CryptoKey | null> {
  try {
    const res = await fetch(JWKS, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const { keys } = (await res.json()) as { keys?: Jwk[] };
    const jwk = keys?.find((k) => k.kid === kid && k.kty === "RSA");
    if (!jwk) return null;
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

function decodeJson<T>(part: string): T | null {
  const bytes = b64urlDecode(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * Verify signature, issuer, audience, expiry, nonce and that Google vouches for the email.
 * Returns the lowercase email, or null.
 */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<Identity | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = decodeJson<{ alg?: string; kid?: string }>(h);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = await googleKey(header.kid);
  if (!key) return null;
  const sig = b64urlDecode(s);
  if (!sig) return null;
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const claims = decodeJson<{
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    iat?: unknown;
    nonce?: unknown;
    email?: unknown;
    email_verified?: unknown;
  }>(p);
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return null;
  if (claims.aud !== clientId) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.iat !== "number" || claims.iat > now + 300) return null;
  if (claims.nonce !== nonce) return null;
  if (claims.email_verified !== true) return null;
  if (typeof claims.email !== "string") return null;
  const email = claims.email.trim().toLowerCase();
  if (!email.includes("@")) return null;
  return { email };
}
