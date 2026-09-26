# Mamoru landing

Coming-soon page for [mamoru.lol](https://mamoru.lol). One screen on rice paper: the Mamoru lockup, `APY. DELIVERED.`, a countdown to the opening after ETHGlobal Tokyo, and an email bar. The next site lives behind `/ops/landing` until `OPEN_AT`.

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
| `src/pages/index.astro` | The screen: lockup, hero, teaser, countdown, email bar |
| `src/pages/open.astro` | Next landing, gated at `/ops/landing` until open |
| `src/pages/app/*.astro` | UI mockup, private at `/ops/app` (Google, same allowlist). The real app is `ottodevs/mamoru` on app.mamoru.lol |
| `src/components/Countdown.astro` | Countdown to `2026-09-27T09:00:00+09:00` |
| `src/components/EmailBar.astro` | Email bar and the on-the-list follow-up |
| `src/styles/global.css` | Rice paper field, ink, Noto Serif |
| `src/worker.ts` | Assets, `POST /api/notify`, and the private list at `/ops` |

`POST /api/notify` writes the address into KV `WAITLIST` or it does not say it saved. The list is not a marketing tool. `/ops` is the private panel (secret `LIST_GATE`, not in git). The welcome note sends only when the `EMAIL` binding can send from `notify@mamoru.lol`, and only once. Nothing secret lives in this repo.
