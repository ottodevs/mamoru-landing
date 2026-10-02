# Mamoru landing and ops console

Public repo `ottodevs/mamoru-landing` (GitHub is the only push remote). Cloudflare Worker `mamoru-lol`: the landing at mamoru.lol, the deck, and the Google-gated ops console at `/ops` (Overview, Mails, Infra, Experiments, Preview). Read `README.md` for channels and files.

## Operating flow

Several agents and sessions work here at once. Same rules as `ottodevs/mamoru`.

### Roles

- **Author**: does one unit of work. Never pushes `main` or `staging`, never merges their own pull request, never deploys, never sets Worker secrets.
- **Coordinator**: one session at a time: reviews, merges, releases. Whoever holds the Forgejo ticket with key `mamoru-release-coordinator` in `otto/mamoru` (status `doing`).

### One unit of work

1. **Ticket first** in Forgejo `otto/mamoru-astro` (`tk add`, then `tk status <id> doing` to claim it).
2. **Check for overlap**: `gh pr list -R ottodevs/mamoru-landing` and the files of each open pull request. Hot files: `src/worker.ts`, `src/ops.ts`, `src/ops-client.ts`, `wrangler.toml`. If yours touches the same ones, stack on that branch or wait.
3. **Own worktree, own branch**: `git worktree add ../mamoru-astro-<slug> -b <type>/<ticket>-<slug> origin/main`. The checkout at `~/box/src/mamoru.workspace/mamoru-astro` stays on a clean `main`.
4. `bun test`, `bun run build`, `bunx wrangler deploy --env="" --dry-run` and `--env staging --dry-run` pass.
5. **Pull request** against `main` with: ticket, paths touched, what was and was not tested, risk, deploy notes (secret, D1 table, order). Screenshots for anything visual, desktop and 390 px.
6. **Independent review** by a model other than the author's, verdict `APTO` or `NO-GO` as a pull request comment. Anything touching the session gate, CSRF, CSP, cookies or the wallet flow gets a security-focused review.
7. **The coordinator merges** with "Rebase and merge". Never force-push `main`.

### Releases

Pushing has side effects, which is why only the coordinator does it:

- `main` → production, automatically: lady's `mamoru-github-deploy.timer` deploys the tip with a health check and automatic rollback.
- `staging` → the `mamoru-lol-staging` Worker, shown at the gated `/ops/preview`. Visual or copy changes to the public pages go to `staging` first and are looked at there before `main`.
- D1 `mamoru` belongs to `ottodevs/mamoru` (`migrations/d1/`): this Worker reads `accounts`, `users`, `account_activity` and writes only `metrics_daily` and `exp_events`.
- Experiments change by code: status and winner are edited in `src/experiments.ts` and shipped by a release.

Each release is announced in Mattermost `#mamoru` by `@mamorusan`.

## Rules that hold

- The `/ops` gate is never weakened: every route returns data only with a valid allowlisted session, fragment requests included.
- No secrets, emails or RPC URLs in the repo, in rendered pages or in logs.
- With no experiment running, the public pages answer exactly as the static build: no cookie, no injected script.
- Design language: washi paper, ink, serif figures, hairline rules. No cards with shadows, colored accent borders or emoji.
