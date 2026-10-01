# Staging deploy automation (lady)

Mirrors the existing prod watcher
(`~/.config/mamoru-lol/github-deploy.sh` + `mamoru-github-deploy.timer/.service`,
defined on lady, not in this repo) for the `staging` branch and the
`mamoru-lol-staging` Worker. The prod watcher is **not modified** by this
install — this adds a second, independent timer that only ever touches the
staging Worker.

## Install on lady

```bash
install -m 755 ops/github-deploy-staging.sh /home/otto/.config/mamoru-lol/github-deploy-staging.sh
install -m 644 ops/systemd/mamoru-github-deploy-staging.timer   /home/otto/.config/systemd/user/
install -m 644 ops/systemd/mamoru-github-deploy-staging.service /home/otto/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mamoru-github-deploy-staging.timer
```

Requires `/home/otto/.config/mamoru-lol/staging-proxy-secret` to exist (0600,
same value as `STAGING_PROXY_SECRET` on both Workers) for the post-deploy
health check. Without it, the script still deploys but skips the health
check and logs a warning to `~/.local/state/mamoru-lol/deploys-staging.log`.

State lives alongside the prod watcher's, under separate filenames so the
two never collide: `~/.local/state/mamoru-lol/github-src-staging`,
`github-deployed-sha-staging`, `deploys-staging.log`,
`last-good-version-staging`, `health-staging.html`,
`github-deploy-staging.lock`.

## One thing this change makes visible in prod's own logs

`wrangler.toml` now defines a named environment (`staging`), so any
`wrangler deploy`/`wrangler rollback` run **without** `--env` prints a
"multiple environments are defined" warning before proceeding with the
top-level (prod) config — confirmed non-fatal with `wrangler deploy --dry-run`
(exits 0, no prompt, correct bindings). It is cosmetic. If the noise in
`~/.local/state/mamoru-lol/deploys.log` / journal is unwanted, the prod
script's two `bunx wrangler` calls can be changed to
`bunx wrangler deploy --env=""` and `bunx wrangler rollback ... --env=""` —
`--env=""` explicitly means "the top-level environment," functionally
identical to omitting the flag. Left as a suggestion, not applied here: that
file drives the live prod pipeline and this agent's mandate was staging-only.

## Verifying it worked

```bash
journalctl --user -u mamoru-github-deploy-staging.service -n 50
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Mamoru-Staging-Secret: $(cat ~/.config/mamoru-lol/staging-proxy-secret)" \
  https://mamoru-lol-staging.ottodevs.workers.dev/
```
