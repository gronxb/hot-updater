---
"hot-updater": minor
"@hot-updater/apple-helper": minor
"@hot-updater/cli-tools": minor
---

Sign in with your Apple Account to issue the App Store Connect API key. An iOS build that needs a key for `signing.ascApiKey` or `--upload testflight` and finds none asks for the Apple Account in a terminal, issues a team key with the Admin role through asc, the open-source App Store Connect CLI, stores it in the vault, and continues; `hot-updater secrets put asc-api-key --kind asc-api-key` without key options does the same ahead of time. Builds without a terminal use the stored key, and refuse with that command when there is none. Only the issued key is kept: asc's session, config, and the `.p8` live in a temporary directory that is deleted, and a key the vault refuses is revoked again.

Every command now reads the vault connection the same way: `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN` from the environment, else from the project's `.env.hotupdater`. Native builds' `vault:` credentials and the TestFlight and Play upload keys used to read only the environment, so a build with the connection in `.env.hotupdater` failed with "not set".
