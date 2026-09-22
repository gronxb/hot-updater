---
"@hot-updater/firebase": patch
---

Use filtered Firestore queries and counts, finite-ID shards, and transactions that load only affected metadata. Continue pages with snapshot cursors, merge finite-ID shards with bounded lookahead, and project requested fields before transfer. Channel ID reads lock the existing uniqueness registry during transactions. Deploy the matching composite indexes before updating the runtime; these read fixes require no additional indexes or migration.
