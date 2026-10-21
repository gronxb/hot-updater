---
"@hot-updater/plugin-vault": minor
"@hot-updater/console": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
---

The vault's master key rotates. `HOT_UPDATER_VAULT_MASTER_KEYS` lists master keys as `kid:key` pairs separated by commas: the first seals new values, and every listed key opens the values sealed under it. `HOT_UPDATER_VAULT_MASTER_KEY` is the key `default`, and when both are set it follows the listed keys; a kid listed twice, or a `default` in both that is not the same key, locks the vault with a message naming the variable. `vault({ masterKeys })` takes the same list.

- The vault keeps a check value sealed under each master key it knows, in a reserved `vault_secrets` row, with no schema change. A vault without that row is checked against its stored versions, and the row starts from the keys that open them. A Console whose keys are not the vault's is locked, even over an empty vault or once every secret is deleted, so Consoles with different keys never seal into one vault. `put` checks it in its transaction, `status()` in one read, and a locked status lists the vault's `knownKeys`.
- `hotUpdater.api.vault.keys()` lists the Console's keys and the vault's, with the stored versions under each and whether the vault still knows each key, and `rewrap({ batch })` moves up to `batch` versions (100 by default) to the active key, re-wrapping only their data keys, and returns `{ rewrapped, remaining }`. Once nothing is under an old key, the vault forgets it, so a Console that holds only that key is locked. It is safe beside concurrent writes and deletes, and running it again moves nothing.
- The Console's Vault page has a Master keys tab: each key with its versions and role, a Rewrap button that counts down batch by batch, and which keys can leave the environment afterwards. Writes no longer call `status()` first.
- The CLI never rewraps: `lockVaultReveal` locks `rewrap` with `reveal`.
- `hot-updater doctor` warns `VAULT_MASTER_KEY_WITH_DATABASE_CREDENTIALS`, without failing, when an `.env*` file of the project, or the environment it runs in, sets a master key beside database credentials.
