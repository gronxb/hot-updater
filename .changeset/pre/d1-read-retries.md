---
"@hot-updater/cloudflare": patch
---

fix(cloudflare): a read that D1 fails with a transient error runs again, so one dropped connection no longer answers an update request with 500.

- A `SELECT` that D1 fails with an error its guide says to retry (`Network connection lost`, a storage reset, a code-update reset, a transient issue on the remote node, a replica disconnected from its primary) runs up to three times in all, after a short jittered wait. The last error is thrown as before.
- Writes, schema changes, and other errors are never retried, since a failed write may have committed.
