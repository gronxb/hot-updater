---
"@hot-updater/server": patch
"@hot-updater/console": patch
---

fix(server): an update check reads its scope's catalog once per 5 seconds, whatever app version asks, and the Console's iOS devices page reads one page of the registry.

- The server's 5-second catalog memo was keyed by scope and app version, but the catalog row is per scope. Twenty app versions of one channel and platform read the same row twenty times. They now share one read and one parse of the row, and each check is projected for its own app version.
- The Console's iOS devices page read the whole registry, pending requests included, on every view and refocus. It now lists 50 devices a page, newest first, with Previous, Next and Newest, as the native build list does. An iPhone that registers still sees its approval when Safari comes back to the page.
- The release list, its folds and a native build's patch pages stay fresh for a minute, so switching back to the tab no longer reads them again. Changes made in the Console still refresh them at once.
