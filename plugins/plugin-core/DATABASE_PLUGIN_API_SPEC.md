# Database Plugin API Spec

## Unit of Work boundary

Database mutations are staged by plugin-core and flushed through one root commit
boundary. Table operations stage logical row changes; they do not commit durable
state themselves.

## Runtime database API

A configured `DatabasePlugin` exposes table operations for reads and staging:

- `database.bundles.getBundleById(...)`
- `database.bundles.getBundles(...)`
- `database.bundles.getUpdateInfo(...)` when supported
- `database.bundles.appendBundle(...)`
- `database.bundles.updateBundle(...)`
- `database.bundles.deleteBundle(...)`
- `database.channels.getChannels(...)`
- `database.analytics.*` when enabled

The only durable mutation boundary is root-level:

```ts
database.commit(context);
```

`commit` receives the optional request context and flushes every staged change in
that logical operation. `commit` is not a bundle-table method, and plugin-core
must not expose `database.bundles.commit` or `database.bundles.commitBundle`.

## Provider factory API

Provider factories return durable read methods grouped by table plus a root
flush method:

```ts
createDatabasePlugin({
  name: "provider",
  factory: () => ({
    bundles: {
      async getBundleById(bundleId, context) {},
      async getBundles(options, context) {},
      async getUpdateInfo(args, context) {},
    },
    async commit({ changedSets }, context) {},
    channels: {
      async getChannels(context) {},
    },
  }),
});
```

`changedSets` is a grouped `DatabaseChanges` payload derived by plugin-core from
all staged bundle-table operations in the current Unit of Work.

## Non-table fast paths

`bundles.getUpdateInfo` remains an optional read-only fast path for update
checks. It does not stage or commit changes.

## Provider atomicity notes

Providers should flush `DatabaseChanges` with the strongest atomicity their
backing store supports. Providers without a cross-table transaction primitive
must document that their root commit is an ordered best-effort flush.
