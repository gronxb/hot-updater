# PostgreSQL installation reads

Installation detail needs two different reads: the latest state across all event
types, and movement history containing only `UPDATE_APPLIED` and `RECOVERED`.
An activity-only installation must still have latest metadata even when its
movement history is empty.

## Exact current state

The internal `createPostgresInsightsInstallationLookup().pageInstallation()`
reads one latest `(received_at_ms, id)` tuple through the existing
`bundle_events_install_idx(install_id, received_at_ms, id)`. It does not require
report storage, a source backfill or a latest-state projection. It never gathers
raw history to choose that row.

One metadata query checks the physical index and samples `observedAtMs` from the
database clock. One bounded data query reads the latest row strictly before that
cutoff, retaining the old search behavior for future-dated events. The result is
live, not a committed snapshot: a late commit may become visible on the next
lookup. The page has zero or one row and no successor, exact total or publication.
Any supplied cursor or fields from another query mode fail before storage access.

Scalar equality alone let PostgreSQL discard the installation key from ordering
and choose the global time index. A natural statistics-lag fixture reproduced
50,003 unrelated rows filtered to return one installation. The query now uses a
singleton `ANY(ARRAY[...])` predicate and orders by all three installation-index
keys. This preserves exact matching while retaining the leading key in the
required native order. The regression retains the global index and checks both
custom and prepared generic plans; it does not force scan-method settings.

Exact installation IDs retain their original value, including empty strings,
case, whitespace and Unicode normalization forms. PostgreSQL cannot store NUL or
unpaired surrogate text; such queries return no match without letting the driver
replace them with U+FFFD. Full event validation precedes projection onto the
eleven installation-result fields, so private/source fields cannot leak out.

The guard requires the actual three-column B-tree key, native UUID event IDs,
non-null timestamps and deterministic text equality. The index collation must
match the installation column. It does not force `COLLATE C` onto a differently
collated index, which could prevent a native seek. A missing or incompatible
index fails explicitly before the data query, including on a warm provider.

## Live all-installation pages

The PostgreSQL-internal `createPostgresInsightsLivePages().pageAll()` reads an
upgraded-writer projection with one row per installation. Its binary key is
`SHA-256(JSON.stringify(installId))`; the table retains the complete installation
ID and latest event so every read can detect a digest collision or corrupt row.
Latest means the greatest `(received_at_ms, id)` tuple. No raw event history is
read to choose or page these rows.

Pages seek the 32-byte primary key and read at most `limit + 1`, with `limit` in
1–100. The cursor binds the layout/order revision and last emitted digest. There
is no OFFSET, refill loop or total. `observedAtMs` comes from the database clock
at the read and describes a live observation; it is not a row timestamp cutoff
or a cross-page snapshot. Future-dated latest rows are therefore included. This
differs intentionally from the exact point lookup's strict cutoff semantics.

One catalog query verifies the projection and state primary keys, exact column
types, raw marker and fence. A second indexed state read checks readiness and
samples the clock. The data query returns at most 101 rows. Missing or malformed
storage fails before a projection or raw-data read. Stored event JSON and public
page rows are validated independently; source/live marker columns are never
copied into the stored event or returned result.

Direct appends allocate the committed source sequence, insert the raw event and
upsert the latest installation in one SQL statement. Mixed catalog/event commits
reuse that statement inside their existing transaction. Duplicate raw IDs and
digest/full-identity mismatches roll back the counter, raw row, latest row and
other mixed changes together.

### Explicit live cutover

Complete the committed-source migration and backfill first. During a maintenance
window, drain writers and run `migratePostgresInsightsLive(db)`. It adds the
nullable raw marker, projection/state tables and this explicit old-writer fence:

```sql
check (insights_live_version is not null and insights_live_version = 1) not valid
```

The explicit null check matters because PostgreSQL otherwise treats a null CHECK
result as satisfied. Deploy the upgraded writer with this schema; older binaries
that omit the marker fail immediately. Then call
`createPostgresInsightsLiveTools(db).backfillStep(200)` until ready. The first
step captures a fixed raw UUID upper bound. Each later transaction reads at most
200 primary-key rows, upserts at most 200 distinct latest rows, verifies their
full identities, marks legacy rows and advances the checkpoint atomically. New
writer rows already carry the marker and projection, including IDs behind the
checkpoint, so ingestion may continue while this live backfill runs.

This is still an internal PostgreSQL slice. It does not add a public optional
capability or retain the old offset route. The coordinated required-port and
Console cutover remains separate, as do other providers' installation layouts.

## Movement history

Movement history uses two partial indexes, one for each event type. Each retains
the existing `(install_id, received_at_ms, id)` key shape. Adding `type` as another
indexed key would widen entries and could reject a long ID that already fits the
old index; the partial predicates avoid that new storage restriction.

The native stream executor emits only the two fixed event-type SQL literals.
Ordinary and prepared generic plans can therefore prove the relevant partial
predicate. Caller IDs and time/cursor values remain bound parameters. Shared
paging merges the two streams, reads at most `limit + 1` candidates per stream
across tie and older-time ranges, and advances from the last emitted event.
There is no OFFSET traversal, activity-event filtering after a broad read, or
automatic refill after a provider-owned short page.

Readiness verifies both named indexes, their complete key shape and exact partial
predicates. Installation and type equality must use deterministic column
collations; index collation must match the installation column. Movement index
readiness does not depend on report/source preparation and does not disable the
existing global or bundle pages.

The scope accepts complete stored installation IDs. Its cursor still binds the
exact scope, but its input/output size allowance includes that scope's outer JSON
escaping plus a fixed 8,192-character metadata allowance. A large cursor for a
small requested ID is still rejected. All/bundle cursor limits are unchanged.
The shared encoder/decoder, server validation and route parser use the same
bound. Empty user search mapping to "all" does not change an explicit empty
installation ID into a different scope.

## Explicit index preparation

```ts
import {
  getPostgresInsightsInstallationEventsMigrationSQL,
  migratePostgresInsightsInstallationEvents,
} from "@hot-updater/postgres/db";

// Review the two statements before deployment if needed.
const sql = await getPostgresInsightsInstallationEventsMigrationSQL();

// Pass a root Kysely connection, not an existing transaction.
await migratePostgresInsightsInstallationEvents(db);
```

The tooling pins one connection and tries a session advisory lock. A competing
preparation fails immediately as busy; it does not block with an old SQL snapshot
that concurrent index construction might need to drain. It creates both partial
indexes concurrently, outside a transaction. It does not rewrite or delete raw events, create report jobs, or
perform a raw backfill. Building an index still requires database work over the
existing table; this is an explicit deployment operation, never a page side effect.

Repeating preparation validates an already complete layout. An interrupted or
incompatible partial layout fails explicitly instead of silently replacing
indexes. Inspect the two owned index names and deliberately remove/repair the
incomplete layout before rerunning preparation. No manual schema changes may race
active reads or other schema tooling.

These are PostgreSQL building blocks. The exact and live helpers still need the
required public installation port. The existing event-page prototype is not the
final API and must be removed during the coordinated provider/HTTP/RPC/Console
cutover. Other-provider integration, bounded retention and the complete scale/E2E
matrix remain unfinished.
