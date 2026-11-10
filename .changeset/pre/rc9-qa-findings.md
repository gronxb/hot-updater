---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Fail `hot-updater doctor` on a signing secret a build needs, and keep secrets errors within 76 columns.

- A `secret()` that a build or a deploy reads and that resolves nowhere now fails doctor: an error under the Secrets block with the command that imports the existing key, no "All checks passed", and exit code 1, for `--json` too. "Needed" is what the build resolves: an iOS device scheme's `signing.ascApiKey`, a release variant's `signing.keystore`, and `signing` while bundle signing is on. A simulator scheme, a debug variant, or `enabled: false` reads nothing, so its missing secret stays a `missing, unused` row. An adapter doctor can't read stays a warning. `--json` gives each reference `required`, and a `message` when a required one is missing.
- The Google Play row marks a package ✗, `upload keystore missing`, when the keystore its release signs with is missing, and `--json` adds `missingKeystore` to that package.
- Deploy prints a missing signing key's next step on a line of its own, as the error lays it out, instead of folding it into the sentence before it. Text the CLI prints that is already laid out in lines keeps them.
- `keys export-public` prints `Public key not exported.` with its cause on the lines after it, doctor and `init` put a secrets adapter's error under `Couldn't read the <adapter> secrets adapter.`, and `infisical()`, `localSecrets()`, and `secret()` break a line that a long name, folder, path, or URL would widen past 76 columns. A URL longer than a line gets a line of its own.
