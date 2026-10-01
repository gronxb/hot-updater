# Server Package Guidance

## Public Entry Boundaries

`@hot-updater/server` is the runtime host. Keep its entries strict:

- `@hot-updater/server` is the runtime-agnostic server entry.
  - Export `createHotUpdater`, its types, the handlers, and `toNodeHandler`
    for Node frameworks.
  - Do not expose public `createMigrator` or `generateSchema` methods on the
    root runtime API.
  - Do not require Node.js request/response types from the root entry.
- `@hot-updater/server/adapters/*` holds the built-in database adapters
  (Kysely, Drizzle, Prisma, MongoDB), each its own entry so a server loads only
  the one it uses.
- `@hot-updater/server/plugins/insights` and
  `@hot-updater/server/plugins/api-keys` re-export the built-in plugins.
- `@hot-updater/server/db`, `@hot-updater/server/diff`, and
  `@hot-updater/server/internal` hold tooling for Hot Updater's own CLI, Console
  and providers until it moves out of the server; add nothing to them.
- `scripts/ci/check-package-boundaries.mjs` pins this list. A new subpath needs
  a deliberate change there.

## What lives elsewhere

- The storage engine, the database adapter kit, and core's schema are in
  `@hot-updater/plugin-core`. The server runs them through its public API,
  `createEngine` above all, and imports nothing else from it.
- Plugin authoring (`definePlugin`, the schema DSL, the database handle) is in
  `@hot-updater/plugin-core`.
- Test suites, fixtures, and measured databases are in
  `@hot-updater/test-utils`, which the server's own specs use as a
  devDependency.

## CLI And Documentation Expectations

- CLI config examples should import `createHotUpdater` from
  `@hot-updater/server`.
- CLI database commands should derive migration/schema capability through
  `@hot-updater/server/db` helpers, not through public DB methods on the root
  instance.
- Express, Connect, or other Node framework examples import `toNodeHandler`
  from `@hot-updater/server`.
