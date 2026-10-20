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

Install preview native builds from the Console, and switch them to a pull request's channel with a QR code.

- The Console's **Preview** page lists registered native builds, newest first, one page per read. **Install** shows an APK's QR code, a simulator app's `xcrun simctl install` command, and a download for every build. `/api/native-builds/<id>/download` redirects to the storage's download URL on each request, so the link never expires; the APK QR code holds that storage URL, read again every five minutes while it shows, so a phone needs no Console sign-in.
- The page's **Channel link** card shows a channel's link, `<prefix>hot-updater/channel/<channel>`, as a QR code, with the `adb` and `xcrun simctl openurl` commands that open it. Set the prefix, the app's URL scheme or universal link prefix, with `console.channelLinkPrefix`. `/preview?build=<id>` and `/preview?channel=<name>` open a build or a channel directly, and a bundle's detail sheet links to its channel's link.
- `hotUpdater.openChannelLink(url, { updateStrategy, defaultChannels })` opens a channel link with the existing `checkForUpdate({ channel })`, `updateBundle()`, and `reload()`, calling `resetChannel()` first when the app runs another channel. Only builds whose default channel is in `defaultChannels` open links, so production builds ignore them. Native code and the bridge don't change.
- `@hot-updater/protocol` exports `createChannelLink` and `parseChannelLink`.
- `hot-updater channel delete <channel>` disables and deletes a channel's bundles, then the channel, as when a pull request closes. A missing channel succeeds without a change; a channel a native build embeds is kept, and the command exits with status 1.
- Core's API adds `getNativeBuild(id)`, one read by key, served at `GET /native-builds/:id` and mapped by `standaloneRepository`.
