---
"@hot-updater/expo": patch
"@hot-updater/bare": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

Resolve Expo config and fingerprint dependencies from the target app with Node's package resolver. Remove Expo config file-path fallbacks, honor evaluated dynamic and platform-specific JavaScript engine settings, and preserve config and dependency errors.

Resolve React Native metadata through its package manifest and legacy Hermes binaries from the app's dependencies, including hoisted installations.
