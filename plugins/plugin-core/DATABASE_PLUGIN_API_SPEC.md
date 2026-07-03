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

- No public `begin` API. Core owns UoW staging.
- No table-local commit verbs on public runtime tables.
- No patch metadata writes through `bundles.updateBundle`.
