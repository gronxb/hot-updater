# Provider contract simplification: target PRD

Status: final target requirements; implementation and acceptance are pending.
Proposed SDK types remain provisional until the native prototype freeze gate.
This document replaces the earlier cleanup completion report. The
[adversarial authoring review](./adapter-authoring-review.md) supplies the problem
evidence; its ownership, atomicity and query-cost objections are requirements
here, not optional follow-up work. Earlier green cleanup tests do not certify
this target. No new build, test run or provider benchmark accompanies this PRD.

## 1. Baseline and problem

The implementation base is `feature/provider-contract-simplification`, with
`next` commit `79c3eea5a`
(manifest artifact protocol v1) merged. The separate
`feature/provider-authoring-wip` now merges `next` and the review stack at
`2f4a51ddf`. Its earlier `670050811` commit is historical prototype evidence from
the old manifest baseline. Neither revision establishes the target SDK or API
freeze. Review the refreshed staging, pagination and projection experiments
selectively against this PRD; do not restore schema assumptions from the older
commit.

Delivery starts with a documentation-only layer based on `next`, containing this
finalized PRD and the adversarial review. That branch is then merged through the
ten existing cleanup layers: RC schema, ORM queries, reverse patch reads,
Firestore reads, AWS projections, internal factory, Firestore staging, DynamoDB
commits, Standalone models and public-facing contract documentation. There are
eleven layers in total; #1331 becomes the final public-facing documentation
layer. At this revision the remote split has not been published. Adding the
first documentation layer makes no runtime change and does not itself invalidate
intermediate runtime validation. It also does not implement the target public
SDK, core-owned Insights or cursor migration.

The current consumer contract is `DatabasePlugin.models + commit`. The bundled
`createDatabasePluginAdapter` is internal. External authors still supply domain
models and commit behavior; native providers also own relationship checks,
transaction overlays and Insights workflows. Publishing that internal factory
unchanged would preserve the authoring burden.

Cost problems are separate from API size. A DynamoDB partition query can inspect
unrelated records after applying a filter; a Firestore offset can reread skipped
prefixes; an exact count can do unnecessary work for an existence decision.
Passing functional tests, avoiding a Scan API, and returning a small page do not
prove bounded database work.

The independent cost review (F1–F9) and native authoring review, dated 2026-09-22,
were consulted for this revision. Their
findings are pinned to the cleanup/prototype revisions stated in those reports;
they are source review and focused source-probe evidence, not full integration
or cloud-cost validation. Their remaining gates are incorporated below. Neither
report approves publication of the current factory as the target SDK, and the
refreshed WIP merge does not clear their findings by itself. Requirements are
settled here; selecting and proving the native mechanisms is implementation work.

## 2. Goals and non-goals

Success means all of the following:

- A supported, Better Auth-style `createAdapterFactory({ config, adapter })`
  creates the consumer plugin. An external author implements storage operations
  and native atomic execution through public exports, without domain models,
  copied helpers or `/internal` imports.
- Core owns fixed-schema validation, normalized queries, ordered changes,
  conflict outcomes, reference policy, staging when required, and all Insights
  rules. Providers own physical encoding, access paths, I/O and atomicity.
- Supported queries have explicit physical-work bounds. Filters, projections,
  cursor position and consistency survive every layer. No runtime full-scan,
  history backfill, growing-offset fallback or arbitrary history ceiling.
- SQL and ORM adapters retain direct native transactions, constraints and
  conditional mutations. D1 batches and Supabase RPC remain first-class paths.
  Staging must not impose speculative snapshots on SQL.
- Every existing supported provider/ORM profile passes the same published
  behavioral contract plus its physical cost and concurrency gates. Schema
  corrections ship as the single pre-GA `1.0.0` baseline.

Non-goals: a general ORM/query language; dynamic user-defined models; a generic
helper collection; a capability-flag framework; identical implementations across
engines; new database engines; changes to OTA selection or artifact semantics;
background repair during requests; claiming arbitrary deep offsets are bounded.
Storage/build plugins are outside this database-authoring contract. Standalone
remains an HTTP repository facade. Existing unsupported engine profiles are
listed explicitly below rather than being described as newly supported.

## 3. Reference and chosen boundary

The official [Better Auth adapter authoring guide](https://better-auth.com/docs/guides/create-a-db-adapter)
was consulted alongside the local source reference at commit
`41b7dc15de41a8726422c392a4857d8764828891`. Its public factory takes configuration
and an adapter implementation, normalizes operations and exposes a separate
consumer API. The local
[factory](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/core/src/db/adapter/factory.ts)
and Kysely/Drizzle registrations demonstrate transaction-bound implementations;
its [internal domain adapter](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/better-auth/src/db/internal-adapter.ts)
keeps application workflows above storage operations.

Adopt that ownership and onboarding pattern. Do not copy dynamic schema features
or assume its CRUD surface establishes Hot Updater atomicity. Better Auth permits
sequential execution without transactions; Hot Updater must fail before mutation
when the required atomic execution is unavailable. Its guide's projection and
pagination examples are not evidence of physical read-cost bounds.

### Authoring versus consumption

| Audience | Target contract | Responsibility |
| --- | --- | --- |
| Adapter author | Public `@hot-updater/plugin-core/adapters` exports `createAdapterFactory` and every type required to implement it | Bind the fixed logical schema to native storage; implement normalized reads and one atomic execution family |
| Server, CLI and repository consumer | `DatabasePlugin` with `models`, `commit`, `name`, optional `dispose` | Express domain operations; never select provider execution algorithms |
| External provider test author | Published `@hot-updater/test-utils` suites | Register lifecycle and HTTP transport; run the same scenarios as bundled providers |
| Standalone consumer | HTTP-backed `BundleRepository` | Translate domain requests to server routes and supported atomic envelopes |

The root consumer types remain public. `createDatabasePlugin({ models, commit })`
may remain a low-level compatibility boundary during migration, but is not the
recommended authoring SDK or a bypass around conformance. No public native
`models`/`commit`/`recordInsights` override is part of the new factory.

The public entry above is proposed, not currently shipped. Preserve lazy client
construction, configuration entry points and disposal semantics. Construction
must not make database calls merely to register an adapter.

### Ownership

| Core/factory owns | Native storage adapter owns |
| --- | --- |
| Fixed row/key types, logical relations, validation and normalization | Physical tables/collections, field encoding, SDK result decoding |
| Supported query shapes, cursor ordering, projections and consistency requirements | Index selection, native bounds, projection execution and query-plan evidence |
| Full input validation before I/O; expectation order; change indices; domain errors | Transaction isolation, constraints, exact affected-row counts and error translation |
| Reference/cascade policy, staged state, cached absence and read-your-writes | Enforcing supplied guards against concurrent writes; native rollback |
| Insights deduplication, latest-head ordering, membership and summary transitions | Atomic conditional writes, counter updates and physical index maintenance |
| Which relation guards must change and when to capture them | Native revision tokens/locks, action coalescing and backend transaction limits |
| Which retries are semantically safe and their finite budget | Classification of native conflicts, transient failures and ambiguous outcomes |

Logical projection transitions and physical projection maintenance are distinct.
Core decides whether an event advances an installation head, which overview rows
change and by what amount. The provider maps those logical effects to physical
index items/documents and maintains that layout atomically. It must not derive
the head winner, summary attribution or overview deltas itself. A callback with
a storage-like name that requires those decisions still violates this boundary.

A new domain rule must be implementable in core and shared scenarios without
rewriting the rule in every provider. A new physical index or storage primitive
can still require adapter work. Core here means the shared semantic implementation
and its native compilers, including packaged SQL routines; moving files alone
without changing who defines and executes policy does not meet this boundary.

## 4. Minimal proposed authoring design

Recommend four intent-preserving read operations and a discriminated native
execution registration. This is a concrete proposal to validate in stage 2,
not a frozen declaration file. Do not promise that six generic CRUD callbacks
can provide all required semantics.

```ts
import {
  createAdapterFactory,
  type StorageAdapter,
} from "@hot-updater/plugin-core/adapters";

export const exampleAdapter = (client: ExampleClient) =>
  createAdapterFactory({
    config: { adapterId: "example", adapterName: "Example" },
    adapter: ({ schema }): StorageAdapter => bindStorage(client, schema),
  }); // Returns a lazy DatabasePlugin; bindStorage contains only storage code.
```

`schema` is the immutable fixed logical schema, including keys, relations and
required access paths. It is not a bag of helpers that authors must compose in
the correct order. No arbitrary schema configuration or callback injection is
needed. All types referenced below must be exported from the same public entry.

```ts
interface ReadPort {
  get<K extends KeyRead>(input: K): Promise<KeyResult<K>>;
  page<Q extends RangeRead>(input: Q): Promise<PageResult<Q>>;
  exists(input: ExistenceRead): Promise<boolean>;
  count(input: CountRead): Promise<number>;
}

interface TransactionPort extends ReadPort {
  guard(input: StorageGuard): Promise<void>;
  write(input: StorageWrite): Promise<WriteResult>;
}

interface StagingPort {
  readonly read: ReadPort;
  flush(input: GuardedWriteSet): Promise<void>;
}

type Execution =
  | {
      kind: "transaction";
      run<T>(body: (tx: TransactionPort) => Promise<T>): Promise<T>;
    }
  | {
      kind: "staged";
      run<T>(body: (storage: StagingPort) => Promise<T>): Promise<T>;
    }
  | {
      kind: "compiled";
      target: "sqlite-batch";
      batch(input: readonly SqlStatement[]): Promise<SqlBatchResult>;
    }
  | {
      kind: "compiled";
      target: "postgres-rpc";
      call(input: PreparedRpcCall): Promise<RpcResult>;
    };

interface StorageAdapter {
  readonly read: ReadPort;
  readonly execution: Execution;
  dispose?(): Promise<void>;
}
```

These are three execution families, with two concrete compiled transports, not
independently combinable capability flags. The factory invokes the selected
family and owns its orchestration. An adapter implements only its family's
operations; dummy writes, unused count emulators and method overrides are absent.

The supporting types have these required meanings:

| Proposed type | Required contents and restrictions |
| --- | --- |
| `KeyRead` / `KeyResult<K>` | Discriminated, schema-derived unique key plus requested fields; result type follows that selection and allows absence. Guarded reads also carry the native revision/absence evidence needed by staged execution, separately from consumer fields. Examples: bundle `id`, catalog `scope_key`, channel `id` or unique `name`, API key `id` or unique `hash`, Insights event/head/summary keys. No recovery of keys from arbitrary WHERE objects. |
| `RangeRead` / `PageResult<Q>` | Closed union of the query families in section 6, with typed equality/range bounds, stable order, exclusive cursor, positive limit, projection and required consistency. Returns selected rows plus continuation. Includes physical guard/projection stores needed by core; these are not new consumer models. |
| `ExistenceRead` | Indexed relation or range, with only the finite staged keys to exclude. Boolean intent is explicit. A separately protected relation guard or native constraint is required for mutation safety. |
| `CountRead` | Explicit exact count of a supported indexed range, with defined distinct identity where needed. Not a replacement for `exists` or maintained summaries. |
| `StorageGuard` | Exact-key absence/version/value precondition or protected relation precondition, and its original conflict attribution. Captured relation tokens precede dependent enumeration. Core selects the guard; storage enforces it atomically. |
| `StorageWrite` / `WriteResult` | Typed insert, patch, upsert, delete/scoped deletion, or accumulation; bounded predicates, numeric deltas/register maxima, conflict target/policy and only required return fields. Exact matched/inserted outcome, including no-op updates. No domain verbs such as `recordInsights` or `deleteChannel`. |
| `GuardedWriteSet` | Core-prepared guards and final logical row/head/overview effects for touched keys, with original change attribution. Storage expands these into its physical layout, accounts for index fanout and rejects excess size before writes. Old fields are supplied only where physical projection removal or a logical transition actually needs them. No whole-database or unconditional full-row snapshots. |
| `SqlStatement` / `SqlBatchResult` | Parameterized SQL and values produced by the core SQLite compiler; ordered native rows/affected counts or structured failure. Result-to-domain decoding remains in core. |
| `PreparedRpcCall` / `RpcResult` | A call to a packaged, version-matched core-owned PostgreSQL routine with its typed input/result. Not arbitrary SQL, a JS callback, or a provider-authored domain implementation. |

Selection-dependent result types must be derived from the fixed schema, not
`readonly object[]`, reflection, or manually duplicated model key lists.
`RangeRead` is an access-path contract, not a general boolean query DSL. Finite
key sets are deduplicated by core and lowered to keyed reads or bounded streams;
empty sets and zero-result requests do not reach storage.

Reads must identify an already-resolved row/head/projection range; they cannot
ask an author to infer “latest per installation, then filter” from raw events.
Guards specify the exact protected precondition, not a request for an author to
discover references. Writes carry the conditional effects selected by core,
not a report for an author to turn into an overview update. The method/model
count is not an acceptance metric: trace every required domain scenario through
these ports and reject any hidden domain algorithm in an author implementation.

### Finite storage execution representation

Accept a small core-owned ordered storage program as necessary compiler/runtime
work. Its vocabulary is fixed: key/range reads, insert with a named uniqueness
target and accepted result, patch with a matched result, native put/upsert,
key/scoped delete, numeric accumulation and elementwise register maximum, and
assertions/guards. Every operation carries its original failure site. Core
computes HLL register positions/ranks; storage only applies supplied maxima.

Conditional effects need named result slots, selected fields from earlier reads,
constant values, key substitution, comparisons/conjunction and a conditional
group. They do not need arbitrary JS, extensible models, unbounded loops or a
public plan-builder API. Core constructs this program, interprets it directly
or with a selective overlay, and lowers it for compiled targets. Authors bind
the resulting storage operations; they do not reconstruct the program from a
domain commit/event. The program, planners and renderers stay private; authors
must not implement a public instruction interpreter. Every storage input/result
type required by the ports and precompiled transports is public. A new compiled
target requires explicit core renderer work and native proof, not a misleading
promise of two trivial author callbacks.

The [Insights activity PRD](./insights-release-activity-prd.md) rejects a public
`InsightsStorage` or provider-authored prepared-event lifecycle. That remains
true. This target explicitly permits the bounded storage execution vocabulary
above as an authoring implementation contract; it supersedes a blanket reading
that would forbid any native execution representation. Consumer Insights APIs
do not gain a projection protocol. The simplicity requirement still applies:
measure the compiler, renderer, schema and author code together.

### Bounded API decision before freezing exports

The remaining design blocker is the exact representation of guarded writes and
conditional Insights effects across the three families. Resolve it with the
same four scenarios: catalog CAS; parent deletion after a staged child deletion;
an event that changes a latest head and its summaries; and a duplicate event.
PostgreSQL/Kysely, Firestore and DynamoDB must execute them, with D1 batch and
Supabase RPC lowering demonstrated at the same gate.

Recommended design: the public ports above, the finite core program, and
operation-specific native lowering from that same representation. SQL executes
direct mutations without a row-overlay interpreter. D1 receives complete guarded
statements; Supabase receives a finite storage-operation RPC or a function
generated from the same program. Hand-maintained copies of attribution, head
comparison or commit branches are still duplicated policy, even inside a folder
named core. Storage authors do not construct plans or call compiler helpers.

For remote execution, compare generated parameterized statements/functions with
a small core-installed executor of the same finite storage operations. Prefer
generated native lowering; a restricted storage-operation RPC is an alternative
where it reduces complexity without adding reads. Neither makes authors write
an interpreter or copied policy. Reject a public program-interpreter SDK,
universal before/after snapshots, callback-only CRUD and raw domain overrides.
Freeze the selected types and two public authoring examples after the bounded
proof; an unresolved native callback boundary is not implemented merely because
its signature has been declared.

## 5. Native execution and atomicity

### Direct transactions: SQL, ORMs and MongoDB

Core executes against a transaction-bound port. Native conditional DML, unique
constraints, foreign keys and affected-row counts should satisfy guards without
extra application reads. A simple field update must not acquire a before/after
snapshot or hydrate its row when its native outcome already supplies the answer.
An old Insights head read required to calculate a transition is legitimate and
must select only its dependencies. Native bulk/scoped deletes need not enumerate
children into JS when constraints and results preserve the contract.

Use native upsert for catalog puts, with no host existence read merely to choose
insert versus update. Overview accumulation uses arithmetic/register-max
expressions without reading whole summary rows. Prisma bindings may require
fixed parameterized native SQL when delegates cannot express these operations;
delegate-only read/replace is not fulfillment of the SQL cost requirement.
MySQL must report matched versus merely changed rows correctly for no-op patches.
Synchronous SQLite drivers execute the finite program synchronously inside their
native transaction, using the compiled SQLite binding where appropriate. An
async callback that outlives a synchronous transaction is not a valid binding.

Foreign keys or serializable/locked relation guards must protect parent deletion
against phantoms. A transaction plus `exists` at ordinary snapshot isolation is
not sufficient by itself. ORM relation emulation must execute core's relation
policy with a proven lock/guard strategy; it must not reimplement it in delegates.
Missing transaction support cannot silently become sequential execution.
An installed constraint substitutes for a logical check only if it proves the
whole rule: a bundle-ID foreign key alone does not prove Release/platform
equality. Retain a minimal protected read or add the equivalent composite
constraint to `1.0.0`.

### Staged execution: Firestore and DynamoDB

Core owns the attempt-local overlay, keyed read cache, cached absence, ordered
changes and final write set. Providers do not reconstruct keys, evaluate domain
queries in memory, compute staged reference deltas or maintain their own overlay.
A cached projection may be expanded once if a later operation needs additional
fields; record that necessary read rather than falsely claiming one read per key.

Firestore binds `read` and `flush` to a native transaction. Core completes all
reads before one flush, matching the documented
[reads-before-writes transaction rule](https://firebase.google.com/docs/firestore/manage-data/transactions).
Retries discard the previous attempt's overlay. Deleted and missing keys remain
absent within an attempt; insert/update/delete ordering is evaluated by core.

DynamoDB uses strongly consistent keyed/range reads where guards require them,
followed by conditional `TransactWriteItems`. A staged `run` is not assumed to
provide an interactive database snapshot: every observed dependency must be
validated by the final write conditions, including absence and relation versions.
Capture the parent guard before enumerating children. Every relevant child
mutation must invalidate it, including replacement with zero net count change.
A lagging GSI cannot be used as a strong reference or catalog guard.

Coalesce physical writes targeting one item, include projection/guard actions in
the budget, and reject an oversized atomic operation before sending writes.
DynamoDB forbids multiple transaction actions on the same item and limits a
transaction to 100 actions and 4 MB; these are physical limits, not limits on the
number of user changes. See [DynamoDB transaction behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).
No automatic splitting into partially committed transactions is allowed.

### Compiled execution: D1 and Supabase

D1 receives one parameterized batch per attempt, generated in core. Cloudflare
[documents batch rollback when a statement fails](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
A conditional statement affecting zero rows does not itself fail a batch. The
compiler must therefore enforce whole-operation abort/guard semantics, preserve
ordered change visibility, and return the correct original conflict index. It
cannot inspect a JS result between statements or rely on an unguarded pre-read.
Worker binding and HTTP transport require independent execution evidence.

Supabase receives one RPC per attempt for the atomic operation. Its
[database functions](https://supabase.com/docs/guides/database/functions) execute
inside PostgreSQL and are callable through the API. Package the core-owned
routine with the baseline schema and use native constraints, conditional updates
and transaction rollback. Returning a conflict after earlier successful writes
without rolling them back fails this requirement. Multiple PostgREST requests
are not an atomic callback transaction.

For both paths, compile state-dependent conditions into native statements or
routines; do not serialize an arbitrary JS closure. Preserve conditional event
insertion, comparison with the old head, and projection updates inside the same
atomic boundary. If a compiler needs new guard storage or a SQL primitive,
prove its costs and place it in the `1.0.0` baseline before freezing the API.

### Shared outcomes, including Insights

Validate the entire input, including later changes, before any provider I/O.
State-dependent checks then execute at their required point within the atomic
operation. Expectations apply to the initial atomic state, including an
expectation-only commit; repeated writes do not shift the check to a later state.
Preserve expectation precedence, ordered changes, `changeIndex`,
`not_found`, `referenced`, and version-conflict details. A follow-up read after a
conflict must not be mislabeled as the version observed at the failed guard.
The target keeps `actualVersion` as the value observed at the failed guard. Its
transport through rollback is a native prototype gate; if that cannot be proved,
an explicitly reviewed diagnostic-contract revision is required before API
freeze, rather than silently reporting a later value.

Core owns immutable event deduplication and the greatest `(received_at_ms, id)`
head per installation; duplicate IDs are complete no-ops. Core also owns current
user membership, source attribution for recovery, release activity, unique-user
HLL summaries, app usage, distributions, time buckets and coverage semantics. Adapters
apply the corresponding typed storage effects. There are no provider-authored
`recordInsights`, `getAppUsage` or `getReleaseActivity` algorithms in the target.

Event counters are exact; distinct-user/active-installation overview metrics
retain the existing bounded, mergeable HLL approximation. Core owns identity,
register updates, merge and estimate rules; never replace those sketches with
unbounded installation sets or sum per-bucket estimates. Accepted older events
still affect their report summaries even when they do not advance the head.
A newer head atomically removes its old distribution contribution and adds the
new one; an inconsistent required old contribution aborts the whole operation.
Consider storing the core-computed logical distribution-summary ID on the head
in the `1.0.0` schema to avoid repeating attribution/hashing in native renderers.
Two first reports for an absent head require insertion/CAS, a keyed lock or
serializable retry: locking a nonexistent row is not a portable mutex.

Retry an ambiguous event outcome with the identical prepared ID/time/input.
Projection changes and the dedup marker must commit together. Define bounded
retry budgets for recognized concurrency failures; an unknown outcome must not
be reported as rollback or blindly retried as a new logical operation. Native
limits, retry exhaustion and unavailable atomic execution fail explicitly.

## 6. Bounded query-cost contract

Measure each operation per attempt and across retries. Let `N` be unrelated data,
`L` the requested page size, `K` the distinct supplied keys, `S` the selected
physical streams, `P` the effective native page capacity, `C` the explicitly
selected children, `M` the matching entries for an exact aggregate, `D` the
staged exclusions, `B` the selected summary buckets/dimensions, and `F` the
physical index/projection fanout of a write.

Record round trips, evaluated rows/index entries, returned rows, hydrated fields
and bytes, skipped/repeated rows, and physical writes. Native page/byte limits,
fixed lookahead and index seeks are legitimate overhead. Index tree navigation
may grow logarithmically with `N`; row examination must not grow with unrelated
history. Projection reduces hydration, not necessarily evaluated work or billing.

| Intent | Required bound and behavior |
| --- | --- |
| Unique-key read | One keyed lookup per needed key/projection in an attempt; absence cached where reused. No collection query or history hydration. |
| Finite-key lookup | When all keys are requested, at most `K` logical probes with native batching. For a limited page, deduplicate/sort and apply known ID/cursor bounds before choosing the key window; hydrate selected results, advancing over missing keys explicitly. Do not hydrate 1,000 full rows to return ten. Empty set: zero data reads. |
| Single-stream page | Seek directly to all filter/cursor bounds; examine/return at most `L` plus fixed documented lookahead, aside from seek overhead. Requests scale with native pages, not rejected history. |
| Finite-stream union | Advancing per-stream cursors and a bounded merge: `O(L + S*P)` fetched candidates per page with retained heads, not `S*(offset + L)`. Across continuation, document bounded head replay or carry buffered heads; never reload growing prefixes. |
| Existence guard | Native constraint/maintained guard can require no row query. Otherwise examine at most `D + 1` candidates in the protected indexed relation, select identity only, and stop at a valid witness. Never exact-count all children for a boolean. |
| Explicit child enumeration | `O(K + C)` logical entries plus fixed page/stream overhead; each continuation advances. No other owners, repeated prefixes, implicit cap or bundle-history fallback. |
| Exact requested count | Native aggregate over only its matching indexed range: up to `O(M)` index work, bounded result hydration. A constant-size response is not constant-cost execution. |
| Insights summaries | Read selected maintained summary keys/ranges: `O(B)` plus required result dimensions. No raw-event or old-head history scan, including when summaries are missing. |
| Writes | Account for `F`, relation guards, summaries, dedup markers, constraints and retries. Index fanout must fit native atomic limits and be justified with read savings. |

Keep finite-owner sets intact through core: SQL uses indexed set operations and
keyset continuation, while Firestore uses finite shard streams. Replacing one
set query with a serial query per owner is a cost regression. Prefer bounded
per-stream buffers over one serial refill per emitted row where native batching
is available; record both candidate lookahead and serial request depth. Reuse
known previous values/absence for physical projection maintenance instead of
rereading canonical rows in an index-expansion helper.

A DynamoDB `FilterExpression` that walks nonmatching rows fails even if only one
page is returned. A server-side SQL `WHERE` or `count()` also needs plan evidence.
Do not reject an efficient small-table sequential plan merely by its name; use
representative data and hold matching results constant while increasing unrelated
data. Missing indexes/projections fail readiness and require explicit repair;
requests never backfill them.

### Required query inventory

This is the complete model-method coverage inventory. Before implementation,
attach a concrete key/index/order/projection and cost trace for each reachable
filter combination to its provider gate. These access-path requirements are not
claims that the current indexes already satisfy them.

| Consumer method family | Required normalized access path and semantics |
| --- | --- |
| `bundles.findById`, `findMany`, `count` | ID key; ordered ID range with optional platform and all simultaneous ID bounds; deduplicated finite IDs where supplied. Count the same exact filtered range. Both order directions and empty intersections are defined. |
| `bundlePatches.findByBundleIds`, `findByBaseBundleIds` | Separate owner and reverse-base indexed streams, stable patch tie-breaker/order, finite-owner merge and continuation. All selected children can be enumerated without revisiting earlier pages. |
| `releases.findById`, `findMany` | ID key and bounded ordered ranges preserving simultaneous bundle, channel, enabled, platform, target-app-version and before/after ID filters. Picking one partition then filtering others is insufficient. |
| `releases.findManyByScope` | Strongly consistent scope/ID range, exclusive cursor and limit; catalog compilation cannot consume a lagging projection. |
| `releaseCatalogs.findByScopeKey`, `findMany` | Scope key lookup and ordered scope-key cursor. Generation/CAS reads use the required strong state. |
| `channels.list`, insert/delete lookups | Stable full-list enumeration or explicit paging; ID and unique-name keys. Reference guard uses channel/Release relation, not an exact total. |
| `apiKeys.findByHash`, `list`, create/revoke lookups | Unique hash/ID keys; explicit full-list enumeration without a hidden ceiling. Return/revocation semantics remain unchanged. |
| `insights.listEvents`, `countEvents` | All-events, installation-movement, or typed source/target bundle range; half-open time bounds and exclusive `(received_at_ms, id)` cursor. Counts share the same filtered interval. |
| `insights.findLatestEvents` | Canonical installation head; user membership ordered by installation ID. Validate lagging membership candidates against canonical heads. If stale candidates can grow without bound, replace that access path; silently dropping candidates or scanning to fill a page is not a bounded solution. |
| `insights.countLatestEvents` | Filter current installation heads after choosing each canonical latest event. Scope/time and optional one/two bundle predicate streams must be selective; union identities once before counting. Old/nonmatching heads must not be traversed. |
| `insights.getReleaseActivity`, `getAppUsage` | Maintained release/scope/time, usage and distribution projections with exact existing attribution, bucket, coverage and uniqueness rules. Requested output dimensions determine necessary summary enumeration. |

All currently supported filter combinations remain required until a deliberate
pre-GA contract revision changes them across all consumers. Do not automatically
create a powerset of indexes, hide residual filtering, or leave a bundled
provider rejecting required queries. Stage 1 must resolve any infeasible shape:
choose a measured physical projection with affordable `F`, or explicitly revise
this PRD and its caller contract before implementation. A generic “indexed” label
is not resolution. Independent cost/provider reviews are inputs to this gate,
not presumed approvals.

### Cursor migration and existing callers

Use keyset cursors in the new storage contract; never a storage offset. Preserve
stable tie-breakers, exclusive bounds, both directions and filter/order identity
in the cursor. Cursors do not promise a snapshot across requests unless the
endpoint explicitly supplies one.

Current bundle APIs expose page/offset behavior as well as cursors. The target
pre-GA contract moves management list callers to cursors. Inventory server admin
routes and pagination response types, Standalone translation, CLI list commands,
Console tables/loaders, repository tooling, public examples and conformance
fixtures. Replace page-number navigation with next/previous cursor navigation
where necessary, and document the API break together with client changes.

No hidden offset-to-cursor walk is permitted. Any temporary legacy page route
must be explicitly outside the new bounded contract and removed or deliberately
resolved before final acceptance; it cannot remain the default caller path.
Consumers that explicitly request a full list may advance through the selected
result set. Exact totals remain explicit aggregates, not mandatory page metadata.

### Independent cost findings: required implementation decisions

F1–F9 refer to the independent cost review of cleanup `6725f4703` and historical
prototype `670050811`; the IAM observation was also checked at `2f4a51ddf`.
These remain open implementation risks, not acceptance evidence for the WIP.

| Finding | Concrete risk and required resolution/proof |
| --- | --- |
| F1: Release projection fanout | The prototype's 31 projections produce 101 physical actions for three ordinary Release inserts sharing parents, before a catalog write. Price inserts, indexed-field updates, scope moves and deletes after full expansion. Ordinary Release+catalog workflows must fit; rejecting an ordinary required operation is not a viable layout. |
| F2: Lost predicates | A recognized partition equality can cause an unsupported storage equality to disappear. Core rejects unknown runtime fields; lowering consumes every normalized predicate or fails before I/O. Test recognized+unsupported conditions together on list/count. This does not add fingerprint filtering to the public Release API. |
| F3: Count starvation | Broad scope-version checks can exhaust five attempts under unrelated bundle activity while repeatedly materializing matching IDs. Prove the consistency mechanism below, selected-range work, union memory, retry cost and liveness. Unrelated same-scope activity must not need to quiesce. |
| F4: IAM/key mismatch | `_hot-updater#insights-scope-v2#` does not match the old `_hot-updater#insights-scope#*` generated allowlist. Test actual membership/guard keys against generated least-privilege policies and deployed-role behavior; runtime, schema and IAM change together. |
| F5: Shard round trips | One-head Firestore refills can issue one serial request per emitted/skipped row; offset calls restart streams. Prove cursor continuation, bounded buffers, sparse/exhausted shards and serial request depth, not only first-page document counts. |
| F6: Lost set operations | A core cursor rewrite makes 61 sparse owners incur 61 serial queries; channel enumeration still repeats offset prefixes. Preserve native SQL set operations/IN sharding and use cursor continuation for channels. Test empty/sparse owners and one large owner. |
| F7: Mandatory totals | `responsePage` counts the entire original bundle predicate even for a cursor window. Request totals separately or use an applicable maintained counter. Window-only responses must not pay aggregate work; select only the cutoff ID when needed. |
| F8: Unneeded hydration | Reads can ignore field selection, index expansion can reread known previous rows, and a ten-row finite-ID page can hydrate 1,000 items. Preserve projections, reuse attempt state and select the key window before hydration, retaining required native guards. |
| F9: Unproved factory boundary | The deferred prototype still requires Insights callbacks and does not establish public factory adoption. Demonstrate the actual public ports, centralized policy, direct SQL and native batch/RPC forms at G1–G7. |

An optional candidate uses eight subsets of bundle/channel/target-version keys,
partitioned by platform and enabled state, and at most four streams when those
low-cardinality filters are omitted. It is unproven, not selected or required.
Stage 1 may evaluate it alongside other layouts; each must preserve accepted
predicates, ordering, consistency and ordinary atomic workflows and demonstrate
read/write budgets. PRD completion and cleanup publication do not wait for it.

### Latest-count consistency and availability

Distinguish exact `countLatestEvents` from approximate overview HLL metrics.
Recommend an exact point-in-time count of the selected canonical head set, with
bounded retries and explicit contention failure. Native snapshots or selective
range/partition protection must establish that result; a moving time index alone
cannot. A stable filtered bundle must remain serviceable while other bundles in
the same scope receive reports. Sustained writes affecting the selected set may
exhaust the stated retry budget; arbitrary-contention success is not promised.

At G7, select and prove the mechanism before API freeze. A published immutable
snapshot/watermark is an alternative if its freshness/lifecycle are explicitly
accepted and documented. Live traversal without snapshot exactness requires an
explicit contract decision, not silent guard removal. Use native counts for
single/disjoint ranges. Overlapping unions require deliberate identity
deduplication with measured minimum-key memory, not event payload hydration or
summing overlapping totals.

## 7. Provider and ORM delivery matrix

Every row requires behavioral, cost and atomicity evidence on the final baseline.
“Required” below describes work to prove, not completed implementation. Exercise
all publicly advertised engines/relation modes rather than treating one SQLite
fixture as evidence for every ORM dialect.

| Provider/profile | Required execution and access strategy | Specific proof or existing boundary |
| --- | --- | --- |
| `@hot-updater/postgres` | Direct PostgreSQL transactions, native constraints/conditional DML, selective composite indexes | No added staging reads; catalog/parent races; shared Insights rules and physical SQL plans |
| Kysely: PostgreSQL, MySQL, SQLite, CockroachDB | Transaction-bound port and dialect lowering; `foreign-keys` and `fumadb` relation modes where exposed | Lock/isolation and affected-row behavior per engine; emulated relations preserve phantom protection; SQL Server is not this adapter's supported profile |
| Drizzle: PostgreSQL, MySQL, SQLite | Native transactions; synchronous SQLite/compiled execution preserves callback lifetime; preserve lazy initialization and tooling | Prove CAS isolation and actual driver transaction behavior. A noninteractive/D1 driver needs an explicit compiled binding or is rejected at configuration; no fake callback transaction. CockroachDB/MongoDB/SQL Server are excluded by current adapter types |
| Prisma: PostgreSQL, MySQL, SQLite, CockroachDB | Callback transactions with proven isolation/constraints; both exposed relation modes | Prove matched-row semantics and fixed native upsert/HLL register-max expression costs; preserve lazy/disposal behavior where applicable, collations and exact identity ordering |
| Prisma: SQL Server | Preserve supported metadata behavior through native transactions | Current code rejects all Insights methods because string identity ordering is incompatible. Do not claim full Insights conformance; retain an explicit unsupported profile unless a separate baseline correction proves it. Prisma MongoDB remains unsupported; use the native MongoDB adapter |
| Native MongoDB | Session transaction, unique/compound indexes and explicit relation contention guards | Replica-set/transaction prerequisites; parent/child write-skew race and duplicate-event atomicity. Snapshot reads alone are not phantom protection |
| Cloudflare D1 Worker | Core SQLite compiler plus Worker `batch`, indexed reads | Ordered changes, later failure rollback, CAS, conditional Insights effects and physical row counts in Workers runtime |
| Cloudflare D1 HTTP | Same compiler and schema, native atomic HTTP batch transport | Independently prove rollback/result parity with Worker; separate requests cannot substitute for a batch |
| Supabase | Core PostgreSQL RPC routines, selective PostgREST/RPC reads, baseline indexes | One atomic RPC per write attempt, exception/rollback behavior, complete ordered effects, no post-filter pagination |
| Firebase / Firestore | Core staging in Firestore transaction, keyed documents and composite indexes | Reads before flush, transaction retries, absence/deletion cache, multi-IN shard cursor merge, relation guard invalidation |
| AWS / DynamoDB | Core staging plus conditional transaction, keyed projections for exact query shapes | Strong guards, `ScannedCount`/consumed work, recent-head ranges, projection fanout, item/action/byte limits and ambiguous retries |
| Mock database | Same core semantics over deterministic in-memory storage | Contract oracle and failure injection only; not evidence of native cost/isolation |
| External custom adapter | Public factory and published types/tests, installed from packed artifacts | At least one working SQL adapter and one staged adapter example; no workspace aliases, internal imports, copied domain rules or native model overrides |
| Standalone | Direct HTTP `BundleRepository` models/commits; cursor parameters flow to server | Preserve custom routes and remote semantics; do not emulate storage CRUD or promise atomic envelopes the server does not provide |

All bundled providers must migrate through the authoring factory. Existing
unsupported profiles must be tested as explicit boundaries; they do not count
as passing full-provider rows. Adding new engines or resolving the pre-existing
SQL Server Insights limitation is not required to satisfy this PRD. Silently
removing previously supported operations to make a row green is prohibited.

## 8. Single pre-GA 1.0.0 infrastructure baseline

The schema marker stays `1.0.0`. Apply every required key, constraint, projection,
summary, guard and routine correction to the existing initial schema/migration
for each provider. Do not add `1.0.1`, a second initialization migration, or an
archive-to-manifest compatibility migration for this work.

The authoritative Bundle row includes `manifest_storage_uri`,
`manifest_file_hash` and `asset_base_storage_uri`. Keep the merged manifest v1
artifact contract and its patch descriptors. Archive integrity/size belongs to
the signed manifest, not restored archive-specific Bundle columns. The historical
WIP schema must not overwrite this baseline; verify the refreshed prototype
against the merged row contract before porting its changes.

Keep SQL initialization, ORM schema generators, D1's
`0001_hot-updater_1.0.0.sql`, Supabase's existing `1.0.0` initialization, Firestore
indexes, DynamoDB projections/IAM and packaged scaffolds consistent. Update the
existing [1.0.0 infrastructure instructions](../../packages/hot-updater/infrastructure-upgrades/1.0.0.md)
and shared doctor requirement as necessary, including prerequisites and every
provider's verification steps. Future GA upgrade history is unaffected by this
explicit pre-GA baseline rule.

Fresh installations must initialize directly to the final shape. Existing RC
resources require inspected, explicit reconciliation preserving identities,
secrets and usable data; an already-recorded initialization marker is not proof
of current readiness. Never replay initialization destructively or perform
request-time repair. Retain existing Insights coverage rules instead of silently
backfilling old raw events into new summaries.

## 9. Acceptance: meaningful RED to GREEN evidence

### API-freeze gates

The native review raises source-derived D1 `delete -> update`, expectation-only
and conflict-diagnostic counterexamples, and missing explicit PostgreSQL/Drizzle
CAS isolation guarantees. Reproduce or disprove them with native execution;
these observations are proof obligations, not verified runtime bug claims.
G1–G7 block SDK API freeze, not PRD finalization or cleanup publication.

| Gate | Required executable proof |
| --- | --- |
| G1: One policy | Catalog CAS, staged-child/parent deletion, head-changing event and duplicate event execute on PostgreSQL/Kysely, Firestore, DynamoDB, D1 Worker/HTTP and Supabase. A changed core Insights/relation rule reaches all bindings and generated RPC artifacts without hand-edited policy copies. |
| G2: Direct SQL | Plain/no-op patches, catalog upsert and overview counter/HLL maximum updates avoid speculative snapshots, reloads and overview SELECTs. Prove Prisma's native expression binding and synchronous Drizzle transaction lifetime. Itemize necessary head/guard reads. |
| G3: Ordered atomic results | `delete -> update`, `insert -> delete -> update`, expectation-only input and late failures preserve conflict indices and rollback. Test existing/absent catalog and head races, PostgreSQL/Drizzle isolation, D1 in-batch assertions, RPC rollback and failed-guard version diagnostics. |
| G4: Staging/protection | Cached absence and unique-alias deletion, all reads before flush, parent protection before enumeration, zero-net relation changes and same-item physical coalescing work without provider-authored overlays/domain callbacks or phantom orphans. |
| G5: Complete bounded queries | Consume every supported predicate; recognized+unknown runtime conditions fail before I/O. Trace multi-page/shard/sparse-owner continuation, limited finite-ID hydration and separately requested totals, including requests, serial depth and bytes. |
| G6: Physical viability/deployment | Three Releases sharing parents plus actual catalog publication fit the ordinary workflow budget after native expansion. Test indexed updates/moves/deletes, oversize rejection, generated-key IAM coverage, schema/RPC compatibility and scaffolds in the single `1.0.0` baseline. |
| G7: Counts/external authors | Prove selected count consistency under unrelated same-scope churn and sustained matching churn; record retry/failure behavior and union memory. Two packed external adapters, SQL and staged, use public exports and pass shared conformance without domain copies. |

### External author journey

A1 and G7 must exercise the published guide from an empty provider project, not
only a preassembled adapter fixture. Use Better Auth's installation, public
import, registration and shared-test progression as the comparison. The
following checks are additional evidence for those gates, not a new SDK design:

| Step | Required author-facing evidence |
| --- | --- |
| Install and import | The documented commands install compatible runtime/test packages and required peers. Guide examples typecheck against packed public exports outside the monorepo, without path aliases or `/internal` imports. |
| Register and run | One SQL and one staged example include their actual storage bindings, schema/bootstrap instructions, first filtered read and atomic write. Every local helper is supplied; omitted domain implementations, dummy callbacks and type casts cannot make an example pass. |
| Understand ownership | The guide separates author-supplied storage operations from factory-owned rules. A provider author never needs to infer latest-head transitions, summary attribution or relationship policy from a method name. Current `models + commit` examples remain labeled as the current contract until the factory ships. |
| Own the lifecycle | Construction does not open a connection just to describe the adapter. Examples distinguish a borrowed client from an owned client, exercise optional disposal, and show test creation/reset/destruction without double-closing a client or leaking a database. |
| Verify the backend | The guide registers the published conformance suite against the actual implementation, with all local test-fixture code available. Native rollback, concurrency and physical-cost checks remain explicit; passing HTTP tests alone is not proof of those guarantees. |
| Handle native limits | A backend without the required atomic primitive has a documented error before writes. D1/RPC and synchronous-driver examples use their real execution binding, and supported filters survive it. No page/offset or native-count example claims constant physical work merely because the response is small. |

Until the authoring factory is implemented, the public guide must candidly state
that custom authors implement complete domain models and native commits. A
composition-only snippet is labeled as wiring, not advertised as a working
storage adapter. The future examples above must remove that remaining burden;
renaming or exporting the internal factory is insufficient.

### Full delivery scenarios

Each row requires a failing scenario or deliberately broken adapter before the
fix, then passing evidence on the final implementation. These are required tests,
not claims that tests have already been written or run. Record provider, engine,
revision, schema and measured bounds; unavailable native infrastructure is an
open gate, not a passing mock substitute.

| Gate | RED scenario | GREEN evidence |
| --- | --- | --- |
| A1 Public authoring | Packed consumer cannot import the factory/types, or must implement Insights/models/internal helpers | External SQL and staged examples build/use only public exports and pass published HTTP/OTA conformance |
| A2 Validation boundary | A later malformed change starts I/O or lets a native path mutate | Zero provider calls for invalid input; same validation/result rules across every family |
| A3 Ordered atomic changes | Insert/update/delete, delete/update, missing update after a valid write, or staged parent/child changes yield wrong state/index | Correct first conflict and rollback, read-your-writes and cached absence in every family, including D1/RPC |
| A4 CAS and reference races | Concurrent catalog CAS has two winners; parent delete races with child insert/replacement; net-zero replacement escapes guard | One valid winner, no orphan rows, guard captured before enumeration and invalidated by all relevant mutations |
| A5 Insights | Duplicate, out-of-order or equal-time events and ambiguous retry double-count or regress a head; user association moves leave wrong membership | Immutable event no-op on duplicate; canonical ordering, attribution, counters, unique users, distributions and coverage agree across providers |
| A6 Selective queries | Many nonmatching Releases precede a rare match; large old/nonmatching head population surrounds a recent subset | Hold matches fixed and grow unrelated fixtures by orders of magnitude; evaluated work stays within section 6 bounds, not merely returned row counts |
| A7 Continuation | Multiple Firestore IN shards and patch owners span many pages; offset/prefix reads repeat work | Advancing cursor trace, bounded merge heads/replay, exact order/no omissions; selected-child growth is linear; empty sets/zero limits perform no reads |
| A8 Existence and SQL cost | Deleting a referenced parent counts/hydrates all children; plain SQL update stages a snapshot | Protected existence at most `D + 1` candidates or native constraint; direct update has no speculative snapshot/extra hydration versus the equivalent native operation |
| A9 Native limits/failure | Failure late in D1 batch/RPC or an oversized expanded DynamoDB write leaves partial state | Entire operation rolls back or is rejected before writes; exact physical-action budget; no splitting; bounded retry exhaustion is explicit |
| A10 Baseline/tooling | Fresh schema lacks guard/index/routine; old manifest row is restored; lazy factory connects eagerly | Every initial `1.0.0` schema, generated ORM schema and scaffold agree; manifest fields persist; lazy/disposal and runtime/tooling boundaries hold |
| A11 Protocol/caller migration | Old offsets survive in an internal loop, filters disappear in HTTP translation, or cursor consumers truncate | All supported query shapes and migrated callers pass; reverse lookup and full enumeration remain complete; documented pre-GA pagination transition |
| A12 No repair fallback | Missing summary/index causes raw history scan or automatic projection rebuild | Explicit readiness failure with zero fallback scan; repair is a separate infrastructure operation |

Physical instrumentation must include native requests and evaluated work where
available: DynamoDB `ScannedCount`, SQL execution plans/row counts, D1 metadata,
and Firestore query evidence plus document/request traces. Instrument transaction
retries and projection writes too. If an emulator cannot establish engine work,
provide representative engine evidence; do not replace a cost claim with a
source-code search or elapsed-time-only benchmark.

Retain `setupDatabasePluginTestSuite` from published `@hot-updater/test-utils`
for every database provider and ORM, with lifecycle and thin `createHttpClient`.
Use `startHttpTestServer` for loopback HTTP and `createHandlerHttpTestClient` for
Workers. Every `examples-server` harness runs `setupReleaseCatalogTestSuite`
against its real server URL and authentication headers. Shared HTTP scenarios
must use admin/client APIs rather than database/compiler shortcuts. OTA scenarios
use production selection and retain device state through update, rollback and
built-in fallback. Add native cost instrumentation alongside these scenarios,
not as a substitute for them.

## 10. Staged delivery and completion

1. **Requirements first, then cleanup publication.** Publish this finalized PRD
   and adversarial review as the first documentation-only layer on `next`, then
   merge it through the existing cleanup layers for eleven total. Keep #1331
   scoped to public-facing contract docs. F1–F9, budgets and G1–G7 are recorded
   requirements/prototype gates; finished index implementation is not a
   prerequisite for publication. Existing layers retain their verified cleanup
   scope and must not claim the pending SDK/Insights/cursor work is implemented.
   Continue access-path/caller inventory and optional layout experiments as
   implementation preparation, without delaying document completion.
2. **RED cases and boundary prototypes.** Reproduce the cost and atomicity
   scenarios, then prove the proposed ports with PostgreSQL/Kysely, Firestore,
   DynamoDB, D1 Worker/HTTP and Supabase. Resolve section 4's bounded representation
   decision and pass G1–G7 before freezing or advertising SDK types. Exact types,
   native layouts and measured costs remain provisional until this gate; a
   necessary requirements change must be explicit and reviewed.
3. **Shared semantics and authoring entry.** Implement typed keys/ranges,
   validation, direct/staged orchestration, Insights rules and native compilers
   from the shared rule representation. Export the complete public surface and
   packed author examples. Establish baseline schema requirements before rollout.
4. **Provider migration.** Migrate every matrix row with engine-specific evidence,
   preserving tests and deleting only superseded execution paths. Port useful
   refreshed WIP changes against the manifest baseline. Reject SQL read
   amplification, unbounded queries and duplicated domain rules at review.
5. **Consumer and infrastructure delivery.** Migrate cursor callers and HTTP
   contracts together; align `1.0.0` initialization, generators, scaffolds, IAM,
   readiness and documentation. Coordinate metadata and Insights writers during
   explicit projection rebuilds before publishing readiness markers; old writers
   cannot keep writing only obsolete keys. Record compatibility changes and
   affected-package changesets with their implementation layers.
6. **Integrated acceptance.** Run build, types, lint, unit and required native
   integration/conformance checks, including packed consumers/scaffolds after
   build. Review the final merged tree for cost, atomicity and schema drift.
   Keep PR descriptions scoped to delivered behavior and remaining gates; use
   normal pushes only. Passing cleanup validation, including D1/native suites,
   does not certify the target SDK or the stronger cost/ownership requirements.

Implementation is complete only when G1–G7, the provider matrix and A1–A12 have
recorded evidence, all required caller/schema changes are present, and no native
feasibility or public API-freeze blocker remains. Earlier cleanup metrics,
smaller line counts and the existence of a prototype cannot substitute for this
evidence.
