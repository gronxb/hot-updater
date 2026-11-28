---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/supabase": minor
"@hot-updater/azure": minor
"@hot-updater/vercel": minor
"@hot-updater/firebase": minor
"@hot-updater/standalone": minor
"@hot-updater/plugin-core": minor
---

The adapters a config creates check their credentials and create their clients on first use, so a config loads without them: `supabaseStorage`, `supabaseDatabase`, `azureBlobStorage`, `cosmosDatabase`, `vercelBlobStorage`, `firebaseStorage`, `standaloneRepository`, `awsKmsSigning`, `googleCloudKmsSigning`, and `remoteSigning`. A server runtime missing a credential now reports it at its first request instead of at startup. `makeEnv` takes `expectedContent` and rewrites only a file that still holds it. In `@hot-updater/cli-tools`, `parseLoadedEnv` and `readLoadedHotUpdaterEnv(cwd)` read an env file as `process.loadEnvFile` does, and `readHotUpdaterEnv` is removed: read `.env.hotupdater` with `readLoadedHotUpdaterEnv(cwd)`, as the config loads it, or `readHotUpdaterInitEnv(cwd).managedEnv`, as init reads it.
