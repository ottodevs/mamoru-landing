# Mamoru landing

Public landing for [mamoru.lol](https://mamoru.lol). Rice paper, `APY DELIVERED`, How it works, allocation, FAQs. The countdown teaser retired 2026-09-26.

Built with [Astro](https://astro.build). Served by a Cloudflare Worker that also handles `POST /api/notify`.

A push to `main` deploys this page to [mamoru.lol](https://mamoru.lol).

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
| `src/pages/index.astro` | Retired teaser (lockup, countdown, email bar) |
| `src/pages/open.astro` | Public landing at `/` after open |
| `src/components/Countdown.astro` | Countdown used on the teaser |
| `src/components/EmailBar.astro` | Email bar and the on-the-list follow-up |
| `src/styles/global.css` | Rice paper field, ink, Noto Serif |
| `src/worker.ts` | Assets, `POST /api/notify`, and the private list at `/ops` |

`POST /api/notify` writes the address into KV `WAITLIST` or it does not say it saved. The list is not a marketing tool. `/ops` is the private panel (secret `LIST_GATE`, not in git). The welcome note sends only when the `EMAIL` binding can send from `notify@mamoru.lol`, and only once. Nothing secret lives in this repo.
