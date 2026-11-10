---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/postgres": patch
"@hot-updater/supabase": patch
"@hot-updater/vercel": patch
---

The config managed `init` writes names the provider's resources and reads its credentials with `secretEnv`, so a team store in `secrets` shares them: `init` stores them there with `HOT_UPDATER_API_KEY` and reads a missing one back, and `secrets import` moves an existing project's from `.env.hotupdater`. Doctor lists where each `secretEnv` name comes from. The storage and database adapters take a credential as a string or a function.
