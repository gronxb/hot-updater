---
"@hot-updater/console": patch
"hot-updater": patch
---

The Console's Install card says each thing about installing a native build once: the QR code's caption says what scanning gets, and the steps beside it add only another way, such as `adb`, `xcrun simctl`, Xcode or Apple Configurator, or the `testflight` and `google-play upload` commands. An AAB's card no longer says twice that it installs through Google Play or bundletool.

A native build's Console download link, as a pull request preview's comment shows it, opened in a browser without a Console session, goes to the build's page to sign in, and sign-in returns to the download. The build's page names the download in `returnTo`, relative to the page, and sign-in takes it only on the Console's own origin; anything else returns to the page. A request that isn't a browser navigation still gets the 401.

`hot-updater channel set <channel>` says per platform when it found no `AndroidManifest.xml` or `Info.plist` and wrote nothing, instead of a success line, and asks for a rebuild only when it wrote a file. In an Expo CNG project it says that builds take the channel from the `@hot-updater/expo` plugin's `channel` option in the project's `app.json` or `app.config.*`, which `expo prebuild` writes into the native files, and shows that option set to the channel given, not `production`.
