# @hot-updater/console

React component package for the Hot Updater management console.

This package owns the console UI and the server-side helper that adapts a Hot
Updater config into the API consumed by that UI. A deployable app should keep
provider plugins in `hot-updater.config.ts`, register the Vite plugin, and
render `HotUpdaterConsole` with the generated API client.

## Exports

```tsx
import { HotUpdaterConsole } from "@hot-updater/console";
import type { ConsoleApiClient } from "@hot-updater/console";
import { defineConfig } from "@hot-updater/console/config";
import { createHotUpdaterConsoleApi } from "@hot-updater/console/hosted";
import { hotUpdaterConsole } from "@hot-updater/console/vite";
import "@hot-updater/console/embedded.css";
```

- `HotUpdaterConsole` renders the bundle management UI.
- `ConsoleApiClient` is the client contract used by the component.
- `defineConfig(config)` type-checks a deployable console config.
- `createHotUpdaterConsoleApi(config)` creates the hosted server API from a
  loaded Hot Updater config.
- `hotUpdaterConsole()` wires `hot-updater.config.ts` into the deployable app as
  Vite virtual modules.
- `embedded.css` contains the console styles for embedded/deployable shells.

## Deployable Console Flow

Use the deployable console repository as the thin Vite/Nitro shell. The Hot
Updater repository does not ship an app template; this package provides the UI
and API adapter, and the `hot-updater/console` repository owns deployment.

```bash
git clone https://github.com/hot-updater/console
cd console
corepack enable
pnpm install
```

Configure `hot-updater.config.ts` in that repository with the same provider
plugins used by your OTA deployment. The console package receives plugins from
this file; provider credentials stay in the deployable app environment.

```ts
import { s3Database, s3Storage } from "@hot-updater/aws";
import { defineConfig } from "@hot-updater/console/config";

export default defineConfig({
  storage: s3Storage({ bucketName: process.env.HOT_UPDATER_BUCKET! }),
  database: s3Database({ bucketName: process.env.HOT_UPDATER_BUCKET! }),
});
```

Install any provider packages referenced by the config and provide credentials
through the deployment environment. Do not commit secrets.

The deployable app should request the server API from the virtual module:

```ts
import { createConsoleApi } from "virtual:hot-updater-console/server-api";

const api = await createConsoleApi();
```

Register the Vite plugin so the virtual module resolves to the app's
`hot-updater.config.ts`:

```ts title="vite.config.ts"
import { hotUpdaterConsole } from "@hot-updater/console/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    hotUpdaterConsole(),
    // nitro(), tanstackStart(), viteReact(), ...
  ],
});
```

Run locally:

```bash
pnpm dev
```

Build and run the Nitro output:

```bash
pnpm build
pnpm start
```

For Node-compatible hosts, use:

```text
Install command: corepack enable && pnpm install --frozen-lockfile
Build command:   pnpm build
Start command:   pnpm start
```

`pnpm build` writes the deployable Nitro server to `.output/server/index.mjs`.
`pnpm start` runs that output directly. Set `PORT` and, if your host requires
it, `NITRO_PORT`.

### Cloudflare Pages

Nitro supports Cloudflare Pages with the `cloudflare_pages` preset. Configure
the Pages project with the Nitro Cloudflare preset and Cloudflare Pages build
settings:

```text
Build command:          corepack enable && pnpm install --frozen-lockfile && NITRO_PRESET=cloudflare_pages pnpm build
Build output directory: dist
Root directory:         /
```

References: [Nitro Cloudflare provider](https://nitro.build/deploy/providers/cloudflare)
and [Cloudflare Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/).

For direct upload from a local checkout:

```bash
NITRO_PRESET=cloudflare_pages pnpm build
pnpm dlx wrangler pages deploy dist
```

Add the environment variables and Cloudflare bindings required by
`hot-updater.config.ts` to the Pages project. If the deployable app uses
TanStack Start or Better Auth, set the Cloudflare compatibility flag to
`nodejs_compat`.

Use Cloudflare environment variables and bindings for credentials referenced by
`hot-updater.config.ts`. For Cloudflare R2 runtime access, bind the bucket used
by the storage plugin to the Pages project.

## Config Handoff

The deployable app should keep provider plugins in `hot-updater.config.ts` and
load them through the Vite virtual server API:

```ts
import { createConsoleApi } from "virtual:hot-updater-console/server-api";

const api = await createConsoleApi();
```

The Vite plugin makes the config file an explicit build input, avoiding
deployable-shell code that reaches into `../../hot-updater.config` by relative
path. `createHotUpdaterConsoleApi` still lazily initializes `config.database()`
and `config.storage()` when console operations need them. The component package
does not own deployment credentials or provider selection; the deployable shell
does.

## Access Control

Run the console behind your deployment platform's access boundary, such as SSO,
VPN, IP allowlist, or an identity-aware reverse proxy. Keep OTA provider
credentials in the runtime environment and avoid exposing the service publicly
without an outer access layer.
