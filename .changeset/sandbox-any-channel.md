---
"hot-updater": minor
"@hot-updater/protocol": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/android-helper": minor
"@hot-updater/apple-helper": minor
"@hot-updater/console": minor
"@hot-updater/test-utils": minor
---

Sandbox builds live on the project's channel. A sandbox build embeds the channel `channel set` writes, or `-c`, like any scheme's build, and registers on it, so in a pull request preview it is one more native build on `pr-<n>`. The `sandbox-<scheme>` channels are no longer reserved: a normal build can use a channel named `sandbox-*`, and nothing about a channel makes a build a sandbox build. The artifact's sandbox layer and the registry's `is_sandbox` do.

- Pull requests reuse a sandbox build across channels. Its registry scope names no channel: the app ID its artifact reports, its URL scheme, its artifact kind, and whether it installs directly (APK, simulator `.app`, ad hoc `.ipa`) or through a store (AAB, App Store `.ipa`). `native-build find --scheme <sandbox scheme>` finds it on any channel, and `--json`'s `sandbox` names the found build's `channel` in place of `otherBuilds`. A store build never hides an installable ad hoc build of the same native code, nor the reverse. An `.ipa` whose export no profile confirmed is never reused. Sandbox previews need the `fingerprint` update strategy to tell native changes apart.
- A sandbox registration needs `sandboxUrlScheme` and the new `sandboxAppId`. `GET /native-builds/latest` takes `sandboxAppId`, `sandboxUrlScheme`, `artifactKind` and `distribution`, all four or none, and `NativeBuildScope` takes `sandbox` for them.
- `native-build find --json` adds `iosDevices` for a found ad hoc `.ipa`: whether it still installs on the device registry's iPhones. The preview action builds again, with `--no-cache`, when an iPhone was approved or registered with Apple since the build, or its profile expired or can't be read, and notes the iPhones Apple hasn't enabled yet without building again.
- The preview action keeps sandbox builds when a pull request closes, merged or not: `channel delete --native-builds --keep-sandbox-builds` deletes the bundles and normal builds and keeps the sandbox builds and their channel, and succeeds with `reason: "sandbox_builds"` and `keptNativeBuildIds` when nothing else is left. Delete a kept build with `native-build delete` or `channel delete --native-builds`.
- `ios-install-url` is the Console build page for a direct-install `.ipa`, where "Install on iPhone" checks the device. `ios-download-url` keeps the `.ipa` itself.
- The comment names the pull request whose sandbox build a preview reuses, and the Console's "newer build" suggestion for an iPhone finds a sandbox build another pull request made.
- The release action refuses a sandbox scheme on any channel.
- `@hot-updater/protocol/native-artifact` drops `sandboxChannelOf` and `isSandboxChannel`, `sandboxArtifactProblem` takes no channel, and `httpRangeSource` moves there from the Console.

For a release candidate already in use:

- `android-fallback-scheme` and `ios-fallback-scheme` are removed. Remove them from your workflow: a pull request with new native code gets a new sandbox build.
- Deploy the server first, then the CLI of this release or later, the actions and the Console. An older CLI's sandbox registration is refused, since it sends no `sandboxAppId`, and its lookup misses the new builds.
- No migration runs. Sandbox builds already on `sandbox-*` channels stay where they are, and the first preview after the upgrade builds a new sandbox build once per platform. Delete the old ones with `npx hot-updater channel delete sandbox-<scheme> --native-builds` once you no longer need them.
