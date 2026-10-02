---
"@hot-updater/plugin-insights": minor
"@hot-updater/plugin-api-keys": minor
"@hot-updater/server": patch
"@hot-updater/react-native": patch
---

Insights and API keys ship as their own packages: `@hot-updater/plugin-insights`, with `./server` and `./client`, and `@hot-updater/plugin-api-keys`, with `./server`. `@hot-updater/server` and `@hot-updater/react-native` depend on them: the server re-exports them from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`, and the app SDK exports the Insights client from its root, so servers and apps install nothing more.
