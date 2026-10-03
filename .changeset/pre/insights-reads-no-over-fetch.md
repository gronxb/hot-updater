---
"@hot-updater/server": patch
---

The Insights HTTP reads no longer read more than they return. Event and installation pages read `limit` rows and return a cursor only for a full page, so the last call may return an empty page. The overview counts whole hours that end with the current one, so it reads only the maintained hour and day rows and never raw events.
