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
Wait for a newly provisioned Supabase Storage tenant before creating the
selected bucket.
