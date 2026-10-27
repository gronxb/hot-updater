---
"@hot-updater/cli-tools": minor
---

Add `createCredentialResolver`, the CLI's credential resolver: it resolves an App Store Connect API key, an Android keystore, or a Play service account from per-item environment overrides (such as `HOT_UPDATER_ASC_KEY_PATH`, `HOT_UPDATER_ASC_KEY_ID`, and `HOT_UPDATER_ASC_ISSUER_ID`), writes file values as 0600 temporary files deleted on dispose and on exit, fails naming the environment variables that can provide a missing item, and masks every resolved secret in CLI logs and build log files.
