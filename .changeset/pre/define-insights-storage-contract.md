---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/console": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": patch
"@hot-updater/mock": minor
"@hot-updater/test-utils": minor
---

Define the required Insights persistence contract as `record`, `listEvents`,
object-based `findInstallations`, `countInstallations`, and `countEvents`. Core
owns report preparation, filters, windows, cursors, and summaries; providers
implement atomic report/latest-state storage, fixed indexed queries, and scalar
counts. Duplicate event IDs are first-write-wins and never update installation
state again.

Add scoped recent-reporting counts and selected-bundle applied, recovered-from,
and adopted report counts with matching event drill-down in Console. Recovery
from B to A belongs to B's recovery count while latest state names A. Counts
remain independent live measurements and do not claim an exact share or success
rate.

Include all Insights indexes and native writers in the initial `1.0.0` schema.
MongoDB Insights requires native transactions on a replica set or sharded
cluster. Regenerate standalone ORM schemas and apply emitted Prisma collation
SQL where required.

Prisma SQL Server Insights explicitly rejects before database I/O because its
string identity/order semantics do not meet this contract; other models remain
available. MongoDB counts require version 5+ snapshot reads.
