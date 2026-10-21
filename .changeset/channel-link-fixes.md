---
"@hot-updater/react-native": patch
---

Fix two channel link cases on preview builds.

- `hotUpdater.openChannelLink(url, { initial: true })` opens an app process's launch link once. React Native returns the launch URL from `Linking.getInitialURL()` again after an in-place reload, as iOS reloads after a switch, so a launch link no longer switches the app back after the tester opened another channel's link. Later calls resolve with `ALREADY_OPENED`. The SDK keeps the opened link in its existing native key-value store, so the fix ships in JavaScript and works on native builds of earlier 1.x versions.
- A device switched to a channel that holds nothing for its build any more, as after `hot-updater channel delete`, leaves the switch. The server answers the deleted channel's scope with an empty catalog; a check without `channel` then returns a forced rollback to the built-in bundle whose `updateBundle()` also clears the runtime channel, as `resetChannel()` does, so the next check reads the build's default channel. The JavaScript check uses the existing `resetChannel` native method; the native `HotUpdaterInstance` checks on iOS and Android follow the same rule after a native rebuild.
