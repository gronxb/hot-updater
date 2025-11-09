# CLAUDE.md - @hot-updater/plugin-core

This file provides guidance to Claude Code when working with the plugin-core package.

## Package Overview

`@hot-updater/plugin-core` is a core utility package that provides shared functionality for building Hot Updater plugins. It contains helper functions, type definitions, and abstractions used by storage and database plugins.

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

### Database Plugin Creation
- `createDatabasePlugin()`: Factory for creating SQL-based database plugins
- `createBlobDatabasePlugin()`: Factory for creating blob-storage-based database plugins (edge-compatible)

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
- Follow the root Biome configuration
- Use Web Standard APIs wherever possible
- Avoid runtime-specific code paths unless absolutely necessary

### Dependencies
- Current dependencies are edge-compatible: `es-toolkit`, `mime`, `semver`
- When adding new dependencies, verify they work in Cloudflare Workers
- Prefer pure JavaScript implementations over native bindings

### Testing
- Write tests in `.spec.ts` files alongside source files
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
- Storage plugins (AWS, Cloudflare, Supabase, Firebase, Standalone)
- Database plugins (PostgreSQL, Cloudflare D1, Supabase)
- Build plugins (Expo, Bare, Re.Pack, Rock)

Changes here may affect multiple plugins across the ecosystem.
