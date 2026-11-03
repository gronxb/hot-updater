---
"hot-updater": patch
---

The preview action's outputs say how to install and fetch each platform's build.

- `android-install-url` and `ios-install-url`: the Console's download link, or for a simulator build, the `native-build install` command.
- `android-download-url` and `ios-download-url`: the storage's URL from `native-build find --json`, for a later step. Empty when the storage gives none; `hot-updater native-build download <id>` always works.
- The `previews` JSON has the same values per platform, as `installUrl` and `downloadUrl`, which is `null` where the output is empty.
- The comment's simulator install is now `npx hot-updater native-build install <id>`, in place of the `unzip` and `xcrun simctl` commands.
- The preview and release actions no longer print `native-build find --json`'s output in the job's log, since its `downloadUrl` is a credential until it expires.
