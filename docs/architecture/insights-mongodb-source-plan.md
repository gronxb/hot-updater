# MongoDB committed Insights source

Status: **internal source boundary implemented; public MongoDB reports, search,
and provider wiring remain pending**, 2026-09-01.

This design gives MongoDB Insights a durable committed-event prefix without
changing public `bundle_events` rows. It is deliberately narrower than a complete
MongoDB Insights provider. The Console and public server contracts do not expose
these tools yet.

## Admission and deployment requirements

The pre-release MongoDB contract is strict:

- every public event `id` is a lowercase canonical 36-character UUID;
- every raw MongoDB `_id` is an `ObjectId`;
- `received_at_ms` is a finite, nonnegative safe integer and all indexed public
  identity fields are scalar valid `BundleEventRow` values;
- the deployment is a replica set or sharded cluster with transaction support;
- WiredTiger cache is sized for the largest accepted event transaction; the
  exact 16-MiB fixture is certified with a 0.5-GiB cache, while MongoDB 7 with
  the artificial 0.25-GiB test minimum rejects it with
  `TransactionTooLargeForCache`;
- `mongoAdapter` requires `transactions: true` and has no raw-only fallback.

Existing rows that violate the UUID or `ObjectId` rules make preparation fail.
Preparation never rewrites, truncates, or deletes raw data and has no legacy
compatibility parser. This is an intentional pre-release cutover, not a claim
that older arbitrary IDs are supported.

The operator must drain old writers before `prepare({ writersDrained: true })`,
keep raw rows immutable, and exclude concurrent schema maintenance until the
fixed old-data range has been audited. The upgraded writer may resume only after
source state and all 16 clocks have been installed transactionally. Ordinary
operation requires permission to create collections and indexes, run `collMod`,
and use multi-document transactions.

## Private storage

Three small sidecar collections use strict validators and simple collation:

| Collection                                   | Stored data                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `private_hot_updater_insights_source`        | One state document binding source UUID, raw/private collection UUIDs, fixed upper public event ID, checkpoint, phase and revision. |
| `private_hot_updater_insights_source_clocks` | Exactly 16 `{ sourceId, shard, value: Long }` counters.                                                                            |
| `private_hot_updater_insights_source_events` | One `{ _id: eventId, sourceId, shard, sequence: Long, rawId: ObjectId }` ledger row per raw event.                                 |

The ledger has a unique simple-collation
`{ sourceId: 1, shard: 1, sequence: 1 }` index. Counters increment only below
signed `Long.MAX_VALUE`; operations decode counters and sequences with
`promoteLongs: false` so JavaScript number promotion cannot lose precision.
Collection UUIDs, validators, validation modes, collation, and index metadata are
checked before readiness or source reads. A missing, replaced, hidden, sparse,
partial, or otherwise incompatible object fails closed; there is no scan
fallback.

Canonical UUIDs keep every sidecar small even when an optional public field makes
a raw event exactly 16 MiB. No source fields are added to the raw document, and
public reads project only `databaseFields.bundle_events`.

## Atomic writes

Direct event append opens one transaction. A mixed database commit reuses its
existing transaction. Both paths use primary read preference, snapshot read
concern, and majority write concern. In that transaction the writer:

1. checks installed source state;
2. inserts the unchanged public event with a generated `ObjectId`;
3. increments its stable SHA-256-selected shard clock with a guarded `$inc`;
4. inserts the one-ID ledger row pointing to the raw `ObjectId`.

A duplicate, missing clock, counter overflow, or any later mixed mutation aborts
all raw, clock, and ledger changes. Standalone `mongod` rejects the transaction;
the adapter does not retry as a nontransactional append.

## Explicit preparation and bounded backfill

Preparation first installs and audits the native event-page validator and
indexes. It then installs the source sidecars, captures the highest canonical
public event ID through the exact ID index, and creates source state plus 16 zero
clocks in one transaction.

`runStep` accepts `maxItems` from 2 through 200 and `maxRequests` from 13 through
1,000. Event-page audit work stays in its own bounded stage. A source step:

1. performs six readiness metadata operations;
2. transactionally reads source state, at most `min(maxItems,
floor((maxRequests - 10) / 3))` raw candidates, and the 16 clocks;
3. for each candidate, point-reads its ledger and, when absent, increments one
   clock and inserts one ledger row;
4. compare-and-swap advances the checkpoint in the same transaction.

The raw candidate query uses the exact public ID index, explicit public-field
projection, `limit`, `batchSize`, and `singleBatch`. It does not traverse offsets,
automatically refill a short first batch, or aggregate whole history. The
reported request count is the number of logical database operations, excluding
the transaction commit command and driver network/failover retries.

The fixed upper ID and checkpoint are bounded UUIDs. Newly committed guarded
writers already have ledger rows, so an ID behind the checkpoint is safe to
observe as existing. A collision with another source, a wrong raw pointer, a
missing fixed-range row, or any invalid raw row aborts the step and leaves the
checkpoint unchanged.

## Capture and byte-bounded replay

`capture()` reads the ready state and all 16 `Long` counters in one snapshot
transaction. The immutable generation contains the source UUID, decimal counter
vector, and the transaction operation time. It never uses event timestamps as a
commit boundary.

`readPage()` binds one shard to that captured counter and runs in a causally
consistent session advanced to the captured operation time. The first
transactional read carries snapshot read concern with `afterClusterTime`.
Ledger traversal uses the unique source-sequence index, `limit <= 100`, matching
`batchSize`, and `singleBatch`.

Raw documents are fetched by `_id_` point lookup with an explicit public-field
projection. Returned public-event BSON is capped at 16 MiB per page while always
allowing one valid maximum-size raw event. Once a later event would exceed the
budget, replay stops and returns a continuation at the last emitted ledger
sequence. It physically reads at most one raw row that is not emitted. It never
issues a normal hidden `getMore` or drains later batches.

## Verification and remaining gates

The focused MongoDB 7 evidence is recorded in
[`insights-scale-evidence/mongodb-source-ledger.json`](./insights-scale-evidence/mongodb-source-ledger.json).
It covers atomic direct/mixed commits, rollback, standalone rejection, canonical
existing-data gates, a 50,001-row backfill, exact logical request accounting,
source-index execution stats, causal prefix visibility, collision failure, and a
16-MiB raw event with zero `getMore` commands.

The test topology is a single-member replica set. It proves real transaction and
causal command behavior but does not simulate replica lag, election stepdown, or
an unknown commit result. Cache sizing is therefore an explicit deployment
requirement rather than a new raw-field limit. Those deployment exercises, the explicit startup
preparation flow for the `standalone-mongodb` profile, report/search materializer
integration, cleanup ownership, and final public provider wiring remain required
before MongoDB can be advertised as a complete scaled Insights provider.
