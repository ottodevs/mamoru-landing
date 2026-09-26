> **SUPERSEDED 2026-09-26 ~13:30 JST (Mitsurugi STOP):** CF Email Sending is the wrong product path. Welcome/notify = Loops Free. Do not onboard CF Email Sending / Workers Paid. See `ops/RESULT-loops-welcome-restore-2026-09-26.md`.

# RESULT — waitlist notify Failed review (2026-09-26 ~13:10 JST)

## Tip
90d066d (agent/app-shell-p0-20260926) — no deploy (blocker is CF entitlement, not worker code).

## Reproduce
- Provider: Cloudflare Email Sending ([[send_email]] binding EMAIL, from notify@mamoru.lol). Not Resend / Loops / SMTP.
- /api/notify and /ops/send call deliver() -> env.EMAIL.send(...). Catch -> KV note: "failed".
- /ops label Failed = note === "failed" (UI copy already says domain cannot send yet).

## Store (KV WAITLIST, remote)
| | count |
|---|---|
| total entries | 14 |
| Sent | 1 (ottodevs@gmail.com) |
| Failed | 13 |
| of which probe/invalid | 3 (*@example.com, *.invalid) |
| real Failed candidates | 10 |

Verified Email Routing destinations on account (only these can receive while Email Sending is off):
- ottodevs@gmail.com (matches the one Sent)
- hi.mamoru@proton.me (not on waitlist)

## Root cause (1 phrase)
Email Sending is disabled for mamoru.lol / account — only pre-verified destinations work; arbitrary waitlist recipients get CF 10203 sending_disabled (Workers binding marks Failed).

## Provider + error pattern
- REST probe POST .../email/sending/send to non-verified -> code 10203 email.sending.error.email.sending_disabled
- Same API to verified ottodevs@gmail.com -> delivered (path OK for verified dest)
- Zone Email Routing: ready (inbound MX/SPF/DKIM cf2024-1). No Email Sending cf-bounce.* onboarding.
- Create sending subdomain API -> 2036 Unauthorized (lady OAuth cannot enable; needs dashboard / Workers Paid entitlement)

## Resend
Not sent. Ot GO present, but CF rejects every non-verified recipient until Email Sending is onboarded. Bulk /ops/send would re-mark Failed.

## Ot must do (HITL — then re-run Send)
1. Cloudflare Dashboard (account owner) -> Workers & Pages -> enable Workers Paid if still Free (required for arbitrary recipients; ~$5/mo).
2. Compute -> Email Service -> Email Sending -> Onboard Domain -> mamoru.lol (auto DNS: cf-bounce MX/SPF/DKIM + _dmarc).
3. Wait until sending DNS records show configured (usually minutes on CF DNS).
4. Smoke: tell agent, or open /ops -> Send the missing ones (skips already-Sent; caps 25/click).
5. Optional cleanup: remove 3 probe rows from /ops so they are not retried.

After steps 2-3, agent can finish: resend Failed only + report Sent counts.
