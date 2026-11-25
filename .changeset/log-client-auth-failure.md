---
"@hot-updater/server": patch
---

Log why client authentication failed before a client route answers 503. The `authenticate` catch answered `{"error":"Service unavailable"}` without logging, so a Worker or server operator saw nothing in their logs (#2035). The response stays the same.
