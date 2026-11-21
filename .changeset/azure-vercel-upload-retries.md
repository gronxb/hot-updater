---
"@hot-updater/azure": patch
"@hot-updater/vercel": patch
---

fix(azure, vercel): send the whole body again when the SDK retries a failed upload

- `azureBlobStorage` streamed every upload of known length, so when the SDK retried a 500 or 503 it sent a stream it had already read, and the upload hung. A body of at most 16 MiB is now held in memory and sent again whole. A larger one is still streamed in one Put Blob, which now gets one try and fails with the SDK's error instead of hanging.
- `vercelBlobStorage` failed a retried upload with `TypeError: Response body object should not be disturbed or locked`, because @vercel/blob sent the same stream again. A body of at most 16 MiB is now held in memory and sent again whole. A larger one is uploaded in 8 MiB parts, which @vercel/blob holds in memory and retries each on its own; before, only bodies over 100 MiB or of unknown length were. A body of unknown length that ends within 16 MiB now goes in one request instead of parts.
