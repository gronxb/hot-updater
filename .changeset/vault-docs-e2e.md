---
"hot-updater": minor
---

The docs walk through setting up the Console vault from start to CI: the master key on each Console host, `vault()` in `hot-updater.config.ts` and `console.config.ts` but not in the server, the vault's tables through `hot-updater doctor --fix`, storing secrets and issuing scoped tokens from the Console or the CLI, and GitHub Actions workflows that deploy, sign, build, and upload with `HOT_UPDATER_CONSOLE_URL` and one vault token. The E2E suite's `vault-signed-ota` deploys that way and checks that the device applies the Console-signed bundle.
