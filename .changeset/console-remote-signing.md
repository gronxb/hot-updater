---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/plugin-vault": minor
"@hot-updater/plugin-core": minor
---

The Console signs bundles with its vault at `/_hot-updater/signing`, the remote signing protocol of `remoteSigning` from `hot-updater/signing`: a deploy sets `signing: remoteSigning({ endpoint: "<Console URL>" })` and sends a vault token whose scope allows `sign` as `HOT_UPDATER_SIGNING_TOKEN`. The Console signs with the one `bundle-signing-key` the token may sign with, so a sign token scoped by name picks a key among several, opens the key with its master key only after the token is verified, writes each signature to the vault's audit log as `sign`, and never returns the key, which `/resolve` still refuses. Vault tokens take the `sign` action in the Console's Tokens tab, which then shows `HOT_UPDATER_SIGNING_TOKEN`, and in `hot-updater secrets token create --actions sign`. `hot-updater keys generate --vault [name]` stores a new private key in the vault as a `bundle-signing-key` through the Console's write route, writing only the public key and never replacing a secret under the name; the write route and `createVaultClient().put` take an optional `expectedVersion`, `0` for a new secret only. A `bundle-signing-key` value must be an unencrypted RSA private key of 2048, 3072, or 4096 bits in PEM (PKCS#8 or PKCS#1), checked when it is stored. `createBundleSigningHandler` in `@hot-updater/plugin-core` takes `token` as a function that accepts or refuses the presented token, and `publicKey` as a function called only after the token is accepted; a string still works for both.
