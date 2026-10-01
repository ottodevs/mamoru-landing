# Mamoru landing

Coming-soon page for [mamoru.lol](https://mamoru.lol). One screen on rice paper: the Mamoru lockup, `APY. DELIVERED.`, a countdown to the opening after ETHGlobal Tokyo, and an email bar. The next site lives behind `/ops/landing` until `OPEN_AT`.

Built with [Astro](https://astro.build). Served by a Cloudflare Worker that also handles `POST /api/notify`.

A push to `main` deploys this page to [mamoru.lol](https://mamoru.lol).

## Channels: prod (main) / staging (staging → /ops/preview)

| Channel | Branch | Worker | Reachable at |
|---|---|---|---|
| prod | `main` | `mamoru-lol` | [mamoru.lol](https://mamoru.lol) |
| staging | `staging` | `mamoru-lol-staging` (env `staging`) | `https://mamoru-lol-staging.ottodevs.workers.dev`, previewed at `/ops/preview` on prod |

The staging Worker is workers.dev-only (no custom domain) and is not meant to be
browsed directly: every response is `X-Robots-Tag: noindex`, and anything other
than a plain static asset (css/js/fonts/images) is refused with 403 unless the
request carries the shared `STAGING_PROXY_SECRET` in the
`X-Mamoru-Staging-Secret` header. Only the prod Worker holds that secret.

To see what's on `staging`, sign in at [mamoru.lol/ops](https://mamoru.lol/ops)
(Google, same allowlist as the rest of `/ops`) and open
[mamoru.lol/ops/preview](https://mamoru.lol/ops/preview). Prod proxies the
request to staging over a Service Binding (`STAGING`, falling back to a plain
fetch against `STAGING_URL`/`STAGING_BASE_URL` if the binding is ever
unavailable), and stamps the response with a fixed "STAGING preview · `<sha>` ·
`<deployed at>`" banner. See `src/staging-preview.ts` for the gate, the proxy,
and why it uses a cross-origin `<base href>` instead of rewriting every asset
path (staged CSS/JS/fonts/images load straight from the staging Worker; only
generic build output is reachable that way, nothing from the page itself).

Staging is not bound to `WAITLIST`/`LOOPS_*`/`GOOGLE_*`: a staged build can
never write a real signup, send a real email, or open its own `/ops`.

Pushing `staging` deploys `--env staging` automatically; see
`ops/github-deploy-staging.sh` and `ops/README.md` for the lady-side watcher.

## Run it

```bash
bun install
bun run dev        # http://localhost:48301
bun run build      # static output in dist/
```

To exercise `/api/notify` locally, build first, then run the Worker:

```bash
bun run build && bunx wrangler dev
```

## Layout

| Path | What it is |
|---|---|
| `src/pages/index.astro` | The screen: lockup, hero, teaser, countdown, email bar |
| `src/pages/open.astro` | Next landing, gated at `/ops/landing` until open |
| `src/pages/app/*.astro` | UI mockup, private at `/ops/app` (Google, same allowlist). The real app is `ottodevs/mamoru` on app.mamoru.lol |
| `src/components/Countdown.astro` | Countdown to `2026-09-27T09:00:00+09:00` |
| `src/components/EmailBar.astro` | Email bar and the on-the-list follow-up |
| `src/styles/global.css` | Rice paper field, ink, Noto Serif |
| `src/worker.ts` | Assets, `POST /api/notify`, and the private panel at `/ops` |
| `src/ops-infra.ts`, `src/infra-snapshot.ts` | `/ops/infra`: relayer status, cost per new account, accounts + TVL on Base (same Google allowlist as `/ops`) |
| `src/worker.ts` | Assets, `POST /api/notify`, and the private list at `/ops` |
| `src/staging-preview.ts` | `/ops/preview` proxy + the staging Worker's own self-gate |

`POST /api/notify` writes the address into KV `WAITLIST` or it does not say it saved. The list is not a marketing tool. `/ops` is the private panel (secret `LIST_GATE`, not in git). The welcome note sends only when the `EMAIL` binding can send from `notify@mamoru.lol`, and only once. `/ops/infra` reads Base over public RPCs (optional secret `BASE_RPC_URL` tried first) and the read-only D1 binding `MAMORU_DB` (owned by `ottodevs/mamoru`). Nothing secret lives in this repo.

## Experiments

A/B experiments are declared in `src/experiments.ts` (id, status, weighted variants, goals, optional `winner`/`endedAt`) and served at the edge in `src/exp-rewrite.ts`: HTMLRewriter swaps `data-exp="<id>"` hooks already baked into the static Astro pages, so the build output never changes per variant, only the response does. `/ops/experiments` is a read-only ledger in the ops console; status and winners only ever change by code + deploy.

**Visitor id and consent.** A visitor who never meets a running experiment gets no identifier at all: no cookie is set, nothing is computed, the response is byte-for-byte what this Worker served before experiments existed. Only when a running, un-pinned experiment applies to the page does a first-party, random, non-identifying id land in a cookie — `__Host-mamoru_vid`, HttpOnly, SameSite=Lax, Secure, 90 days, no fingerprinting, no IP stored, never sent to a third party. `Sec-GPC: 1` and `DNT: 1` are both a full opt-out: no cookie, no event, control variant, same as a request from a simple bot UA. That response is also never shared: `Cache-Control: private, no-store` and `Vary: Cookie` apply whenever content can differ by visitor, so a CDN or browser cache can never hand one visitor's variant to another.

**Events.** Exposure (once per visitor per experiment per day) and goal conversions land in the additive D1 table `exp_events` (`MAMORU_DB`, same binding `/ops/infra` already reads — see `migrations/0004_experiments.sql` in this repo for the file; the canonical copy to apply lives at `migrations/d1/0004_experiments.sql` in `ottodevs/mamoru`, which owns this database's schema). `waitlist_submit` is hooked into a genuinely new `/api/notify` save server-side, so it can't be spoofed. `open_app_click`/`deck_click` go through a same-origin, nonce-checked, rate-limited beacon at `POST /api/exp/event` that validates the reported variant against the visitor's own assignment. Every read and write degrades silently when `exp_events` is missing, exactly like `metrics_daily`. The staging channel has no D1 binding at all (by design, see below), so experiment writes there are always a no-op — there is no path by which staging can touch prod's `mamoru` database.

A one-paragraph, publish-ready privacy note for a future `/privacy` page: *"We run small experiments on this site to see which wording works better. If you take part, we store a random id in a cookie on your device — never your IP, never anything that identifies you, never shared with anyone else. If your browser sends Global Privacy Control or Do Not Track, we skip this entirely: no cookie, no record, you simply see the default version."*
