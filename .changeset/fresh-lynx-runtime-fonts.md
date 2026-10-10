---
"@hot-updater/lynx-sparkling": patch
---

Allocate a process-unique resource epoch for every new managed Lynx runtime
binding, including retained Activity rebinds and replacement hosts. This keeps
generation-qualified font sources from reusing another runtime's cached font
without invoking its verified resource provider.
