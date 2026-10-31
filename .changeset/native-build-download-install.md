---
"hot-updater": patch
"@hot-updater/android-helper": patch
"@hot-updater/apple-helper": patch
"@hot-updater/console": patch
---

Download and install a tracked native build from the CLI.

- `hot-updater native-build download <id> [-o path]` writes the artifact through the config's storage (`storage.get`), with no Console and no download URL.
- `hot-updater native-build install <id> [--simulator <udid>] [--device <serial>]` downloads a simulator `.app` or `.apk`, installs it on a booted simulator or a connected Android device, and opens the app the artifact names, so a sandbox build's `.sandbox` application ID works the same way.
- `native-build find --json` adds `downloadUrl`, the storage's `getDownloadUrl` result or `null`. Only a Console signs a signed link: the CLI doesn't hold its secret.
- The Console's Install card shows `native-build install` for a simulator build, in place of the `xcrun simctl` commands.
