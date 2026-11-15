---
"@hot-updater/react-native": patch
"@hot-updater/apple-helper": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

fix(react-native): an Android sandbox build works on stock React Native 0.88 and One templates, without changing `ext.kotlinVersion`.

- A sandbox build used to require the root `ext.kotlinVersion` to equal the Kotlin Gradle plugin the build loads. React Native 0.88's template sets `kotlinVersion = "2.2.0"`, while its Gradle plugin loads 2.2.10, so every default 0.88 app had to edit `android/build.gradle` first. A One app couldn't build at all, because `one prebuild` rewrites that file. The SDK now reads the version from the Kotlin Gradle plugin the build loaded, and puts the Compose compiler plugin on the classpath at that version. Kotlin 1.9 is unchanged, and builds that aren't sandbox builds get nothing new.
- One 2.15 is now a tested Android host for sandbox builds. `hot-updater doctor` warns about a One iOS sandbox scheme, which hasn't been tested yet.
- When `bundle install` or React Native codegen fails in `native-build ios`, the output now shows the error line, such as Ruby's `NoMethodError`, along with the command to run it again. It used to show only the backtrace's last lines and the CLI's own stack.
- `native-build android` now refuses a Rock sandbox scheme before it prepares anything, so `fingerprint.json` stays unchanged.
