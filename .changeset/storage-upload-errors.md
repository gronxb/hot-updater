---
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/azure": patch
"@hot-updater/vercel": patch
---

fix(storage): fail a transient upload failure fast with one line that names it, instead of a parse error, a hang, or a TypeError

A failed upload stops `deploy` before it writes the database, so run the command again.

- `supabaseStorage`: a gateway's HTML error page no longer surfaces as `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. An upload fails with `Supabase Storage answered HTTP 502 while uploading <key>`, and a 4xx adds Storage's message. Other Storage calls that fail with such a page report `Supabase Storage answered HTTP <status>`.
- `firebaseStorage`: an upload goes in one request instead of a resumable session's two, and fails with `Firebase Storage answered HTTP 503 while uploading <key>` instead of `Retry limit exceeded - "<!DOCTYPE html>..."`. Storage's message is added unless it is an HTML error page, as for a timed-out upload's 408.
- `azureBlobStorage`: an upload of known length no longer hangs when Azure answers 500 or 503. The SDK retried it by sending the stream it had already read; it now gets one try and fails with `Azure Blob Storage answered HTTP 503 while uploading <key>`, and a 4xx adds Azure's error code.
- `vercelBlobStorage`: a single-request upload that Vercel Blob fails with an error or a dropped connection reads `Vercel Blob failed while uploading <key>: it answered an error or the connection dropped` instead of `TypeError: Response body object should not be disturbed or locked`. @vercel/blob doesn't expose the HTTP status.
