---
"@hot-updater/android-helper": patch
---

Sign with the scheme's `signing.keystore` on Linux. The Gradle wrapper's `/bin/sh` is dash on Debian and Ubuntu, which silently drops the `ORG_GRADLE_PROJECT_android.injected.signing.*` variables, so a build there signed with the project's own config, such as the debug keystore. The wrapper now runs under bash when it needs them, so a Linux runner needs bash for a signed build.
