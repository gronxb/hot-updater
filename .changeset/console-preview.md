---
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/react-native": minor
"@hot-updater/protocol": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/test-utils": minor
---

The Console's **Native builds** tab lists the native builds Hot Updater tracks and installs them, and preview builds switch to a pull request's channel with a QR code.

- **Native builds** (`/native-builds`) lists the tracked builds, newest first, one read per page, with each build's channel, fingerprint or app version, built-in bundle, and commit. `?channel=<name>` lists only the builds that embed a channel, also one read per page. A row opens the build's page.
- A build's page, `/native-builds/<id>`, reads five times whatever the build. **Install** shows an APK's QR code and `adb install` command, a simulator app's `xcrun simctl install` command, TestFlight for an IPA's testers, and a download for every build. **Built-in bundle** shows the min bundle ID its OTAs patch from, how many bundles patch from it, and whether it is its scope's newest build, which new deploys patch from, or the build that superseded it. **Served now** lists what the update check offers an install of the build, newer than its built-in bundle, and whether each first OTA downloads as a patch or as the full bundle. **Patches from this build** pages the patches from its built-in bundle.
- `/api/native-builds/<id>/download` redirects to the storage's download URL on each request, so the link never expires; a browser without a Console session goes to the build's page, which signs it in and returns to the build. The APK QR code holds the storage URL itself, read again every 30 seconds while it shows, so a phone needs no Console sign-in. `/_hot-updater/native-builds/qr?build=<id>` serves the QR code of a build's download link without a session and without a read.
- **Import** on the Native builds page, or a file dropped on it, imports an `.ipa`, `.aab`, or `.apk` built elsewhere as a native build, as `hot-updater native-build import` does. The browser reads the artifact with `@hot-updater/protocol/native-artifact` and shows what it compiled in and how it will be found, refusing what the CLI refuses with the same messages, and linking a build already registered to its page. `POST /api/native-builds/import` (same-origin, Console session, up to 2 GB) takes the file with upload progress, reads and checks it again, stores the artifact and the built-in bundle, registers the build, and the page opens it. A build registers by `console.updateStrategy`, which `hot-updater console` takes from `updateStrategy` in hot-updater.config.ts; without it, by the newest registered build's strategy, or by whether the artifact compiled a fingerprint in.
- Sign-in returns to the Console page that asked for it.
- A bundle's detail sheet links to the newest native build of its release's scope, and says whether the bundle has a patch from it.
- A channel's link is `<prefix>hot-updater/channel/<channel>`. Set the prefix, the app's URL scheme or universal link prefix, with `console.channelLinkPrefix`.
- `hotUpdater.openChannelLink(url, { updateStrategy, defaultChannels })` opens a channel link with the existing `checkForUpdate({ channel })`, `updateBundle()`, and `reload()`, calling `resetChannel()` first when the app runs another channel. Only builds whose default channel is in `defaultChannels` open links, so production builds ignore them. Native code and the bridge don't change.
- `@hot-updater/protocol` exports `createChannelLink` and `parseChannelLink`.
- `hot-updater channel delete <channel>` disables and deletes a channel's bundles, then the channel, as when a pull request closes. A missing channel succeeds without a change; a channel a native build embeds is kept, and the command exits with status 1.
- Core's API adds `getNativeBuild(id)`, one read by key, served at `GET /native-builds/:id`, and `listNativeBuilds({ channelId })`, one read of the channel's builds, served at `GET /native-builds?channelId=`; `standaloneRepository` maps both.
