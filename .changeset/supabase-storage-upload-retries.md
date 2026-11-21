---
"@hot-updater/supabase": patch
---

fix(supabase): retry a transient Supabase Storage upload failure, and name the HTTP status when it fails

- `supabaseStorage` sends an upload again after a 5xx, a 429, or a request Storage never answered, up to 3 attempts with a short jittered backoff, as the AWS SDK does for `s3Storage`. The upload overwrites (`upsert`), so an attempt Storage stored before it failed is replaced with the same bytes. A 4xx other than 429 is not retried.
- Only a body of at most 16 MiB is held in memory to send again. A larger one, such as a native build, is still streamed once and not retried.
- A gateway's HTML error page no longer surfaces as `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. A failed upload now reads `Supabase Storage answered HTTP 502 while uploading <key>`, a 4xx adds Storage's message, and a request without a response reads `Supabase Storage did not answer while uploading <key>: <reason>`.
