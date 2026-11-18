---
"@hot-updater/react-native": patch
---

**React Native.** A release whose download fails verification is no longer downloaded again on every launch. When a file or the manifest fails its hash or signature, or can't be decoded, update checks skip that bundle for 24 hours, so a bad release costs each device at most one download a day instead of one per launch. After a day the bundle may be selected again, because a proxy, a block page, or a body cut short can make good bytes fail. `getCrashHistory()` lists these bundles next to crashed ones while they're skipped (up to 10, never as crashes), `clearCrashHistory()` clears them, and installing another native build forgets them. Network, HTTP and local storage errors keep retrying as before. Released JavaScript benefits without an update, because it already skips what `getCrashHistory()` returns. Crash history is now written atomically, so an app killed mid-write keeps the previous history.
