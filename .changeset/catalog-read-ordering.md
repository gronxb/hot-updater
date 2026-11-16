---
"@hot-updater/plugin-core": minor
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
---

feat(server): primary, snapshot-consistent reads on MongoDB for multi-row catalog reads.

- `DatabaseAdapter` gains an optional `readSnapshot(read)`, which runs `read` with a `get` and `query` that all observe one committed state. Core will read a release catalog's head and its rows, list pages and patch-base unions through it; nothing calls it yet. An adapter that fails it rejects with `DatabaseSnapshotConflictError` (transient failures outlasted its retries) or `DatabaseSnapshotUnsupportedError` (the deployment has no snapshots). The schema fence, `verifyAdapter` and `meterReads` check and count the reads a snapshot makes.
- The MongoDB adapter reads on the primary, whatever read preference its client has. A client configured for secondary reads (`readPreference=secondaryPreferred` and the like) now reads Hot Updater's rows from the primary.
- The MongoDB adapter implements `readSnapshot` with a snapshot session: every read is one bounded `find` at the first reply's cluster time, never a `getMore`, and an election or a snapshot older than the server's history starts the whole read over, up to 3 times, before it fails closed. Nothing is checked up front: MongoDB before 5.0 serves every other call as before, and only a snapshot read is refused there.
- The Prisma and Drizzle adapters run every statement on the primary under a read-replica extension (`$primary()`) or `withReplicas` (`$primary`).
- The adapter contract page states how each built-in adapter meets the strong-read rule, and the conformance suite checks it, with a `snapshots: false` option for a deployment without snapshots.
