# Hot Updater Console Template

Standalone TanStack Start app for running the Hot Updater Console as its own
service. Copy this directory into a deployment repository, configure your Hot
Updater plugins, create the auth schema, bootstrap the first admin, then deploy
the Nitro output on a Node-compatible host.

This template is intentionally standalone. It does not depend on monorepo-only
console package entrypoints, demo data fixtures, or local package aliases.

## Quick Start

```bash
cp -R templates/console hot-updater-console
cd hot-updater-console
corepack enable
pnpm install
pnpm dev
```

The development server listens on `http://localhost:3000`.

`hot-updater.config.ts` starts with fail-closed placeholder plugins. Replace
them before using real OTA data.

## Configure Hot Updater Plugins

Install the provider packages used by your Hot Updater project, then wire the
same build, storage, database, and update strategy into
`hot-updater.config.ts`.

```typescript
import { s3Database, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage({ bucketName: process.env.HOT_UPDATER_BUCKET! }),
  database: s3Database({ bucketName: process.env.HOT_UPDATER_BUCKET! }),
  updateStrategy: "appVersion",
});
```

Provider credentials stay in the deployment environment. Do not commit them.

## Auth Environment

The Console uses Better Auth with its own database. Keep `AUTH_DATABASE_URL`
separate from the OTA bundle database used by your Hot Updater database plugin.

Required in every production environment:

```bash
BETTER_AUTH_URL=https://console.example.com
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
AUTH_DATABASE_URL=postgres://user:password@host:5432/hot_updater_console_auth
HOT_UPDATER_CONSOLE_ADMIN_EMAIL=admin@example.com
HOT_UPDATER_CONSOLE_ADMIN_PASSWORD=replace-with-a-strong-password
```

Optional:

```bash
BETTER_AUTH_TRUSTED_ORIGINS=https://console.example.com,https://admin.example.com
HOT_UPDATER_CONSOLE_ADMIN_NAME="Console Admin"
```

`BETTER_AUTH_URL` must be the public origin users visit. Set
`BETTER_AUTH_TRUSTED_ORIGINS` when a reverse proxy or preview domain needs to
send browser auth requests from more than one trusted origin.

## Auth Schema And First Admin

Generate and migrate the Better Auth schema after `AUTH_DATABASE_URL`,
`BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` are available:

```bash
pnpm auth:generate
pnpm auth:migrate
```

Bootstrap the first admin after setting
`HOT_UPDATER_CONSOLE_ADMIN_EMAIL` and
`HOT_UPDATER_CONSOLE_ADMIN_PASSWORD`:

```bash
pnpm auth:bootstrap
```

The bootstrap is idempotent for an existing user. Run migrations and bootstrap
once per environment, then rotate or remove the bootstrap password from the
runtime environment if your platform keeps build-time and runtime variables
separate.

## Build And Smoke Test

```bash
pnpm test:type
pnpm test
pnpm build
pnpm preview
```

`pnpm build` creates Nitro server output under `.output/` and copies static
assets into `dist/`. Use `pnpm preview` for a local production smoke test.

## Deployment Support Matrix

| Target | Status | Build preset | Notes |
| --- | --- | --- | --- |
| Node server | MVP | default `node-server` | Preferred first deployment path. Build with `pnpm build`, run the generated Nitro server with `node .output/server/index.mjs`, and provide all auth plus provider env vars at runtime. |
| Vercel | MVP | Nitro auto-detects, or set `NITRO_PRESET=vercel` | Use a Postgres-compatible `AUTH_DATABASE_URL`. Keep provider SDK credentials in Vercel environment variables. |
| Netlify | MVP | Nitro auto-detects, or set `NITRO_PRESET=netlify` | Use a Postgres-compatible `AUTH_DATABASE_URL`. Verify provider SDKs do not require local filesystem writes outside the platform runtime. |
| Cloudflare Workers or Pages | Limited / experimental | `cloudflare_module` or `cloudflare_pages` | Verify every selected Hot Updater provider SDK, native binding, filesystem access path, and database driver against Cloudflare before production use. |

Nitro can select deployment presets automatically in CI/CD. For explicit
builds, set `NITRO_PRESET` or `SERVER_PRESET`, pass a preset to Nitro config,
or use the Nitro CLI preset flag.

Set Nitro `compatibilityDate` for runtime behavior stability. Cloudflare
deployments also need a pinned Wrangler `compatibility_date`. For example:

```typescript
import { defineConfig } from "nitro";

export default defineConfig({
  compatibilityDate: "2026-07-07",
  preset: "cloudflare_module",
  cloudflare: {
    wrangler: { compatibility_date: "2026-07-07" },
  },
});
```

Keep Cloudflare as an experimental track until your provider set is verified
there. The Node, Vercel, and Netlify paths are the MVP deployment targets.

## Capability States

The Console reports plugin capabilities from the server and disables unsupported
UI actions. Server RPCs still enforce the same checks and return typed
`CONSOLE_CAPABILITY_UNSUPPORTED` errors with HTTP 409 for unsupported
operations.

- Channel and bundle reads require the configured database plugin to expose the
  corresponding read methods.
- Bundle updates, bundle creation, and move promotion require database write
  methods plus `commitBundle`.
- Copy promotion and deletion require database write support plus a Node
  storage profile.
- Downloads from direct `http` or `https` bundle URLs work without a runtime
  storage profile. Downloads from provider URIs require a runtime storage
  profile whose protocol matches the bundle `storageUri`.

If an action is disabled, check the capability reason in the UI first, then
confirm that `hot-updater.config.ts` uses providers with the required database
and storage profiles.

## Defense In Depth

Better Auth is the application auth layer. For production, place the Console
behind at least one additional boundary:

- SSO, VPN, IP allowlist, mTLS, or an identity-aware reverse proxy.
- TLS termination with the same public origin as `BETTER_AUTH_URL`.
- No public CDN caching for authenticated Console pages or API routes.
- Rate limiting on `/api/auth/*` and Console RPC endpoints.
- Separate auth and OTA databases, with least-privilege credentials for both.

Do not rely on the proxy as the only auth layer. The app should still require a
valid Better Auth session even when a proxy is present.

## Project Layout

```text
src/routes/              TanStack Start routes and server endpoints
src/components/          shadcn-style UI and feature components
src/lib/server/          auth, Hot Updater config, and plugin loading
src/lib/api-rpc/         authenticated server RPCs and capability gates
src/styles.css           Tailwind v4 tokens and theme variables
hot-updater.config.ts    project-specific provider configuration
```

## Design

The template follows the extracted console design contract in `DESIGN.md`.
Keep operational screens dense, tabular, and action-oriented. Prefer existing
components and tokens over new visual systems.
