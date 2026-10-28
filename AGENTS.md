# Repository Guidelines

## Project Structure & Modules

- `packages/`: Core libraries (e.g., `protocol`, `server`, `hot-updater`, `react-native`, `console`, `test-utils`).
- `plugins/`: Provider adapters, build adapters, and integration plugins (e.g., `aws`, `azure`, `cloudflare`, `supabase`, `firebase`, `vercel`, `bare`, `expo`, `rock`, `sentry-plugin`).
- `examples/`: React Native example apps by version (e.g., `v0.77.0`, `v0.85.0`).
- `docs/`: Documentation site sources.
- `scripts/`: Local tooling (e.g., `bench.mjs`, `changeset-minor.mjs`).

## Build, Test, and Dev Commands

- Install: `pnpm install` (Node 22 via `mise`/`.node-version`, corepack enabled).
- Build all: `pnpm -w build` (Nx runs package and plugin builds; output in `dist/`).
- Test all: `pnpm -w test` (Vitest workspace over `packages/*`, `plugins/*`).
- Format/Lint: `pnpm -w lint:fix` (write) • `pnpm lint` (read-only).
- Console design lint: `pnpm lint:design` loads `@shadcn/lint` with its
  dedicated Oxlint-compatible configuration.
- Clean: `pnpm clear` (removes `**/dist` and `.nx`).

## Skill Usage

- Do not use the `hot-updater` skill when developing this repository. That skill is intended for Hot Updater library users who need setup, deployment, diagnostics, and OTA operation guidance, not for maintainers changing the library code itself.
- Use the `e2e` skill when writing or debugging `e2e/mobile`. The suite is deterministic: use `screen` locators, `device`, and `expect` matchers, and never add `agent.*` steps, `agents`, a model, or the replay cache. The skill tracks the latest e2e release; `pnpm exec e2e guide <topic>` prints the guide for the pinned version.

## Coding Style & Naming

- Language: TypeScript (`strict: true`).
- Formatting: `oxfmt` + `oxlint` (2 spaces, semicolons, 80 cols, sorted imports). Example: run `pnpm -w lint:fix` before committing.
- Naming: camelCase (functions/vars), PascalCase (types/classes), kebab-case (package and dir names). Scoped packages use `@hot-updater/<name>`.
- Structure: Source under `src/` with a focused `index.ts` entry per package.

## CLI Output Design

- Apply the shared CLI design system to `packages/hot-updater` commands through `packages/hot-updater/src/utils/cli-ui.ts`; avoid ad hoc `colors.*` formatting in command files.
- Keep CLI output concise and action-oriented. Prefer the minimum useful state, target, and result over explanatory context or next-step tutorials.
- Keep short code snippets or commands when they are directly actionable, such as config blocks, generated SQL previews, or exact commands to run next.
- Use color semantically: green for success/enabled, red for disabled/errors, yellow for ids/warnings, cyan for platforms/titles, blue for channels, magenta for versions, and dim for paths/secondary text.
- Use `ui.block`, `ui.kv`, and `ui.line` for human-readable summaries; use `ui.table` for list output, including `hot-updater bundle list`, with a Wrangler-like bordered table. `ui.block` pads its `ui.kv` labels to the widest one plus two spaces, without colons or indent; print it with `p.log.step` (a result with nothing to do), `p.log.success`, or `p.log.warn`, whose symbol marks its heading.
- Keep every line within an 80-column terminal: one idea per line, paths through `ui.fitPath` (`~`, relative to the project, a long middle shortened to `…`), commands bare and highlighted through `ui.command`, `ui.withCommand`, or `ui.commandLines`, never in backticks, and text `--json` also prints, such as doctor issues, through `ui.prose`. The command specs' width guard (`renderClackLog` in `@hot-updater/test-utils/node`) fails on any line a terminal would wrap.
- Print a next step only when the user has to act; a result with nothing to do states the result and stops. Rare alternatives such as `--replace` belong in `--help` and the docs.
- Avoid emojis, long notes, and verbose fallback explanations in command output unless the text is required to prevent a destructive or irreversible action.
- `deploy`, `console`, and `init` are currently excluded from this CLI output migration unless explicitly requested.

## Infrastructure Upgrade Requirements

- Doctor requirements and agent upgrade instructions share
  `packages/hot-updater/src/commands/infrastructureUpdates.ts`. When a release
  requires infrastructure changes, register its version/note and add
  `packages/hot-updater/infrastructure-upgrades/<version>.md`.
- Each version file must have Compatibility, Steps, Cloudflare, Supabase, AWS,
  Firebase, and Verification sections, plus a section for each provider added
  before it (Vercel and Azure, in files after 1.0.0). Files released before a
  provider stay unchanged: `PROVIDER_SECTIONS` records the last one as
  `addedAfter`. State when a provider needs no schema migration. Build validation rejects missing files, missing sections, or files
  without a corresponding doctor requirement. Append a new file for each release;
  do not overwrite an older file to describe a newer release. Preserve history
  so agents can read the entire upgrade path before applying changes.
- Reuse the provider runtime, migrations, and config builders in packaged agent
  scaffolds. Public `infra scaffold` and agent commands must share the server
  extractor and produce identical server artifacts. Update provider
  `agent/SETUP.md` when setup prerequisites change, and record upgrade changes in
  the new version file. Validate packaged scaffolds and versioned upgrade files
  with `pnpm -w test` after `pnpm -w build`.

## Documentation

- Keep PRDs, plans, audits, and measurement records out of the repository.
  The docs site describes shipped behavior only.
- Latest-version documentation describes current behavior. Keep v0/v1
  comparisons and transition instructions in `guides/upgrade-to-v1.mdx`.
  Preserve literal resource names, API paths, and protocol identifiers.

## Agent Infrastructure Onboarding

- The agent discovers the target app, build/config and existing provider state
  before asking questions. It creates missing projects, instances and resources,
  applies the scaffold and verifies setup within the user's request. Do not
  require users to pre-create resources or provide discoverable IDs/settings.
- Ask only for unresolved targets, missing access/login, billing activation or
  a consequential choice that cannot be inferred. Never ask for token values,
  passwords, private keys or credential JSON in chat. Use provider login or private
  local/provider credential storage and verify access without exposing values.
- Keep every generated environment variable documented in the provider's
  `agent/ENVIRONMENT.md`, including its purpose, required/conditional status and
  source. Distinguish local adapter credentials, interactive-init inputs and server
  settings. Optional fields are not prerequisites for agent setup.

## OTA Compatibility Between Patches

Patch releases of one minor (such as 1.0.x) may change native code, the server, and the database, but an OTA between any two of them must keep working. An OTA replaces only JavaScript, so with the `appVersion` strategy a patch's JavaScript runs on another patch's native code, older or newer, and both talk to a server from yet another patch.

- App usage does not change in a patch: `HotUpdater.init`, `checkForUpdate`, `updateBundle`, `reload`, and their options keep their signatures and behavior.
- The JavaScript↔native bridge only grows. A new contract is a new native method that JavaScript detects (`typeof HotUpdaterNative.method === "function"`) and falls back from. Never change what an existing method's parameters mean.
- Native keeps accepting every parameter shape a released JavaScript sent, marked `Legacy:`. iOS new-architecture codegen drops fields missing from the TurboModule spec, so such fields stay optional in `packages/react-native/src/specs/NativeHotUpdater.ts` and are omitted from the public JavaScript types.
- The server keeps every route and response shape a released SDK calls, such as `/artifacts/v1` beside v2. A new protocol is a new route the SDK falls back from on 404.
- Database changes ship as migrations, after which the server still answers every released SDK.
- Before merging a change to the bridge or the update protocol, check both directions: this JavaScript on the previous patch's native code, and the previous patch's JavaScript on this native code.

## Testing Guidelines

- Framework: Vitest. Place tests near code or in `__tests__`. Use `*.spec.ts`.
- Run all tests: `pnpm -w test`. To focus: `pnpm -w test -- -t "name"`.
- Prefer small, deterministic unit tests; mock external services and filesystem where applicable.
- Every database provider and ORM adapter must register `setupDatabaseAdapterConformanceSuite`, `setupReadBudgetTestSuite`, and `setupDatabaseTestSuite` from the published `@hot-updater/test-utils` package; `setupDatabaseTestSuite` takes its database lifecycle and a thin `createHttpClient` adapter. Use `startHttpTestServer` from the same package for real loopback HTTP by default; Workers use `createHandlerHttpTestClient`. Every `examples-server` integration harness must run `setupReleaseCatalogTestSuite` against its spawned server URL with actual authentication headers. Shared HTTP scenarios must use admin/client HTTP APIs without invoking database or compiler implementations directly. OTA lifecycle scenarios must feed those HTTP catalogs to the production client selector and retain device state across update, rollback, and built-in fallback checks. Add scenarios centrally; internal providers and external custom providers must use the same published conformance contract.

## Commit & Pull Requests

- Commit style: Conventional Commits (e.g., `feat(aws): add R2 option`, `fix(android): handle proguard syntax`).
- Do not force push. Use normal pushes and coordinate before any history rewrite.
- Before PR: `pnpm -w lint`, `pnpm -w test`, and `pnpm changeset` (select affected packages; patch/minor as appropriate).
- PR content: clear description, linked issues, screenshots for console/UI changes, and notes on docs/Breaking Changes.

## Security & Configuration

- Do not commit secrets. Use `.env.hotupdater` for provider credentials (Supabase, Cloudflare, AWS, Firebase, Vercel, Azure, etc.).
- Keep tokens local; review `.gitignore` and provider guides in `README.md`/site docs.
