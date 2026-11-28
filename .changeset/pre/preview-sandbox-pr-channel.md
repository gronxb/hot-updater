---
"hot-updater": minor
"@hot-updater/android-helper": minor
"@hot-updater/apple-helper": minor
---

`hot-updater native-build ios|android -c, --channel <channel>` sets the channel a build embeds, with any build adapter, and writes no project file. On Android it replaces `com.hotupdater.CHANNEL` in the variant's merged manifest; on iOS, `HOT_UPDATER_CHANNEL` in the built app's `Info.plist`. Without it, a build embeds what `channel set` wrote, or in an Expo project the `@hot-updater/expo` config plugin's `channel`, as before. A build that doesn't embed the channel it was asked for, or whose channel can't be read, fails before it is tracked or submitted, a Debug build too. An iOS scheme that archives without exporting refuses `--channel`, since only an export signs the stamped app again: set `exportOptionsPlist` or `signing.ascApiKey` on it. A stamped build never shares a native build cache slot with an unstamped one.

The preview action builds every native build with `--channel` set to the pull request's channel, so an Expo project's previews, sandbox builds too, embed `pr-<n>` with nothing set in the app's config, where a new sandbox build used to register on the config plugin's `production`. The action fails a new build that embeds another channel before it deploys, and still reuses a sandbox build another pull request made. It needs the CLI of the same release.

The release action builds with `--channel` set to its `channel` input, in place of `channel set` and a refusal when the project embeds another channel, so an Expo project releases on that channel too.
