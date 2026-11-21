---
"@hot-updater/firebase": patch
---

fix(firebase): retry a transient Firebase Storage upload failure, and name the HTTP status when it fails

- `firebaseStorage` never retried an upload: the Cloud Storage SDK retries one only under a generation precondition, which would fail concurrent puts of one key. `put` now sends an upload again after a 5xx, a 429, a 408, or a dropped connection, up to 3 attempts with a short jittered backoff. The upload overwrites, so an attempt Storage stored before it failed is replaced with the same bytes. Another 4xx is not retried.
- Only a body of at most 16 MiB is held in memory to send again. A larger one, such as a native build, is still streamed once and not retried.
- Uploads go in one request instead of a resumable session's two.
- A failed upload reads `Firebase Storage answered HTTP 503 while uploading <key>` instead of `Retry limit exceeded - "<!DOCTYPE html>..."`, and a 4xx adds Storage's message.
