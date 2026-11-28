---
"@hot-updater/console": patch
---

Install an APK on a phone from a build's signed link.

- A build's page creates its signed link when it opens. The QR code, the download button and the link to copy all use it, so a phone without a Console session goes straight to the download. "Create a link without sign-in" is gone.
- The page no longer reads the download URL every 30 seconds. A Console that can't sign, such as a local `hot-updater console`, shows the storage's URL in the QR code, read when the page opens and when someone comes back to it.
- A streamed `.apk` always answers `content-type: application/vnd.android.package-archive`, and a streamed build's `content-disposition` also has a plain `filename` for clients that don't read `filename*`.
- The Install card says what Android needs: the browser's "Install unknown apps" permission, and that an install over the same package signed with another key fails.
- An APK on an emulator or over USB shows `native-build install` in place of the `adb install` command.
