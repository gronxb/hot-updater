# Insights scalability implementation evidence

Date: 2026-09-01. Full target: [scale plan](./insights-scale-plan.md).
This is a staged rollout, separate from the mobile Console work in PR #1233.

**Design revision:** the user clarified that this is pre-release and backward API
compatibility is unnecessary. The additive implementation below records commit
`658329812`; its optional query surface, separate v1 route and retained offset API
are being replaced. Passing tests for that commit do not approve the revised
contract or the full provider/operation goal.

## Plugin-developer adversarial review

A separate reviewer explicitly adopted the persona of an external database plugin
author. They rejected the additive design under the clarified requirements and
agreed to direct replacement only under these conditions:

- One required query contract, with event pages, historical installation search
  and finite typed reports covering all eight operations; no old-plugin shim.
- Provider-owned lookahead/continuation and measured physical queries on each DB.
- Runtime read dependencies do not contain raw `scan`; maintenance owns backfill.
- Existing HTTP/RPC/Console consumers change together, with no `.eventPages`,
  `/insights/v1/events`, offset adapter or legacy response serializer left behind.
- Preserve raw events, cursor format validation, schema/layout versions and report
  generations; those are data-safety requirements, not API compatibility support.
- All providers, report result bounds, readiness/reuse, and migrations need code
  and execution evidence before final approval. An unsupported official provider
  is not an acceptable finished implementation.

The follow-up review agreed on append plus four required read ports:
`pageEvents`, `pageInstallations`, `getReport`, `pageReport`. Report sections are
bounded, single summaries reuse batch, and report cache keys exclude wall-clock
request time/page state. The plan records their responsibilities and remaining
storage correctness gates.

This is agreement on the contract and responsibilities, **not approval of a
rewritten implementation**. Commit boundaries, lease/replay/publication atomicity,
historical snapshot construction, section ordering and each provider's physical
read budget still need implementation evidence.

## Implemented subset

### Native event readers and ordered SQL

These are implementation building blocks, not the completed required runtime
contract. Supabase and Firebase page executors remain internal until that direct
replacement. Firebase's existing `scan` now uses an ordered native query with a
maximum batch of 1,000 instead of loading the event collection.

| Operation | Event queries | Maximum returned candidates |
| --- | ---: | ---: |
| Firebase global page | 1 | N + 1 |
| Firebase installation or bundle movement | 2 | 2 × (N + 1) |
| Firebase backfill initialization | 2 | 2 |
| Firebase backfill step | 1 | 200 |
| Supabase global page | 1 active SQL stream | N + 1 |
| Supabase installation or bundle movement | 2 active SQL streams | 2 × (N + 1) |

Firebase also checks its persisted index-preparation state; backfill transactions
read one checkpoint document. Supabase also checks index metadata. Those metadata
reads are separate from the event counts. These are query/result bounds, not
unconditional disk-I/O or Firestore billing guarantees.

Firebase hashes exact UTF-8 scope values for indexing and checks the original
value on every match. This preserves long identities without normalizing case,
whitespace, or Unicode; hash mismatches fail instead of silently filtering a
page. Canonical lowercase UUIDs keep timestamp/ID ordering identical across
Firestore and JavaScript. Lone-surrogate identities are rejected rather than
silently replaced during UTF-8 encoding. Direct append rejects them before reads;
mixed commits preserve atomic rollback but still read the existing catalog.

The internal backfill helper requires old writers to be drained first. It saves a
fixed upper ID, applies only derived key fields, and commits each bounded batch
together with its checkpoint. Source update-time preconditions and a transactional
checkpoint prevent partial advancement. It does not remove or rewrite raw fields.
Initialization uses the descending `id` field index, then an ascending document-key
probe in the same transaction to detect missing or mismatched IDs beyond that
bound. A pure descending document-key query failed in the real emulator and was
removed. Invalid source records stop preparation, including records inside the
captured range. Deployment readiness and public maintenance tooling remain part
of the unfinished provider rollout.

The Supabase RPC returns one JSON value containing the bounded page, avoiding
PostgREST's table-row cap. Anonymous/authenticated roles cannot execute it. Missing
RPC/index preparation maps to not-ready; permission errors and unrelated SQL
failures retain their original operational classification. There is no scan
fallback. The migration generator includes the RPC and its installation/type
index without changing the original event data.

Kysely and Drizzle now omit computed null-sort expressions only for the two
non-null event ordering columns. Actual SQLite execution and query-plan tests
cover 50,001 unrelated events, equal-time cursors, and preserved nullable-field
sorting. Other columns and models retain their existing ordering behavior.

Validation performed after pulling `73e73b0cf` (which already contains `next`):

- Full build: 26 projects; type checks: 34 projects; root lint passed.
- Root unit suite: 2,525 tests, including the RPC-readiness regression.
- Firebase event reads/writes: 64 tests passed on the emulator, including 50,104
  events, asymmetric movement directions, a fixed cutoff, and long Unicode scopes.
- Firebase backfill: 11 tests passed after fixing the descending-key query,
  including missing IDs before/after the boundary, durable resume, raw extension
  preservation, invalid-row rollback, and an injected stale write precondition
  rejected by a real Firestore commit. The latter is not a timing-based race test.
- Standard repository integration setup also passed the backfill and scalar-RPC
  suites together: 13 tests, with its emulator cleaned up after completion.
- Supabase scalar RPC: 2 real PostgreSQL 15/PostgREST 14.6 tests passed in each of
  three fresh-container runs with `PGRST_DB_MAX_ROWS=1`. TCP readiness avoids the
  image's temporary initialization-server race. CI prepares both required images.
- Independent Supabase generic-plan review: six executions of the actual SQL
  body on 50,104 rows. With `limit=1`, active index scans examined at most 2 rows
  globally and 4 for movement; inactive branches executed zero times. The
  [recorded plans](./insights-scale-evidence/supabase-generic-plan.jsonl) include
  the SQL source hash, engine version, fixture size, and executed statements.

The independent reviewer approved these implementation slices after checking
cursor boundaries, exact scope semantics, error classification and backfill
atomicity. Full-provider/report implementation approval is still outstanding.
The review also reproduced a pre-existing PostgreSQL/Supabase raw-text index
limit: some 1,024-character multibyte identities exceed a B-tree entry's byte
limit. This is an existing storage prerequisite, not a page-executor regression;
do not claim uniform long-identity support across all providers yet.

### Firebase write isolation

An independent adversarial reviewer approved the implementation plan, then the
external plugin-developer persona reviewed the actual three-file diff and the
emulator/type-check results, then approved this slice. This
slice changes storage access without adding a compatibility API:

- Direct event append uses immutable document creation after the existing input
  validation and schema check. It does not load event history or catalog rows.
- Catalog reads and mutations no longer load event history. Mixed commits stage
  only new events and use `transaction.create` in the same transaction as catalog
  writes; an existing event ID aborts the entire commit.
- An explicit internal event query still reads history separately and sees staged
  inserts. Queried history never enters the write maps or gets rewritten.

Firebase emulator integration: **54 tests passed**, including four new scenarios
covering unrelated malformed records/read-call isolation, duplicate event rollback
of a bundle update, same-batch duplicates, and concurrent append versus a mixed
commit for the same ID. Existing event extensions remain unchanged. Before the
fix, the first two scenarios failed while parsing unrelated collections.
Package type checks, root lint, and all 2,489 root unit tests also passed.

At that commit, explicit `findMany`/`scan` still read the event collection. The
native reader work above replaces `scan`; private generic event `findMany` and
the six-collection catalog snapshot remain. Required read ports, source counters,
report computation and the complete migration/tooling rollout are unfinished.

### Historical PostgreSQL/additive API slice

- Optional version 1 native event-page capability in plugin-core and the typed
  server API. Existing append/scan plugins and bounded aggregate methods retain
  their behavior. No raw events are removed or sampled.
- Additive admin `GET /insights/v1/events` with a strict query parser and versioned
  errors. It is not registered on the client handler. Mount it behind the same
  host-owned authentication as other admin routes; `handlers.admin` does not
  perform authentication by itself.
- PostgreSQL opts in for global events and bundle movement events. Installation
  movement is deliberately not enabled until its type/time index is migrated.
- The provider receives the final page size (1–100), performs lookahead and
  bounded merging, and resumes from the final emitted event tuple. Server pages
  have no mandatory total count, offset traversal, or automatic refill loop.
- Each PostgreSQL page checks the relevant existing indexes before querying
  events. Missing, invalid, partial, expression, mixed-direction, or nondefault
  operator-class indexes do not enable the native path. Readiness is checked
  again on warm instances; failed readiness does not fall back to scanning.

For example, `hotUpdater.insights.eventPages?.getPage({ scope: { kind: "all" },
limit: 50, beforeReceivedAtMs: Date.now() })` returns a live page. Send the same
scope/cutoff and the returned cursor for the next page. A fixed cutoff prevents
newer reports pushing the boundary, but late commits do not form a snapshot.
Refresh to begin a new view. A non-null cursor can accompany a short or empty
page on future capped providers; consumers must offer an explicit next action.

## Read budgets and limits

| Native scope | Data queries per page | Candidate rows returned to the adapter |
| --- | --- | --- |
| Global | At most 2 | At most N + 1 total |
| Bundle movement | At most 4 across two streams | At most 2 × (N + 1) total |

PostgreSQL also performs one catalog query per logical page, plus the existing
schema readiness wrapper. The limits above describe data query/candidate budgets,
not an absolute bound on physical disk I/O. The fixture's actual PostgreSQL plans
use the intended B-tree indexes without sorting or scanning unrelated events.
Optimizer settings/statistics can change plans. Concurrent manual index DDL is
outside this measured guarantee; migrations must mark affected scopes preparing
before index replacement to close the check/query race.

## Adversarial review

An independent read-only reviewer challenged the implementation before approval:

1. Moved lookahead ownership into the provider; rejected server-side truncation.
2. Split equal-time and older queries while sharing one candidate budget.
3. Preserved explicit continuation for capped providers instead of inferring
   exhaustion from a short page or recursively filling it.
4. Rejected blanket opt-in through generic `findMany`. Supabase response caps,
   SQL computed null ordering, MSSQL UUID ordering, and MongoDB expression plans
   require provider-specific verification before activation.
5. Found mixed-direction indexes passing a column-name-only readiness check.
   The catalog check now verifies ordering and operator classes as well.
6. Found indefinite readiness caching could allow a warm provider to scan after
   an index drop. The check now runs once per logical page.
7. Added public server input, query-version, row identity/type/order/scope, size,
   and continuation validation independently of adapter implementation.

The reviewer approved only this PostgreSQL global/bundle typed API slice after
re-running its tests, then separately reviewed and approved the additive admin
HTTP path. Other providers, Console integration, and the full eight-operation
matrix are not covered by those approvals.

## HTTP usage

For a host that mounts protected admin routes at `/hot-updater/admin`, request
`GET /hot-updater/admin/insights/v1/events?limit=50`. The first response supplies
`pagination.beforeReceivedAtMs`; send it with the returned `cursor` to continue.
The optional `scope=bundle&bundleId=<canonical-lowercase-uuid>` selects bundle
movement. Unknown/duplicate fields, `offset`, conflicting scope IDs, malformed
bookmarks and missing continuation cutoffs fail before data queries.

Errors use `{ "error": { "code": "..." } }`: invalid page input is 400,
unsupported native scope/provider is 501, missing indexes or schema is 503, and
unexpected storage/adapter failures are a sanitized 500. No error triggers a
legacy scan fallback. Existing HTTP routes retain their response shapes.

## Reproducible verification

Run with the repository's configured Node version:

```sh
pnpm exec vitest run --project='unit:default' plugins/mock/src/test/insightsEventQueries.spec.ts plugins/postgres/src/postgresInsights.spec.ts packages/server/src/insights/eventPages.spec.ts
pnpm --filter @hot-updater/plugin-core --filter @hot-updater/server --filter @hot-updater/postgres test:type
```

- Mock fixtures: 50,001 old events, 103 equal-time events, one-row interleaved
  stream pagination, cutoff changes, malformed bookmarks and executor results.
  These measure query count and transferred rows, not physical storage cost.
- PGlite runs the shipped PostgreSQL schema with 50,001 unrelated events and 103
  equal-time movements. Captured real queries are checked with `EXPLAIN ANALYZE`:
  expected indexes, no sort/sequential scan, and bounded examined result rows.
  Tests go through `createHotUpdater`, forbid the legacy scanner/count, and
  exercise index removal, mixed ordering, and recovery on the same warm instance.
- Server boundary tests cover short/empty continuation without automatic refill,
  invalid inputs/version, malformed results, and nonadvancing continuation.
- HTTP tests cover a Hono bearer-auth admin mount (missing credentials and valid
  client API keys cannot read admin events), client-route isolation, input
  validation before reads, unsupported providers/scopes without fallback, fixed
  cutoff continuation and sanitized structured errors. PostgreSQL additionally
  rejects noncanonical UUID scope/bookmark input before even the catalog query.

## Remaining release gates

The 50,000-row ceiling still applies to legacy methods and aggregates. This slice
does not remove that ceiling across Insights. Next stages must implement the
Console path, installation browsing/index migrations, remaining
official providers, exact reports/search and durable maintenance, existing-data
backfill, and the full provider/operation correctness and cost matrix. The
standalone E2E series checks OTA integration; it does not replace large-scale
Insights benchmarks. Its exact PR commit and task results will be recorded here.

The first full `standalone-dynamodb` attempt on `658329812`, job
`job-20260831160856-sjc1g3`, failed the runner's disk preflight (7.3 GiB available,
20 GiB required). This is not a successful scenario run. Remaining profiles were
not submitted; re-run the series after the contract replacement and disk preflight
are ready. No disk-space safety threshold is bypassed.
