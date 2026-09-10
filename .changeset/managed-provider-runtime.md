---
"@hot-updater/firebase": patch
"@hot-updater/aws": patch
"hot-updater": patch
---

Align Firebase Functions and its CLI with the Admin SDK used by generated servers. Firebase emulator checks now require Java 21.

Forward the original JSON request body through the Firebase Functions entrypoint so Insights events retain their payload and can be recorded.

Allow the managed AWS runtime to access release catalogs and release lookup records required by the current storage implementation.
