---
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/test-utils": minor
---

The Console's **Native builds** tab lists the native builds Hot Updater tracks, installs them, and shows each one's built-in bundle, the diff baseline its OTAs patch from.

- **Native builds** (`/native-builds`) lists the tracked builds, newest first, one read per page, with each build's channel, fingerprint or app version, built-in bundle, and commit. `?channel=<name>` lists only the builds that embed a channel, also one read per page. A row opens the build's page.
- A build's page, `/native-builds/<id>`, reads five times whatever the build. **Install** shows an APK's QR code and `adb install` command, a simulator app's `xcrun simctl install` command, TestFlight for an IPA's testers, and a download for every build. **Built-in bundle** shows the min bundle ID its OTAs patch from, how many bundles patch from it, and whether it is its scope's newest build, which new deploys patch from, or the build that superseded it. **Served now** lists what the update check offers an install of the build, newer than its built-in bundle, and whether each first OTA downloads as a patch or as the full bundle. **Patches from this build** pages the patches from its built-in bundle.
- `/api/native-builds/<id>/download` redirects to the storage's download URL on each request, so the link never expires; a browser without a Console session goes to the build's page, which signs it in and returns to the build. The APK QR code holds the storage URL itself, read again every 30 seconds while it shows, so a phone needs no Console sign-in. `/_hot-updater/native-builds/qr?build=<id>` serves the QR code of a build's download link without a session and without a read.
- Sign-in returns to the Console page that asked for it.
- A bundle's detail sheet links to the newest native build of its release's scope, and says whether the bundle has a patch from it.
- `hot-updater channel delete <channel>` disables and deletes a channel's bundles, then the channel, as when a pull request closes. A missing channel succeeds without a change; a channel a native build embeds is kept, and the command exits with status 1.
- Core's API adds `getNativeBuild(id)`, one read by key, served at `GET /native-builds/:id`, and `listNativeBuilds({ channelId })`, one read of the channel's builds, served at `GET /native-builds?channelId=`; `standaloneRepository` maps both.
