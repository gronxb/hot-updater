---
"hot-updater": minor
"@hot-updater/apple-helper": minor
"@hot-updater/cli-tools": minor
---

Sign in with your Apple Account to issue the App Store Connect API key. An iOS build that needs a key for `signing.ascApiKey` or `--upload testflight` and finds none asks for the Apple Account, its password (masked), and the two-factor code in Hot Updater's own prompts in a terminal, issues a team key named `hot-updater <date>` with the Admin role through asc, the open-source App Store Connect CLI, stores it through the config's `secrets` adapter, or in an owner-only file when the adapter can't store it, and continues; `hot-updater secrets put asc-api-key --kind asc-api-key` without key options does the same ahead of time. Builds without a terminal use the stored key, and refuse with that command when there is none. Only the issued key is kept: asc's session, config, and the `.p8` live in a temporary directory that is deleted, and a key the adapter surely did not store is revoked again.
