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
