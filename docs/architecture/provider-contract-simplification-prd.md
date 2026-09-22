# Provider contract simplification

Status: implementation in progress. Follow-up to #1330, targeting `next`.

## Problem and outcome

PostgreSQL and Kysely translate a small database interface into operations their
storage already supports. Other providers currently implement unused mutations,
translate domain queries through several intermediate representations, or emulate
a query engine just to participate in the same adapter.

Keep one public `models + commit` contract. A single adapter factory owns validation,
query planning and execution selection. Providers register storage operations;
they do not assemble shared model helpers. Make that factory usable with
either transactional CRUD or native models and a native atomic commit. Providers
must implement only operations that their chosen execution path actually uses.
Simplicity means fewer execution paths and fewer representations, not identical
line counts across databases with different atomicity and index constraints.

## Architecture reference

Reviewed Better Auth at commit `41b7dc15de41a8726422c392a4857d8764828891`:

- [Adapter factory](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/core/src/db/adapter/factory.ts)
  owns normalization and delegates database operations to a registered adapter.
- [Kysely registration](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/kysely-adapter/src/kysely-adapter.ts)
  and MongoDB bind their native transaction context to that contract.
- [Adapter authoring guide](https://better-auth.com/docs/guides/create-a-db-adapter)
  distinguishes storage logic from factory-owned behavior.

Adopt that ownership boundary, not a collection of public shared helpers. Retain
Hot Updater's fixed schema and atomic commit protocol; Better Auth's sequential
execution without transaction support cannot replace an OTA atomic commit. Do
not import its dynamic schema machinery or optional fallback algorithms.

## Scope

- Core: separate validated reads, model query planning, commit validation and
  transactional execution. Native composition must not need dummy CRUD writes or
  create generic models only to overwrite them later.
- PostgreSQL, Kysely, Drizzle, Prisma, MongoDB, mock: retain the transactional
  adapter and native query execution. They share the same validation boundary as
  native providers; no second SQL implementation.
- Cloudflare D1 (HTTP and Worker) and Supabase: retain native atomic batch/RPC
  commits and use shared composition; do not reimplement their transactions.
- AWS: compose native patch, Insights and API-key models with shared metadata
  reads and native commit. Remove the redundant low-level mutation path and its
  now-unused helpers. Exercise concurrency through the public commit path.
- Firebase: keep Firestore transaction staging, but address staged rows by keys
  and explicit relationships. Remove the general in-memory query engine from
  transactions. Persist only touched rows after all reads complete.
- Standalone: implement repository models directly over the HTTP contract.
  Remove domain-query -> generic WHERE -> local CRUD -> HTTP translations and
  unused legacy writes. It remains a BundleRepository, not a database plugin.

Storage/build plugins do not implement this database contract and need no change.

## Contract and invariants

1. Validate the complete commit before executing any provider operation. Native
   composition cannot bypass validation. Preserve ordered changes, expectation
   checks, conflict indices and rollback behavior.
2. Queries carry their filters, order, cursor and requested window to storage.
   Missing indexes or unsupported operations fail explicitly. No scan fallback,
   implicit backfill or arbitrary 50,000-row ceiling.
3. Scoped patch enumeration and finite-ID sharding may need continuation pages;
   they must never broaden to all bundles. Aggregates and explicitly requested
   lists retain their documented cost; this design does not claim constant cost.
4. A staged deletion stays deleted on subsequent reads in the same transaction.
   An insert followed by an update/delete uses the staged row. A missing-row
   update fails at its original change index and persists nothing.
5. Storage owns concurrency: SQL transactions/constraints, D1 atomic batches,
   Supabase RPC, Firestore transaction reads, DynamoDB conditional writes,
   counters and projection maintenance. No generic retry or best-effort commit.
6. Keep the existing public provider APIs, HTTP protocol, schema, index layout,
   pagination order and Insights semantics. No new migration is required. Any
   schema correction discovered before GA belongs in the single 1.0.0 migration
   and 1.0.0 infrastructure notes, never a 1.0.1 migration.

## Adversarial design review

| Challenge | Decision / proof obligation |
| --- | --- |
| Is this just moving complexity into a larger framework? | Use one adapter factory with typed transactional/native implementations. Query planners stay private to that factory; providers must not assemble shared helpers. Do not add a provider DSL or capability registry. Delete unused execution paths; report net source changes. |
| Will native models bypass the checks previously supplied by CRUD? | Commit validation belongs at the shared factory boundary. Preserve channel/Insights validation. Native row parsers and HTTP guards remain responsible for stored/remote rows. Test malformed input before provider calls. |
| Could a shared fallback silently page through the whole database? | The read adapter delegates only the explicit query. No exception-to-list fallback. Keep and run bounded-read regressions including reverse-patch lookup and finite-ID sets. |
| Does a Firebase cache resurrect a deleted row from Firestore? | Track fetched keys separately from staged row presence. RED test delete -> update and delete -> dependent insert; aborted transactions must not persist. |
| Can Firebase write early and then read another document? | Staging remains local until the callback completes. Native persistence runs once after all reads and validation. Emulator tests cover multi-model commits. |
| Can removing AWS CRUD bypass relation locks or transaction limits? | Public native commit remains the only metadata writer. Move low-level concurrency scenarios to that path and verify counters, version guards and patch-owner/base races against DynamoDB Local. |
| Are SQL/ORM implementations being made harder to support native stores? | Keep the existing CRUD adapter API compatible. Read/model helpers are shared underneath; do not require SQL providers to implement individual domain models. |
| Does Standalone lose filters, empty-IN behavior or unaligned offsets? | Translate the fixed domain query straight to HTTP parameters. Test simultaneous bounds, repeated IDs, zero limit, arbitrary offset and count. Fetch only intersecting pages. |
| Can a lazy ORM initialize sooner or lose its disposal behavior? | Preserve lazy construction and test runtime/tooling entry points. Avoid an unrelated generic lazy-object abstraction. |
| Should all provider algorithms be unified? | No. Native limits, constraints and index maintenance remain visible in their provider. Share semantics and conformance tests, not a lowest-common-denominator execution algorithm. |

## Implementation and verification

1. Add failing Vitest scenarios for native composition without CRUD writes,
   validation before native execution, and Firebase staged deletion semantics.
2. Extract the shared read and commit boundaries; migrate provider wiring while
   preserving transactional adapter compatibility.
3. Remove Standalone's query emulator, AWS's redundant mutation path and
   Firebase's general query engine for staged changes.
4. Run focused unit and provider integration/conformance tests after each change.
   Final gates: build, types, lint, whole unit suite, native Firebase/AWS/MongoDB
   integration and D1 conformance. Record unavailable infrastructure explicitly.
5. Review the final diff adversarially for atomicity, stale reads, cursor bounds,
   hidden scans, deleted test coverage, schema drift and package exports. Update
   this PRD with results and remaining limitations before opening the PR.

## Acceptance evidence

To be filled with test results, removed execution paths and review findings.
