# Database Plugin API Spec

## Root Unit of Work

Database plugin mutations are staged by core and flushed through a single
database-level commit boundary. `commit` is a root database operation, not a
table verb. This keeps domain workflows that touch multiple logical tables from
partially committing one table at a time.

## Public Runtime Shape

Core-assembled database plugins expose the root commit operation:

```ts
await database.commit(context, {});
```

Table operations remain storage-shaped:

- `bundles.getBundleById`
- `bundles.getUpdateInfo` as the isolated update-check fast path
- `bundles.getBundles`
- `bundles.appendBundle`
- `bundles.updateBundle`
- `bundles.deleteBundle` until the shared delete-domain helper fully replaces
  direct caller usage
- `channels.getChannels`

`bundles.commitBundle` is not part of the public `DatabasePlugin` type.

## Provider Factory Shape

New provider factories should flush durable changes through root commit:

```ts
return {
  bundles: {
    getBundleById,
    getUpdateInfo,
    getBundles,
  },
  commit(context, { changes }) {
    // changes.bundles contains staged insert/update/delete bundle changes.
  },
  channels: {
    getChannels,
  },
};
```

The current plugin-core wrapper still contains an internal compatibility bridge
for legacy provider-local `bundles.commitBundle({ changedSets })` factories while
providers are migrated. That bridge is not exposed on the public runtime type.

## Change Payload

`DatabaseChanges` is an aggregate root payload:

```ts
type DatabaseChanges = {
  readonly bundles: readonly BundleChange[];
};
```

Future logical tables, including bundle patches, analytics events, and ingest
keys, must be added to this root payload rather than adding table-local commit
verbs.

## Explicit Non-Goals

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
- current bundle commit cleanup is success-only, so failed provider commits can
  leave staged changes attached to a reused context until the root scope helper
  adds terminal cleanup.
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
