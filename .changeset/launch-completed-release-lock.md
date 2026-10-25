---
"@hot-updater/react-native": patch
---

Fix a race where first content and a Release selection committed at the same time, such as by the native check after a crash, could save over each other's metadata. A bundle verified by its first content stayed unverified, so the next launch could roll it back and reported its update as applied a second time. Every write of the update metadata on Android and iOS now runs under the lock Release selection uses.
