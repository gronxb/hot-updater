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
- Dev watch: `pnpm build:dev` (watches `packages/`, `plugins/`, `docs/`).
- Test all: `pnpm -w test` (Vitest workspace over `packages/*`, `plugins/*`).
- Format/Lint: `pnpm -w biome` (write) • `pnpm biome:check` (read-only).
- Clean: `pnpm clear` (removes `**/dist` and `.nx`).

## Coding Style & Naming
- Language: TypeScript (`strict: true`).
- Formatting: Biome (2 spaces, semicolons, 80 cols, organized imports). Example: run `pnpm -w biome` before committing.
- Naming: camelCase (functions/vars), PascalCase (types/classes), kebab-case (package and dir names). Scoped packages use `@hot-updater/<name>`.
- Structure: Source under `src/` with a focused `index.ts` entry per package.

## Testing Guidelines
- Framework: Vitest. Place tests near code or in `__tests__`. Use `*.spec.ts`.
- Run all tests: `pnpm -w test`. To focus: `pnpm -w test -- -t "name"`.
- Prefer small, deterministic unit tests; mock external services and filesystem where applicable.

## Commit & Pull Requests
- Commit style: Conventional Commits (e.g., `feat(aws): add R2 option`, `fix(android): handle proguard syntax`).
- Before PR: `pnpm -w biome`, `pnpm -w test`, and `pnpm changeset` (select affected packages; patch/minor as appropriate).
- PR content: clear description, linked issues, screenshots for console/UI changes, and notes on docs/Breaking Changes.

## Security & Configuration
- Do not commit secrets. Use `.env.hotupdater` for provider credentials (Supabase, Cloudflare, AWS, Firebase, etc.).
- Keep tokens local; review `.gitignore` and provider guides in `README.md`/site docs.
