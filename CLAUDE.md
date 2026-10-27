# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hot Updater is a self-hostable OTA (Over-The-Air) update solution for React Native apps, serving as an alternative to CodePush. It consists of a monorepo with packages and plugins organized using NX workspace management.

## Key Architecture

### Adapters and Plugins

An adapter fills one slot of a config (`build`, `storage`, `database`, `secrets`, `signing`); a plugin is an entry of a `plugins` list. `plugins/plugin-core/` (`@hot-updater/plugin-core`) is the public kit both are written against (the adapter contracts, the storage engine with its KV and SQL kits, and `definePlugin`), and the docs' overview (`docs/content/docs/(latest)/concepts/plugin-system.mdx`) describes how to write each one:

- **Build Adapters**: Handle bundling and the native fingerprint (Metro, Expo, Rock) - located in `plugins/bare/`, `plugins/expo/`, `plugins/rock/`. Bare and Rock fingerprint the native interface with cli-tools' `createInterfaceFingerprint` through `nativeBuild.fingerprint`; Expo, and any adapter without one, uses `@expo/fingerprint`
- **Storage Adapters**: Handle bundle storage (AWS S3, Cloudflare R2, Supabase Storage, Firebase Storage, Vercel Blob, Azure Blob Storage) - located in `plugins/aws/`, `plugins/cloudflare/`, `plugins/supabase/`, `plugins/firebase/`, `plugins/vercel/`, `plugins/azure/`, `plugins/standalone/`
- **Database Adapters**: Handle metadata storage on one storage engine (Cloudflare D1, Supabase, DynamoDB, Firestore, Cosmos DB, PostgreSQL) - use the same directories as storage and build on plugin-core's database kit; the built-in Kysely, Drizzle, Prisma, and MongoDB adapters live in `packages/server/src/adapters/` (`@hot-updater/server/adapters/*`)
- **Secrets Adapters**: Read the secrets a config names, `secret:<name>` build credentials and `secretEnv([...])` deploy credentials, and store issued keys. The default, `localSecrets({ path? })` (what `init` writes), reads the environment, then `<name>.json` files in `~/.hot-updater/secrets/<project-key>/` (0700/0600; the key is the project directory's name and path hash; `HOT_UPDATER_HOME` relocates it; a `path` in a git work tree must be git-ignored), where issued keys and `secrets put` go. Another adapter is read first and that default directory after it (`withLocalKeyStore` in `packages/cli-tools/src/secrets.ts`, the store in `localKeyStore.ts`). In CI, GitHub Actions secrets mapped into the job's env are what `localSecrets()` reads first; after a sign-in, `localSecrets()`'s key may be written there once (`utils/native/githubSecret.ts`, sealed boxes in `githubSecretWriter.ts`). The provider packages ship their cloud's store: `secretsManager()` from `@hot-updater/aws` (AWS Secrets Manager on the AWS SDK, `plugins/aws/src/secretsManager.ts`) and `secretManager()` from `@hot-updater/firebase` (Google Secret Manager's REST API through firebase-admin's `google-auth-library`, `plugins/firebase/src/secretManager.ts`). Other stores (dotenvx, Bitwarden, 1Password, Infisical) are docs snippets implementing `SecretsAdapter` (plugin-core) with the vendor's SDK, type-checked by `packages/hot-updater/src/secretsSnippets.spec.ts`. Resolution is in `credentialResolver.ts`
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
  - Its one subpath, `./native-artifact`, reads a store artifact (`.ipa`, `.aab`, `.apk`) and checks whether it can be imported as a native build. The CLI's `native-build import` and the Console share it, and no app imports it, so an app's bundle never carries it.

- `@hot-updater/plugin-core` is the public kit for third-party adapter and server plugin authors, like `@better-auth/core` or `@nuxt/kit`.
  - Its root holds only what the docs teach or what an adapter implements, each name with the reason in its JSDoc.
  - It runs wherever the server runs, and the app never imports it.
  - Official plugin packages take it as a peer, like third-party ones.
- `@hot-updater/server` is the runtime host. Its root is `createHotUpdater`, its types, the handlers, and `toNodeHandler`.
  - Its only subpaths are the built-in adapters (`./adapters/{kysely,drizzle,prisma,mongodb}`) and the built-in plugins (`./plugins`).
  - Tooling reads a server definition only through its public read-only properties.
- The root of `hot-updater` holds `defineConfig`, `secretEnv`, and the one built-in secrets adapter, `localSecrets`, with the `SecretsAdapter` and `SecretsContext` types. `hot-updater/signing` holds the official signing adapters. Every config load imports the root, so it stays light: the KMS clients are optional peers loaded only for the signer in use.
- `hot-updater/plugins` re-exports the official `apiKeys`, `insights`, and `remoteConfig` factories for `hot-updater.config.ts`. Server and hosted Console code imports `@hot-updater/server/plugins` instead of depending on the CLI package.
- `@hot-updater/vercel` re-exports `postgres` from `@hot-updater/postgres`, the managed Vercel database, so a Vercel project's config imports and installs one package.
- `@hot-updater/react-native` is the app SDK. Apps import everything from its root, including the built-in `insights` and `remoteConfig` clients. It has no subpaths.
  - It imports `@hot-updater/protocol` and the Insights and Remote Config clients, never plugin-core or server.
  - Nothing in its install closure pulls plugin-core or server.
- `@hot-updater/test-utils` holds all test-only code: adapter and plugin test suites, fixtures, `createMeasuredDatabase`, and test stores and executors.
  - It uses other packages' public API only.
  - No other package ships a test export or test helper, or keeps a path or hook that exists only for test-utils.
- Each managed provider package (`plugins/aws`, `azure`, `cloudflare`, `firebase`, `supabase`, `vercel`) exposes one `./init` entry, which the CLI loads after installing the package, plus its runtime builds.
  - Its root holds the provider's adapters for a config or a server, its secrets adapter included where the provider has a store: `secretsManager()` in `@hot-updater/aws`, `secretManager()` in `@hot-updater/firebase`.
  - A config-time adapter loads its SDK and `@hot-updater/cli-tools` inside its methods, never at import, so a server that imports the storage adapter from the same root loads neither. The runtime builds import single source files and never include it.
- Dependencies are cut cleanly:
  - No package has an `/internal` entry or a deep import. Every cross-package import uses the other package's public API.
  - A shared convention is implemented in each package and documented here, not imported. An example is the official-plugin brand key `Symbol.for("@hot-updater/server/official-plugin")`.
  - `remoteSigning` (plugin-core) names the errors whose reason it wrote itself, which never holds the token, `HotUpdaterRemoteSigningError`. cli-tools' bundle signing shows the message of those errors only and redacts every other signing adapter error.
  - The managed D1 and Supabase databases mark the target they reach for their provider's `./init`, which `hot-updater doctor --fix` calls with the config's database: `Symbol.for("@hot-updater/cloudflare/d1-target")` and `Symbol.for("@hot-updater/supabase/project")`.
- Subpaths are the exception. Add one only to isolate something optional (an adapter's dependency, a built-in plugin, a runtime build), never as a back door.
- `@hot-updater/cli-tools` depends on `@hot-updater/server` for `assembleServer({ database, storage, plugins })`, which runs `createHotUpdater` over a config's database, storage, and plugins for the CLI, the providers' `./init`, the agent scaffold build, and the E2E controller.
  - The Console keeps its own small copy of that assembly: a hosted Console must never load cli-tools, whose native bindings (oxc-parser, oxc-transform) and unconfig don't belong in it.
- A CLI command exists only for a user workflow. Checks belong in `hot-updater doctor`, which repairs what it can with `--fix`.
  - Plugins add no CLI commands. `PluginCli` holds only `clientCredential` and `clientPlugin`, the metadata init, doctor, and the agent scaffold read.
  - `hot-updater api-key create|list|revoke` is a built-in command over the config's `database` and `plugins`, or the server file a server project passes as its last argument.
  - `hot-updater secrets put <name> --kind <kind>` is a built-in command that stores a build credential you have, from its files, through the config's `secrets` adapter (`set`), or into `localSecrets()`'s directory. `hot-updater secrets issue <asc-api-key|play-service-account> [name] [--replace]` is the only command that signs in ahead of a build: at a terminal only, it signs in with an Apple Account or Google, and stores the key Hot Updater issues as builds do when theirs is missing. `hot-updater apple login` and `hot-updater google-play login` are its shortcuts for `asc-api-key` and `play-service-account`, with the same handler: they take no options or arguments (anything else exits 1 naming `secrets issue`), and the hints people meet first name them for the default names. It keeps a stored key unless `--replace`, which never revokes the old one. Hot Updater keeps no session, so there is no `logout` or `whoami`: each run ends saying only the key stayed. Hot Updater hosts no secret.
  - `hot-updater native-build ios|android [-s <scheme>] [-o <path>] [--submit testflight|play-internal] [--dry-run] [--json]` builds a native app; `native-build find|delete` query and delete the builds it tracks. There is no `build:*`, `run:*`, or opt-out flag: every build but a Debug one (no built-in bundle) is tracked, recorded with its artifact in the config's database and storage. Before building, and before any sign-in, a read-only preflight (the registry for the build's scope, and a storage `exists` on a tracked build's artifact) fails fast naming what it can't reach; a tracking failure after the build exits with the artifact's path and submits nothing. `--dry-run` builds but records and submits nothing, and never signs in.
  - `hot-updater testflight` and `hot-updater google-play upload` are the shortcuts for `native-build ios --submit testflight` and `native-build android --submit play-internal`, running the build's own handler. They take only `--scheme` (anything else exits 1 naming the full command); without it they build the one scheme `resolveTestFlightUploadKey` / `resolvePlayUploadServiceAccount` accepts, ask at a terminal among several, and refuse in CI.
  - Each `secretEnv` reads the environment, then the `secrets` adapter of the config load that created it (never `localSecrets()`'s files, which hold only keys Hot Updater stores); credential resolvers take the consuming command's config's adapter, else the one `loadConfig` last loaded. That state and the masking registry live on `globalThis`, since the config file loads its own copy of Hot Updater's modules. Loading reads no secret: `secretEnv` returns a function adapters call on first use, and resolved values never go into the CLI's own `process.env`, only to the caller, 0600 temporary files, or a child's explicit environment, which `isReservedVariableName` guards. Adapters and signers check their credentials and create clients on first use, so a config without them still loads.

### Reference Projects

When working on helper packages, reference these external projects:

- **Android Helper**: Reference `~/Desktop/rnef/packages/platform-android` (can be referred to as "rnef" or "rock" in prompts)
- **Apple Helper**: Reference `~/Desktop/rnef/packages/platform-apple-helpers` (can be referred to as "rnef" or "rock" in prompts)

### Configuration

Projects use `hot-updater.config.ts` (`defineConfig()`) for `build`, `storage`, `database`, and `plugins`, plus the deploy settings (`updateStrategy`, `secrets`, `signing`, `fingerprint`, `patch`, `platform`, `nativeBuild`, `console`, `cacheDir`). The config mirrors the server and never names server code:

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

# Print a channel's link, from console.channelLinkPrefix
npx hot-updater channel link <channel>

# Delete a channel and its bundles, such as a closed pull request's
npx hot-updater channel delete <channel> --yes

# Build a release app, tracked in the config's database and storage
npx hot-updater native-build android --scheme release
npx hot-updater native-build ios --scheme release --dry-run

# Build an .ipa, track it, and upload it to TestFlight (= native-build ios --scheme <scheme> --submit testflight)
npx hot-updater testflight
npx hot-updater testflight --scheme release

# Build an .aab, track it, and release it to Google Play's internal track (= native-build android --scheme <scheme> --submit play-internal)
npx hot-updater google-play upload

# Manage client API keys through apiKeys(): the config's, or a server file's
npx hot-updater api-key create --name <name>
npx hot-updater api-key list src/hotUpdater.ts

# Store a build credential you have through the config's secrets adapter, or localSecrets()'s directory
npx hot-updater secrets put asc-api-key --kind asc-api-key --p8 ./AuthKey.p8 --key-id <id> --issuer-id <id>

# Sign in at a terminal and store the key Hot Updater issues (--replace issues a new one)
npx hot-updater apple login          # = secrets issue asc-api-key
npx hot-updater google-play login    # = secrets issue play-service-account

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
