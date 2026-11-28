---
"@hot-updater/react-native": patch
---

The Android fingerprint Gradle task locates the hot-updater CLI by running `resolve-hot-updater-cli.js`, a file the package ships, instead of an inline `node -e` script, so no code passes through the command line, whose quoting differs on Windows.
