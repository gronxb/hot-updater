---
"@hot-updater/console": minor
"@hot-updater/plugin-vault": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
---

The Console serves the vault to CI: `GET /_hot-updater/vault/v1/secrets` lists the secrets a vault token's scope reaches, and `POST /_hot-updater/vault/v1/resolve` returns the values of the secrets it names, opened with the Console's `HOT_UPDATER_VAULT_MASTER_KEY`. The routes take `Authorization: Bearer hu_vault_...` instead of a session, refuse out-of-scope names with 403 and unknown, revoked, or expired tokens with 401, never resolve a `bundle-signing-key`, and record each read in the vault's audit log (`hotUpdater.api.vault.recordAudit`). `reveal({ id, actor, version })` opens only the version a caller authorized, so a secret rotated or replaced since is refused with `VaultNotFoundError` and the route authorizes it again. A Console over `standaloneRepository(...)` answers `vault_unavailable`. The CLI never reveals a vault secret, even where the master key is set: cli-tools' `assembleServer` and plugin commands over a server definition refuse `reveal` with `VaultLockedError` (`lockVaultReveal`).
