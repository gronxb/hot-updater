---
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

The provider packages no longer export `plugins`, the plugins their managed servers run. A config lists its plugins itself, as `hot-updater init` writes them:

```ts
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

export default defineConfig({
  // build, storage, database, ...
  plugins: [apiKeys(), insights(), remoteConfig()],
});
```

- `@hot-updater/aws`, `@hot-updater/cloudflare`, `@hot-updater/cloudflare/worker`, `@hot-updater/firebase`, `@hot-updater/supabase`, and `@hot-updater/supabase/edge` drop the export. A server or Console config imports the same factories from `@hot-updater/server/plugins`.
- `hot-updater init --provider <provider>` rewrites a config that still imports `plugins` from a provider package into the list above.
- The managed Supabase Edge Function lists its plugins from `@hot-updater/server/plugins`, and `hot-updater init` vendors that entry into the function with the others.
