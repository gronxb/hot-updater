---
"@hot-updater/react-native": patch
---

Android: on the New Architecture, an update applied with `setReloadBehavior("reload")` now completes its launch when its first screen appears. Before, the next cold start rolled the working update back as an unfinished launch, for force updates and for rollbacks alike.
