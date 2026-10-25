---
"@hot-updater/expo": patch
---

The Expo config plugin no longer leaves invalid Kotlin behind when it replaces an existing `getJSBundleFile()` override in `MainApplication.kt`. The override is now removed up to its matching closing brace, so a body with nested blocks such as `if`/`else` is removed whole instead of being cut at the first line that starts with `}`.
