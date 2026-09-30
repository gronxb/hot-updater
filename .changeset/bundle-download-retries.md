---
"@hot-updater/react-native": patch
---

Bundle downloads retry a transient failure on both platforms. Android's retry loop never ran, because each attempt returned its error instead of throwing it, and iOS had no retry. A manifest, file, or patch download that fails with a network error, a timeout, a body that ended early, or a `408`, `429`, or `5xx` answer is now tried up to three times in all, 1 and then 2 seconds apart. Another `4xx`, a TLS failure, a cancelled download, and a local storage failure are not retried, and the archive, which falls back to per-file downloads, is tried once. A failure that remains keeps its update-failure classification.
