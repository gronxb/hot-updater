---
"@hot-updater/supabase": patch
---

Fix Supabase init skipping database migrations in npm/Yarn workspaces by explicitly passing the staged migration directory to db push.
