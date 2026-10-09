# @hot-updater/plugin-api-keys

Hot Updater's API keys plugin. It protects the server's client routes with API
keys and stores their SHA-256 digests; the built-in `hot-updater api-key`
manages them.

You don't install it on its own. In `hot-updater.config.ts`, use the CLI's
plugin entry:

```ts
import { apiKeys } from "hot-updater/plugins";
```

In a `createHotUpdater` server definition, use the server's entry:

```ts
import { apiKeys } from "@hot-updater/server/plugins";
```

See [API key authentication](https://hot-updater.dev/docs/custom/api-key-authentication).
