---
"@hot-updater/vercel": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

`@hot-updater/vercel` re-exports `postgres`, so a managed Vercel project installs only `@hot-updater/vercel`. `hot-updater init` writes `import { postgres, vercelBlobStorage } from "@hot-updater/vercel"` and, on a rerun, moves an existing `postgres` import from `@hot-updater/postgres` there. You can then remove `@hot-updater/postgres` from the app's devDependencies.
