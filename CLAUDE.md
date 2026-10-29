# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hot Updater is a self-hostable OTA (Over-The-Air) update solution for React Native apps, serving as an alternative to CodePush. It consists of a monorepo with packages and plugins organized using NX workspace management.

## Key Architecture

### Adapters and Plugins
An adapter fills one slot of a config (`build`, `storage`, `database`, `signing`); a plugin is an entry of a `plugins` list. `plugins/plugin-core/` (`@hot-updater/plugin-core`) is the public kit both are written against (the adapter contracts, the storage engine with its KV and SQL kits, and `definePlugin`), and the docs' overview (`docs/content/docs/(latest)/concepts/plugin-system.mdx`) describes how to write each one:
- **Build Adapters**: Handle bundling and the native fingerprint (Metro, Expo, Rock) - located in `plugins/bare/`, `plugins/expo/`, `plugins/rock/`. Bare and Rock fingerprint the native interface with cli-tools' `createInterfaceFingerprint` through `nativeBuild.fingerprint`; Expo, and any adapter without one, uses `@expo/fingerprint`
- **Storage Adapters**: Handle bundle storage (AWS S3, Cloudflare R2, Supabase Storage, Firebase Storage, Vercel Blob, Neon Object Storage, Azure Blob Storage) - located in `plugins/aws/`, `plugins/cloudflare/`, `plugins/supabase/`, `plugins/firebase/`, `plugins/vercel/`, `plugins/neon/`, `plugins/azure/`, `plugins/standalone/`. AWS S3, R2, and Neon share one S3 API implementation, `createS3Storage` from `plugins/storage-s3/` (`@hot-updater/storage-s3`)
- **Database Adapters**: Handle metadata storage on one storage engine (Cloudflare D1, Supabase, DynamoDB, Firestore, Cosmos DB, PostgreSQL) - use the same directories as storage and build on plugin-core's database kit; the built-in Kysely, Drizzle, Prisma, and MongoDB adapters live in `packages/server/src/adapters/` (`@hot-updater/server/adapters/*`)
- **Signing Adapters**: Sign bundle artifacts (local PEM, remote, AWS KMS, Google Cloud KMS) - `hot-updater/signing`
- **Integration Plugins**: Wrap a build adapter to upload source maps (Sentry, Datadog, BugSnag) - `plugins/*-plugin/`
- **Server Plugins**: Add tables, APIs, routes, and client auth to `createHotUpdater` with `definePlugin` from `@hot-updater/plugin-core` (source in `plugins/plugin-core/src/serverPlugin/`) - the official `insights()`, `apiKeys()`, and `remoteConfig()` are the packages `plugins/insights/` (`@hot-updater/plugin-insights`), `plugins/api-keys/` (`@hot-updater/plugin-api-keys`), and `plugins/remote-config/` (`@hot-updater/plugin-remote-config`), re-exported by `@hot-updater/server/plugins` for servers and hosted Consoles, and by `hot-updater/plugins` for CLI configuration
- **Client Plugins**: Run in the React Native app with `defineClientPlugin` from `@hot-updater/protocol` (`packages/protocol/src/clientPlugin.ts`, beside the reference host `createPluginHost`) - the official `insights()` and `remoteConfig()` clients are `plugins/insights/src/client/` and `plugins/remote-config/src/client/`, exported from the root of `@hot-updater/react-native`; a client plugin reaches the server only through its context's `fetch`, on the `baseURL` and headers of `HotUpdater.init`, and its `setup` returns `{ hooks, api }`, where `api` is `hotUpdater.<id>` on the instance `HotUpdater.init` returns

### Core Packages
- `packages/protocol/`: `@hot-updater/protocol`, what crosses the device boundary (shared formats, pure computations, the client plugin contract and host)
- `packages/server/`: `@hot-updater/server`, the server runtime (`createHotUpdater`) with its built-in adapters and plugins
- `plugins/plugin-core/`: `@hot-updater/plugin-core`, the public kit for adapter and server plugin authors
- `packages/test-utils/`: `@hot-updater/test-utils`, every test suite, fixture, and test helper
- `packages/cli-tools/`: `@hot-updater/cli-tools`, tooling the CLI, the providers' `init`, and the build adapters share
- `packages/hot-updater/`: CLI tool and main commands
- `packages/react-native/`: React Native library for client-side integration
- `packages/console/`: Web-based management console built with React and TanStack Start
- `packages/android-helper/`: Android native build utilities and device management
- `packages/apple-helper/`: iOS/macOS native build utilities and device management

### Package Boundaries
Every export belongs to exactly one package. `scripts/ci/check-package-boundaries.mjs` (run by `pnpm lint`) and oxlint enforce these rules, so moving a boundary means deliberately editing them and this section.

- `@hot-updater/protocol` is the device-safe, zero-dependency package for what crosses a boundary:
  - the formats and pure computations the app and the server share, such as the release catalog format and its validation;
  - the device-side contract between a host and its extensions: `defineClientPlugin` and the reference host `createPluginHost`.

  It runs anywhere: Hermes, Node, Workers, Deno.
- `@hot-updater/plugin-core` is the public kit for third-party adapter and server plugin authors, like `@better-auth/core` or `@nuxt/kit`.
  - Its root holds only what the docs teach or what an adapter implements, each name with the reason in its JSDoc.
  - It runs wherever the server runs, and the app never imports it.
  - Official plugin packages take it as a peer, like third-party ones.
- `@hot-updater/server` is the runtime host. Its root is `createHotUpdater`, its types, the handlers, and `toNodeHandler`.
  - Its only subpaths are the built-in adapters (`./adapters/{kysely,drizzle,prisma,mongodb}`) and the built-in plugins (`./plugins`).
  - Tooling reads a server definition only through its public read-only properties.
- `hot-updater/plugins` re-exports the official `apiKeys`, `insights`, and `remoteConfig` factories for `hot-updater.config.ts`. Server and hosted Console code imports `@hot-updater/server/plugins` instead of depending on the CLI package.
- `@hot-updater/vercel` re-exports `postgres` from `@hot-updater/postgres`, the managed Vercel database, so a Vercel project's config imports and installs one package.
- `@hot-updater/neon` re-exports `postgres` from `@hot-updater/postgres` the same way, so a Neon project's config imports `neonStorage` and `postgres` from one package.
- `@hot-updater/storage-s3` holds `createS3Storage`, the S3 API storage adapter that `s3Storage` (`@hot-updater/aws`), `r2Storage` (`@hot-updater/cloudflare`), and `neonStorage` (`@hot-updater/neon`) wrap with their own name, URI protocol, and client defaults. Those packages depend on it; configs import the provider's adapter, not it, and the docs don't teach it.
- `@hot-updater/react-native` is the app SDK. Apps import everything from its root, including the built-in `insights` and `remoteConfig` clients. It has no subpaths.
  - It imports `@hot-updater/protocol` and the Insights and Remote Config clients, never plugin-core or server.
  - Nothing in its install closure pulls plugin-core or server.
- `@hot-updater/test-utils` holds all test-only code: adapter and plugin test suites, fixtures, `createMeasuredDatabase`, and test stores and executors.
  - It uses other packages' public API only.
  - It peers on the packages it tests (protocol, plugin-core, plugin-insights, server), so the workspace graph stays acyclic: those packages, and everything they depend on, take test-utils, and any other package their specs use, from the root `package.json`, never their own. nx builds its project graph from `package.json` alone (`analyzeSourceFiles: false` in `nx.json`), so pnpm and nx see the same acyclic graph.
  - No other package ships a test export or test helper, or keeps a path or hook that exists only for test-utils.
- Each managed provider package (`plugins/aws`, `azure`, `cloudflare`, `firebase`, `supabase`, `vercel`) exposes one `./init` entry, which the CLI loads after installing the package, plus its runtime builds.
- Dependencies are cut cleanly:
  - No package has an `/internal` entry or a deep import. Every cross-package import uses the other package's public API.
  - A shared convention is implemented in each package and documented here, not imported. An example is the official-plugin brand key `Symbol.for("@hot-updater/server/official-plugin")`.
- Subpaths are the exception. Add one only to isolate something optional (an adapter's dependency, a built-in plugin, a runtime build), never as a back door.
- `@hot-updater/cli-tools` depends on `@hot-updater/server` for `assembleServer({ database, storage, plugins })`, which runs `createHotUpdater` over a config's database, storage, and plugins for the CLI, the providers' `./init`, the agent scaffold build, and the E2E controller.
  - The Console keeps its own small copy of that assembly: a hosted Console must never load cli-tools, whose native bindings (oxc-parser, oxc-transform) and unconfig don't belong in it.
- A CLI command exists only for a user workflow. Checks belong in `hot-updater doctor`, which repairs what it can with `--fix`.
  - Plugins add no CLI commands. `PluginCli` holds only `clientCredential` and `clientPlugin`, the metadata init, doctor, and the agent scaffold read.
  - `hot-updater api-key create|list|revoke` is a built-in command over the config's `database` and `plugins`, or the server file a server project passes as its last argument.

### Reference Projects
When working on helper packages, reference these external projects:
- **Android Helper**: Reference `~/Desktop/rnef/packages/platform-android` (can be referred to as "rnef" or "rock" in prompts)
- **Apple Helper**: Reference `~/Desktop/rnef/packages/platform-apple-helpers` (can be referred to as "rnef" or "rock" in prompts)

### Configuration
Projects use `hot-updater.config.ts` (`defineConfig()`) for `build`, `storage`, `database`, and `plugins`, plus the deploy settings (`updateStrategy`, `signing`, `fingerprint`, `patch`, `platform`, `nativeBuild`, `console`, `cacheDir`). The config mirrors the server and never names server code:
- `storage` is the one adapter the CLI uploads with, the same adapter as the server's `createHotUpdater({ storage })`;
- `database` is the server's database adapter, or `standaloneRepository({ baseUrl, commonHeaders })` to reach a self-hosted server's admin API;
- `plugins` lists the server plugins the server runs. Over a direct database, the CLI assembles core over `database` and `plugins` as `createHotUpdater` does, so the schema fence and retention pruning apply to its writes.

Plugins are configured in three places: the server's `createHotUpdater({ plugins })`, `plugins` in `hot-updater.config.ts`, and the app's `HotUpdater.init({ plugins })`. A managed project uses two, the config and the app: its prebuilt server runs only the official `apiKeys()`, `insights()`, and `remoteConfig()`. Init imports their factories from `hot-updater/plugins` and writes `plugins: [apiKeys(), insights(), remoteConfig()]` into the config. Custom-server apps also import official factories from `hot-updater/plugins` and list the same plugins and options as their server. The Console's `defineConsoleConfig({ database, storage, plugins, console })` mirrors the server using factories from `@hot-updater/server/plugins`. React Native client factories remain on `@hot-updater/react-native`. No config file calls `createHotUpdater`: servers do, and tooling calls it internally over a config's database, storage, and plugins (cli-tools `assembleServer` and the Console's own copy).

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
```

### Hot Updater CLI
```bash
# Initialize hot updater in a project
npx hot-updater init

# Deploy bundle
npx hot-updater deploy

# Open web console
npx hot-updater console

# Check project health, and repair what doctor can
npx hot-updater doctor
npx hot-updater doctor --fix

# Generate fingerprint
npx hot-updater fingerprint create

# Set the native default channel
npx hot-updater channel set <channel>

# Manage client API keys through apiKeys(): the config's, or a server file's
npx hot-updater api-key create --name <name>
npx hot-updater api-key list src/hotUpdater.ts

# Migrate a server's database (in the server project)
npx hot-updater db migrate src/hotUpdater.ts
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

### OTA Compatibility Between Patches
Patch releases of one minor (such as 1.0.x) may change native code, the server, and the database, but an OTA between any two of them must keep working. An OTA replaces only JavaScript, so with the `appVersion` strategy a patch's JavaScript runs on another patch's native code, older or newer, and both talk to a server from yet another patch.

- App usage does not change in a patch: `HotUpdater.init`, `checkForUpdate`, `updateBundle`, `reload`, and their options keep their signatures and behavior.
- The JavaScript↔native bridge only grows. A new contract is a new native method that JavaScript detects (`typeof HotUpdaterNative.method === "function"`) and falls back from. Never change what an existing method's parameters mean.
- Native keeps accepting every parameter shape a released JavaScript sent, marked `Legacy:`. iOS new-architecture codegen drops fields missing from the TurboModule spec, so such fields stay optional in `packages/react-native/src/specs/NativeHotUpdater.ts` and are omitted from the public JavaScript types.
- The server keeps every route and response shape a released SDK calls, such as `/artifacts/v1` beside v2. A new protocol is a new route the SDK falls back from on 404.
- Database changes ship as migrations, after which the server still answers every released SDK.
- Before merging a change to the bridge or the update protocol, check both directions: this JavaScript on the previous patch's native code, and the previous patch's JavaScript on this native code.
