# CLAUDE.md - @hot-updater/plugin-core

This file provides guidance to Claude Code when working with the plugin-core package.

## Package Overview

`@hot-updater/plugin-core` is the public kit that adapter and server plugin authors depend on, including Hot Updater's own adapters and official plugins. It contains the adapter contracts and storage helpers, the storage engine with its KV, SQL and memory kits and core's schema, and server plugin authoring.

- Its root is the whole public API. It has no internal entry or subpath (see the root CLAUDE.md, "Package Boundaries").
- Every root name is either taught by the docs or implemented by an adapter, and its JSDoc says which.
- Code that only this package uses stays unexported.
- `CoreSchema` is public, so a change to core's tables releases this package and comes with a migration.

## Runtime Compatibility

**CRITICAL**: This package MUST be compatible with the following JavaScript runtimes:

- **Node.js** (18+)
- **Bun** (1.0+)
- **Deno** (1.30+)
- **Cloudflare Workers** (edge runtime)

### Runtime Compatibility Requirements

1. **No Node.js-specific APIs**: Avoid using Node.js-only modules (fs, path, etc.) unless conditionally imported
2. **Use Web Standard APIs**: Prefer Web standards (fetch, Response, Request, Headers, etc.)
3. **Universal dependencies**: Only use dependencies that work across all runtimes
4. **No native bindings**: Avoid packages with native dependencies
5. **Edge-compatible**: Code must work in Cloudflare Workers' V8 isolate environment

### Testing Across Runtimes

When making changes, ensure compatibility by testing:

```bash
# Node.js (default)
pnpm test

# Bun
bun test

# Deno
deno test

# Cloudflare Workers
pnpm test # Uses @cloudflare/vitest-pool-workers
```

## Key Components

### Storage Engine and Database Adapter Kit

- `src/database`: the `DatabaseAdapter` contract, `createMemoryAdapter()`,
  `verifyAdapter()`, value helpers, and the distinct-count sketches of
  aggregate `distinct` metrics.
- `src/engine`: `createEngine(database, { plugins, now })`, the engine
  `createHotUpdater` runs (core's and the plugins' tables, the schema fence,
  pruning during writes, aggregate batching), `createEngineDatabase` (whose
  `retry` tunes transaction reruns for a store), `meterReads` for adapter cost
  analysis, the KV and SQL kits, the document-store and ORM adapter helpers,
  and core's schema and migrations. The engine's, fence's and migrators'
  internals stay unexported.

### Server Plugin Authoring API

- `src/serverPlugin`: `definePlugin` and its CLI metadata (`clientCredential`,
  `clientPlugin`), the schema DSL, the typed database handle, the explicit
  `CoreReads` interface, and the errors plugins handle, all from the root.
  The official plugin packages (`plugins/insights`, `plugins/api-keys`) take
  this package as a peer, as third-party plugins do. The official-plugin
  brand is a convention, not an export: each package that needs it keeps a
  local helper over `Symbol.for("@hot-updater/server/official-plugin")`.

### Utility Functions

- `calculatePagination()`: Pagination calculation helper
- `compressionFormat()`: Compression format detection and handling
- `filterCompatibleAppVersions()`: App version compatibility filtering
- `generateMinBundleId()`: Generate minimal unique bundle IDs
- `parseStorageUri()`: Parse and validate storage URIs
- `semverSatisfies()`: Semantic version comparison

### Type Definitions

Located in `src/types/`, provides TypeScript interfaces for plugins and core functionality.

## Development Guidelines

### Code Style

- Follow the root OXC configuration
- Use Web Standard APIs wherever possible
- Avoid runtime-specific code paths unless absolutely necessary

### Dependencies

- Current dependencies are edge-compatible: `es-toolkit`, `mime`, `semver`
- When adding new dependencies, verify they work in Cloudflare Workers
- Prefer pure JavaScript implementations over native bindings

### Testing

- Write tests in `.spec.ts` files alongside source files
- Shared suites, fixtures and test stores come from `@hot-updater/test-utils` (a devDependency); none ship from this package
- Test edge cases for runtime compatibility
- Use Vitest for testing
- Tests should pass in all supported runtimes

### Build Configuration

- Uses `tsdown` for building (see `tsdown.config.ts`)
- Outputs both ESM and CJS formats
- Generates TypeScript declarations
- `unbundle: true` to maintain compatibility across runtimes

## Common Commands

```bash
# Build the package
pnpm build

# Type checking
pnpm test:type

# Run tests
pnpm test
```

## When Making Changes

1. **Check runtime compatibility**: Ensure code works in all target runtimes
2. **Avoid platform-specific APIs**: Use Web Standards
3. **Test thoroughly**: Run tests and verify builds pass
4. **Update types**: Keep TypeScript definitions up to date
5. **Consider edge cases**: Test with Cloudflare Workers constraints in mind

## Related Packages

This package is used by:

- Storage adapters (AWS, Cloudflare, Supabase, Firebase, Standalone)
- Database adapters (PostgreSQL, Cloudflare D1, Supabase, DynamoDB, Firestore, and the server's built-in Kysely, Drizzle, Prisma and MongoDB adapters)
- Build adapters (Expo, Bare, Rock)
- `@hot-updater/server`, which runs the engine, and the official plugin packages

Changes here may affect multiple plugins across the ecosystem.
