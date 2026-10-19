---
"@hot-updater/plugin-vault": minor
"@hot-updater/server": minor
"hot-updater": minor
---

Add the `vault()` plugin, `@hot-updater/plugin-vault`, which stores signing and deploy credentials in the database encrypted.

- Each version of a secret is sealed with AES-256-GCM under a data key of its own, which the master key in `HOT_UPDATER_VAULT_MASTER_KEY` wraps. Both seals bind the secret's id and version, so a value moved to another row does not decrypt.
- `hotUpdater.api.vault` lists, stores, reveals, and removes secrets, and keeps each secret's last five versions. Without a master key it still lists and removes, and refuses to store or reveal with `VaultLockedError`.
- The plugin adds tables and an API, and no routes. List `vault()` in the plugins of `hot-updater.config.ts` and `console.config.ts`; `hot-updater/plugins` and `@hot-updater/server/plugins` export it, and managed servers don't run it.
