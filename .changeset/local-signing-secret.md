---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
---

Local PEM signing reads its private key from the config's `secrets` adapter with `signing: { enabled: true, privateKey: "secret:<name>" }`, beside `privateKeyPath`. The CLI reads the secret once per run, when it first derives the public key or signs, masks it in its output, and keeps it in memory only; a missing secret fails the deploy with where it was looked for. With `env()`, `secret:bundle-signing-key` is `HOT_UPDATER_BUNDLE_SIGNING_KEY`, and a one-line PEM with `\n` for its line breaks reads as the PEM.

`hot-updater keys generate --secret [name]` stores the private key as that secret, `bundle-signing-key` by default, through an adapter that stores values, and writes only `public-key.pem`. With a read-only adapter such as `env()`, it writes an owner-only `private-key.pem` and names the variable to store it as. It never replaces a secret it reads a value from; a write-only store such as `githubActions()` returns none outside a workflow.
