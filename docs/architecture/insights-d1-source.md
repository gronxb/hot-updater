# D1 Insights v2 source and native pages

This is an internal provider slice. It prepares a committed event source, native
event pages, and live latest-installation pages for both the D1 REST executor and
Worker binding. The required public four-port contract, report/search jobs,
startup preparation wiring, cleanup, and Console cutover remain separate work.

## Storage and write boundary

New databases create the v2 private layout with the core schema. Existing
databases use `0002_hot-updater_insights-v2.sql` during a writer-drained
maintenance window. The migration adds nullable private markers to raw events,
creates empty sidecars and their indexes, captures a fixed
`(received_at_ms, id COLLATE BINARY)` upper bound, then installs a `BEFORE INSERT`
old-writer fence. There is no version negotiation, optional capability, legacy
writer path, raw-table rebuild, or scan fallback.

The sidecars contain:

- one current source state and a monotonic integer generation;
- compact source pointers ordered by generation and event time;
- installation and bundle movement pointers with named three-column indexes;
- one latest pointer per SHA-256(JSON-stringified installation identity).

The live table retains the full installation identity only to reject digest
collisions at write time. Enumeration never selects that value as lookahead;
selected raw events independently reproduce the digest and full identity. Event
IDs keep the plugin-core contract of 1–1,024 characters and use binary ordering.
Empty IDs fail before new writes and make legacy preparation fail closed.

Direct event append is one raw insert. Its trigger advances the source counter
and writes all applicable pointers in the same statement. Mixed commits put the
same insert in D1 `batch()`, which is transactional. Mixed event statements omit
`RETURNING`, so large event rows do not accumulate in the response. Duplicate
raw IDs, source overflow, missing readiness, and digest collisions roll back the
whole statement or batch.

## Bounded preparation

Call `createD1InsightsSourceTools(executor).backfillStep(limit)` with a limit of
1–6 until it reports ready. A step first checks the exact private table, PK,
foreign-key, named-index, non-partial-index, and trigger shapes. It then reads the
next raw primary range through `bundle_events_received_at_idx` and commits pointer
inserts plus its checkpoint in one batch.

The worst case is six movement events. Layout, state, and raw reads use three
queries; the transactional batch uses 32 statements, for 35 total queries. The
limit leaves headroom under the D1 Free-plan limit of 50 queries per Worker
invocation. Retrying after an uncertain client response reads the committed
checkpoint and continues; it does not replay or skip the committed prefix.

## Native read bounds

Event candidate pages seek a named source, installation, or bundle index and read
at most `limit + 1`, where `limit` is at most 100. Source replay reads at most 100
generation pointers. Live installation enumeration reads 101 compact digest/event
pointers; exact lookup reads one. The response byte prefix is chosen from stored
public-event byte counts before raw lookup. Raw events are fetched by bounded ID
points through the certified raw PK. There is no OFFSET, refill loop, total-count
query, or startup scan.

Event pages target a 1 MiB public-event budget while still allowing one valid D1
row up to the provider's 2,000,000-byte value/row limit. A short page continues
after its last emitted event. Long installation identities do not inflate the
lookahead response, and mixed commits return no event rows.

Commit plans allow at most 50 batch statements without expectations. With one or
more expectations they reserve one query for post-rollback reconciliation, so
the batch itself is at most 49 statements. All expectations are packed into one
JSON parameter and evaluated inside the transaction guard. Every statement is
also rejected before I/O if it exceeds D1's 100 bound-parameter limit.

## Deployment gate

Local Worker-runtime evidence covers migration, both logical executors, rollback,
unknown-response retry, 50,001-row plans and rows-read counts. Production approval
still requires a real remote REST database and deployed Worker binding run that
records rollback parity, `rows_read`/`rows_written`, response sizes, storage, and
the exact deployed D1 engine. Until that evidence and the remaining provider
ports/jobs exist, this module must stay internal and the public 50,000-row ceiling
must remain in place.
