# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hot Updater is a self-hostable OTA (Over-The-Air) update solution for React Native apps, serving as an alternative to CodePush. It consists of a monorepo with packages and plugins organized using NX workspace management.

## Key Architecture

### Adapters and Plugins
An adapter fills one slot of a config (`build`, `storage`, `database`, `signing`); a plugin is an entry of a `plugins` list. `plugins/plugin-core/` holds the shared contracts (`BuildAdapter`, `StorageAdapter`, `BundleSigningAdapter`), and the docs' overview (`docs/content/docs/(latest)/concepts/plugin-system.mdx`) describes how to write each one:
- **Build Adapters**: Handle bundling (Metro, Expo, Rock) - located in `plugins/bare/`, `plugins/expo/`, `plugins/rock/`
- **Storage Adapters**: Handle bundle storage (AWS S3, Cloudflare R2, Supabase Storage, Firebase Storage) - located in `plugins/aws/`, `plugins/cloudflare/`, `plugins/supabase/`, `plugins/firebase/`, `plugins/standalone/`
- **Database Adapters**: Handle metadata storage on one storage engine (Cloudflare D1, Supabase, DynamoDB, Firestore, PostgreSQL) - use the same directories as storage; the Kysely, Drizzle, Prisma, and MongoDB adapters live in `packages/server/src/adapters/`
- **Signing Adapters**: Sign bundle artifacts (local PEM, remote, AWS KMS, Google Cloud KMS) - `hot-updater/signing`
- **Integration Plugins**: Wrap a build adapter to upload source maps (Sentry, Datadog, BugSnag) - `plugins/*-plugin/`
- **Server Plugins**: Add tables, APIs, routes, and client auth to `createHotUpdater` with `definePlugin`, whose authoring API lives in `plugins/plugin-core/src/serverPlugin/` (`@hot-updater/plugin-core/server-plugin`, re-exported by `@hot-updater/server/plugins`) - the official `insights()` and `apiKeys()` are the packages `plugins/insights/` (`@hot-updater/plugin-insights`) and `plugins/api-keys/` (`@hot-updater/plugin-api-keys`), re-exported by `@hot-updater/server/plugins/*`
- **Client Plugins**: Run in the React Native app with `defineClientPlugin`, whose contract lives in `packages/core/src/clientPlugin.ts` (re-exported by `@hot-updater/react-native/client-plugin`) - the official `insights()` client is `plugins/insights/src/client/`, re-exported by `@hot-updater/react-native/plugins/insights`

### Core Packages
- `packages/core/`: Core types and utilities
- `packages/hot-updater/`: CLI tool and main commands
- `packages/react-native/`: React Native library for client-side integration
- `packages/console/`: Web-based management console built with React and TanStack Start
- `packages/android-helper/`: Android native build utilities and device management
- `packages/apple-helper/`: iOS/macOS native build utilities and device management

### Reference Projects
When working on helper packages, reference these external projects:
- **Android Helper**: Reference `~/Desktop/rnef/packages/platform-android` (can be referred to as "rnef" or "rock" in prompts)
- **Apple Helper**: Reference `~/Desktop/rnef/packages/platform-apple-helpers` (can be referred to as "rnef" or "rock" in prompts)

### Configuration
Projects use `hot-updater.config.ts` files that define build, storage, and database adapters using the `defineConfig()` function.

## Common Commands

### Development
```bash
# Install dependencies
pnpm install

# Build all packages and plugins
pnpm build

# Run tests
pnpm test

# Type checking
pnpm test:type

# Format code with OXC
pnpm lint:fix

# Check code with OXC
pnpm lint
```

### Release Management
```bash
# Test release (dry run)
pnpm release:test

# Create release (without publishing)
pnpm release

# Publish all packages
pnpm publish:all

# Publish release candidate
pnpm publish:rc
```

### Hot Updater CLI
```bash
# Initialize hot updater in a project
npx hot-updater init

# Deploy bundle
npx hot-updater deploy

# Open web console
npx hot-updater console

# Check project health
npx hot-updater doctor

# Generate fingerprint
npx hot-updater fingerprint

# Manage channels
npx hot-updater channel
```

## Development Notes

### CI/CD Requirements
**IMPORTANT**: All changes must pass the GitHub Actions workflow (`.github/workflows/integraion-typescript.yml`) before being merged. This workflow runs:

1. `pnpm build` - All packages and plugins must build successfully
2. `pnpm test:type` - TypeScript type checking must pass with no errors
3. `pnpm lint` - Code must pass OXC linting and formatting checks
4. `pnpm test` - All unit tests must pass

Before committing changes, always run these commands locally to ensure CI will pass:
```bash
pnpm build && pnpm test:type && pnpm lint && pnpm test
```

### Code Style
- Uses `oxfmt` and `oxlint` for formatting and linting (see `.oxfmtrc.json` and `.oxlintrc.json`)
- 2-space indentation, 80 character line width
- Semicolons required, arrow parentheses always

### Testing
- Uses Vitest with workspace configuration
- Cloudflare Workers testing uses `@cloudflare/vitest-pool-workers`
- Each plugin/package has its own test configuration

### Build System
- NX workspace with shared build targets
- TypeScript compilation with `tsdown`
- Outputs go to `dist/` directories

### Project Structure
- Monorepo with `packages/` (core functionality) and `plugins/` (provider integrations)
- Examples in `examples/` showing different React Native versions and configurations
- Documentation site in `docs/` using Waku and Fumadocs; see `docs/README.md`

### Native Modules
The React Native package includes native iOS (Swift) and Android (Kotlin) implementations with support for both old and new React Native architectures.
