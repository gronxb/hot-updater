# Insights beyond 50,000 events

## Goal

Remove the 50,000-event query ceiling for every official database integration
without introducing unbounded reads. Raw event retention stays provider-owned;
public reads use bounded cursor pages and exact, durable projections.

This is a pre-release cutover. The new contract replaces the previous event
scan contract directly. There are no compatibility adapters, dual writers,
deprecated routes, or optional capability branches.

## Public database contract

Every database plugin implements one required model:

```ts
interface InsightsModel {
  append(row: BundleEventRow): Promise<void>;
  runMaintenanceStep(input: InsightsMaintenanceStepInput): Promise<void>;
  pageEvents(input: InsightsPageEventsInput): Promise<InsightsPageEventsResult>;
  pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  getReport(input: InsightsReportInput): Promise<InsightsReportResult>;
  pageReport(input: InsightsReportPageInput): Promise<InsightsReportPage>;
}
```

Every provider owns its maintenance state machine and implements the same
bounded step entry point. When a valid read returns `preparing`, the server runs
one step capped at 256 items and 512 storage requests, then rereads once. For a
`stale` read, it runs one step and returns the usable committed publication.
The server does not scan source data or emulate provider behavior.

## Required semantics

### Events

- Append-only raw events are the source of truth.
- Pages are newest first by `(received_at_ms, id)` with deterministic ties.
- Selectors support all events and one exact installation ID.
- A continuation cursor is opaque and bound to the exact query.
- Events accepted before a first-page cutoff remain visible throughout that
  traversal; later events do not move existing pages.

### Installations

- The latest event defines an installation's current bundle and metadata.
- Exact installation-ID reads remain live and cheap.
- `all`, exact user/legacy identity, and substring search use immutable
  published result sets so pagination cannot mix generations.
- Search retains full source strings and uses JavaScript lowercase, literal
  substring, and UTF-16 ordering semantics.
- Totals describe the complete result set, not the current page.

### Reports

- Active installations are distinct installation IDs in the requested window.
- Movement counts preserve existing bundle transition semantics.
- Reports expose an exact immutable summary and separately paged sections.
- Report pages bind the requested window, bundle filter, section, metric, and
  publication ID.
- Preparing, stale, expired, and failed states are explicit; readers never
  silently substitute a different generation.

## Bounds

| Boundary | Limit |
| --- | ---: |
| Public page rows | 100 |
| Serialized page response | 1 MiB |
| Cursor | 8 KiB |
| Query | 32 KiB |
| Raw event | 20 KiB |
| Maintenance input | 4 MiB |
| Server maintenance step | 256 items / 512 storage requests |

Providers own bounded lookahead. A page may be short or empty while still
having a continuation cursor; only a null cursor means exhaustion. Database
`OFFSET`, complete-history materialization, and request-sized in-memory
aggregation are prohibited.

## Storage identity and safety

`HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE` is a required stable lowercase UUID.
It fences cursor and projection identities across deployments.

Event IDs are canonical lowercase UUIDv7 values. Installation storage keys use
SHA-256 of UTF-8 `JSON.stringify(installId)` and retain the complete source ID
for collision validation. All strings must be well-formed JSON strings without
NUL code units; providers preserve exact raw extension fields.

Projection work advances a durable source checkpoint only after all derived
writes for the step commit. Invalid source data remains stored and leaves the
checkpoint and source generation unchanged. Leases, bookmarks, publications,
and storage versions fail closed when they do not match the configured
namespace or current schema.

## Provider implementation

| Integration | Native paging | Durable work |
| --- | --- | --- |
| DynamoDB | partition/index key queries | ledger, jobs, publications |
| Cloudflare D1 | indexed SQL keysets | source state, jobs, publications |
| Firebase | ordered Firestore queries | source state, leases, publications |
| PostgreSQL | indexed SQL keysets | source state, jobs, publications |
| Supabase | bounded scalar RPCs | source state, jobs, publications |
| Drizzle | dialect-aware indexed SQL | source state, jobs, publications |
| Prisma | callback-transaction raw SQL | source state, jobs, publications |
| Kysely | dialect-aware indexed SQL | source state, jobs, publications |
| MongoDB | compound-index keysets | ledger, jobs, publications |
| Mock | deterministic in-memory pages | deterministic projection state |

Each provider supplies schema installation and index-readiness checks with its
existing initialization flow. Shared validation and semantic conformance stay
in `plugin-core` and `test-utils`; provider query syntax and transaction rules
stay next to the provider.

## HTTP and Console cutover

- `POST /events` ingests one validated event.
- `GET /events` pages all or exact-installation history.
- Installation and report routes expose the public model's selectors and read
  states directly.
- Offset query parameters and versioned fallback routes are removed.
- Console Overview, All Events, lookup, and installation history use the same
  cursor contract in local and standalone modes.
- All Events is reachable without entering a lookup value.

## Delivery sequence

1. Replace the plugin-core contract and shared conformance oracle.
2. Implement provider-native event pages and durable source capture.
3. Implement immutable installation search and report projections.
4. Cut over server routes, Console queries, and standalone QA together.
5. Remove the old scan contract, optional capability branches, and fallbacks.
6. Verify package consumers, provider integrations, Console responsiveness,
   full workspace tests, and exact-SHA standalone profiles.

## Release gates

- Every official provider passes the shared semantic conformance suite.
- Native plan or candidate-read evidence shows bounded work beyond 50,000 rows.
- Cursor tampering, query mismatch, namespace mismatch, oversized input/output,
  expired publications, and projection poison fail closed.
- Packed ESM and CommonJS consumers load the public contract.
- Console event history has no horizontal overflow at 375, 768, and 1280 px;
  mobile controls remain at least 44 px.
- `pnpm -w build`, package type checks, `pnpm -w lint`, and `pnpm -w test` pass.
- `standalone-dynamodb`, `standalone-drizzle`, `standalone-prisma`,
  `standalone-kysely`, and `standalone-mongodb` pass sequentially on the exact
  pushed commit.
