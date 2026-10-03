# @hot-updater/plugin-core

The kit that extends the Hot Updater server: the storage and database adapter
contracts and their helpers, such as `createStorageAdapter`, the release
catalog compiler, the server plugin authoring API (`definePlugin`, the schema
DSL, the typed database handle, and the database errors), and the storage
engine every database runs on, with `createEngine` and `meterReads`. Adapter
and server plugin authors import it from here and list it in
`peerDependencies`, as Hot Updater's own plugin packages do.

## Boundary with `@hot-updater/protocol`

- `@hot-updater/protocol` is the device-safe, zero-dependency package for what
  crosses a boundary: the formats and pure computations the app and the server
  share, and the contracts between a host and its extensions on the device,
  such as the client plugin contract. React Native imports it and the built-in
  Insights client, never plugin-core or the server.
- `@hot-updater/plugin-core` is the kit that extends the server: the adapter
  and server plugin contracts and their helpers. It runs wherever the server
  runs, in Node, Workers, Deno, or Lambda, depends on `@hot-updater/protocol`,
  never the reverse, and the app never imports it. When both sides need
  something here, move it to `@hot-updater/protocol` and re-export it from this
  package.

The public API is the package root, and it has no other entry. Hot Updater's
own packages use it the way any adapter or plugin does: a name another package
needs is on the root, with a JSDoc line that says why, and everything else stays
private to this package.

Core's tables are part of that API: `CoreSchema` types the `core` handle of
`createEngine`, and `coreSchema` and `coreTarget` are what tooling creates. A
change to core's schema is a release of this package, and it ships with the
migration that `schema.core` versions.
