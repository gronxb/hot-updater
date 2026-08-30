---
"hot-updater": minor
"@hot-updater/cloudflare": patch
---

Rename the CLI's `init --env-file` option to `init --init-env-file` to avoid Node.js interpreting replay files as its own startup configuration. This keeps the portable shebang required by Yarn Classic on Windows without allowing `NODE_OPTIONS` in a replay file to run preloads before the CLI starts.

Breaking change: update replay commands to `hot-updater init --init-env-file .env.hotupdater`. The old `--env-file` CLI option is no longer supported. The programmatic `envFile` option is unchanged.
