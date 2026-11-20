---
"@hot-updater/aws": patch
---

**AWS.** Init no longer fails on an existing CloudFront distribution with `IllegalUpdate: The specified list of custom error responses does not exist or is not valid`. Each error response that keeps a 500, 502, 503 or 504 out of the cache now carries an empty `ResponsePagePath` and `ResponseCode`, which CloudFront requires even when no page replaces the server's answer.
