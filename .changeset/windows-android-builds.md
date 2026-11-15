---
"@hot-updater/android-helper": patch
"@hot-updater/cli-tools": patch
"@hot-updater/bare": patch
"@hot-updater/expo": patch
"@hot-updater/rock": patch
"hot-updater": patch
---

fix(android-helper): Windows Android native builds record the channel and app version they embed, and build where long paths broke them.

- aapt2.exe ends its lines with CRLF, so the built artifact's `versionName` and `com.hotupdater.CHANNEL` read as unknown and the build was recorded on `production` with no native app version. The reader now accepts CRLF, and a meta-data name it can't read counts as unknown, never as no channel. With `--channel`, the build is recorded with the channel the artifact check verified.
- `gradlew.bat` runs by its path, so a Windows machine with `NoDefaultCurrentDirectoryInExePath` set finds it.
- Windows builds pass `-DCMAKE_OBJECT_PATH_MAX=250` to every module's CMake through an init script. CMake then hashes the long part of React Native's codegen object paths, which ninja 1.10.2 in the SDK's CMake 3.22.1 can't reach past 260 characters.
- A bundle command that fails, such as `expo export:embed`, now reports its exit code or signal (an NTSTATUS such as 0xC0000005 in hex) and the last lines of its output, instead of only its stderr.
