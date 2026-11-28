---
"@hot-updater/plugin-core": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
---

`deploy` and `keys export-public` say why remote signing failed instead of only "Failed to resolve the bundle signing provider public key.", and `deploy` prints it as a signing configuration error rather than exiting with a stack trace.

- `remoteSigning` names the signing endpoint's status, and the `{ error }` or `{ error: { code, message } }` it answered with, with the signing token masked. It also says when `HOT_UPDATER_SIGNING_TOKEN` is not set, and which endpoint it could not reach.
- Every other signing adapter error stays redacted, as it may quote key material.
- `doctor` reports the warning `SIGNING_PUBLIC_KEY_UNAVAILABLE` with the reason when it cannot read the configured signer's public key, such as `remoteSigning` without `HOT_UPDATER_SIGNING_TOKEN`, instead of `PUBLIC_KEY_MISMATCH`, whose resolution was a new native release.
