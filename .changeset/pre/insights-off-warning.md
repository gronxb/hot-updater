---
"@hot-updater/server": patch
---

Say when a server drops Insights events.

- **First dropped event:** a server without `insights()` still answers `POST /events` with 204 and `x-hot-updater-insights: disabled`, so apps need no change. It now logs one warning, on the first event it drops, naming `insights()` for the server and `insights: false` for apps that should stop reporting.
- **Upgrade error:** the `HotUpdaterConfigError` for a release candidate's `clientAccess` object also names `insights()`, which the release candidates ran by default.
