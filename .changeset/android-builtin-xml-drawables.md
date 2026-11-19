---
"@hot-updater/react-native": patch
---

fix(android): the first OTA after a store install downloads XML drawables instead of reusing them from the APK. AAPT2 compiles XML under `res/` to binary XML, so the packaged file was copied into the bundle in place of its source, and anything reading that file (such as an XML vector icon loaded by its `file://` URI) got binary XML (#1984). Takes effect with the next native build.
