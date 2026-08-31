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

These are PostgreSQL building blocks. The exact helper still needs the required
public installation port. The existing event-page prototype is not the final
API and must be removed during the coordinated provider/HTTP/RPC/Console cutover.
Live enumeration of every installation, other-provider integration, bounded
retention and the complete scale/E2E matrix remain unfinished. These reads do not
resolve the separate full-ID ordering problem for live enumeration.
