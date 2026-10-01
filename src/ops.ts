import { b64url, b64urlDecode } from "./google";
import type { Entry } from "./list";
import { motionHeadScript, opsClientScript } from "./ops-client";
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

export const FLASH_COPY: Record<Exclude<Flash, "">, string> = {
  sent: "Notes sent.",
  waiting: "Still waiting. Loops is not wired yet.",
  failed: "Some notes did not go out. The address stays on the list.",
  removed: "Removed from the list.",
  bad: "That did not go through. Try again.",
};

export type SectionId = "overview" | "mails" | "infra" | "gate";

export type OpsSection = { id: string; label: string; href: string; /** Leaves the console: a full navigation in a new tab. */ out?: boolean };

/** Extensible on purpose: new /ops sections are one more entry, not a rewrite. */
export const OPS_SECTIONS: readonly OpsSection[] = [
  { id: "overview", label: "Overview", href: "/ops" },
  { id: "mails", label: "Mails", href: "/ops/mails" },
  { id: "infra", label: "Infra", href: "/ops/infra" },
  // The staged site is its own document with its own base URL and CSP, so it opens beside the console.
  { id: "preview", label: "Preview", href: "/ops/preview", out: true },
];

/** What a section hands to the frame: the same object becomes a full document or a JSON fragment. */
export interface SectionView {
  section: SectionId;
  /** Short page name. The document title is "<title> · Mamoru ops". */
  title: string;
  /** The section body: everything inside <main>. No scripts. */
  html: string;
  /** HTTP status of the full document. Defaults to 200. */
  status?: number;
  /** The server is recomputing this section in the background; the client looks again shortly. */
  refreshing?: boolean;
}

export const TITLE_SUFFIX = " · Mamoru ops";

/** All console CSS, in one place. Sections add markup, never their own stylesheet. */
export const OPS_STYLE = `
/* ---- tokens and base ---- */
@font-face { font-family: "Noto Serif"; src: url("/fonts/NotoSerif-400.ttf") format("truetype"); font-weight: 400; font-style: normal; }
:root {
  --rice: #f8f5ef; --paper: #f4f0e6; --ink: #0f0f0e; --wash: #d9d2c3;
  --emerald: #2f5d50; --stone: #8a8578; --muted: #5d594f;
  --warn: #7a5a12; --bad: #a33b2e;
  --rule: rgba(15, 15, 14, 0.14); --rule-soft: rgba(15, 15, 14, 0.07);
  --out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --gutter: clamp(1.15rem, 4vw, 3rem);
}
* { box-sizing: border-box; }
html { background: var(--rice); }
body { margin: 0; background: var(--rice) url("/rice-washi-tile.webp") repeat; background-size: 256px 256px; color: var(--ink); font-family: "Noto Serif", Georgia, "Times New Roman", serif; -webkit-font-smoothing: antialiased; }
h1 { font-weight: 400; font-size: 1.6rem; line-height: 1.2; margin: 0; }
h1:focus { outline: none; }
h2 { font-weight: 400; font-size: 1.15rem; margin: 0; }
p { line-height: 1.45; margin: 0 0 0.8rem; }
a { color: var(--emerald); text-underline-offset: 0.16em; }
a:hover { color: var(--ink); }
.soft { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
button, input { font: inherit; color: inherit; }
button { background: var(--ink); color: var(--paper); border: 0; border-radius: 0; padding: 0.55rem 1rem; cursor: pointer; }
button:hover { background: var(--emerald); }
button:disabled { background: rgba(15, 15, 14, 0.2); color: var(--rice); cursor: default; }
button.link { background: none; color: var(--emerald); padding: 0; text-decoration: underline; text-underline-offset: 0.16em; }
button.link:hover { background: none; color: var(--ink); }
button.link:disabled { background: none; color: var(--muted); text-decoration: none; }
a:focus-visible, button:focus-visible, summary:focus-visible, label:focus-visible { outline: 2px solid var(--emerald); outline-offset: 3px; }
form { margin: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; font-weight: 400; padding: 0.55rem 0.4rem 0.55rem 0; vertical-align: baseline; border-bottom: 1px solid var(--rule); }
th { color: var(--muted); font-size: 0.85rem; }
.status-ok { color: var(--emerald); }
.status-low { color: var(--warn); }
.status-empty { color: var(--bad); }

/* ---- the console frame: one header for every section ---- */
.ops-top { position: sticky; top: 0; z-index: 5; background: var(--rice) url("/rice-washi-tile.webp") repeat; background-size: 256px 256px; border-bottom: 1px solid var(--rule); }
.ops-bar { max-width: 70rem; margin-inline: auto; padding: 0.7rem var(--gutter); display: flex; align-items: center; gap: 0.5rem clamp(1.2rem, 3vw, 2.4rem); }
.ops-brand { display: inline-flex; align-items: center; gap: 0.55rem; color: var(--ink); text-decoration: none; font-size: 1.05rem; line-height: 1; }
.ops-brand img { width: 1.75rem; height: auto; display: block; }
.ops-nav { display: flex; align-items: center; gap: clamp(0.9rem, 2.2vw, 1.5rem); min-width: 0; }
.ops-nav a { color: var(--ink); text-decoration: none; line-height: 1; padding: 0.45rem 0; border-bottom: 1px solid transparent; white-space: nowrap; }
.ops-nav a:hover { color: var(--emerald); }
.ops-nav a[aria-current="page"] { border-bottom-color: var(--ink); }
.ops-nav a.out { color: var(--muted); }
.ops-who { margin-left: auto; display: flex; align-items: baseline; gap: 0.8rem; font-size: 0.9rem; color: var(--muted); min-width: 0; }
.ops-who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops-page { max-width: 70rem; margin-inline: auto; padding: 2rem var(--gutter) 4rem; outline: none; view-transition-name: ops-main; }
#ops-progress { position: fixed; left: 0; right: 0; top: 0; z-index: 9; height: 2px; background: var(--ink); transform: scaleX(0); transform-origin: left; opacity: 0; pointer-events: none; }
#ops-progress.on { opacity: 1; transform: scaleX(0.82); transition: transform 2.4s cubic-bezier(0.1, 0.7, 0.2, 1); }
#ops-progress.on.done { transform: scaleX(1); opacity: 0; transition: transform 160ms ease-out, opacity 200ms ease-out 80ms; }
::view-transition-old(ops-main) { animation: ops-out 110ms ease-in both; }
::view-transition-new(ops-main) { animation: ops-in 190ms var(--out) both; }
@keyframes ops-out { to { opacity: 0; } }
@keyframes ops-in { from { opacity: 0; transform: translateY(4px); } }
.pg-head .asof form { display: inline; margin-left: 0.6rem; }
.tick-note { margin-left: 0.7rem; color: var(--emerald); animation: tick-fade 4s ease-out both; }
@keyframes tick-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }

/* ---- notices: flash messages, stale readings, form results ---- */
.notice { margin: -0.4rem 0 0; padding: 0.85rem 0 1.3rem; border-top: 1px solid var(--ink); display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem 1.5rem; }
.notice p { margin: 0; max-width: 46rem; line-height: 1.45; }
.notice.bad p { color: var(--bad); }
.empty { margin: 1.4rem 0 0; font-size: 1.15rem; line-height: 1.45; max-width: 34rem; }
.gate { max-width: 34rem; padding-top: 3rem; }
.gate h1 { margin-bottom: 1rem; }
.gate p { font-size: 1.05rem; }

/* ---- figures, sections, charts ---- */

.pg-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.4rem 1.5rem; margin: 0.8rem 0 1.5rem; }
.pg-head h1 { margin: 0; }
.asof { margin: 0; font-size: 0.9rem; color: var(--muted); }
.notes { margin: -0.6rem 0 1.4rem; font-size: 0.95rem; }
.notes p { margin: 0 0 0.25rem; }

/* Headline figures: one ruled line of numerals, no boxes. */
.figs { margin: 0; border-top: 1px solid var(--rule); padding: 1.15rem 0 0.4rem; display: grid; grid-template-columns: minmax(0, var(--lead, 2.2fr)) repeat(var(--n, 5), minmax(0, 1fr)); column-gap: clamp(1rem, 2.4vw, 2.2rem); align-items: baseline; }
.fig { display: contents; }
.fig > dt { grid-row: 1; grid-column: var(--c); font-size: 0.9rem; color: var(--muted); }
.fig > dd { margin: 0; grid-column: var(--c); }
.fig-n { grid-row: 2; font-size: 2.15rem; line-height: 1.15; letter-spacing: -0.01em; white-space: nowrap; }
.fig.lead .fig-n { font-size: clamp(3rem, 5.4vw, 4.3rem); line-height: 1; letter-spacing: -0.02em; }
.fig-n [data-n] { display: inline-block; }
.fig-n .of { font-size: 0.5em; color: var(--muted); letter-spacing: 0; margin-left: 0.3em; }
.fig-s { grid-row: 3; align-self: start; font-size: 0.85rem; line-height: 1.4; color: var(--muted); padding-top: 0.35rem; }
.fig-s span { display: block; text-wrap: balance; }

.cols { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); column-gap: clamp(2rem, 5vw, 4.5rem); margin-top: 2.1rem; }
.sec { border-top: 1px solid var(--rule); padding: 1.05rem 0 2.5rem; min-width: 0; }
.sec.full { grid-column: 1 / -1; }
.sec-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.3rem 1.4rem; }
.sec h2 { margin: 0; font-size: 1.15rem; }
.legend { display: flex; flex-wrap: wrap; gap: 0.2rem 1.2rem; margin: 0; padding: 0; list-style: none; font-size: 0.85rem; color: var(--muted); }
.legend b { font-weight: 400; color: var(--ink); margin-left: 0.3rem; }
.key { display: inline-block; width: 1.1rem; height: 0; border-top: 2px solid var(--ink); vertical-align: 0.28em; margin-right: 0.45rem; }
.key.k-emerald { border-color: var(--emerald); }
.key.dashed { border-top-style: dashed; }
.key.sw { width: 0.62rem; height: 0.62rem; border: 0; vertical-align: -0.02em; }
.key.sw-stone { background: rgba(138, 133, 120, 0.5); }
.key.sw-emerald { background: rgba(47, 93, 80, 0.45); }

.chart { margin-top: 1.25rem; }
.plot { position: relative; height: 13rem; margin: 0 0 1.9rem 2.9rem; }
.plot:focus-visible { outline: 2px solid var(--emerald); outline-offset: 6px; }
.layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.layer * { vector-effect: non-scaling-stroke; fill: none; }
.layer .rule { stroke: var(--rule-soft); stroke-width: 1; }
.layer .axis { stroke: rgba(15, 15, 14, 0.4); stroke-width: 1; }
.layer .area.a-stone { fill: rgba(138, 133, 120, 0.26); }
.layer .area.a-emerald { fill: rgba(47, 93, 80, 0.24); }
.layer .edge { stroke: rgba(15, 15, 14, 0.22); stroke-width: 1; }
.layer .line { stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.layer .l-ink { stroke: var(--ink); }
.layer .l-emerald { stroke: var(--emerald); }
.layer .l-stone { stroke: var(--stone); }
.layer .line.dashed { stroke-dasharray: 6 5; stroke-linecap: butt; }
.yt, .xt { position: absolute; font-size: 0.78rem; line-height: 1; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.yt { right: calc(100% + 0.6rem); transform: translateY(-50%); }
.xt { top: calc(100% + 0.55rem); transform: translateX(-50%); }
.xt.first { transform: none; }
.xt.last { transform: translateX(-100%); }
.dot { position: absolute; width: 7px; height: 7px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; background: var(--ink); border: 2px solid var(--rice); }
.dot.d-emerald { background: var(--emerald); }
.dot.d-stone { background: var(--stone); }
.stem { position: absolute; right: -1.5px; width: 3px; }
.stem.s-stone { background: var(--stone); }
.stem.s-emerald { background: var(--emerald); }
.stem.s-ink { background: var(--ink); }
.plot-note { position: absolute; left: 0; bottom: 0.7rem; margin: 0; max-width: 78%; font-size: 0.95rem; line-height: 1.4; color: var(--muted); }

.bar-row { position: absolute; inset: 0; display: flex; align-items: flex-end; }
.slot { flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
.bar { display: block; width: min(34%, 7px); background: var(--ink); }
.bar.today { background: var(--emerald); }
.bar.zero { height: 2px !important; background: var(--stone); }
.bar.rest { width: 1px; height: 7px; background: rgba(15, 15, 14, 0.38); }
.plot.idle .rule { display: none; }
.slot.on .bar { outline: 1px solid var(--ink); outline-offset: 2px; }

.cross { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid rgba(15, 15, 14, 0.45); opacity: 0; pointer-events: none; }
.tip { position: absolute; left: 0; top: 0; z-index: 2; pointer-events: none; opacity: 0; background: var(--ink); color: var(--paper); padding: 0.4rem 0.6rem 0.45rem; font-size: 0.8rem; line-height: 1.4; white-space: nowrap; transition: opacity 120ms ease; }
.cross.on, .tip.on { opacity: 1; }
.tip .tt { color: rgba(244, 240, 230, 0.72); }
.tip .tr { display: flex; justify-content: space-between; gap: 1.1rem; }
.tip .tr span:last-child { font-variant-numeric: tabular-nums; }
.tip .tr + .tr span:first-child { color: rgba(244, 240, 230, 0.72); }

.cap { margin: 0 0 0.3rem; font-size: 0.85rem; }
details.tbl { margin-top: 0.2rem; font-size: 0.85rem; }
details.tbl summary { cursor: pointer; color: var(--muted); width: fit-content; }
details.tbl table { margin-top: 0.4rem; max-width: 26rem; font-variant-numeric: tabular-nums; }
details.tbl th, details.tbl td { padding: 0.3rem 0.8rem 0.3rem 0; border-color: var(--rule); }
details.tbl th { color: var(--muted); font-size: inherit; }

.funnel { list-style: none; margin: 1.25rem 0 0; padding: 0; }
.step { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; align-items: baseline; padding-bottom: 1.2rem; }
.step-name { font-size: 1rem; }
.step-rate { margin-left: 0.55rem; font-size: 0.85rem; color: var(--muted); white-space: nowrap; }
.step-n { font-size: 1.5rem; line-height: 1; }
.step-track { grid-column: 1 / -1; display: block; height: 5px; margin-top: 0.5rem; border-bottom: 1px solid var(--rule); }
.step-bar { display: block; height: 100%; background: var(--ink); }

.runway { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: clamp(1.5rem, 4vw, 3.5rem); align-items: center; margin-top: 1rem; }
.run-n { margin: 0; display: flex; align-items: baseline; gap: 0.7rem; }
.run-n .fig-n { font-size: 2.15rem; }
.run-s { margin: 0; text-align: right; font-size: 0.95rem; line-height: 1.5; }
.tally { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.55rem 6px; min-height: 1.1rem; }
.tick { display: block; width: 1.5px; height: 1.1rem; background: var(--ink); }
.tick.fifth { margin-right: 11px; }
.tally-more { font-size: 0.85rem; color: var(--muted); align-self: center; }


@media (max-width: 1040px) {
  .figs { grid-template-columns: repeat(var(--n, 5), minmax(0, 1fr)); row-gap: 0; }
  .fig.lead > * { grid-column: 1 / -1; }
  .fig:not(.lead) > dt { grid-row: 4; grid-column: var(--m); padding-top: 1.3rem; }
  .fig:not(.lead) > .fig-n { grid-row: 5; grid-column: var(--m); }
  .fig:not(.lead) > .fig-s { grid-row: 6; grid-column: var(--m); }
}
@media (max-width: 860px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .runway { grid-template-columns: minmax(0, 1fr); row-gap: 1rem; }
  .run-s { text-align: left; }
}
@media (max-width: 640px) {
  .figs { display: block; padding-bottom: 0; }
  .fig { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; align-items: baseline; padding: 0.75rem 0 0.8rem; border-top: 1px solid var(--rule); }
  .fig.lead { display: block; border-top: 0; padding: 0 0 1.2rem; }
  .fig:not(.lead) > dt { grid-row: 1; grid-column: 1; padding-top: 0; font-size: 1rem; color: var(--ink); }
  .fig:not(.lead) > .fig-n { grid-row: 1 / span 2; grid-column: 2; font-size: 1.7rem; text-align: right; }
  .fig:not(.lead) > .fig-s { grid-row: 2; grid-column: 1; padding-top: 0.1rem; }
  .cols { margin-top: 0; }
  .plot { height: 11rem; margin-left: 2.5rem; }
}

/* Motion: only under .js-motion, which the head script sets when motion is welcome. */
@keyframes mm-draw { to { stroke-dashoffset: 0; } }
@keyframes mm-reveal { from { clip-path: inset(-12px 100% -12px -12px); } to { clip-path: inset(-12px -12px -12px -12px); } }
@keyframes mm-pour-up { from { clip-path: inset(100% -4px -1px -4px); } to { clip-path: inset(-4px -4px -1px -4px); } }
@keyframes mm-pour-right { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes mm-settle { from { opacity: 0; transform: scale(0.3); } }
.js-motion .sec:not(.in) :is(.layer.wash, .layer.ink, .layer.over, .dot, .stem, .bar, .step-bar, .tick) { opacity: 0; }
.js-motion .sec.in :is(.layer.wash, .layer.over) { animation: mm-reveal 1200ms var(--out) calc(var(--s, 0ms) + 160ms) both; }
.js-motion .sec.in .layer.ink .line:not(.done) { stroke-dasharray: var(--len, 4000); stroke-dashoffset: var(--len, 4000); animation: mm-draw 1200ms var(--out) calc(var(--s, 0ms) + 160ms) forwards; }
.js-motion .sec.in .dot { animation: mm-settle 360ms var(--out) calc(var(--s, 0ms) + 1150ms) both; }
.js-motion .sec.in .stem { animation: mm-pour-up 700ms var(--out) calc(var(--s, 0ms) + 200ms) both; }
.js-motion .sec.in .bar { animation: mm-pour-up 480ms var(--out) calc(var(--s, 0ms) + 160ms + var(--i, 0) * 38ms) both; }
.js-motion .sec.in .tick { animation: mm-pour-up 300ms var(--out) calc(var(--s, 0ms) + 200ms + var(--i, 0) * 24ms) both; }
.js-motion .sec.in .step-bar { animation: mm-pour-right var(--ms, 400ms) linear calc(var(--s, 0ms) + var(--d, 0ms)) both; }
.js-motion .sec.in .step-bar.pour-first { animation-timing-function: cubic-bezier(0.5, 0, 0.75, 0.75); }
.js-motion .sec.in .step-bar.pour-last { animation-timing-function: cubic-bezier(0.25, 0.25, 0.3, 1); }
@media (prefers-reduced-motion: reduce) {
  .ops-page *, .ops-page *::before, .ops-page *::after { animation: none !important; transition: none !important; }
}

/* ---- infra ---- */
.fig-n .unit { font-size: 0.42em; color: var(--muted); letter-spacing: 0; margin-left: 0.35em; }
.fig:not(.lead) .fig-n .unit { font-size: 0.5em; }
.fig-s b { font-weight: 400; }
.fig-n.none { color: var(--muted); }
.sec h3 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 400; }

table.ledger { margin-top: 0.9rem; font-variant-numeric: tabular-nums; }
table.ledger th, table.ledger td { border-color: var(--rule); padding: 0.55rem 0 0.55rem 1rem; text-align: right; white-space: nowrap; }
table.ledger th:first-child, table.ledger td:first-child { padding-left: 0; text-align: left; white-space: normal; }
table.ledger thead th { color: var(--muted); font-size: 0.85rem; }
table.ledger tr.total td { border-top: 1px solid var(--ink); border-bottom: 0; padding-top: 0.7rem; }
table.ledger .dim { color: var(--muted); }
.ledger-note { margin: 0.9rem 0 0; font-size: 0.9rem; line-height: 1.5; color: var(--muted); max-width: 30rem; }
.sum { margin: 0.9rem 0 0; line-height: 1.5; }
.quiet-line { margin: 0 0 2rem; font-size: 0.9rem; color: var(--muted); }

.tu-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.4rem 1.5rem; margin-top: 1rem; min-height: 1.5rem; }
.tu-steps { list-style: none; display: flex; gap: 1.4rem; margin: 0; padding: 0; font-size: 0.85rem; color: var(--muted); }
.tu-steps li[aria-current] { color: var(--ink); border-bottom: 1px solid var(--ink); }
.tu-line { margin: 0.9rem 0 0; font-size: 1.3rem; line-height: 1.35; max-width: 34rem; text-wrap: pretty; min-height: 2.7em; }
.tu-line.warn { color: var(--warn); }
.tu-line.bad { color: var(--bad); }
.tu-line.good { color: var(--emerald); }
.tu-detail { margin: 0.4rem 0 0; font-size: 0.95rem; line-height: 1.45; max-width: 34rem; min-height: 2.9em; overflow-wrap: anywhere; }
.tu-wallet { margin: 0; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.tu-wallet button.link { margin-left: 0.6rem; }
.tu-amount { margin-top: 1.3rem; }
.tu-amount label { display: block; font-size: 0.9rem; color: var(--muted); }
.tu-field { display: flex; align-items: baseline; gap: 0.6rem; max-width: 17rem; border-bottom: 1px solid var(--ink); }
.tu-field input { flex: 1; min-width: 0; width: 100%; border: 0; background: none; padding: 0.15rem 0 0.25rem; font-size: 2.15rem; line-height: 1.15; letter-spacing: -0.01em; outline: none; }
.tu-field input::placeholder { color: rgba(15, 15, 14, 0.28); }
.tu-field input:read-only { color: var(--muted); }
.tu-field:focus-within { border-bottom-color: var(--emerald); box-shadow: 0 1px 0 var(--emerald); }
.tu-unit { color: var(--muted); }
.tu-presets { display: flex; flex-wrap: wrap; gap: 0.3rem 1.3rem; margin-top: 0.75rem; }
button.tu-preset { background: none; color: var(--emerald); padding: 0.35rem 0; border-bottom: 1px solid transparent; font-variant-numeric: tabular-nums; }
button.tu-preset:hover { color: var(--ink); }
button.tu-preset[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--ink); }
button.tu-preset:disabled { color: rgba(15, 15, 14, 0.35); cursor: default; }
.tu-hint { margin: 0.6rem 0 0; font-size: 0.95rem; min-height: 1.45em; }
.tu-actions { margin: 1.2rem 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem 1.4rem; min-height: 2.6rem; }
.tu-actions button.go { padding: 0.75rem 1.2rem; }
.tu-actions button.go:hover { background: var(--emerald); }
.tu-actions button.go:disabled { background: rgba(15, 15, 14, 0.2); color: var(--rice); cursor: default; }
.tu-actions button.link { margin-left: 0; padding: 0.4rem 0; }
.tu-actions a { font-size: 0.95rem; }
.tu-manual { margin-top: 2rem; padding-top: 1.1rem; border-top: 1px solid var(--rule); }
.tu-addr { margin: 0 0 0.5rem; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1rem; }
.tu-addr code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88rem; overflow-wrap: anywhere; }
.tu-addr button.link { margin-left: 0; }
.tu-manual p.soft { margin: 0; font-size: 0.9rem; line-height: 1.5; max-width: 34rem; }

table.accts { margin-top: 1.1rem; font-variant-numeric: tabular-nums; }
table.accts th, table.accts td { border-color: var(--rule); padding: 0.5rem 0 0.5rem 1.2rem; text-align: right; white-space: nowrap; }
table.accts .a-key { padding-left: 0; text-align: left; }
table.accts .a-addr { text-align: left; }
table.accts thead th { color: var(--muted); font-size: 0.85rem; }
table.accts td.unread { color: var(--warn); }

@media (max-width: 640px) {
  table.accts .wide-only { display: none; }
  table.accts th, table.accts td { padding-left: 0.7rem; }
  table.accts .a-addr { padding-left: 0; }
  .tu-line { font-size: 1.15rem; }
  .tu-actions button.go { width: 100%; }
}

/* ---- mails ---- */
.lede { margin: 1.6rem 0 0; max-width: 40rem; line-height: 1.5; }
.lede + .lede { margin-top: 0.5rem; }
.mail-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1.6rem; margin-top: 1.4rem; min-height: 2.4rem; }
.reveal-box { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
label.reveal { color: var(--emerald); cursor: pointer; text-decoration: underline; text-underline-offset: 0.16em; }
label.reveal:hover { color: var(--ink); }
.reveal-box:focus-visible ~ .mail-tools label.reveal { outline: 2px solid var(--emerald); outline-offset: 3px; }
.reveal .when-shown { display: none; }
.reveal-box:checked ~ .mail-tools .reveal .when-hidden { display: none; }
.reveal-box:checked ~ .mail-tools .reveal .when-shown { display: inline; }
table.mails { margin-top: 0.6rem; font-variant-numeric: tabular-nums; }
table.mails td, table.mails th { padding-right: 1.2rem; }
table.mails .act { text-align: right; padding-right: 0; white-space: nowrap; }
td.mail { overflow-wrap: anywhere; }
td.mail .full { display: none; }
td.mail:hover .mask, td.mail:focus-within .mask, .reveal-box:checked ~ table td.mail .mask { display: none; }
td.mail:hover .full, td.mail:focus-within .full, .reveal-box:checked ~ table td.mail .full { display: inline; }
.note-failed { color: var(--bad); }
.note-pending { color: var(--warn); }

/* ---- narrow frame ---- */
.ops-page.still .sec :is(.layer, .dot, .stem, .bar, .step-bar, .tick, .line) { animation: none !important; }
@media (max-width: 640px) {
  .ops-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "brand who" "nav nav"; row-gap: 0.35rem; padding-top: 0.6rem; padding-bottom: 0.35rem; }
  .ops-brand { grid-area: brand; }
  .ops-who { grid-area: who; margin-left: 0; }
  .ops-who span { display: none; }
  .ops-nav { grid-area: nav; gap: 1.3rem; overflow-x: auto; }
  .ops-page { padding-top: 1.4rem; }
  table.mails .wide-only { display: none; }
}
`;

export function renderNav(active: string): string {
  const links = OPS_SECTIONS.map((section) => {
    if (section.out) {
      return `<a class="out" href="${esc(section.href)}" target="_blank" rel="noopener" data-ops-full title="Opens the staged site in a new tab">${esc(section.label)}</a>`;
    }
    const current = section.id === active ? ' aria-current="page"' : "";
    return `<a href="${esc(section.href)}" data-section="${esc(section.id)}"${current}>${esc(section.label)}</a>`;
  }).join("");
  return `<nav class="ops-nav" aria-label="Sections">${links}</nav>`;
}

/** UTC, to the minute: "2026-10-01 14:05 UTC". */
export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${esc(csrf)}" />`;
}

/** The shared notice line: flash messages, stale readings, form results. `action` is optional trailing markup. */
export function noticeHtml(text: string, opts: { tone?: "plain" | "bad"; action?: string } = {}): string {
  return `<div class="notice${opts.tone === "bad" ? " bad" : ""}" role="status"><p>${esc(text)}</p>${opts.action ?? ""}</div>`;
}

/** Page heading with the "as of + refresh" pattern every data section shares. */
export function pageHead(opts: { title: string; asOf?: string; refresh?: { action: string; csrf: string; label?: string } }): string {
  const refresh = opts.refresh
    ? `<form method="post" action="${esc(opts.refresh.action)}" data-ops-form>${csrfField(opts.refresh.csrf)}<button class="link" type="submit">${esc(opts.refresh.label ?? "Refresh")}</button></form>`
    : "";
  const asOf = opts.asOf ? `As of <time datetime="${esc(opts.asOf)}">${esc(when(opts.asOf))}</time>` : "";
  const aside = asOf || refresh ? `<div class="asof">${asOf}${refresh}</div>` : "";
  return `<header class="pg-head"><h1>${esc(opts.title)}</h1>${aside}</header>`;
}

/** One figure of a headline band. `value` and `lines` are trusted markup built by the caller. */
export function figure(opts: { col: number; lead?: boolean; label: string; value: string; lines?: string[] }): string {
  const lines = (opts.lines ?? []).filter(Boolean).map((line) => `<span>${line}</span>`).join("");
  return `<div class="fig${opts.lead ? " lead" : ""}" style="--c:${opts.col};--m:${opts.col - 1}"><dt>${esc(opts.label)}</dt><dd class="fig-n">${opts.value}</dd><dd class="fig-s">${lines}</dd></div>`;
}

/** A number that counts up once on first view. The final text is in the markup. */
export function countUp(value: number, format: string, text: string): string {
  return `<span data-n="${value}" data-f="${esc(format)}">${esc(text)}</span>`;
}

/**
 * The full document around a section. One header, one script, one stylesheet for
 * every page of the console. `chrome: false` is the bare frame for the gate page:
 * no nav, no session, nothing that names a section.
 */
export function renderDocument(
  view: SectionView,
  opts: { csrf?: string; who?: string; nonce: string; chrome?: boolean },
): string {
  const chrome = opts.chrome !== false && Boolean(opts.csrf);
  const who = chrome
    ? `<form class="ops-who" method="post" action="/ops/logout">${csrfField(opts.csrf ?? "")}${opts.who ? `<span>${esc(opts.who)}</span>` : ""}<button class="link" type="submit">Sign out</button></form>`
    : "";
  const brand = chrome
    ? `<a class="ops-brand" href="/ops" data-section-home aria-label="Mamoru ops, overview"><img src="/mark-two-stones.png" width="28" height="28" alt="" /><span>Mamoru</span></a>`
    : `<span class="ops-brand"><img src="/mark-two-stones.png" width="28" height="28" alt="" /><span>Mamoru</span></span>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#F8F5EF" />
  <link rel="icon" href="/mark-two-stones.png" type="image/png" />
  <title>${esc(view.title)}${TITLE_SUFFIX}</title>
  <style>${OPS_STYLE}</style>
  ${motionHeadScript(opts.nonce)}
</head>
<body>
  <div id="ops-progress" aria-hidden="true"></div>
  <header class="ops-top"><div class="ops-bar">${brand}${chrome ? renderNav(view.section) : ""}${who}</div></header>
  <main id="ops-main" class="ops-page" data-section="${esc(view.section)}"${view.refreshing ? " data-refreshing" : ""}>
${view.html}
  </main>
  <div id="ops-live" class="sr-only" aria-live="polite"></div>
  ${chrome ? opsClientScript(opts.nonce) : ""}
</body>
</html>`;
}

/** The JSON a fragment request gets: the section body, never the frame. */
export function fragmentBody(view: SectionView): string {
  return JSON.stringify({
    v: 1,
    section: view.section,
    title: view.title,
    html: view.html,
    ...(view.refreshing ? { refreshing: true } : {}),
  });
}

/** A designed page for states with no console behind them: access denied, nothing configured. */
export function gateView(opts: { title: string; lines: string[]; status?: number; link?: { href: string; label: string } }): SectionView {
  const link = opts.link ? `<p><a href="${esc(opts.link.href)}">${esc(opts.link.label)}</a></p>` : "";
  return {
    section: "gate",
    title: opts.title,
    status: opts.status ?? 403,
    html: `<div class="gate"><h1>${esc(opts.title)}</h1>${opts.lines.map((line) => `<p>${esc(line)}</p>`).join("")}${link}</div>`,
  };
}

const NOTE_LABEL: Record<Entry["note"], string> = {
  sent: "Sent",
  pending: "Waiting",
  failed: "Failed",
};

/** First two letters of the name, then the rest hidden. Short names keep one letter. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const keep = (value: string) => value.slice(0, value.length <= 2 ? 1 : 2);
  return `${keep(local)}•••@${keep(host)}•••${tld}`;
}

export interface MailsInput {
  entries: Entry[];
  truncated: boolean;
  csrf: string;
  flash: Flash;
  mailReady: boolean;
  /** False when the WAITLIST binding is missing: the section says so instead of listing. */
  connected?: boolean;
}

/** The list, as a ledger: counts on one ruled line, then one row per address. */
export function mailsSection(opts: MailsInput): SectionView {
  const head = pageHead({ title: "Mails" });
  const notice = opts.flash ? noticeHtml(FLASH_COPY[opts.flash], { tone: opts.flash === "bad" || opts.flash === "failed" ? "bad" : "plain" }) : "";
  if (opts.connected === false) {
    return {
      section: "mails",
      title: "Mails",
      status: 503,
      html: `${head}${notice}<p class="empty">The list is not connected to this deployment, so there is nothing to show or send.</p>`,
    };
  }
  const sent = opts.entries.filter((e) => e.note === "sent").length;
  const failed = opts.entries.filter((e) => e.note === "failed").length;
  const waiting = opts.entries.length - sent;
  const figures = `<dl class="figs" style="--n:2;--lead:1fr" aria-label="The list in numbers">
    ${figure({ col: 1, lead: true, label: "On the list", value: countUp(opts.entries.length, "int", String(opts.entries.length)), lines: [opts.truncated ? `These are the first ${opts.entries.length}; there are more` : ""] })}
    ${figure({ col: 2, label: "Notes sent", value: countUp(sent, "int", String(sent)) })}
    ${figure({ col: 3, label: "Without a note", value: countUp(waiting, "int", String(waiting)), lines: [failed ? `${failed} failed` : ""] })}
  </dl>`;
  const mail = opts.mailReady
    ? "The welcome note goes out once, through Loops. If a row says Failed, Loops rejected the send; the address is still saved."
    : "The list is saved. The note cannot go out yet: sending from the domain is not connected.";
  const rows = opts.entries
    .map(
      (entry) => `<tr>
        <td class="mail"><span class="mask">${esc(maskEmail(entry.email))}</span><span class="full">${esc(entry.email)}</span></td>
        <td class="wide-only">${esc(when(entry.at))}</td>
        <td class="note-${entry.note}">${NOTE_LABEL[entry.note]}</td>
        <td class="act">
          <form method="post" action="/ops/remove" data-ops-form>
            ${csrfField(opts.csrf)}
            <input type="hidden" name="email" value="${esc(entry.email)}" />
            <button class="link" type="submit" aria-label="Remove ${esc(maskEmail(entry.email))}">Remove</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");
  const send =
    waiting > 0 && opts.mailReady
      ? `<form method="post" action="/ops/send" data-ops-form>${csrfField(opts.csrf)}<button type="submit">Send the missing ${waiting === 1 ? "note" : "notes"}</button></form>`
      : "";
  const list = opts.entries.length
    ? `<input class="reveal-box" id="reveal-mails" type="checkbox" />
      <div class="mail-tools">${send}<label class="reveal" for="reveal-mails"><span class="when-hidden">Reveal addresses</span><span class="when-shown">Hide addresses</span></label></div>
      <table class="mails">
        <thead><tr><th>Address</th><th class="wide-only">Added</th><th>Note</th><th class="act"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p class="empty">Nobody yet. Addresses left on the landing page appear here.</p>`;
  return {
    section: "mails",
    title: "Mails",
    html: `${head}
    ${notice}
    ${figures}
    <p class="lede">These emails stay here. We hold them the way we hold funds: they do not leave this house, and we send nothing else.</p>
    <p class="lede soft">${esc(mail)}</p>
    ${list}`,
  };
}

/** Full document for the list. Kept for callers and tests that want the whole page. */
export function renderList(opts: MailsInput & { who?: string; nonce?: string }): string {
  return renderDocument(mailsSection(opts), { csrf: opts.csrf, who: opts.who, nonce: opts.nonce ?? "" });
}

export function opsHeaders(extra?: HeadersInit, opts?: { scriptNonce?: string }): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  // connect-src 'self' is what lets the console fetch its own fragments; nothing else may be reached.
  const scriptSrc = opts?.scriptNonce ? ` script-src 'nonce-${opts.scriptNonce}'; connect-src 'self';` : "";
  headers.set(
    "content-security-policy",
    `default-src 'none'; img-src 'self'; style-src 'unsafe-inline';${scriptSrc} font-src 'self'; form-action 'self'; base-uri 'none'`,
  );
  return headers;
}
