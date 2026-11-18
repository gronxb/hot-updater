---
"@hot-updater/react-native": patch
---

**React Native.** A release whose download fails verification is no longer downloaded again on every launch. When a file or the manifest arrives whole but fails its hash or signature, or can't be decoded, the device remembers that bundle and every update check skips it. Before, each launch selected the release and downloaded the same bad file again until it was rolled back. `getCrashHistory()` now lists these bundles next to crashed ones (up to 10, never as crashes), `clearCrashHistory()` clears them, and installing another native build forgets them. Network, HTTP and local storage errors keep retrying as before. Released JavaScript benefits without an update, because it already skips what `getCrashHistory()` returns.
