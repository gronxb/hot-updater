# Repository Guidelines

## Project Structure & Modules

- `packages/`: Core libraries (e.g., `core`, `hot-updater`, `react-native`, `console`).
- `plugins/`: Provider/build plugins (e.g., `aws`, `cloudflare`, `supabase`, `expo`, `repack`).
- `examples/`: React Native example apps by version (e.g., `v0.77.0`, `v0.81.0`).
- `docs/`: Documentation site sources.
- `scripts/`: Local tooling (e.g., `build-dev.mjs`).

## Build, Test, and Dev Commands

- Install: `pnpm install` (Node 22 via `mise`/`.node-version`, corepack enabled).
- Build all: `pnpm -w build` (Nx runs package and plugin builds; output in `dist/`).
- Test all: `pnpm -w test` (Vitest workspace over `packages/*`, `plugins/*`).
- Format/Lint: `pnpm -w lint:fix` (write) • `pnpm lint` (read-only).
- Clean: `pnpm clear` (removes `**/dist` and `.nx`).

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
- Use `ui.block`, `ui.kv`, and `ui.line` for human-readable summaries; use `ui.table` for list output, including `hot-updater bundle list`, with a Wrangler-like bordered table.
- Avoid emojis, long notes, and verbose fallback explanations in command output unless the text is required to prevent a destructive or irreversible action.
- `deploy`, `console`, and `init` are currently excluded from this CLI output migration unless explicitly requested.

## Testing Guidelines

- Framework: Vitest. Place tests near code or in `__tests__`. Use `*.spec.ts`.
- Run all tests: `pnpm -w test`. To focus: `pnpm -w test -- -t "name"`.
- Prefer small, deterministic unit tests; mock external services and filesystem where applicable.

## Commit & Pull Requests

- Commit style: Conventional Commits (e.g., `feat(aws): add R2 option`, `fix(android): handle proguard syntax`).
- Before PR: `pnpm -w lint`, `pnpm -w test`, and `pnpm changeset` (select affected packages; patch/minor as appropriate).
- PR content: clear description, linked issues, screenshots for console/UI changes, and notes on docs/Breaking Changes.

## Security & Configuration

- Do not commit secrets. Use `.env.hotupdater` for provider credentials (Supabase, Cloudflare, AWS, Firebase, etc.).
- Keep tokens local; review `.gitignore` and provider guides in `README.md`/site docs.
