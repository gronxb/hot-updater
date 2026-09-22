# Provider contract simplification

Status: implemented and verified. Follow-up to #1330, targeting `next`.

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
- Better Auth exposes the factory through the public `better-auth/adapters` and
  `@better-auth/core/db/adapter` entries. Its separate `@better-auth/core/db/internal`
  entry contains schema/index implementation facilities. See its
  [package exports](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/core/package.json)
  and [authoring entry](https://github.com/better-auth/better-auth/blob/41b7dc15de41a8726422c392a4857d8764828891/packages/better-auth/src/adapters/index.ts).

Adopt that ownership boundary, not a collection of public shared helpers. Retain
Hot Updater's fixed schema and atomic commit protocol; Better Auth's sequential
execution without transaction support cannot replace an OTA atomic commit. Do
not import its dynamic schema machinery or optional fallback algorithms.

This PR preserves Hot Updater's existing export boundary: external providers
implement the public `createDatabasePlugin({ name, models, commit })` contract;
the bundled adapter factory remains at `@hot-updater/plugin-core/internal`.
Consequently this change centralizes bundled-provider execution but does not
yet provide Better Auth's public factory-based authoring SDK. Publishing a
supported adapter-authoring entry would require an explicit API and type
compatibility contract. The custom-provider guide documents the current boundary.

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
  the repository's unused CRUD write wiring. Preserve custom HTTP routes and
  their existing remote methods. It remains a BundleRepository, not a database
  plugin.

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
| Can a parent version read absorb a concurrent child insertion? | Capture deletion targets and patch replacement owners before querying relationships. A concurrent child write must change that version, forcing the native commit to retry its reads. Guard Release parent writes even when patch counters do not change. |
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

### RED to GREEN

- Native commits accepted malformed changes before invoking their provider, and
  native channel models bypassed the transactional adapter's validation. Added
  failing tests at the public plugin boundary; the factory now validates every
  commit before dispatch, including a later invalid change in the same batch.
- Firebase fetched a missing or staged-deleted document repeatedly. The new
  tests observed two/three reads instead of one. Explicit loaded-key tracking
  preserves absence and staged deletions throughout the transaction.
- Reusing the actual DynamoDB native commit in concurrency tests exposed an
  orphan patch when insertion raced with parent deletion. Additional tests
  reproduced both bundle and channel deletion racing with Release creation.
  The parent snapshot/version correction passes all 11 concurrency scenarios,
  including physical transaction limits and aggregate-counter consistency.

### Review conclusions

- Providers register implementations with `createDatabasePluginAdapter`; read
  planning and commit validation are private implementation details of the
  factory. The additional read-only type requires no fake write methods.
- Firebase retains a small transaction-local row overlay, which is necessary
  for Firestore's reads-before-writes rule. It has no generic sorting, filtering
  or pagination engine. Native read queries and persistence still own indexes
  and Firestore operations.
- DynamoDB retains conditional transactions, keyed projections and aggregate
  maintenance. Removing these would lose atomicity or require scans; removing
  the duplicate CRUD writer reduces the number of mutation algorithms instead.
- Standalone delegates domain reads and commits directly to HTTP. Explicit
  window pagination and finite patch-owner enumeration remain because they are
  part of the requested operation, with no history-loading fallback.
- `next` commit `39f60f9dc` was merged before final validation, including its
  published HTTP/OTA conformance suite and Firebase field-replacement fix. Its
  Supabase RPC correction was folded into the initial 1.0.0 migration in #1330;
  this follow-up introduces no schema or index changes.

Runtime TypeScript changes relative to #1330 are +993/-2,200 lines (net -1,207),
excluding tests, fixtures, this document and the changeset. This includes the
factory implementation and the concurrency fix, rather than counting only the
deleted provider files.

### Merged-tree verification

| Gate | Result |
| --- | --- |
| `pnpm -w build` | 26 projects passed |
| `pnpm -w test:type` | 34 projects passed |
| `pnpm -w lint` | No warnings or errors |
| `pnpm -w test` | 301 files, 3,408 tests passed |
| D1 Worker integration | 6 files, 260 tests passed |
| Standalone/server handler integration | 1 file, 17 tests passed |
| Firebase, DynamoDB, MongoDB and packaged conformance integration | 7 files, 300 tests passed |
| Changeset status / `git diff --check` | Passed |

The unit run includes the published provider/HTTP/OTA conformance suite for
PostgreSQL, Kysely, Drizzle, Prisma, Supabase and MongoDB harnesses. D1 runs in the
Workers runtime; native Firebase, DynamoDB and MongoDB use local emulators or
containers. The packaged-consumer test exercises an external provider using the
packed `@hot-updater/test-utils` artifact, and mutation tests verify that broken
providers fail the public scenarios. These checks do not cover live cloud
deployments or every supported external SQL engine/version. No production data
or infrastructure was changed.
