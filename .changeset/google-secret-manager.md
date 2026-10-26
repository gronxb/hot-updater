---
"hot-updater": minor
---

`googleSecretManager({ project, prefix? })` from `hot-updater` reads and stores the CLI's secrets in Google Cloud Secret Manager over its REST API. A name is the secret ID with `prefix` before it, and a read is its `latest` version, checked against its CRC32C. The access token comes from `CLOUDSDK_AUTH_ACCESS_TOKEN` or `GOOGLE_OAUTH_ACCESS_TOKEN`, then a Workload Identity Federation file in `GOOGLE_APPLICATION_CREDENTIALS` as `google-github-actions/auth` writes it, exchanged with `fetch`, then Application Default Credentials through the optional peer `google-auth-library`. `set` creates a missing secret, checks the permissions it needs before it writes, adds a version, waits for the eventually consistent `latest` alias to resolve to it, and then destroys the older versions it added, which the secret's `hot-updater-versions` annotation lists and which it updates against the secret's etag; versions added any other way are never touched.
