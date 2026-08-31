# MongoDB event-page preparation

MongoDB native event pages require an explicit historical-data audit and guarded
writes. This tooling prepares that reader only. It does not create a committed
report source or wire the required public Insights query ports.

## Deployment and safety

Drain existing writers before calling `prepare`. Keep existing raw events
immutable and exclude other schema maintenance throughout preparation and every
audit step. The acknowledgement is an operator prerequisite, not a distributed
writer lock. Preparation installs strict database validation and the required
simple-collation indexes, retaining any existing validator as an additional
condition. Replacing incompatible owned indexes is explicit schema work and may
be expensive; it is not part of the bounded audit or a startup side effect.

Maintenance uses a separate DB handle with primary/local reads and acknowledged
majority writes; it does not change the caller's client settings. The `collMod`
command carries its own explicit majority write concern because the driver does
not inherit DB options for raw commands. Preparation must not certify a lagging
secondary's incomplete prefix. Tests verify the override and transmitted command;
replica-lag/failover behavior has not been exercised in the standalone fixture.
The later public reader wiring must preserve its stated consistency guarantees.

```ts
import { createMongoInsightsPreparation } from "@hot-updater/server/db";

const preparation = createMongoInsightsPreparation(mongoClient);
await preparation.prepare({ writersDrained: true });

// Resume the new guarded writer after prepare succeeds. Schedule bounded steps
// separately; do not loop over the whole collection in an HTTP request.
const progress = await preparation.runStep({ maxItems: 1000, maxRequests: 4 });
await preparation.ensureReady(); // succeeds only after the audit is complete
```

State persists independently from the existing core migration version. It records
the collection UUID, installed validator, phase and audit checkpoint before
claiming readiness. A collection replacement, weakened/changed validator or
missing required index makes the readiness check fail again. Retrying preparation
does not repeatedly nest an unchanged validator.

New event writes validate canonical lowercase UUID event IDs, finite safe integer
timestamps and the existing row domain before serialization. Ill-formed scope
strings fail before BSON can replace lone UTF-16 surrogates. Valid supplementary
Unicode is preserved. Direct append and transactional mixed commits use the same
guard. Standalone MongoDB does not gain multi-document transactions through this
change; existing mixed-commit transaction requirements still apply.

Existing rows are inspected without rewriting or deleting fields, including
extensions. Malformed legacy data leaves preparation failed, not ready with
quietly skipped rows. Repair of invalid old data requires an explicit operator
decision. Normal writes after the fence must satisfy the installed validator;
out-of-band validator bypasses and arbitrary edits are outside this guarantee.

## Bounded audit and continuation

Legacy `_id` values are not assumed to be ObjectIds. A normal `_id > checkpoint`
predicate type-brackets BSON values and can omit later types. The audit instead
uses native `_id_` index bounds and EJSON-preserved checkpoints across numeric,
string, document, binary, ObjectId, boolean, date, timestamp and MinKey/MaxKey
values. A separately bounded point read handles the captured upper key.

Each step uses one `singleBatch` event read, so the driver cannot issue hidden
`getMore` calls when large documents fill MongoDB's response byte cap. A short
nonempty batch never proves exhaustion. Only an empty bounded range advances to
the upper-key phase. Continuation excludes the saved checkpoint with native
negative equality and resumes safely if that checkpoint document was deleted.

`maxItems` accepts 2–1000 and bounds raw event candidates, including one reserved
candidate for excluding the previous checkpoint. The query projects only public
event fields and `_id`; arbitrary extension payloads are not transferred. Control
metadata is separate: an active step makes four requests (state, collection
metadata, one event range/point, checkpoint CAS). A completed state needs only its
two metadata checks. The returned `itemsRead` counts returned event rows, not the
excluded checkpoint candidate or metadata. These are logical-operation and normal
command counts, excluding driver retries on network errors or failover; they are
not byte or disk-I/O bounds. `singleBatch` prevents ordinary response-cap refills.
Index traversal may also inspect one endpoint key beyond the document budget.

Checkpoint advancement uses compare-and-swap. Concurrent steps may both perform
one bounded read, but only one advances the saved revision; a loser returns a
conflict requiring a later bounded retry. This does not simulate MongoDB
transactions or permit an unfinished audit to appear ready.

## Verification

Real MongoDB 7.0.31 regressions cover 50,001 legacy events, mixed BSON keys under
simple and locale/numeric collations, deleted checkpoints, special upper keys,
concurrent checkpoint CAS, preserved validators, invalid old/new data and warm
readiness after schema changes. Actual mixed-key plans use IXSCAN with bounded
examined keys/documents, without a collection scan or sort.

A large public-string fixture forces a response byte limit below the requested
row count and confirms that the next step still visits remaining rows, without
`getMore`. The generic server DB entry is also tested without loading the optional
MongoDB peer until Mongo-specific maintenance is invoked.
