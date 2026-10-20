---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/plugin-vault": minor
"@hot-updater/plugin-core": minor
"@hot-updater/apple-helper": minor
"@hot-updater/android-helper": minor
---

The CLI resolves credentials from the Console's vault, connected only by `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN`. The credential resolver's default source is the vault: an item's own environment overrides still win and never reach the Console, the items a build needs go in one `POST /_hot-updater/vault/v1/resolve`, nothing is cached, and an unreachable Console, a refused token, or missing connection variables fail at once, naming the Console's URL and the environment variables that replace the item. Native build `signing.keystore` and `signing.ascApiKey` reference vault secrets as `vault:<name>`, such as `"vault:release-keystore"`. `vaultEnv([...names])` from `hot-updater` returns a function that resolves environment variables from the vault's `deploy-credentials` and `generic` secrets when a config calls it, each name set in the environment winning. The built-in `hot-updater secrets` command lists secrets (`secrets list`) and stores them through the Console (`secrets put <name> --kind <kind>`), runs a command with the vault's variables (`secrets env -- <command>`), and issues, lists, and revokes vault tokens in process over the config's `database` and `plugins`, or a server definition, without a master key (`secrets token create|list|revoke`). The Console serves `PUT /_hot-updater/vault/v1/secrets/:name`, which encrypts a value with its master key and answers with the secret's metadata only, and vault token scopes take a `write` action, allowed only on the secrets in scope and never reading a value back; a `bundle-signing-key` can be written but is never resolved. The audit log records writes as `write`. `createVaultClient` in `@hot-updater/cli-tools` is the CLI's client for these routes.
