---
"hot-updater": patch
---

`hot-updater keys export-public` in an Expo CNG project without native folders says one thing. With the `@hot-updater/expo` plugin's `publicKeyPath` set, it says `npx expo prebuild` embeds that file and succeeds. Without it, it prints only the `publicKeyPath` warning and exits with an error, without `No native configuration files found.` or the `--print-only` tip.
