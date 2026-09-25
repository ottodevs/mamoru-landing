# Mamoru landing

Coming-soon page for [mamoru.lol](https://mamoru.lol). One screen on rice paper: the Mamoru lockup, `APY. DELIVERED.`, a countdown to the opening after ETHGlobal Tokyo, and an email bar.

Built with [Astro](https://astro.build). Served by a Cloudflare Worker that also handles `POST /api/notify`.

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
| `src/components/Countdown.astro` | Countdown to `2026-09-27T09:00:00+09:00` |
| `src/components/EmailBar.astro` | Email bar and the on-the-list follow-up |
| `src/styles/global.css` | Rice paper field, ink, Noto Serif |
| `src/worker.ts` | Assets plus `/api/notify` |

The waitlist KV namespace (`WAITLIST`) and the confirmation email (`RESEND_API_KEY`, `MAIL_FROM`) are optional Worker bindings. Nothing secret lives in this repo.
