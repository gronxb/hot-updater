---
"hot-updater": patch
"@hot-updater/cli-tools": patch
---

Warn on a missing secret nothing reads, close every doctor run with its counts, and keep Infisical errors within 76 columns.

- A `secret()` that is missing and that no build reads, such as a debug variant's keystore or a simulator scheme's App Store Connect API key, is now a warning: the Secrets block is marked `▲`, the run still passes with exit code 0, and `--json` lists it as a `SECRETS_MISSING_UNUSED` warning in `details.secrets.issues`. A missing name an adapter's `secret()` reads is a `DEPLOY_SECRETS_MISSING` warning in `details.deploySecrets.issues`.
- Doctor's last line counts what it found. A run with warnings ends `All checks passed with 2 warnings.`, and a failing run, the `--scope` checks included, now ends `Doctor found 1 error, 2 warnings.` before it exits with code 1.
- Messages the CLI breaks into lines, such as a secrets adapter's errors, now fit 76 display columns with clack's `│  ` in front, measured as a terminal shows them rather than by length. `infisical()` cuts Infisical's own message to fit, and names the project on one line and the environment and folder on the next. A URL that can't fit stays alone on its line.
