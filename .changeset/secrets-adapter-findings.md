---
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/firebase": patch
---

Fix what real-account runs of the secrets adapters found.

- A rejected or missing credential names what's in use: `AWS_ACCESS_KEY_ID`, `CLOUDSDK_AUTH_ACCESS_TOKEN`, `AZURE_CLIENT_SECRET`, a `credentials` option, or the set `AWS_PROFILE`, instead of a sign-in that can't replace it.
- `secretManager()` no longer prints the Google auth library's `MetadataLookupWarning`.
- `keyVault()` says to check `vaultName` or `vaultUrl` when the vault's host doesn't resolve.
- `doctor` prints one block for a secrets adapter it can't read, listing the names, and closes with `2 secrets not checked, 1 warning.` instead of a pass. It still exits 0.
- `doctor` says when `hot-updater` isn't in `package.json`, instead of `hot-updater CLI not found`.
- The `Source` row shows an adapter's description whole, instead of a shortened fragment, and `secretManager()` describes a secret as the other adapters do.
