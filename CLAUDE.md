# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hot Updater is a self-hostable OTA (Over-The-Air) update solution for React Native apps, serving as an alternative to CodePush. It consists of a monorepo with packages and plugins organized using NX workspace management.

## Key Architecture

### Adapters and Plugins

An adapter fills one slot of a config (`build`, `storage`, `database`, `secrets`); `signing` is a deploy setting, not a slot. A plugin is an entry of a `plugins` list. `plugins/plugin-core/` (`@hot-updater/plugin-core`) is the public kit both are written against (the adapter contracts, the storage engine with its KV and SQL kits, and `definePlugin`), and the docs' overview (`docs/content/docs/(latest)/concepts/plugin-system.mdx`) describes how to write each one:

- **Build Adapters**: Handle bundling and the native fingerprint (Metro, Expo, Rock) - located in `plugins/bare/`, `plugins/expo/`, `plugins/rock/`. Bare, Rock, and Expo fingerprint the native interface with cli-tools' `createInterfaceFingerprint` through `nativeBuild.fingerprint`; an adapter without one gets the React Native CLI default
- **Storage Adapters**: Handle bundle storage (AWS S3, Cloudflare R2, Supabase Storage, Firebase Storage, Vercel Blob, Neon Object Storage, Azure Blob Storage) - located in `plugins/aws/`, `plugins/cloudflare/`, `plugins/supabase/`, `plugins/firebase/`, `plugins/vercel/`, `plugins/neon/`, `plugins/azure/`, `plugins/standalone/`. AWS S3, R2, and Neon share one S3 API implementation, `createS3Storage` from `plugins/storage-s3/` (`@hot-updater/storage-s3`)
- **Database Adapters**: Handle metadata storage on one storage engine (Cloudflare D1, Supabase, DynamoDB, Firestore, Cosmos DB, PostgreSQL) - use the same directories as storage and build on plugin-core's database kit; the built-in Kysely, Drizzle, Prisma, and MongoDB adapters live in `packages/server/src/adapters/` (`@hot-updater/server/adapters/*`)
- **Secrets Adapters**: Read the secrets a config names with `secret("<name>")`, build credentials and adapter credentials alike, and store issued keys. The default, `localSecrets({ path? })` (what `init` writes), reads the environment, then `<name>.json` files in `~/.hot-updater/secrets/<project-key>/` (0700/0600; the key is the project directory's name and path hash; `HOT_UPDATER_HOME` relocates it; a `path` in a git work tree must be git-ignored), where issued keys and `secrets put` go. Another adapter is the only store, with no directory on this machine under it (`resolveSecretsAdapter` in `packages/cli-tools/src/secrets.ts`, the store in `localKeyStore.ts`). `set` is required: every adapter stores, and a write the store refuses throws. In CI, GitHub Actions secrets mapped into the job's env are what `localSecrets()` reads first; after a sign-in, `localSecrets()`'s key may be written there once (`utils/native/githubSecret.ts`, sealed boxes in `githubSecretWriter.ts`). The provider packages ship their cloud's store: `secretsManager()` from `@hot-updater/aws` (AWS Secrets Manager on the AWS SDK, `plugins/aws/src/secretsManager.ts`), `secretManager()` from `@hot-updater/firebase` (Google Secret Manager's REST API through firebase-admin's `google-auth-library`, `plugins/firebase/src/secretManager.ts`), and `keyVault()` from `@hot-updater/azure` (Azure Key Vault on `@azure/keyvault-secrets` and `DefaultAzureCredential`, `plugins/azure/src/keyVault.ts`; names outside Key Vault's case-insensitive `[0-9a-zA-Z-]` map to `<words>--<sha256 prefix>`). `infisical({ projectId, environment?, path?, siteUrl? })` (only `projectId` is required: `prod`, `/`, and `INFISICAL_DOMAIN` / `INFISICAL_API_URL` or Infisical Cloud US by default) from `hot-updater` (`packages/hot-updater/src/infisical.ts`) is the one team store built in beside `localSecrets()`, because it works with every provider, is free for a small team or self-hosted, and is plain `fetch` against Infisical's REST API with no dependency: it signs in only from the environment or `.env.hotupdater` (no credentials in the config), with `INFISICAL_TOKEN`, Universal Auth, or GitHub Actions OIDC at GitHub's default audience (the Infisical CLI's names; `INFISICAL_` is reserved), lists the folder before reading because Infisical answers 404 alike for a missing secret, folder, environment, or project, and refuses values Infisical would trim and requests over 1 MiB; its integration spec runs a pinned self-hosted Infisical (`infisical.compose.yml`, the `infisical` integration group). Other stores (dotenvx, Bitwarden, 1Password) are docs snippets implementing `SecretsAdapter` (plugin-core) with the vendor's SDK, type-checked by `packages/hot-updater/src/secretsSnippets.spec.ts`. Resolution is in `credentialResolver.ts`
  - Design rule: every credential read, write, and "already stored" check goes through the config's `secrets` adapter, after the environment's overrides; with a configured adapter there is no local copy, and an issued key that does not read back exactly is revoked. `localSecrets()` keeps credentials on one machine. A team store (`infisical()`, `secretsManager()`, `secretManager()`, `keyVault()`, 1Password, or an adapter of your own) shares every credential with the team, the App Store Connect API key, the Play service account, the Android upload keystore, the bundle signing key, and the adapter credentials `secret()` reads, so a teammate's `apple login` finds its key already stored and issues nothing, nobody stores a second Play service account key or upload keystore, and a teammate with only the repository and the store builds, uploads, signs, and deploys.
- **Bundle signing** is a deploy setting, not an adapter slot: `signing: secret("bundle-signing-key")`, the shorthand of `{ enabled: true, privateKey: secret(...) }`, reads an RSA private key in PEM through the config's `secrets` adapter; 1.1's `{ enabled: true, privateKeyPath }` reads a file and `{ enabled: false }` turns it off. Without `signing`, deploy and doctor warn that bundles are unsigned; any other value, such as a removed signing adapter, deploy refuses rather than deploy unsigned. One path in cli-tools (`packages/cli-tools/src/bundleSigning.ts`, `readBundleSigningState`) signs, derives the public key a build adapter's `nativeBuild.getBundleSigningPublicKey` is checked against, and words both lines; `secrets issue bundle-signing-key` (`packages/hot-updater/src/commands/signingKey.ts`) creates the key and adds the shorthand to a config without `signing`
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
  - Its one subpath, `./native-artifact`, reads an artifact built elsewhere (`.ipa`, `.aab`, `.apk`, simulator `.app.zip`) as untrusted input and checks whether it can be imported as a native build, for the CLI's `native-build import`. No app imports it, so an app's bundle never carries it.

- `@hot-updater/plugin-core` is the public kit for third-party adapter and server plugin authors, like `@better-auth/core` or `@nuxt/kit`.
  - Its root holds only what the docs teach or what an adapter implements, each name with the reason in its JSDoc.
  - It runs wherever the server runs, and the app never imports it.
  - Official plugin packages take it as a peer, like third-party ones.
- `@hot-updater/server` is the runtime host. Its root is `createHotUpdater`, its types, the handlers, and `toNodeHandler`.
  - Its only subpaths are the built-in adapters (`./adapters/{kysely,drizzle,prisma,mongodb}`) and the built-in plugins (`./plugins`).
  - Tooling reads a server definition only through its public read-only properties.
- The root of `hot-updater` holds `defineConfig`, `secret`, and the built-in secrets adapters, `localSecrets` and `infisical`, with the `SecretRef`, `SecretsAdapter`, and `SecretsContext` types. Every config load imports the root, so it stays light.
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
  - Its root holds the provider's adapters for a config or a server, its secrets adapter included where the provider has a store: `secretsManager()` in `@hot-updater/aws`, `secretManager()` in `@hot-updater/firebase`, `keyVault()` in `@hot-updater/azure`.
  - A config-time adapter loads its SDK and `@hot-updater/cli-tools` inside its methods, never at import, so a server that imports the storage adapter from the same root loads neither. The runtime builds import single source files and never include it.
- Dependencies are cut cleanly:
  - No package has an `/internal` entry or a deep import. Every cross-package import uses the other package's public API.
  - A shared convention is implemented in each package and documented here, not imported. An example is the official-plugin brand key `Symbol.for("@hot-updater/server/official-plugin")`.
  - Each managed provider's database factory (`d1Database`, `supabaseDatabase`, `dynamoDB`, `firebaseDatabase`, `postgres`, `cosmosDatabase`) marks the resource it reaches, without credentials, under `Symbol.for("@hot-updater/database-target")`, such as `d1/<databaseId>`. Doctor compares it with the target init's saved inputs describe (`INIT_PROVIDER_PACKAGES[provider].target`) before it names init replay.
- Subpaths are the exception. Add one only to isolate something optional (an adapter's dependency, a built-in plugin, a runtime build), never as a back door.
- `@hot-updater/cli-tools` depends on `@hot-updater/server` for `assembleServer({ database, storage, plugins })`, which runs `createHotUpdater` over a config's database, storage, and plugins for the CLI, the providers' `./init`, the agent scaffold build, and the E2E controller.
  - The Console keeps its own small copy of that assembly: a hosted Console must never load cli-tools, whose native bindings (oxc-parser, oxc-transform) and unconfig don't belong in it.
  - The one exception is the local Console that `hot-updater console` runs, the `.output` `@hot-updater/console` ships: its config module loads `hot-updater.config.ts` with cli-tools' `loadConfig`, taken from the CLI that runs it (cli-tools is an optional peer of the Console). A hosted build compiles the host's `console.config.ts` instead, so its output has no cli-tools. `scripts/ci/check-package-boundaries.mjs` fails when the Console installs cli-tools, or when a source under its `src/` imports or names it, but for the local config module it lists.
- A CLI command exists only for a user workflow. Checks belong in `hot-updater doctor`, which only reports: each issue names the existing command or edit that resolves it.
  - A deployment `hot-updater init` created upgrades by running init again with its saved inputs, which migrates the database and redeploys the server back to back; doctor names that command when `.env.hotupdater` records the provider and the config's database is the one init saved.
  - Plugins add no CLI commands. `PluginCli` holds only `clientCredential` and `clientPlugin`, the metadata init, doctor, and the agent scaffold read.
  - `hot-updater api-key create|list|revoke` is a built-in command over the config's `database` and `plugins`, or the server file a server project passes as its last argument.
  - `hot-updater secrets put <name> [file] [--kind <kind>]` is a built-in command that stores a build credential you have, from its files, through the config's `secrets` adapter (`set`), `localSecrets()`'s directory by default, and reads it back exactly. The kind defaults to the name. `secrets put bundle-signing-key <key.pem>` moves an existing PEM (PKCS#1 or PKCS#8, RSA of 2048 bits or more) into the store as PKCS#8 and prints its public key's SHA-256 SPKI fingerprint, so a `privateKeyPath` key moves without a new trust anchor. Google Play is set up with it alone: `secrets put play-service-account <key.json>` checks the file is a service account JSON key (refusing `google-services.json`), and `secrets put android-keystore <file>` asks a keystore's passwords at a terminal and checks them with keytool (`--key-alias` and the password variables without one). Nothing creates a Play key or a keystore implicitly: `native-build android --submit play-internal` and `google-play upload` check the key, the keystore, and Play access (an edit opened and deleted) before the prebuild and list every unmet item at once, and `hot-updater doctor` reports the same access per Android package. `hot-updater secrets import` stores the names the adapters' `secret()`s read (`getDeploySecretNames`), and `HOT_UPDATER_API_KEY`, from `.env.hotupdater` through a team adapter and reads them back; it refuses `localSecrets()`, and a file that sets none of them. `hot-updater secrets issue asc-api-key [name] [--replace]` is the only command that signs in ahead of a build: at a terminal only, it signs in with an Apple Account, and stores the key Hot Updater issues as builds do when theirs is missing; `secrets issue android-keystore` creates a new upload key, which fits only an app with no `.aab` on Google Play yet. `secrets issue bundle-signing-key` creates an RSA 4096 bundle signing key, keeps a stored one unless `--replace` (shipped apps reject a new key's bundles), creates one without a terminal only in a team store, and adds `signing: secret("bundle-signing-key")` to a config without `signing`. `hot-updater apple login` is its shortcut for `asc-api-key`, with the same handler: it takes no options or arguments (anything else exits 1 naming `secrets issue`), and the hints people meet first name it for the default name. It keeps a stored key unless `--replace`, which never revokes the old one. Hot Updater keeps no session, so there is no `logout` or `whoami`: each run ends saying only the key stayed. Hot Updater hosts no secret.
  - `hot-updater native-build ios|android [-s <scheme>] [-o <path>] [--submit testflight|play-internal] [--dry-run] [--json]` builds a native app; `native-build find|delete` query and delete the builds it tracks. There is no `build:*`, `run:*`, or opt-out flag: every build but a Debug one (no built-in bundle) is tracked, recorded with its artifact in the config's database and storage. Before building, and before any sign-in, a read-only preflight (the registry for the build's scope, and a storage `exists` on a tracked build's artifact) fails fast naming what it can't reach; a tracking failure after the build exits with the artifact's path and submits nothing. `--dry-run` builds but records and submits nothing, and never signs in.
  - `hot-updater testflight` and `hot-updater google-play upload` are the shortcuts for `native-build ios --submit testflight` and `native-build android --submit play-internal`, running the build's own handler. They take only `--scheme` (anything else exits 1 naming the full command); without it they build the one scheme `resolveTestFlightUploadKey` / `resolvePlayUploadServiceAccount` accepts, ask at a terminal among several, and refuse in CI.
  - `secret("<name>")` (cli-tools `secrets.ts`) returns a frozen async function branded with `Symbol.for("@hot-updater/secret-ref")`, plugin-core's `SecretRef`: build credentials (`signing` or `signing.privateKey`, a scheme's `signing.keystore` and `signing.ascApiKey`) take only a reference, which the CLI resolves by `name` for its kind (`parseSecretReference` refuses anything else), and any adapter credential (plugin-core's `Lazy<T>`, a value or a function) calls it. Called, it reads `secretVariableName(name)` in the environment or `.env.hotupdater`, then the `secrets` adapter of the config load that created it (never `localSecrets()`'s files, which hold only keys Hot Updater stores): the first call reads every name of that load but the build credentials' in one `get`. Credential resolvers take the consuming command's config's adapter, else the one `loadConfig` last loaded. That state and the masking registry live on `globalThis`, since the config file loads its own copy of Hot Updater's modules. Loading reads no secret: adapters call a `secret()` on first use, and resolved values never go into the CLI's own `process.env`, only to the caller, 0600 temporary files, or a child's explicit environment, which `isReservedVariableName` guards. Adapters and signers check their credentials and create clients on first use, so a config without them still loads.

### Reference Projects

When working on helper packages, reference these external projects:

- **Android Helper**: Reference `~/Desktop/rnef/packages/platform-android` (can be referred to as "rnef" or "rock" in prompts)
- **Apple Helper**: Reference `~/Desktop/rnef/packages/platform-apple-helpers` (can be referred to as "rnef" or "rock" in prompts)

### Configuration

Projects use `hot-updater.config.ts` (`defineConfig()`) for `build`, `storage`, `database`, and `plugins`, plus the deploy settings (`updateStrategy`, `secrets`, `signing`, `fingerprint`, `patch`, `platform`, `nativeBuild`, `console`, `cacheDir`). The config mirrors the server and never names server code:

- `storage` is the one adapter the CLI uploads with, the same adapter as the server's `createHotUpdater({ storage })`;
- `database` is the server's database adapter, or `standaloneRepository({ baseUrl, commonHeaders })` to reach a self-hosted server's admin API;
- `plugins` lists the server plugins the server runs. Over a direct database, the CLI assembles core over `database` and `plugins` as `createHotUpdater` does, so the schema fence and retention pruning apply to its writes.

The config managed `init` writes names the provider's resources as literals and reads each credential inline with `secret("<name>")` (each provider's `iac/init` lists the names as `secrets`, and storage and database adapters take a credential as plain `Lazy<string>`, S3, R2, and Neon also access keys whose fields are lazy, which `createS3Storage` (`@hot-updater/storage-s3`) turns into one SDK credential provider; a server passes its own environment's values). Adapters create their clients on first use, so `.env.hotupdater` and the environment win, then the config's `secrets` adapter. `init` saves them in `.env.hotupdater` as before; with a team adapter, it also reads the credentials it lacks from it, stores them with `HOT_UPDATER_API_KEY` after its run, and reads them back (`commands/initSecrets.ts`). Neither `init` nor `secrets import` deletes a line: the app's build reads `HOT_UPDATER_API_KEY` from the file. `secrets import` moves an existing project's into a team store and deletes nothing. A replay replaces a managed adapter's string and `process.env.HOT_UPDATER_*` options with what it resolved, so a 1.1 config, or an earlier 1.2 one's `secretEnv` helpers, moves to `secret()`; other options stay the project's.

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

# Check project health; each issue names the command that resolves it
npx hot-updater doctor
npx hot-updater doctor --server-base-url https://updates.example.com

# Upgrade a managed deployment: migrate the database and redeploy the server
npx hot-updater init --provider <provider> --from-env-file .env.hotupdater

# Generate fingerprint
npx hot-updater fingerprint create

# Set the native default channel
npx hot-updater channel set <channel>

# Delete a channel and its bundles, such as a closed pull request's; --native-builds deletes the builds that embed it too
npx hot-updater channel delete <channel> --native-builds --yes

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
npx hot-updater secrets put asc-api-key --p8 ./AuthKey.p8 --key-id <id> --issuer-id <id>

# Set up Google Play: the service account's JSON key and the upload keystore, then check access
npx hot-updater secrets put play-service-account ~/Downloads/key.json
npx hot-updater secrets put android-keystore ./upload.jks
npx hot-updater doctor

# Move the credentials .env.hotupdater sets for the adapters' secret()s, and the app's API key, into a team store
npx hot-updater secrets import

# Sign in at a terminal and store the key Hot Updater issues (--replace issues a new one)
npx hot-updater apple login          # = secrets issue asc-api-key

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
