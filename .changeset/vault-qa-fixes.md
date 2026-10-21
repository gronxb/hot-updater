---
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/plugin-vault": minor
"@hot-updater/android-helper": minor
---

Vault fixes from integrated QA.

- The CLI masks a stored value shorter than six characters, such as `1`, only where it is a whole word, as in `PASSWORD=1`, so the Console's URL and versions stay readable.
- `hot-updater secrets put` and the Console's secret form warn, naming the secret, when another deploy-credentials or generic secret already sets a variable. A command whose vault token reaches both names the variable, both secrets with their kinds, and how to keep it in one.
- A Console without a master key, on a vault rotated to a named key, says to list that key in `HOT_UPDATER_VAULT_MASTER_KEYS` as `"<kid>:<key>"`, in the page, `status()`, and the vault routes' 503.
- The Vault page folds revoked and expired tokens behind a toggle, shows a bundle signing key's size and public key SHA-256, and over a self-hosted server links the vault guide.
- `hot-updater channel delete --json` keeps stdout one JSON document when a native build keeps the channel.
- `build:android` prints "App Module" in its Gradle settings.
