# `@hot-updater/api-key`

Database-free API key authentication for the Hot Updater server kernel.
Adding the plugin protects every route produced by `createHotUpdater`.

```ts
import { apiKey } from "@hot-updater/api-key";
import { createHotUpdater } from "@hot-updater/server";

const server = createHotUpdater({
  database,
  plugins: [
    apiKey({
      sha256: process.env.HOT_UPDATER_API_KEY_SHA256!,
    }),
  ],
});
```

Clients send the original 32-byte base64url key in `x-api-key`. Use
`headerName` to select another valid HTTP field name.

Managed provider tooling can provision the raw key in the gitignored
`.env.hotupdater` file and pass only its digest to the runtime:

```ts
import { provisionApiKey } from "@hot-updater/api-key/provisioning";

const { apiKey: rawApiKey, sha256 } = await provisionApiKey();
```

`provisionApiKey` is Node-only and idempotent. Do not import the provisioning
subpath from a Worker or other Web API runtime.
