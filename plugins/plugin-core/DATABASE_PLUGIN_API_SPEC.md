# Database Plugin API Spec

Status: root Unit-of-Work amendment target

This spec defines the database plugin API that plugin authors and core runtime
code should converge on. It supersedes table-local mutation commits for new
root Unit-of-Work work: table APIs describe durable table operations, while the
root database API owns the commit boundary for a logical operation.

## Design principles

1. Table APIs describe row or logical-table operations only.
2. Domain workflows stay above plugin storage and may span multiple tables.
3. Core owns Unit-of-Work staging and read overlays.
4. Providers flush a grouped change set at the strongest durable boundary they
   can support.
5. Public plugin ergonomics avoid long-lived transaction handles until there is
   a proven need.
6. `updates.check` remains an isolated non-table fast path for runtime update
   checks.

## Public method shape

All provider-facing and core-assembled methods use this shape:

```ts
method(context, inputObject)
```

- `context` is the request or runtime context. It may be reused by host code, so
  core must scope and clean staged changes per logical operation.
- `inputObject` is always an object. Use `{}` when a method has no inputs.
- Public `begin` is not part of this API.

## Core-assembled database

Core exposes table operations plus a root commit:

```ts
database.bundles.get(context, { id })
database.bundles.list(context, options)
database.bundles.append(context, { bundle })
database.bundles.update(context, { id, patch })
database.bundlePatches.append(context, { patch })
database.bundlePatches.update(context, { id, patch })
database.analyticsEvents.append(context, { event })
database.ingestKeys.get(context, { keyHash })
database.ingestKeys.update(context, { keyHash, state })
database.commit(context, {})
```

`commit` is intentionally root-level. It is not a table verb, because one domain
operation may need to stage bundle, patch, analytics, and ingest-key changes
before any provider flushes durable state.

## Provider factory result

A provider returns durable read tables and one root commit:

```ts
providerDatabase.bundles.get(context, input)
providerDatabase.bundles.list(context, input)
providerDatabase.bundlePatches.get(context, input)
providerDatabase.bundlePatches.list(context, input)
providerDatabase.analyticsEvents.list(context, input)
providerDatabase.ingestKeys.get(context, input)
providerDatabase.commit(context, { changes })
```

Provider storage tables expose durable reads only. Mutations are staged by core
and delivered to the provider as a grouped `DatabaseChanges` payload at root
commit time.

## DatabaseChanges payload

`DatabaseChanges` groups table-specific changes so providers can flush one
logical Unit of Work:

```ts
type DatabaseChanges = {
  readonly bundles: readonly BundleChange[];
  readonly bundlePatches: readonly BundlePatchChange[];
  readonly analyticsEvents: readonly AnalyticsEventChange[];
  readonly ingestKeys: readonly IngestKeyChange[];
};
```

Each change carries an operation name and typed row payload. Providers should
process all groups under one native transaction when the backing store supports
it. Providers that cannot guarantee cross-table atomicity must document their
weaker guarantee in the provider package.

## Table verbs

Allowed table verbs are:

- `get`
- `list`
- `append`
- `update`

`commit` is not a table verb. Deletion is not a generic table verb in this spec;
shared domain deletion helpers stage the required table changes internally.

## Bundle deletion

Bundle deletion is a shared core/server domain workflow, not a provider table
method. The helper stages the affected `bundles` and `bundlePatches` changes and
then the caller performs one root `database.commit(context, {})` with any other
same-operation changes.

## Analytics and ingest keys

`analyticsEvents` is a generic event table. Metrics are derived by core/server
from bounded reads rather than written as metrics rows through bundle mutation
APIs.

`ingestKeys` is separate from analytics so key lifecycle state can be staged and
committed independently from event ingestion.

## Updates check fast path

`updates.check` is the only planned non-table exception. It may read optimized
provider state directly for runtime update checks and must not become a general
mutation surface.

## Unit-of-Work scope requirements

Core must provide an internal Unit-of-Work scope helper that:

1. creates a fresh staging scope for each logical operation;
2. overlays staged changes onto reads within the scope;
3. clears staged changes after successful root commit;
4. clears staged changes after failed operations; and
5. prevents reused context objects from leaking staged changes into later
   operations.

## Compatibility

This amendment is a deliberate breaking change for provider-facing database
plugin APIs. No compatibility shim is required unless implementation discovers a
small internal migration aid is cheaper than direct call-site updates.

## Current implementation review notes

As of this documentation update, the repository still contains the legacy
bundle-only Unit-of-Work surface in `plugins/plugin-core/src/types/index.ts` and
`plugins/plugin-core/src/createDatabasePlugin.ts`:

- `bundles.commitBundle(context?)` is still table-local.
- bundle mutation staging is bundle-only (`BundleUnitOfWork`).
- public callers still invoke `databasePlugin.bundles.commitBundle(...)`.
- `plugins/plugin-core/DATABASE_PLUGIN_API_SPEC.md` did not previously exist.

Those notes are implementation review findings, not an alternate contract. The
target contract above is the root-UoW contract approved by the RAL plan.

## Migration checklist

- Remove table-local `commitBundle` from public database table operations.
- Add root `database.commit(context, {})` to core-assembled database plugins.
- Add provider root `commit(context, { changes })`.
- Generalize bundle-only staging into `DatabaseChanges`.
- Move bundle patch, analytics event, and ingest-key mutations through root
  staging.
- Replace direct bundle deletion table calls with the shared domain deletion
  helper.
- Preserve `updates.check` as the isolated non-table fast path.
- Document provider atomicity levels in each provider package when the provider
  cannot guarantee cross-table transactions.

## Verification checklist

Implementation of this spec should prove:

- no table-local commit method remains in provider-facing table APIs;
- root commit receives grouped changes across all staged tables;
- a failed operation clears staged changes before context reuse;
- bundle deletion stages bundle and bundle-patch changes before one root commit;
- `updates.check` remains available without creating new non-table mutation
  exceptions; and
- provider type tests cover every supported database provider package.
