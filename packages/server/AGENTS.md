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
- `@hot-updater/server/plugins/insights`,
  `@hot-updater/server/plugins/api-keys`, and
  `@hot-updater/server/plugins/remote-config` re-export the built-in plugins.
- Nothing else: no tooling entry. `scripts/ci/check-package-boundaries.mjs`
  pins this list, and a new subpath needs a deliberate change there.

## The definition tooling reads

What `createHotUpdater` returns is the server definition. Tooling (the CLI,
the Console, managed init) reads it only through its public, read-only,
documented properties: `core`, `api`, `database`, `storage`, `plugins`,
`clientPlugins`, `clientEndpoints`, and `clientAuth`. Keep each one documented
where it is declared, and add a property rather than a hidden symbol or a
tooling entry when tooling needs more.

## What lives elsewhere

- The storage engine, the database adapter kit, and core's schema are in
  `@hot-updater/plugin-core`. The server runs them through its public API,
  `createEngine` above all, and imports nothing else from it.
- Plugin authoring (`definePlugin`, the schema DSL, the database handle) is in
  `@hot-updater/plugin-core`.
- Test suites, fixtures, and measured databases are in
  `@hot-updater/test-utils`, which the server's own specs use as a
  devDependency.
- The CLI and IaC tooling (the server the CLI assembles from
  `hot-updater.config.ts`, client credentials, `db` migrators over a
  definition) is in `@hot-updater/cli-tools`; bundle diffs are in the
  `hot-updater` CLI.

## CLI And Documentation Expectations

- Server definition examples, such as `src/hotUpdater.ts`, import
  `createHotUpdater` from `@hot-updater/server`. `hot-updater.config.ts`
  never does: it lists the server's `database`, `storage`, and `plugins`.
- CLI database commands derive migration and schema capability from the
  definition's `database` through `@hot-updater/cli-tools`, not through
  methods on the root instance.
- Express, Connect, or other Node framework examples import `toNodeHandler`
  from `@hot-updater/server`.
