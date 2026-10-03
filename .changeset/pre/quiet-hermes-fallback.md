---
"@hot-updater/bare": patch
---

Restore the legacy Hermes binary path fallbacks after modern compiler and React Native bundled compiler detection. Check the local hermes-engine binary directly and retain the final hermesvm path without requiring package resolution.
