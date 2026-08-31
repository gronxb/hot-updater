# MongoDB committed source plan

Status: **unimplemented architecture, pending final review**, 2026-09-01.
This document proposes the MongoDB source boundary required by the
[Insights scale plan](./insights-scale-plan.md). It is not evidence that MongoDB
reports, search, public query ports, or the complete provider matrix are ready.
The existing [event-page preparation](./insights-mongodb-preparation.md) prepares
a narrower reader; it does not implement this protocol.

## Decision and current implementation

Keep raw events unchanged. Store a separate, immutable ledger entry for each
event, and commit the raw event, its ledger entry, and its source counter in one
real MongoDB transaction. Reports and historical contains search consume a
captured vector of committed counter prefixes. Neither event timestamps nor a
largest observed ID establish that commit boundary.

The existing common `bundle_events` create branch in
`packages/server/src/adapters/mongodbWrites.ts` only validates and inserts the raw
row. Both direct `models.insights.append` and generic event commits reach that
branch. In `mongodb.ts`, enabling `transactions` currently adds a transaction
wrapper, but direct append still uses the implementation without a session.
Wrapping only generic commits would therefore leave an ingestion hole.

Use transaction-capable MongoDB, with explicit primary read preference, snapshot
transaction read concern, and majority transaction write concern. A standalone
`mongod` cannot implement this contract. The final required provider must fail
explicitly when transactions or preparation are unavailable; it must not fall
back to raw-only writes or an append/scan-only capability. MongoDB documents the
replica-set and sharded-cluster transaction requirement in its
[transaction guidance](https://www.mongodb.com/docs/manual/core/transactions/).

The repository's `standalone-mongodb` E2E profile is compatible with this choice:
`examples-server/hono-mongodb/docker-compose.yml` starts `mongod --replSet rs0`,
and `src/db.ts` enables transactions. Here, “standalone” names the application
profile, not the database topology. The E2E service currently runs only the core
DB migration before starting the server; it does not prepare this source.

## Existing data domain must remain explicit

There are three different limits in the current code:

| Layer | Current event-ID rule |
| --- | --- |
| Core CRUD row validation | A string, without a length or UUID restriction. |
| Shared event-page row/cursor helpers | A nonempty string of at most 1,024 UTF-16 code units. |
| Mongo native reader and event-page preparation | A canonical lowercase UUID of exactly 36 characters. |

The event-page cursor has an 8,192-character base budget, extended for an exact
installation scope; this does not remove its event-ID limit. The core Mongo
migrator does not install the native event preparation's validator. A legacy
core-valid event can consequently have a much larger public `id`, even though
the current Mongo write guard and native preparation reject it.

Do not treat that narrower validator as proof that every existing event has a
small ID. Source preparation must validate the persisted core row domain rather
than silently borrow the UUID restriction. It must not truncate, rewrite, omit,
or newly reject otherwise valid stored IDs to make the ledger fit. Empty stored
string IDs must not double as an absent-checkpoint sentinel. Strict BSON decoding
remains enabled; malformed stored data is an explicit preparation failure.

The native reader's ordering/cursor domain is a separate unresolved cutover gate.
This source design does not solve arbitrary event-ID ordering in public pages.
The existing preparation also stores two EJSON-encoded, heterogeneous raw `_id`
values in one state document. Those values have no small-ID proof: duplication
and EJSON expansion can exceed the document limit. Its current tests do not
certify near-limit legacy `_id` values. The proposed source checkpoint avoids
that representation entirely; the existing preparation still needs its own fix.

## Private storage

Create ordinary collections and indexes during explicit maintenance. No server
extension, change-stream history, oplog access, or custom collation is required.
Use simple collation for the source identity indexes.

| Collection | Records and required access path |
| --- | --- |
| `private_hot_updater_insights_source` | One small state record and exactly 16 clock records, addressed by fixed `_id` values. State binds a source UUID, raw/ledger collection identities, storage revision, preparation phase and checkpoint revision. |
| `private_hot_updater_insights_source_events` | `{ _id: eventId, sourceId, shard, seq }`; unique `_id` and unique ascending `{ sourceId: 1, shard: 1, seq: 1 }`. The public event ID appears only once. |
| `private_hot_updater_insights_source_bounds` | Separate `{ _id: "upper", g: sourceId, id: eventId }` and `{ _id: "after", g: sourceId, id: eventId }` documents. Presence/phase lives in the small state; no sentinel ID is needed. |
| `bundle_events` | Unmodified raw events, with an exact simple-collation unique `{ id: 1 }` index for identity lookup and the preparation traversal. |

Sixteen shards are a private storage-revision choice, not a public contract or a
throughput claim. Define one stable hash of the stored event ID to select a shard.
Counters and sequences are BSON signed 64-bit `Long` values; decode them without
promotion to JavaScript numbers. Increment only below `9223372036854775807`, so
MongoDB cannot promote an overflowing counter to an imprecise numeric type.

The source ID and counters are never reset during a retry. A collection
replacement, missing or incompatible index, invalid counter type, or changed
source identity makes capture/consumption fail before data traversal. Rebuilding
the source is separate, explicitly fenced maintenance; it must invalidate old
source references rather than silently reuse their generation.

## BSON storage and command budgets

Let `B = 16,777,216` and let `b` be the UTF-8 byte length of a stored event ID.
Using the installed driver's BSON size calculator, the following exact shapes
have these sizes:

| Shape | BSON bytes |
| --- | --- |
| Smallest core-valid raw event described below | `285 + b` |
| `{ _id: I, sourceId: G, shard: Int32(0), seq: Long(1) }` | `102 + b` |
| `{ _id: "upper", g: G, id: I }` or the `"after"` equivalent | `73 + b` |

Here `G` is a 36-character ASCII UUID. The raw example has `_id: null`,
`type: "UNCHANGED"`, `platform: "ios"`, and `received_at_ms: Int32(0)`. Its
`install_id`, `to_bundle_id`, `app_version`, `channel` and `cohort` are empty
strings; `user_id`, `username`, `from_release_id`, `from_bundle_id`,
`to_release_id`, `update_strategy`, `fingerprint_hash` and `sdk_version` are null.
Together with `id`, these are all 18 required public fields. A normal generated
ObjectId or nonminimal field values only increase the raw size.

Thus each proposed one-ID ledger or boundary document is smaller than any such
valid raw event containing that ID. Do not repeat the ID in another ledger field,
add source fields to raw events, put both boundaries in one document, or encode
them as JSON/EJSON strings. Those alternatives lose the storage bound. The
[MongoDB BSON limit](https://www.mongodb.com/docs/manual/reference/limits/#bson-document-size)
applies to each document independently.

Document fit is not a complete command-size proof. A range predicate containing
both `after` and `upper`, or an update containing the same huge ID in its filter
and replacement, can exceed the limit even with separate stored checkpoints.
Every proposed command therefore carries at most one large ID: fixed-key
replacement for boundary documents, `insertOne` for a ledger entry, and one-ID
filters for raw/ledger point reads. Do not batch large identities into `$in`,
`bulkWrite`, or a command array.

The public-field projection itself is 289 BSON bytes. A near-limit ID query also
needs namespace, session, transaction and read-concern metadata. MongoDB 7's
[BSON builder constants](https://raw.githubusercontent.com/mongodb/mongo/v7.0/src/mongo/bson/util/builder.h)
provide command/internal overhead beyond the 16 MiB stored-document limit, and
the installed Node driver's `OpMsgRequest` serializes the command without a
separate 16 MiB check. These observations support a one-ID command, but are not a
native end-to-end proof. Maximum accepted IDs must pass actual indexed find,
insert and checkpoint replacement with the final transaction metadata before
this design can claim preservation of the whole stored domain. Failure is a
design blocker, not permission to add a smaller event-ID limit.

## Atomic ingestion

The common event-create operation must join its caller's active session. If no
transaction exists, it opens one with the explicit concerns above. Inside it:

1. Verify source storage readiness for writes. Writes may proceed during a
   correctly installed backfill, but never during incomplete schema installation.
2. Validate the event and select its shard. Atomically increment that shard's
   guarded `Long` counter and obtain the new sequence.
3. Insert the unchanged raw event and its one-ID ledger entry in the same
   transaction. Return success only after the transaction commits.

An existing generic mixed commit retains one outer transaction. Do not nest a
transaction or split a multi-event commit to satisfy a maintenance batch size.
Duplicate identity, failed catalog work, counter overflow, or any later failure
rolls back the raw event, ledger and counter together. Every committed increment
has exactly one ledger entry; aborted increments leave no holes. Concurrent
updates to one counter must resolve through transaction conflict/retry semantics,
never a read-increment-write calculation in JavaScript.

Use bounded retry/deadline handling appropriate to transaction outcomes. An
unknown commit result is not proof of rollback and must not trigger a fresh,
unrelated append. Transaction retries can repeat database work; a logical
operation budget is not an unconditional wire-attempt bound.

## Existing-data preparation and bounded backfill

Before schema installation, drain old writers, wait for their in-flight writes
to finish, and prevent old processes from restarting. Keep raw events immutable
and exclude concurrent schema maintenance. A strict validator can enforce row
shape, but it cannot require a ledger in another collection. The operator's
writer-drain acknowledgement is therefore a deployment prerequisite, not a
database-enforced cross-collection fence. Do not claim otherwise.

Persist a nonready installation state first. Create source collections, strict
validators and exact indexes, preserving any existing raw validator as an
additional condition without repeated nesting. These DDL operations may inspect
the whole collection and are not bounded audit steps. Maintenance reads use
primary/local and writes use majority; raw `db.command` DDL must include its own
write concern because the driver does not inherit DB options for commands.

After DDL and while old writers are still drained, capture the largest public
`id` using the exact ID index, descending order, `limit: 1`, `singleBatch` and
`{ id: 1, _id: 0 }`. Do not add a type filter that would hide invalid legacy IDs;
validate the captured boundary as a string. Initialize the source state, clocks
and separate upper document transactionally. An empty collection has an explicit
empty state. Only then allow the upgraded atomic writer to resume. Capture
remains unavailable until the bounded backfill finishes.

Use the public string ID for this private traversal, not heterogeneous Mongo
`_id`. One backfill unit runs in a transaction and does the following:

1. Read small state plus the separate upper/after documents. Verify their source
   identity and the current checkpoint revision.
2. Find one next raw candidate through the simple ID index, sorted ascending,
   with only `{ id: { $gt: after } }`, or an empty filter before the first ID.
   Explicitly project public fields and exclude Mongo `_id`; use `limit: 1` and
   `singleBatch`. Do not put `upper` into this query.
3. Compare the returned ID to the saved upper using UTF-8 binary/simple-collation
   order, not JavaScript UTF-16 order. No candidate or a candidate above upper
   proves that the fixed old-data range is exhausted. The overshoot consumes one
   candidate from the step's budget and is never assigned as an old-data row.
4. Otherwise validate the entire public row. Point-read its ledger entry. An
   existing entry must belong to this source and have valid shard/sequence data;
   if absent, increment its clock and insert one ledger entry. Never increment
   for an already assigned event.
5. Replace the fixed-key `after` document and advance the small state's revision
   using compare-and-swap in the same transaction as the assignment. Processing
   the saved upper itself can finish the backfill without an additional probe.

This also handles a newly appended ID behind the checkpoint: the atomic writer
already assigned it. A new ID above the captured upper does not extend the old
range. Concurrent steps conflict on the checkpoint transaction; only one commits.
A failed attempt cannot advance the checkpoint without its ledger assignment.
Rows already assigned by new writers still count as examined candidates; never
scan repeatedly until a quota of previously unassigned rows is filled.

The smallest implementation processes one candidate per transaction. A bounded
runner may schedule more such units while debiting every candidate, control
operation and transaction operation. This intentionally favors a simple byte
bound over batching near-limit IDs. Schema scans and automatic network retries
must be reported separately from normal per-step logical work.

A backfill unit reads `upper`, `after`, one projected candidate and at most one
existing ledger record in separate commands. Its hard response reservation is
therefore four maximum-size documents plus measured control envelopes, even
though each command contains or returns at most one large ID. Release each value
as soon as its comparison or validation is complete. This bound is independent
of the source-consumption unit below; do not advertise the smaller reader budget
as the maintenance budget.

## Capture and causal consumption

Capture uses one short snapshot transaction to read ready state and all 16
clocks at the same snapshot. Address only their fixed IDs; never read the large
boundary documents as part of capture. Validate the complete clock set, source
identity and numeric types before creating a token. Take the session's server
operation time after successful completion; absence is an error.

The proposed opaque generation is canonical JSON:

```text
[1, sourceId, [sixteen canonical nonnegative decimal counter strings],
 [operationTimeSeconds, operationTimeIncrement]]
```

It is bounded below 1 KiB, contains no event IDs, and uses no JavaScript-number
conversion for counters. Validate exact shape, UUID, 16 counter bounds and both
unsigned 32-bit timestamp components before any query. Persist the generation
with the report/search job once; polling or continuing a job must not recapture
new clocks and change its source silently.

Each consuming worker transaction starts a fresh explicit
`startSession({ causalConsistency: true })`, advances that session's operation
time from the saved token, then starts a transaction with primary/snapshot and
majority commit concern. Do not use the distinct session option
`snapshot: true`, which conflicts with causal consistency. Do not force the
old capture time through `atClusterTime` or rely on a long-lived historical
snapshot.

This composition is supported by the installed Node driver's `sessions.ts`:
`applySession` adds the transaction read concern and saved `afterClusterTime` to
the first command, and `updateSessionFromResponse` advances operation time. The
[transaction specification](https://raw.githubusercontent.com/mongodb/specifications/master/source/transactions/transactions.md)
also explicitly permits snapshot read concern with that causal lower bound on
the first transaction command. The
[causal-consistency specification](https://specifications.readthedocs.io/en/latest/causal-consistency/causal-consistency/)
permits advancing operation time between sessions while the client gossips
cluster time. This has been checked against source, not exercised here against
replica lag or stepdown.

The timestamp only ensures a consuming snapshot is late enough to contain the
captured commits. The source identity and 16 sequence bounds determine membership.
A new transaction with an old event timestamp receives a later sequence and
cannot enter an earlier generation. Within one shard, transactional counter
updates prevent a later committed sequence from passing an uncommitted earlier
allocation.

## Source units and response-size handling

Read one ledger entry at a time through the exact source/shard/sequence index,
bounded by `afterSequence < seq <= capturedPrefix`, with ascending sequence,
`limit: 1` and `singleBatch`. Require the next sequence to equal the previous
sequence plus one. A missing entry below the prefix is corruption, not exhaustion.
Only `afterSequence === capturedPrefix` completes the shard.

Resolve that entry through one exact raw `{ id: eventId }` point read, hinting
the required unique simple-collation index and explicitly projecting the 18
public fields with `_id: 0`. Use `findOne`/`limit: 1` with `singleBatch`; the
installed driver's `findOne` enforces these options. Validate identity and row
shape. Missing or invalid raw data fails explicitly without advancing progress.
Never join or aggregate the whole raw collection, fetch an ID array, or issue a
hidden `getMore` to fill a requested count.

One unit transfers at most one ledger document and one projected raw document:
their BSON payload is bounded by `2 * B`, plus separately bounded response and
control metadata. Process and release that unit before the next; do not retain
an array of N potentially 16 MiB events. `singleBatch` also makes a server response
byte cap observable. A short batch must not imply that a multi-row requested
range is complete; the proposed one-entry sequence unit avoids that ambiguity.
The continuation is the last successfully processed sequence, never a guessed
offset or a timestamp bookmark.

For a hard response-byte budget, reserve the worst-case two-document unit plus
the measured command/control envelope **before** issuing it, and stop when the
remaining budget cannot hold another unit. A budget too small for one valid
unit must be rejected as a budget request, not used to reject a valid event or
repeatedly return a zero-progress page. Measure actual encoded responses in the
native tests; document payload bounds do not claim an equal process RSS or
disk-I/O bound. No smaller public-field truncation is allowed.

Apply `asOfMs`, windows and semantic filters only after consuming each source
entry. Filtering the ledger traversal by event timestamp could hide a sequence
and falsely finish a report. Derived writes, lease fencing and the source
checkpoint must commit in the same worker transaction. Reports/search still
need their own bounded storage, ordering, publication and cleanup implementations;
the source ledger alone does not provide those guarantees.

## Implementation order and required evidence

1. Implement source storage/readiness and explicit preparation in new
   `packages/server/src/db/mongoInsightsSource.ts`, exported only through `/db`.
   Resolve the existing raw-domain/native-preparation conflict first. Keep core
   migration readiness separate from source readiness.
2. Add the common atomic append/session path in `mongodb.ts`, `mongodbWrites.ts`
   and `mongodbCollections.ts`, with a focused internal source helper. Remove the
   optional raw-only final path. Test direct append and mixed commits separately.
3. Implement bounded backfill, capture and source consumption, then connect the
   shared projections to Mongo report/search jobs, immutable publications and
   required public ports. Do not expose a new optional capability as completion.
4. Add explicit preparation and a bounded maintenance runner to the Mongo example
   service. Update `e2e/detox/insights-http-client.ts` and the existing Insights QA
   flow for preparing/ready publications and cursor pages. Its current checks
   already require events observed during the current run; retain that evidence.
5. Run native replica-set tests before the sequential `standalone-*` E2E series.
   Required cases include more than 50,000 legacy events; concurrent writer and
   backfill overlap; duplicate/rollback and interrupted commit; a delayed commit
   with an older event timestamp; captured multi-shard consistency; Long boundary
   and overflow; corrupt/missing ledger rows; and immutable raw retention.

Byte-domain evidence must include near-limit valid public IDs and near-limit
heterogeneous raw `_id` values, escaped/NUL/non-ASCII strings, empty IDs, two large
successive boundaries, an above-upper concurrent append, and a large public
optional field. Capture actual commands and `executionStats`: bounded index
candidates, no collection scan/sort, one-ID command bodies, no `getMore`, actual
response bytes, and successful checkpoint continuation. Command overhead tests
must include the final session/transaction metadata and a single atomic commit
containing both the near-limit raw event and its ledger. Invalid legacy ID types
must fail preparation rather than disappear through a type-bracketed query.
Replica lag/failover needs a suitable topology; a single-member replica-set pass
must not be presented as that proof. No new MongoDB source runtime or native tests
were executed to author this plan; the size calculations and driver inspection
are design evidence only.
