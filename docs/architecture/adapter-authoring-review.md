# Adapter authoring: adversarial design review

Status: design decision and implementation gates; not an implemented SDK.
Reviewed against #1331 at `c259b4a3e`, stacked on #1330 and targeting `next`.

## Verdict

The existing factory is useful cleanup but does not satisfy the plugin author's
goal. External authors still implement domain models and commits. Bundled native
providers still reconstruct keys, stage logical rows, enforce relationships and
orchestrate Insights behavior. Moving those implementations into helpers, or
exporting the current factory, does not remove that knowledge requirement.

Introduce a supported authoring factory that owns Hot Updater semantics and
returns the consumer-facing `DatabasePlugin`. Authors register storage behavior
once. Preserve native atomicity and require bounded access paths as part of that
contract. Do not approve the authoring work as complete until both developer
effort and database work meet the gates below.

This is a source-based adversarial review, not a new benchmark or an independent
multi-reviewer sign-off. Previously passing tests do not cover every cost claim
discussed here.

## Reference and limits

Actively follow Better Auth's
[adapter authoring guide](https://better-auth.com/docs/guides/create-a-db-adapter):
one public `createAdapterFactory({ config, adapter })` entry, normalized database
inputs, factory-owned conversions, and a published adapter test suite. Authors
translate operations into their database SDK. Its `findMany` example forwards
filter, limit, ordering and offset; it also exposes field selection. This is a
useful ownership and onboarding model, not a proof of bounded physical reads.

The guide permits sequential execution when transactions are unavailable.
Hot Updater must reject unsupported atomic commits instead. We also cannot copy
offset pagination as the universal storage contract. The reference remains
Better Auth commit `41b7dc15de41a8726422c392a4857d8764828891`:
[factory](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/core/src/db/adapter/factory.ts),
[domain adapter](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/better-auth/src/db/internal-adapter.ts).
The latter owns application workflows; the factory does not eliminate all
complexity or make every database implementation equally short.

## Findings in the current implementation

| Finding | Evidence at the reviewed revision | Consequence |
| --- | --- | --- |
| Authoring and consumption remain conflated | `plugins/plugin-core/src/types/databasePlugin.ts` requires `models + commit`; `types/databaseOperations.ts` still requires six CRUD methods, five Insights methods and two channel methods on the transactional path | An author must understand Hot Updater workflows despite using a factory. The native path keeps even more domain implementation in the provider. |
| The transaction interface loses key intent | `plugins/firebase/src/firebaseDatabaseTransaction.ts`, `selector`, `rowKey`, `loaded`, `lookup`, and model-specific create/delete branches | Firebase reconstructs model keys from generic predicates and implements absence, staged deletion, uniqueness and relationship semantics. These are not Firestore SDK translations. |
| A partition query can still examine many irrelevant rows | `plugins/aws/src/dynamoDB.ts`, `metadataPartition` and `queryMetadataItems`: one equality selects a partition; remaining conditions become `FilterExpression`; pages continue until enough matches arrive | A Release query combining channel and enabled state can walk most of the channel partition for a tiny result. `Limit` and absence of `ScanCommand` do not prove bounded work. |
| A scoped count can still read outside the requested time range | `plugins/aws/src/dynamoDB.ts`, `countLatestEvents`: partition-only key condition, time/bundle post-filter, and continuation through the partition | Counting recent matching installations can examine old or nonmatching scope entries. Returning only a number does not eliminate read cost. |
| Internal pagination repeatedly skips or reloads prefixes | `plugins/plugin-core/src/createDatabaseReadModels.ts`, `bundlePatches.findByBundleIds`, increments offset. `plugins/firebase/src/firebaseDatabaseReads.ts` uses increasing offsets and fetches `offset + limit` from each finite-IN shard before slicing | Long owner enumerations repeat earlier work; multiple ID shards amplify it. A finite requested ID set prevents a global scan but does not prevent overfetch. |
| An existence decision requests an exact total | `plugins/plugin-core/src/createDatabasePlugin.ts`, bundle/channel deletion, calls `count(releases)` and only tests `> 0`; Firebase stages this with a native aggregate plus a local delta | An indexed count can still traverse all matching index entries. A reference guard needs an existence answer with concurrency protection, not an exact total. |

The screenshot's `Map` search only searches transaction-local rows; it is not
evidence of a Firestore collection scan. Its problem is ownership and authoring
burden. Conversely, an SDK query with no application-side filtering can still
over-read internally. AWS documents that
[query filters run after reads](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html),
and Firebase documents that
[offsets read skipped documents](https://firebase.google.com/docs/firestore/best-practices#read_and_write_operations).
The findings above identify concrete execution paths, not measured cloud bills.

## Decisions after counterarguments

| Proposal or objection | Decision |
| --- | --- |
| Export the current internal factory and declare the authoring problem solved | Reject. Publication fixes access, not the remaining domain implementation or query translation burden. |
| Move Firebase's functions into a shared helper package | Reject. Providers would still choose their order and enforce the protocol. The factory must execute that protocol automatically. |
| Require identical CRUD callbacks and emulate everything else | Reject. Firestore prohibits reads after writes; DynamoDB needs conditional batches. Do not make authors build a miniature transactional database to fit an SQL-shaped interface. |
| Keep domain-native `models` and `commit` overrides as the normal authoring path | Reject as the target SDK. That preserves independent implementations of domain rules. Native optimizations may implement storage execution, not silently replace validation, relationship policy or Insights semantics. |
| Put every database behind one generic mutation-plan interpreter | Reject unless prototypes prove it improves authoring without extra reads. SQL must retain native constraints and direct updates; a universal before/after snapshot can increase work and complexity. |
| A request returned only 20 rows, so it is bounded | Reject. Count evaluated rows, skipped rows, repeated hydration and requests, including empty filtered pages. |
| Replace reference counts with `limit(1)` everywhere | Insufficient. A row deleted earlier in the same commit must be excluded, and concurrent child insertion must invalidate the parent guard. Use a native constraint, maintained relation guard, or bounded existence query that accounts for the staged write set. |
| Every physical index visit beyond returned rows is forbidden | Too strong to be meaningful across engines. Permit necessary key lookups, explicit aggregate work, finite stream heads and documented pagination lookahead; reject growth caused by unrelated rows or discarded prefixes. State the bound for each query shape. |
| Keep arbitrary deep offsets and guarantee no over-scan on every provider | Incompatible. Use cursors in the new authoring contract and migrate affected caller/HTTP pagination deliberately. Do not hide an offset-to-cursor walk behind the factory or silently drop an existing filter. |
| Automatically add indexes for every filter combination | Reject as an unmeasured default. Index fanout also costs writes and atomic batch actions. Enumerate supported query shapes and prove their physical layout, query cost and write cost together. |

## Ownership boundary

| Factory/core owns | Storage adapter owns |
| --- | --- |
| Fixed models, logical keys, input/result validation, row normalization | SDK calls, physical field/key encoding and database error translation |
| Domain queries, filters, stable ordering, cursor semantics and required logical access paths | Index/query lowering that preserves those bounds and consistency requirements |
| Ordered changes, expectation outcomes, conflict indices, references and cascade intent | Native transaction or conditional batch execution and physical constraint enforcement |
| Read-your-writes and missing/deleted-row state when staging is needed | Transaction-bound reads; application of the prepared physical writes |
| Insights deduplication, installation-head transitions and summary update rules | Native execution of the required atomic projection updates |
| Logical relation guards and when they must be captured | Enforcing those guards against concurrent writes, including physical action limits |

The public authoring entry should be documented separately from the consuming
`models + commit` interface, with no required `/internal` imports. Follow the
reference's configuration-and-adapter registration shape. The exact export name
and method signatures are provisional until real backends prove them.

Inputs must preserve key lookup, existence, range-page and aggregate intent.
Authors should not discover that a generic `where` happens to represent a unique
key, or infer that a count is only needed as a boolean. Provide normalized typed
inputs; do not ask providers to maintain lists of allowed domain keys or parse
`readonly object[]` with `Reflect.get`.

Use native transactional execution where available and explicit conditional
atomic execution where required. Any staging or guard preparation belongs inside
the factory. This must not become a capability-flag framework, general ORM DSL,
or a collection of domain callbacks. The smallest viable method set is a result
of the prototypes, not a predetermined promise of six methods.

Standalone remains an HTTP repository facade over the public domain protocol;
it should not implement a storage adapter merely for visual symmetry.

## No-overfetch contract

1. Unique-key reads address the key; finite-ID reads deduplicate IDs and restrict
   hydration to requested/selected keys. Empty sets and zero limits perform no
   data reads. Missing keys stay cached within one transaction attempt.
2. Page reads preserve all filters, ordering and cursor bounds in their access
   path. A residual predicate is unacceptable when unrelated rows can force
   additional pages. Fixed endpoint exclusions need an explicit constant bound.
3. Internal continuation uses stable cursors, never an increasing offset or a
   fresh prefix per page. A union over finite shards uses advancing cursors and
   a bounded merge, not `offset + limit` rows from every shard on every request.
4. Select only fields necessary for the result, guard or merge when the backend
   supports projection. Full-row hydration for an existence test or a skipped
   item needs a demonstrated necessity. Projection alone is not proof of reduced
   storage-engine work or billing.
5. Existence checks stop at a valid witness, while preserving staged deletions
   and phantom protection. A native foreign-key constraint or atomically
   maintained reference guard may avoid the read entirely.
6. Exact requested counts may process their matching indexed range; they must
   not hydrate all matching rows or traverse unrelated history. Insights summary
   endpoints read maintained summaries. Missing summaries/indexes fail explicitly
   and are repaired through infrastructure operations, never during a request.
7. Listing all explicitly requested children may take several pages proportional
   to those children. It must not revisit earlier pages or inspect other owners.
   Necessary continuation is not a fallback and must have no arbitrary row cap.
8. Query-cost bounds include round trips, evaluated rows/index entries, returned
   documents, hydrated fields and physical write amplification as applicable.
   Small responses, successful conformance tests and method names prove none of
   these alone.

Preserving all existing offset semantics is not an accepted shortcut. The cursor
migration must identify consumers, HTTP routes and console/CLI behavior before
changing the public interface. Existing pagination cannot be silently truncated,
rejected on one bundled provider, or advertised as satisfying the new guarantee.

## Implementation and proof gates

1. Write a query-shape inventory for every public model method and actual caller.
   Map each provider/ORM to keys, indexes, filters, order, cursor, projections and
   expected read bounds. Include SQL/ORM query plans; backend `WHERE` clauses do
   not automatically prove selective access. Record index write fanout as well.
2. Add meaningful Vitest RED cases for the concrete paths above: many nonmatching
   Releases before a rare match; a large old installation population with a small
   recent subset; multiple Firebase ID shards and several continuation pages;
   reference existence with many children and with staged child deletion.
   Instrument physical requests/evaluated work, not only returned row counts.
3. Prototype the same factory boundary with PostgreSQL/Kysely, Firestore and
   DynamoDB before freezing public types. Review D1 batch and Supabase RPC
   lowering at the same time; they cannot depend on arbitrary JS callbacks
   executing inside a remote SQL transaction.
4. Reject a prototype that adds speculative reads to native SQL writes, repeats
   domain algorithms in adapters, or handles unsupported queries by scanning.
   Change access paths or the explicit pre-GA query contract. Do not leave
   bundled providers failing required operations as the permanent solution.
5. Exercise atomic behavior: later malformed change causes zero I/O; repeated
   key reads, insert/update/delete ordering and cached absence; concurrent catalog
   CAS with one winner; parent delete versus child insert; duplicate Insights
   events and ambiguous retries; native limits reject without partial writes.
   Capture parent guards before relation enumeration and invalidate them on every
   relevant child mutation, even when an aggregate's net delta is zero.
6. Grow unrelated fixtures while holding the requested result constant. Also
   grow selected children and verify linear continuation without repeated
   prefixes. Use SDK traces and DynamoDB `ScannedCount` where available, and
   representative SQL plans/execution evidence. Do not reject an efficient small
   table plan merely because the optimizer chooses a sequential scan.
7. Migrate all database providers and ORM adapters through the same authoring
   contract, preserving their published HTTP/OTA conformance registration. An
   external packed-package consumer must implement a working adapter without
   `/internal`, model implementations or copied domain helpers. Document native
   transaction/index bindings and export every type that example requires.
8. Update public authoring docs, cursor consumers and conformance tests together.
   Run build, types, lint, unit and native integration checks after implementation.
   Any necessary schema/index correction goes into the single 1.0.0 initialization
   migration and 1.0.0 infrastructure notes. No 1.0.1 or extra migration file.

The authoring acceptance test is whether a new domain rule can be implemented in
core and its shared scenarios without rewriting that rule in each provider.
Physical schema/index changes can still require provider-specific work. Line
count reduction alone is not acceptance, and the new SDK must not be presented
as complete while the cost findings remain unresolved.
