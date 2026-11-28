---
"@hot-updater/react-native": patch
---

fix(react-native): a shared sandbox build opens a channel's latest bundle even when the bundle is older than the build.

Sandbox builds are shared across channels, so the installed build can be newer than a channel's last deploy. Opening that channel from the sandbox (a link, a QR code, or Enter a channel) used to run the build's own built-in bundle. On another channel it said "has no bundle for this build", even though the channel had a bundle for that native code.

The sandbox's channel open now picks the channel's latest bundle that matches this build's fingerprint, or its app version under the appVersion strategy, whatever its age. A channel with no such bundle, the build's own channel included, now says "<channel> has no bundle for this build." before anything is reset or downloaded. Reset still opens the built-in bundle.

Apps outside the sandbox, and the app's own update checks inside it, keep today's behavior: they never select a bundle older than the built-in one. If the app's own check replaces the selection while the sandbox downloads, the sandbox checks again once before it reports the failure.
