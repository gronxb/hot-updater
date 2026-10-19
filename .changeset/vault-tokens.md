---
"@hot-updater/plugin-vault": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add scoped vault tokens to the `vault()` plugin, the credential CI reaches the vault with.

- `hotUpdater.api.vault.issueToken({ name, scope, expiresAtMs })` returns a `hu_vault_` token once; the vault stores only its SHA-256 digest and a short display prefix. `listTokens()` lists tokens without their digests, and `revokeToken({ id })` revokes one at once.
- A scope names the secrets a token reaches, by `names`, `kinds`, or both, and its `actions`, `read` or `sign`. A scope names at least one secret or kind and one action, so no token reaches every secret implicitly; listing every kind is how one does. `expiresAtMs`, when given, is after now.
- `verifyToken({ token })` reads the token's digest row on every call, so a revocation holds from the next request, and answers `{ ok: true, token }` or `{ ok: false, reason }` with `unknown`, `revoked`, or `expired`. `authorizeVaultToken(token, { action, secret })` checks one secret and action against the verified token's scope.
- Tokens need no master key, so a vault without `HOT_UPDATER_VAULT_MASTER_KEY` issues, lists, revokes, and verifies them.
- The read-budget suite runs `vault()` too, and pins a token verification at one read.
