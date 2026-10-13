---
"@hot-updater/vercel": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

Add Vercel as a managed provider. `hot-updater init` can now set up Hot Updater on Vercel: it selects the team, creates or reuses the project, selects or creates a Blob store (private by default) and connects it to the project, and takes a Postgres database connected to the project, a new Neon database from the Vercel Marketplace, or a connection URL. It then migrates the database, deploys the prebuilt Hot Updater Function to production, and issues the first API key. The new `@hot-updater/vercel` package exports `vercelBlobStorage`, and the generated config uses `postgres` from `@hot-updater/postgres`. `hot-updater agent infra` and `infra scaffold` take `--provider vercel`.
