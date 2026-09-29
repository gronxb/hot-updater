---
"@hot-updater/console": patch
---

The console's Insights on/off check for a self-hosted server asks for one event of the last hour, so it reads at most two days instead of walking up to 90 empty ones.
