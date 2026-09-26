# RESULT — restore waitlist welcome via Loops (2026-09-26 ~13:30 JST)

## Tip restore
`6e84080` on agent/loops-welcome-restore-20260926 (and deploy SHA after wrangler).

## Causa — which commit switched to CF Email Sending
- **Forgejo:** `9f21a55` `feat: keep signup emails on a private list` (2026-09-25)
- **GitHub twin:** `a74f462` (same change set on `ottodevs/mamoru-landing`)
- What changed: removed Loops env (`LOOPS_API_KEY` / `LOOPS_FORM_ID`) from the live notify path and added Cloudflare `[[send_email]]` binding `EMAIL` (`notify@mamoru.lol`) + `env.EMAIL.send(...)` in `deliver()`.
- Note: welcome HTML briefly went through **Resend** in earlier landing commits (`0ce9389`…); `9f21a55`/`a74f462` is the commit that put **CF Email Sending** on the product path. Mitsurugi closed decision: welcome/notify = **Loops Free**, not CF Email Sending / Workers Paid / Onboard Domain.

## Why prior 10203 diagnosis was wrong
`ottodevs@gmail.com` Sent OK only because it is a CF Email Routing **verified destination**. That is not proof the CF path is correct for arbitrary waitlist recipients. Product path must be Loops API.

## Code restore (this change)
- Removed `[[send_email]]` / `EMAIL` binding from `wrangler.toml`.
- `deliver()` → `POST https://app.loops.so/api/v1/transactional` with `LOOPS_API_KEY` + `LOOPS_TRANSACTIONAL_ID`.
- `/api/notify` and `/ops/send` use Loops; KV `WAITLIST` remains the private list (lista propia unchanged).
- `SHOW_EMAIL_FORM` stays false; no Turnstile; no Live LP/Titan.

## Secrets / vars (HITL if missing — do not print values)
```bash
cd ~/box/src/mamoru.workspace/mamoru-astro
bunx wrangler secret list   # expect LOOPS_API_KEY among secrets
# put once (paste OOB, never commit):
bunx wrangler secret put LOOPS_API_KEY
# then set non-secret template id in wrangler.toml [vars]:
# LOOPS_TRANSACTIONAL_ID = "<published transactional id>"
bun run deploy
```
Loops dashboard: publish transactional **"Welcome to Mamoru"** matching `src/follow-up.ts` (Brais four lines + custody). Verify sending domain for Mamoru in Loops (Free).

## Resend Failed
Ot GO present. After Loops secrets+template are live: open `/ops` → **Send the missing ones** (skips `note === sent`, cap 25). Skip probe `*.example.com` / `*.invalid` if still present.

## CF Email Sending
Disabled for waitlist notify: binding removed; no Workers Paid / Onboard Domain ask.
