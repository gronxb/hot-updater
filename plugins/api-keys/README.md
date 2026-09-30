# @hot-updater/plugin-api-keys

Hot Updater's API keys plugin. It protects the server's client routes with API
keys, stores their SHA-256 digests, and adds `hot-updater api-key` commands to
the CLI.

You don't install it on its own. `@hot-updater/server` depends on it and
re-exports its `./server` entry:

```ts
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
```

See [API key authentication](https://hot-updater.dev/docs/custom/api-key-authentication).
