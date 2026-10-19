---
"@hot-updater/console": minor
"@hot-updater/plugin-vault": minor
---

The Console manages the vault: a Vault page, shown when `console.config.ts` lists `vault()` over the database, adds, overwrites, and deletes secrets from their files and fields, and issues read tokens and lists and revokes vault tokens. Values are write-only: the page shows each secret's name, kind, version, update time, and non-secret metadata such as a key ID or a keystore's alias, and never a value. A new token shows once, with the `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN` lines CI sets. Without `HOT_UPDATER_VAULT_MASTER_KEY` the page shows the vault as locked instead of failing on save. `hotUpdater.api.vault.status()` reports whether the vault holds a usable master key, reading nothing, and `parseVaultSecretValue(kind, value)` and `vaultSecretMetadata(kind, value)` define each kind's value: `asc-api-key` `{ p8, keyId, issuerId }`, `android-keystore` `{ keystore, storePassword, keyAlias, keyPassword }`, `play-service-account` `{ serviceAccount }`, `bundle-signing-key` `{ privateKey }`, with files in base64, and environment variables by name for `deploy-credentials` and `generic`.
