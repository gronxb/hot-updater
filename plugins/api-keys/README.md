# @hot-updater/plugin-api-keys

Hot Updater's API keys plugin. It protects the server's client routes with API
keys and stores their SHA-256 digests; the built-in `hot-updater api-key`
manages them.

You don't install it on its own. `@hot-updater/server` depends on it and
re-exports its `./server` entry:

```ts
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
```

See [API key authentication](https://hot-updater.dev/docs/custom/api-key-authentication).
