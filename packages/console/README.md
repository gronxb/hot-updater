# @hot-updater/console

React component package for the Hot Updater management console.

This package owns the console UI and the server-side helper that adapts a Hot
Updater config into the API consumed by that UI. A deployable app should load
`hot-updater.config.ts`, pass the loaded config to `createHotUpdaterConsoleApi`,
and render `HotUpdaterConsole` with that API client.

## Exports

```tsx
import { HotUpdaterConsole } from "@hot-updater/console";
import type { ConsoleApiClient } from "@hot-updater/console";
import { createHotUpdaterConsoleApi } from "@hot-updater/console/hosted";
import "@hot-updater/console/embedded.css";
```

- `HotUpdaterConsole` renders the bundle management UI.
- `ConsoleApiClient` is the client contract used by the component.
- `createHotUpdaterConsoleApi(config)` creates the hosted server API from a
  loaded Hot Updater config.
- `embedded.css` contains the console styles for embedded/deployable shells.

## Deployable Console Flow

Use the deployable console repository as the thin Vite/Nitro shell:

```bash
git clone https://github.com/hot-updater/console
cd console
corepack enable
pnpm install
```

Configure `hot-updater.config.ts` in that repository with the same provider
plugins used by your OTA deployment:

```ts
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

Install any provider packages referenced by the config and provide credentials
through the deployment environment. Do not commit secrets.

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

## Config Handoff

The deployable app should keep provider plugins in `hot-updater.config.ts` and
pass the loaded config into this package:

```ts
import { loadConfig } from "@hot-updater/cli-tools";
import { createHotUpdaterConsoleApi } from "@hot-updater/console/hosted";

const config = await loadConfig(null);
const api = createHotUpdaterConsoleApi(config);
```

`createHotUpdaterConsoleApi` lazily initializes `config.database()` and
`config.storage()` when console operations need them. The component package does
not own deployment credentials or provider selection; the deployable shell does.

## Access Control

Run the console behind your deployment platform's access boundary, such as SSO,
VPN, IP allowlist, or an identity-aware reverse proxy. Keep OTA provider
credentials in the runtime environment and avoid exposing the service publicly
without an outer access layer.
