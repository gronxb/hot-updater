---
"hot-updater": patch
"@hot-updater/react-native": patch
"@hot-updater/bare": patch
"@hot-updater/expo": patch
"@hot-updater/rock": patch
"@hot-updater/repack": patch
---

Read deployed bundle IDs from native bundle manifests instead of injecting them
into JavaScript, and document that the Babel plugin is only needed for Expo DOM
`use dom` projects.
