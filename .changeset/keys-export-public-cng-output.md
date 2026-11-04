---
"hot-updater": patch
---

`hot-updater keys export-public` in an Expo CNG project without native folders says one thing.

- When the `@hot-updater/expo` plugin's `publicKeyPath` file holds the signing key, the command says `npx expo prebuild` embeds that file and succeeds.
- When the file is missing, or holds another key, the command says so with the `keys export-public --output <publicKeyPath>` command that writes it, and fails.
- Without `publicKeyPath`, the command prints only the `publicKeyPath` warning and fails, without `No native configuration files found.` or the `--print-only` tip.
