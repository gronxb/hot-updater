# Insights event storage PRD

## Status and delivery boundary

- Date: 2026-09-09
- Status: implemented; storage choices and measured limits are recorded in the decision document.
- Baseline: [#1289](https://github.com/gronxb/hot-updater/pull/1289),
  `ef1a071e83fc870038a591b7b83d91a6a738f96c`
- PR base: `codex/insights-download-pending`, not `next`.
- Target: the unreleased HotUpdater 1.0 schema and all supported Insights providers.

The requested direction is to remove the shared `bundle_installations` table,
keep events as the source of truth, evaluate derived state only for providers
that need it, and put ancillary event data in a typed `metadata` JSON field.
See the [storage decision, measurements, and RC replay procedure](./insights-event-storage-decision.md). This is an unreleased schema change.

## Problem and intended outcome

In the #1289 baseline, every accepted Insights event inserts into `bundle_events` and supplies
a complete replacement candidate for `bundle_installations`. Providers must
atomically maintain both, including duplicate handling, ordering, current-user
membership, and pending-download fields.

The installation row contains information derivable from an event. It makes
latest-state reads simpler, but imposes a table, indexes, write work, schema
changes, and conformance requirements on every provider. The baseline does not
include a comparison demonstrating that this is cheaper than event-based reads
for every supported database. Console historical graphs already read events
directly; the installation table does not accelerate that path.

The intended result is one canonical Insights event schema. A relational provider
can serve installation queries from events without maintaining a second table.
A provider with restrictive query capabilities can use a justified internal
projection without turning that projection into a universal schema requirement.
New diagnostic attributes should normally extend `metadata`, not add columns
across every provider.

Reducing custom-plugin implementation and maintenance burden is an explicit
product goal. Removing a shared SQL table must not force NoSQL authors to build
expensive aggregation, extra event fetches, or a bespoke synchronization system.
Their internal installation documents/items may resemble today's snapshot when
that is the simplest supported representation. This is a choice of physical
storage inside the provider, not a second shared domain model. Some NoSQL systems
also call their physical containers tables; container terminology is not a rule.

## Personas and adversarial design agreement

| Persona | Need | Objection to resolve | Acceptance condition |
| --- | --- | --- | --- |
| App developer operating Insights | Upgrade infrastructure and inspect adoption without new setup decisions | Removing a table must not remove search, require Redis, or introduce storage-mode configuration | Existing SDK requests, Console behavior, and provider setup remain supported |
| SQL plugin author | Implement Insights with native queries and the fewest maintained structures | Why maintain a second table and atomic dual writes when the DB can query events? | Event-only storage is a supported contract, with shared semantics, reference SQL, and conformance tests |
| NoSQL plugin author | Implement a supplied storage/query specification with native keys/documents | Why discard a simple installation document or require knowledge of core helpers and lifecycle rules? | A document/item is allowed; inputs contain fully prepared values and predicates; only native I/O and atomicity are implemented |
| Maintainer of all adapters | Keep lifecycle/metadata changes centralized | Provider freedom could multiply subtly different reducers, serializers, and cursor rules | Core prepares and validates data automatically at the boundary; one reusable conformance suite checks provider behavior |

The adversarial positions and the agreement are:

1. **Event-only position:** any duplicate state is unnecessary schema and write
   complexity. **Counterargument:** recomputing latest-user membership over event
   history can be harder to implement and more expensive on a document/KV store.
   **Agreement:** remove the universal table requirement, not every provider's
   ability to maintain a current-installation record.
2. **Uniform-storage position:** keep the same snapshot structure everywhere so
   provider implementations look alike. **Counterargument:** SQL authors then pay
   ongoing write and schema costs for a representation their engine may not need.
   **Agreement:** standardize observable query behavior and prepared input/output
   values, while allowing storage-specific representations.
3. **Minimal-interface position:** move all queries into core so authors implement
   only event append/list. **Counterargument:** fewer methods can hide global scans
   and increase operational cost. **Agreement:** keep explicit logical reads with
   fully specified predicates, and measure both authoring effort and I/O rather
   than counting methods alone.
4. **Minimal-projection position:** store only an event pointer and index keys.
   **Counterargument:** an extra read per result and more reconstruction code can
   burden NoSQL authors. **Agreement:** a small full snapshot or a pointer-based
   index is acceptable; choose using implementation effort and measured total
   read/write cost. The snapshot remains rebuildable and provider-owned.
5. **Helper-based reuse position:** ask authors to call shared derivation and
   validation helpers. **Counterargument:** selecting helpers, knowing when to call
   them, and understanding their domain rules is itself integration burden.
   **Agreement:** core invokes its own logic before/after adapter calls. The author
   receives a plain-data contract and implements it; helpers are not prerequisites.

These constraints are part of acceptance, not optional discussion notes. A
proposal that simplifies the shared schema by increasing every NoSQL author's
implementation burden fails this PRD even if the SQL implementation improves.

## Product requirements

Preserve the capabilities and labels delivered by #1289:

- Global event browsing, installation movement history, exact installation
  lookup, and current-user installation lookup with pagination.
- Server reporting-installation counts and raw bundle outcome counts.
- Console usage, distribution, and bundle activity over the existing windows.
- Active, Downloaded, and Recovered totals above chart-only tabs; the same
  terminology in Bundles, restrained colors, and concise recovery wording.
- Downloaded means downloaded and waiting to apply. It remains one state;
  do not reintroduce a separate Pending apply metric.

This work changes persistence and query responsibility. It does not introduce
SDK delivery queues, device heartbeats, new lifecycle events, a new analytics
service, or new UI explanations. The separate limitation of learning only what
devices report is not the justification for this storage change.

## Canonical event schema and metadata

Remove `bundle_installations` from the shared schema, generated SQL/ORM models,
`DatabaseModelMap`, and the required custom-provider storage contract. A provider
must not recreate the same mandatory table under another shared name.

Use the following classification for `bundle_events`:

| Placement | Fields | Reason |
| --- | --- | --- |
| Columns | `id`, `type`, `install_id`, `user_id`, `received_at_ms` | Event identity, latest-event ordering, installation and user lookup |
| Columns | `platform`, `channel`, `app_version` | Existing scope and distribution dimensions |
| Columns | `from_bundle_id`, `to_bundle_id`, `from_release_id`, `to_release_id` | Core transition identity, running/pending derivation, recovery and release attribution |
| `metadata` | `username`, `cohort`, `update_strategy`, `fingerprint_hash`, `sdk_version` | Display or execution metadata; not predicates in the current Insights database query contract |

Release IDs remain columns because their meaning is central to the lifecycle,
even though the baseline does not index all of them. `user_id` remains a column
because it is an identity lookup field; `username` remains display-only.
Only the copies of cohort/fingerprint/strategy in Insights events move: the
Release Catalog and update-selection schemas retain their existing fields.

Example storage value for a downloaded event:

```json
{
  "username": "Example user",
  "cohort": "example-cohort",
  "update_strategy": "appVersion",
  "fingerprint_hash": null,
  "sdk_version": "1.0.0-rc"
}
```

Rules:

1. `metadata` is a JSON object, with a shared exported type and runtime validator.
   Providers use the existing JSON serialization facilities used by Bundle
   metadata, including string-backed SQL representations where necessary.
2. Preserve today's validation: `cohort` remains required; nullable fields retain
   their null semantics; download/apply/recovery require a valid strategy;
   `UNCHANGED` requires a null strategy. Moving a field does not make it untyped
   or optional. Validate through the event-type discriminator.
3. Additive ancillary keys require no schema migration. Reuse the existing JSON
   value type and serialization conventions; do not introduce a separate metadata
   version field for this initial schema.
   Unknown JSON keys may be preserved but must not affect lifecycle or query
   behavior. Known keys retain validation. Reject invalid known-key values
   at ingestion rather than accepting events that cannot be interpreted.
4. Keep current request-size limits. JSON must not create an unbounded alternate
   payload path. Do not add a user-configurable metadata schema or arbitrary
   metadata filtering in this change.
5. Normalize the current SDK request fields into `metadata` on the server. This
   storage refactor must not require existing RC clients to change their HTTP
   payload or make another request. Preserve existing admin/Console response
   fields by mapping from metadata at the server boundary.
6. Do not dual-write the moved values into both columns and metadata. Future
   ancillary event data should enter metadata; a new column requires a documented
   query, index, constraint, or core identity requirement.

## Latest-state semantics

Define an installation's latest event as the maximum `(received_at_ms, id)` over
all its accepted events, including `UNCHANGED`. These are server receipt values;
this proposal does not replace them with device clocks or promise device-time
ordering. Keep exact case-sensitive IDs and the existing tie-break ordering.

Derive the read result with one shared core function:

| Latest event | Running bundle | Pending bundle/release |
| --- | --- | --- |
| `UPDATE_DOWNLOADED` | `from_bundle_id` | `to_bundle_id` / `to_release_id` |
| `UPDATE_APPLIED` | `to_bundle_id` | null / null |
| `RECOVERED` | `to_bundle_id` | null / null |
| `UNCHANGED` | `to_bundle_id` | null / null |

The read DTO may continue exposing `lastKnownBundleId`, `pendingBundleId`,
`pendingReleaseId`, and `latestStatus`. These are calculated response fields,
not a shared installation storage row. A download preserves running-bundle
distribution; recovery is attributed to its source bundle in outcome queries.

For current-user lookup, choose the latest event before applying `user_id`.
An installation that moved from user A to B must not match A. A latest null
user clears the association. Apply the same rule to platform, channel, and
running-bundle counts: a historical match must not resurrect old membership.

Latest-state queries keep the existing live-query semantics. Event history keeps
its fixed receipt cutoff and cursor. Do not turn the existing installation count
into an as-of-cutoff count incidentally, or claim cross-request snapshot isolation.
Historical graph folding and same-file release attribution remain distinct from
latest-event lookup; preserve their existing behavior and truncation indicator.

## Provider contract and query implementation

Retain logical read capabilities; remove the requirement to persist their result.
The implemented contract is:

- `record({ event })`: core supplies one canonical immutable event. SQL stores
  only that event; NoSQL may copy the same event into a private latest-event
  document. There is no separate state envelope, reducer, or helper to implement.
  Ordering comes directly from `(received_at_ms, id)`. The first event ID wins;
  duplicate IDs are complete no-ops, including any private index writes.
  This is storage idempotency, not HTTP-request deduplication.
- `listEvents(...)`: retain history filters and cursors. Add an all-event
  installation filter if the shared latest-event implementation needs one;
  `installationMovement` alone excludes `UNCHANGED` and is insufficient.
- Replace the storage-row return of `findInstallations` with a logical operation
  `findLatestEvents(...)` returning canonical event rows.
  Core creates the installation DTO. Preserve zero-or-one exact lookup and the
  current-user page ordered by installation ID.
- Replace the storage-row count with a latest-event count accepting explicit
  event-field predicates prepared by core. Core expands a running-bundle filter
  through `countLatestEvents(...)` into one OR of downloaded/from-bundle and
  other-type/to-bundle predicates. Count each latest event once; providers must
  not discover that rule. Select each installation's latest event before applying
  the supplied predicates. Remove the requirement to count installation storage
  rows and never read history. A provider may satisfy the same query using its
  prepared private index values.
- `countEvents(...)`: retain raw-event count semantics.

The input/output and ownership changes above are requirements. Reducing method count is not a success metric.
Do not replace these reads with an invisible global-history scan in core.
Core owns lifecycle interpretation, DTOs, window rules, and cursors. Providers
own query execution, physical indexes, and any justified private acceleration.

Core automatically performs event/metadata validation, state derivation, query
predicate preparation, and response mapping at the adapter boundary. It may reuse
internal helpers, but author-facing instructions must not require calling them,
choosing a reducer, or registering a synchronization pipeline. For example,
the running-bundle count receives explicit event-field predicates; the author
does not need to learn which event type uses `from_bundle_id` instead of
`to_bundle_id`.

The specification must provide exact plain input/output shapes, field predicates,
ordering, pagination, idempotency, and atomicity rules with concrete fixtures.
It must be possible to implement against that specification without reading
HotUpdater core source. A fixture-driven conformance command checks the result;
it must not require authors to reconstruct the business scenarios in their code.
HotUpdater maintainers own storage-strategy research, baseline implementations,
and the comparative benchmarks in this PRD. A third-party plugin author is not
required to conduct an architecture study or submit performance evidence to
implement the supplied contract.

Supply a minimal custom SQL example and a minimal custom NoSQL example with native
I/O only. The NoSQL example may persist the supplied event directly. Neither
example imports lifecycle/metadata helpers or defines Downloaded/Recovered rules.
Do not introduce a generic query language beyond the fixed predicates needed by
these operations, a new storage framework, or a per-provider background service.

### Relational baseline

Exact installation lookup uses all event types ordered by receipt tuple and
limited to one. Evaluate an `(install_id, received_at_ms, id)` index; the existing
index places `type` before the receipt tuple and does not directly serve this
query. Retain or adjust movement indexes based on query-plan evidence.

For current-user pages, evaluate a window function or equivalent anti-join:

```sql
WITH latest AS (
  SELECT e.*,
    ROW_NUMBER() OVER (
      PARTITION BY install_id ORDER BY received_at_ms DESC, id DESC
    ) AS position
  FROM bundle_events e
)
SELECT * FROM latest
WHERE position = 1 AND user_id = :user_id AND install_id > :after_install_id
ORDER BY install_id
LIMIT :limit;
```

This is a semantic example, not a promised optimal query or portable SQL string.
The first page omits the cursor predicate. Apply each engine's existing exact-ID
collation rules. Never prefilter by historical user/bundle/scope before selecting
latest rows. Query planners, examined rows, and pagination costs must be measured.

### Storage-specific decision record

| Provider family | First implementation to evaluate | When derived state is eligible |
| --- | --- | --- |
| PostgreSQL/Supabase, MySQL, SQLite/D1 through supported adapters | Event queries and native indexes; ordinary non-materialized views where useful | Only after measured query limitations; not by default |
| MongoDB | Event aggregation for latest-per-install and indexed exact lookup | If measured grouping/page costs justify it |
| DynamoDB | Indexed exact-event lookup; evaluate current-user and count access paths | If those access paths otherwise require excessive scans or fan-out |
| Firestore | Indexed exact-event lookup; evaluate current-user and count access paths | If latest-per-install grouping cannot meet the measured read requirements |
| Mock/in-memory | Event-derived reference implementation | No production projection needed |

Do not expand the existing unsupported SQL Server Insights surface. Cover both
packaged providers and supported Drizzle/Kysely/Prisma adapter dialects in the
decision record; SQL syntax similarity is not proof of behavioral equivalence.

Any retained projection must be private to its provider, contain fields justified
by its access paths, and identify the canonical event that produced it. A snapshot
similar to the baseline installation row is explicitly allowed for NoSQL. Do not
require pointer-only storage if it adds reads or implementation complexity. It
may copy the core-prepared metadata needed to serve a response, using native JSON
storage rather than expanding it into separately maintained columns. No core
serializer import is required in the plugin implementation.
Its mapping must be deterministic and rebuildable from retained events.

For this change, private persistent projections must update in the same native
atomic operation as event acceptance. Preserve duplicate, tie-break, out-of-order
write, and current-user index behavior. No new asynchronous projection worker or
eventually-consistent-only success path is introduced. Existing secondary-index
lag remains documented; validate stale candidates against canonical data.

For bundled providers choosing a projection, maintainers must ship a tested
rebuild/repair path, including how it excludes concurrent writes during rebuild
or catches them up before use.
It must never return an incomplete rebuild as a complete query result. Core owns
preparing replay inputs and verification; authors must not implement another
reducer or a bespoke repair service. A fresh-target replay using the same record
contract is an acceptable baseline; the operator procedure must account for other
stored application data before a cutover. Replaying duplicate events into the
existing store is not a repair strategy, because duplicate records are no-ops.
No extra public repair method, Redis service, or application-facing storage-mode
option is required by this PRD.

## Measurements and decision gates

Compare against #1289 using the same data and query results. Publish a separate
decision for each bundled provider family, including any local-emulator
limitations. Do not call an emulator measurement a production latency or billing
result.

Use deterministic datasets with 1,000 and 10,000 installations, each with 10 and
100 events, to separate installation cardinality from history depth. Include
anonymous installs, user switches, multiple installs per user, scope changes,
superseded downloads, recovery, and skewed event history on a few installs.
Exercise a larger dataset if the results have not exposed the scaling boundary.

Measure local append work, exact lookup, first and later user pages, and global/
bundle installation counts against baseline results. Publish p50/p95, native
query plans, total storage size, and private-copy read/write paths. State unavailable
metrics explicitly: local SQLite/emulator evidence must not become a claim about
production billed units, mixed-load throughput, or another SQL engine's latency.
Discuss low/high dashboard-read frequency using the measured count cost. Native
provider integration supplies correctness and query-capability evidence; a full
cloud benchmark deployment is outside this implementation.

For plugin-author effort, record the before/after required storage structures and
indexes, native query/transaction implementations, required helper calls,
provider-owned lifecycle branches, setup steps, and reusable versus custom tests.
Required lifecycle/metadata helper calls and provider-owned lifecycle branches
must both be zero. Lines changed can support the comparison but cannot replace it.
SQL authors must lose the mandatory snapshot
and dual-write implementation. NoSQL authors must be able to reuse a simple native
snapshot without acquiring new domain logic or a bespoke repair service. Any new
adapter-specific obligation needs an explicit justification in the decision record.

The primary acceptance goal is simpler shared storage and plugin implementation,
not a universal speedup. Event-only SQL may increase latest-state read costs; publish
that regression and its scaling boundary. No product latency budget was supplied,
so do not invent a passing SLO after measuring. A deployment with high dashboard
read frequency can use a private projection under the same contract.

Before retaining a bundled NoSQL projection, document the native query limitation,
bounded event-versus-latest cardinality comparison, private write cost, and authoring
burden. Native capability limitations can justify a simple copy without building a
production scan workaround first. Record unmeasured production latency/billing as
limitations, not pending claims of improvement.

## RC schema and upgrade handling

Keep one existing `1.0.0` initialization migration per provider. Update it and
generated schemas to remove the shared installation table and add event metadata;
do not append another RC migration or increment the schema version. Provider-local
indexes or projections belong only in that provider's initialization artifacts.

Existing initialized RC databases are not automatically transformed by rerunning
initialization. The implementation must document and verify an explicit RC
cutover: back up/export events, normalize old columns into metadata in replacement
storage initialized with the revised schema, preserve event IDs/receipt times,
rebuild any private projection, compare results, then switch the server. Do not
drop the original event store before verification. This implementation PR does not perform a production cutover.

Regenerate scaffolds and ORM artifacts, update the existing unreleased 1.0.0
infrastructure guidance and provider setup docs, and describe the custom-provider
contract change. Preserve released upgrade history. Missing historical download
telemetry cannot be backfilled from an installation snapshot.

## Implementation sequence and acceptance

1. Add the event-only reference queries and provider measurements. Verify latest
   selection, current-user ownership, counts, and pagination against baseline
   results before choosing provider optimizations.
2. Introduce typed metadata and ingestion/response normalization. Update schema
   generation and all supported serializers. Verify old RC request compatibility,
   JSON round trips, required keys, nulls, strategy validation, and preservation of ancillary keys.
3. Change the storage contract and remove shared installation persistence. Apply
   the measured provider-specific implementations and test their rebuild paths.
4. Update Console/server consumers and published provider/setup documentation.
   Confirm the #1289 screenshots and lifecycle behavior remain representative.
5. Run build, type checks, lint, unit/Console tests, and native provider integration
   tests. Add release changesets for the implementation's affected packages.

Required regression scenarios:

- Download B while running A; supersede with C; apply C; recover from C to A.
  Verify running and pending identities and every raw-event outcome count.
- A later `UNCHANGED` participates in latest lookup and clears pending state
  according to the baseline contract; movement history still excludes it.
- User A becomes B, then anonymous; channel/platform scope changes. Old filters
  must not return a previous matching event as the latest installation.
- Duplicate prepared events, equal-time ID ties, reversed database write order,
  and injected partial-write failure with and without a private projection.
- Exact case-sensitive IDs, multiple pages, stale secondary-index candidates,
  and native continuation pages; no silent result cap for an exact count/page.
- Built-in bundles with null release IDs and same-file release attribution in
  historical charts; Downloaded continues to leave running distribution intact.
- Delete/corrupt a disposable private projection, rebuild from events, and verify
  equivalent query results under the documented rebuild concurrency protocol.
- Fresh initialization has no shared `bundle_installations` table. The RC export
  and normalization exercise preserves event identities, counts, and API results.

Completion requires the shared table and storage row to be absent, moved fields
to exist only in metadata, every previously supported provider to retain its
features, provider comparisons to justify any private projection, the bundled SQL/NoSQL
reference implementations behind the author examples to pass shared conformance, and the authoring
burden criteria above to be satisfied. All required validation must pass.
Existing historical chart limits are not broadened as part of this refactor, and
must not be copied into latest-state query results.

## Evidence and limits of the comparison

- Better Auth queries its `session` table by user for normal database storage,
  but maintains a separate `active-sessions-{userId}` index for secondary storage:
  [implementation](https://github.com/better-auth/better-auth/blob/163e9f9740bb25c9d107aa49c6c1b3b970fdf916/packages/better-auth/src/db/internal-adapter.ts#L329-L395).
- Maintaining that index required revoked-session cleanup in merged
  [PR #3820](https://github.com/better-auth/better-auth/pull/3820). Concurrent index
  updates are the subject of [issue #11022](https://github.com/better-auth/better-auth/issues/11022),
  open when reviewed on 2026-09-09; it is not evidence of a completed fix.
- Better Auth also reduced query round trips using existing-table joins in merged
  [PR #6004](https://github.com/better-auth/better-auth/pull/6004).
- Drydock rebuilds Better Auth's active-session index from D1 when read:
  [implementation](https://github.com/JoviDeCroock/drydock/blob/0e6213e702d258516141cef1296273619311385b/server/lib/auth/index.ts#L138-L183).
  It still maintains an index; this is not a complete index-removal case.

These examples show alternative placements of query and maintenance work. They
do not prove our latest-per-install event queries are cheap: those queries do
more work than filtering an existing session table. Provider measurements,
rather than the analogy, decide whether private derived state is justified.
