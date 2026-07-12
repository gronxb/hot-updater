# Experimental Database Connector v2

Status: maintainer RFC; Experimental reference implementation only.

Database connector v2 freezes an ORM-neutral contract before any SQL or managed
provider integration. It is published only from
`@hot-updater/plugin-core/database-v2`; the package root, database plugin v1,
server, CLI, console, and provider acceptance paths remain unchanged.

## Trust and topology

An authenticating host derives a non-empty `tenantId` and `principalId` and
passes them as an immutable `AssertedDatabaseScope`. The connector enforces the
assertion but does not authenticate a raw caller, and opaque `context` cannot
override either ID. Tenant rows are shared by principals authorized into that
tenant. Cursor and receipt identity additionally bind the principal to avoid
cross-principal disclosure or replay.

The trust boundary validates and snapshots caller-supplied data, but it is not a
same-realm code sandbox. The host must preserve the integrity of JavaScript
intrinsics and globals while connector code runs. A Proxy trap or callback that
mutates ambient globals, prototypes, Promise behavior, or platform APIs is
arbitrary code execution in the connector's realm and is outside this contract.
Untrusted code requiring that isolation must run in a separate realm or process.

The lifecycle is connector -> connection -> session. Connections and sessions
are independently open, closing, or closed; sessions can also be committing or
poisoned. A session permits at most one active commit. An indeterminate backend
outcome poisons it: reads and unrelated writes fail closed until an identical
scope, change-set ID, and payload retry produces a definitive result. Close is
idempotent, waits for active work, and never closes a borrowed client.

## Identity and reference behavior

Change-set payload, asserted scope, and manifest tuple identities use separate,
versioned SHA-256 domains. Canonical JSON preserves array order, sorts plain
object keys by raw UTF-16 code units, does not normalize Unicode, and rejects
unsupported descriptors, values, cycles, sparse arrays, invalid surrogates,
`-0`, and non-finite numbers. Committed and rejected receipt identities include
tenant, principal, change-set ID, and canonical payload hash.

The fixed reference manifest certifies only the checked-in tuple: native memory
adapter, JavaScript ES2022 runtime, `reference-memory-v1` schema, atomic
single-process commit, and opaque keyset cursors. The reference connector is
process-local, non-durable, retains its store and receipt index for the connector
object's lifetime, and may grow without a public disposal API. It is not a claim
of server, provider, multi-process, or general runtime support.

## Conformance and next gate

The structural conformance suite in `@hot-updater/test-utils` checks scope
isolation, atomicity, deterministic replay and conflict, cursor binding,
unknown-outcome recovery, and lifecycle behavior without importing plugin-core
implementation types. Maintainer validation for this Experimental change also
consumed packed local artifacts through ESM, CJS, and strict NodeNext
declarations and ran the checked-in SDK driver.

Extraction into a dedicated package and a Kysely adapter are deferred until
this Experimental contract is stable, SQL scope/schema ownership is designed,
and a server acceptance path exists. Any future Kysely, Drizzle, Prisma, or
managed-provider connector must declare a truthful implementation tuple, derive
its manifest digest from that complete tuple, and pass conformance for the exact
runtime, adapter, driver, target, schema, capability, and ownership claims it
publishes. Method presence or marketing compatibility is never certification.

## Explicit non-goals

- No database plugin v1 migration or compatibility bridge.
- No server, CLI, console, or managed-provider integration in this slice.
- No Kysely, Drizzle, Prisma, SQL schema, migration, or dialect implementation.
- No durability, cross-process, GA, certified-provider, or all-runtime claim.
