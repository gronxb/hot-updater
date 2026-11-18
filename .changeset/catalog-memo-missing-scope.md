---
"@hot-updater/server": patch
---

fix(server): an update check of a scope without a catalog reads the database once per 5 seconds, like a scope that has one.

- A store version before its first OTA release has no catalog, and the server read the database on every update check for it. Firebase, Azure and Supabase have no CDN in front, so every such check cost one database read. The server's 5-second per-scope memo now remembers the missing catalog too. Concurrent checks still share one read.
- A remembered miss never pushes a live catalog out of the memo. Past its 128 scopes, expired entries go first, then the oldest miss.
- A scope's first release shows within 5 seconds at the origin, and within 15 seconds behind a CDN, as a deploy to a scope that has a catalog already did.
