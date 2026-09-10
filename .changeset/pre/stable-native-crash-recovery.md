---
"@hot-updater/react-native": patch
---

Drain queued iOS surface starts before recovery and prevent failed runtimes from
starting surfaces or reporting readiness. Preserve fatal error handling when
recovery cannot proceed and prevent delayed content events from verifying a
crashing bundle. Serialize Android recovery decisions, publish complete crash
markers before restarting, and preserve exception hooks in minified builds.
