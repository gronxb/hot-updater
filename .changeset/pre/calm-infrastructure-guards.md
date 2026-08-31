---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Prevent managed init from overwriting existing v0 Workers and Functions when
the selected compute resource name is already in use. Retry initial AWS Lambda
creation while a newly created execution role propagates. Show the issued API
key separately after the React Native setup example so it can be stored safely.
Enable the Cloud Functions API before checking an existing Firebase function
and report function discovery failures without an unhandled command stack.
Bundle Firebase Functions' internal plugin dependency and deploy only the
managed v1 Function target so an existing v0 Function is preserved.
Wait for a newly provisioned Supabase Storage tenant before creating the
selected bucket, and preserve the access level of a reused operator-owned
bucket. Wait for PostgREST to expose newly migrated Supabase tables before
registering the init API key, and keep Supabase CLI metadata inside the
temporary scaffold workdir.
