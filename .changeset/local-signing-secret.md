---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
---

Local PEM signing reads its private key from the config's `secrets` adapter with `signing: { enabled: true, privateKey: "secret:<name>" }`, beside `privateKeyPath`. The CLI reads the secret once per run, when it first derives the public key or signs, masks it in its output, and keeps it in memory only; a missing secret fails the deploy with where it was looked for. Without an adapter, `secret:bundle-signing-key` is `HOT_UPDATER_BUNDLE_SIGNING_KEY` in the environment, where a one-line PEM with `\n` for its line breaks reads as the PEM, and otherwise this machine's key store.

`hot-updater keys generate --secret [name]` stores the private key as that secret, `bundle-signing-key` by default, through the config's adapter, or in this machine's key store (`~/.hot-updater/keys/<project-key>/<name>.json`, readable by you alone) without one, and writes only `public-key.pem`. It never replaces a secret it reads a value from.
