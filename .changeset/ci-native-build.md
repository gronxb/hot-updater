---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/apple-helper": minor
---

Native builds run in CI without signing in. The CLI treats a run as CI when `CI` is set or it has no terminal: it asks nothing there, even on a terminal a runner allocates, and never starts an Apple or Google sign-in. `native-build ios` and `native-build android` resolve every credential they sign and upload with before the build adapter's prebuild, so a missing one fails in seconds; the error names the `secrets` adapter and where it keeps the credential, the command that stores it once (`apple login` or `google-play login` for a key Hot Updater issues, `secrets put` for a keystore), and the environment variables that provide it instead. In CI, an iOS build that signs with an App Store Connect API key archives and exports in a keychain of its own, restores the runner's keychains afterwards, and revokes the development certificates Xcode created in it, so runners that start empty don't pile up certificates. The new `actions/native-build` GitHub Action runs `native-build <platform> --submit` with the job's environment, its `submit` input naming the store, and the "Build and upload from CI" guide has a complete workflow for each secrets adapter.
