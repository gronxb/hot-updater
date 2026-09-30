---
"@hot-updater/postgres": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
---

Each provider's schema follows the plugins its server runs.

- **PostgreSQL:** `sql/bundles.sql` holds core's tables and settings rows. Add the tables and settings rows of the server's plugins, such as `insights()`, with `hot-updater db migrate`.
- **DynamoDB:** `migrateDynamoDB(config, plugins)` creates the table when it is missing and writes the settings items of core and `plugins`. `hot-updater init` and `dynamodb/schema-settings.json` from `hot-updater infra scaffold` use the managed server's `plugins`, as its IAM policy does.
- **Firestore:** `migrateFirebaseDatabase(config, plugins)` writes the settings rows of core and `plugins`. `hot-updater init` passes the managed server's `plugins`.
- **D1 and Supabase:** the checked-in migrations hold the tables of core and of the managed server's plugins, Insights and API keys. `hot-updater db generate` for a server on the REST `d1Database` or on `supabaseDatabase` writes core's tables and those of the plugins it runs.
