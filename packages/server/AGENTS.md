# Server Package Guidance

## Public Entry Boundaries

Keep the `@hot-updater/server` subpaths semantically strict:

- `@hot-updater/server` is the default runtime-agnostic server entry.
  - Export `createHotUpdater` and Web `Request`/`Response` runtime APIs here.
  - Do not expose public `createMigrator` or `generateSchema` methods on the
    root runtime API.
  - Do not require Node.js request/response types from the root entry.
- `@hot-updater/server/node` is only for Node HTTP interop.
  - Export `toNodeHandler` and directly related Node handler types only.
  - Do not export `createHotUpdater`.
  - Do not export DB tooling such as migration, schema, or bundle diff APIs.
- `@hot-updater/server/db` is the home for DB tooling.
  - Export migration/schema helpers such as `createMigrator(hotUpdater)` and
    `generateSchema(hotUpdater, version, name?)`.
  - Export DB tooling types, schema-readiness errors, and bundle diff helpers
    from this subpath.
  - DB helpers may consume the root runtime instance through runtime-neutral
    package-internal metadata, but they must not depend on Node HTTP interop.
- `@hot-updater/server/runtime` should not exist.
  - If a change reintroduces this subpath, stop and re-check the API direction.
  - Use `@hot-updater/server` as the runtime-agnostic entry instead.
- Existing `@hot-updater/server/adapters/*` subpaths remain adapter-specific
  provider entries.

## CLI And Documentation Expectations

- CLI config examples should import `createHotUpdater` from
  `@hot-updater/server`.
- CLI database commands should derive migration/schema capability through
  `@hot-updater/server/db` helpers, not through `/node` and not through public
  DB methods on the root instance.
- Express, Connect, or other Node framework examples may import
  `toNodeHandler` from `@hot-updater/server/node`, but should keep the
  `hotUpdater` instance itself created from `@hot-updater/server`.
- Release notes and changesets must not say DB tooling moved to
  `@hot-updater/server/node`; it belongs under `@hot-updater/server/db`.
