# @hot-updater/plugin-core

The kit that extends the Hot Updater server: the storage and database adapter
contracts and their helpers, such as `createStorageAdapter`, the release
catalog compiler, and the server plugin authoring API: `definePlugin`, the
schema DSL, the typed database handle, and the database errors. Adapter and
server plugin authors import it from here and list it in `peerDependencies`, as
Hot Updater's own plugin packages depend on it.

## Boundary with `@hot-updater/protocol`

- `@hot-updater/protocol` is the device-safe, zero-dependency package for what
  crosses a boundary: the formats and pure computations the app and the server
  share, and the contracts between a host and its extensions on the device,
  such as the client plugin contract. It is the only Hot Updater library React
  Native imports.
- `@hot-updater/plugin-core` is the kit that extends the server: the adapter
  and server plugin contracts and their helpers. It runs wherever the server
  runs, in Node, Workers, Deno, or Lambda, depends on `@hot-updater/protocol`,
  never the reverse, and the app never imports it. When both sides need
  something here, move it to `@hot-updater/protocol` and re-export it from this
  package.

The public API is the package root. `@hot-updater/plugin-core/internal` holds
what Hot Updater's own packages share, which is not public API; add nothing
else as a subpath.
