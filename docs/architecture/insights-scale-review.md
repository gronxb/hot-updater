# Insights scalability implementation review

Date: 2026-09-02
Design: [Insights beyond 50,000 events](./insights-scale-plan.md)

## Decision

The implementation removes the 50,000-event read ceiling without changing raw
event retention. Every official database integration now implements the same
required `InsightsModel`:

```ts
interface InsightsModel {
  append(row): Promise<void>;
  pageEvents(input): Promise<InsightsPageEventsResult>;
  pageInstallations(input): Promise<InsightsInstallationPage>;
  getReport(input): Promise<InsightsReportResult>;
  pageReport(input): Promise<InsightsReportPage>;
}
```

The old generic event CRUD, `scan`, optional capability checks, offset adapters,
and alternate v1 routes are removed. This project is still pre-release, so the
cutover does not include compatibility shims, dual writers, or deprecated public
types.

## Adversarial agreement

The implementation was reviewed from both the server maintainer and external
database plugin developer perspectives. They agreed on these release conditions:

- the five-method model is the only public database contract;
- every page owns bounded lookahead and opaque continuation state;
- search and reports publish immutable snapshots with exact totals;
- raw events remain the source of truth while derived state can be rebuilt;
- malformed input and cursors fail before provider reads where possible;
- a stable lowercase UUID namespace fences every durable database;
- maintenance is provider-internal and never expands the public model;
- every official provider must pass the shared semantic conformance suite;
- HTTP, Console, and E2E clients cut over together, without an offset fallback.

The final code follows those conditions. Provider-specific storage and lease
mechanics remain inside provider or SQL-dialect boundaries; shared semantics and
validation remain in `plugin-core` and `test-utils`.

## Provider implementation

| Integration | Native read strategy | Durable derived state |
| --- | --- | --- |
| DynamoDB | partition and index keyset queries | source ledger, jobs, publications |
| Cloudflare D1 | indexed SQL keysets | source state, jobs, publications |
| Firebase | ordered Firestore queries | source state, leases, publications |
| PostgreSQL plugin | indexed SQL keysets | source state, jobs, publications |
| Supabase | bounded scalar RPCs | source state, jobs, publications |
| Drizzle adapter | dialect-aware indexed SQL | source state, jobs, publications |
| Prisma adapter | raw dialect SQL in callback transactions | source state, jobs, publications |
| Kysely adapter | dialect-aware indexed SQL | source state, jobs, publications |
| MongoDB adapter | compound-index keysets | source ledger, jobs, publications |
| Mock/test database | deterministic in-memory pages | deterministic projection state |

SQL dialect code is split only where schema, query syntax, or transaction
behavior differs. Related provider state machines and their tests remain
co-located; the cutover does not add generic one-use abstraction layers.

## Bounded behavior

- Public pages accept 1 to 100 rows and enforce a 1 MiB serialized result.
- Cursors are limited to 8 KiB and bind the database namespace, query identity,
  publication, and ordering revision.
- Search text is limited to 32 KiB.
- Public events are limited to 20 KiB canonical JSON.
- A maintenance request is limited to 4 MiB and provider-specific item budgets.
- Providers use keyset pagination and bounded lookahead. No Insights read uses
  database `OFFSET` or loads the complete event history.
- Search membership and report sections publish exact totals. A short or empty
  page does not imply exhaustion; only a null cursor does.

## Data safety

- `append` validates canonical lowercase UUIDv7 event IDs and the complete event
  before storage mutation.
- The installation key is SHA-256 of UTF-8 `JSON.stringify(installId)`. Providers
  retain and compare the full installation ID, so a digest collision is storage
  corruption rather than a second identity.
- JavaScript lowercase, literal substring, and UTF-16 string ordering semantics
  are reproduced across providers.
- Projection poison keeps the raw event, source checkpoint, and source generation
  unchanged. Reopening another process observes the same durable failure.
- Publication, bookmark, lease, and source-generation mismatches fail closed.
- A configured namespace mismatch cannot silently attach a process to another
  database's cursors or projections.

## HTTP and Console cutover

The admin API exposes canonical event pages through `GET /events`, including the
unfiltered newest-first history. Installation search uses explicit selector
kinds and cursor pagination. Reports return `ready`, `stale`, `preparing`, or
`failed` states and page immutable sections by publication ID.

The Console consumes the model directly in local mode and the same response
contract through HTTP in standalone QA. It no longer scans or translates offsets.
All Events is reachable from Insights without entering a search. Installation
history uses an exact installation selector, while user and substring searches
publish stable result sets.

## Verification

The following checks are green on this branch:

- formatting across 1,086 files and lint across 1,092 files with no warnings or
  errors;
- package type checks across all 34 workspace projects;
- the complete 26-project production build, including documentation dead-link
  checks;
- packed ESM and CommonJS consumers for AWS, Cloudflare Worker, Firebase,
  PostgreSQL, Supabase root, and Supabase edge;
- the complete unit workspace: 313 files, 2,768 passed, 37 skipped;
- the complete integration workspace: 49 files and 478 tests passed, with 7
  files and 81 tests skipped by environment guards;
- PostgreSQL search and report tests that traverse more than 50,000 rows in
  bounded steps;
- Supabase native scale and populated-migration tests: 19 passed;
- the complete Console package: 52 files and 149 tests passed;
- Detox Insights HTTP/QA and harness contract tests after the cursor cutover.

A refreshed 375px Events screenshot is checked in with the responsive review.
Exact-commit standalone provider runs are recorded in the pull request after the
branch is synchronized with `next`.
