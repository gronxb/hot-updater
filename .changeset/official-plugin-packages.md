---
"@hot-updater/plugin-insights": minor
"@hot-updater/plugin-api-keys": minor
"@hot-updater/server": patch
"@hot-updater/react-native": patch
---

Insights and API keys ship as their own packages: `@hot-updater/plugin-insights`, with `./server`, `./client`, and `./testing`, and `@hot-updater/plugin-api-keys`, with `./server`. `@hot-updater/server` and `@hot-updater/react-native` depend on them and re-export them from `@hot-updater/server/plugins/insights`, `@hot-updater/server/plugins/insights/testing`, `@hot-updater/server/plugins/api-keys`, and `@hot-updater/react-native/plugins/insights`, so servers and apps install nothing more and keep their imports.
