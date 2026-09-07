# Cloudflare environment

Read COMMON.md for secure credential handling. Discover the account and existing
resources first; create the missing Worker, D1 database and R2 bucket needed for
the requested setup. Resource IDs are outputs to record, not values the user
must find before the agent can start.

Use env.example as a reference and set only applicable values in the app's ignored
.env.hotupdater. Preserve existing values. These are local deployment settings;
provider credentials must never enter the React Native app.

| Variable | Purpose and when needed | Where to obtain it |
| --- | --- | --- |
| `HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID` | Required by the local R2/D1 configuration and Worker deployment. | Query the authenticated account or read the Cloudflare account dashboard. |
| `HOT_UPDATER_CLOUDFLARE_API_TOKEN` | Required by the supplied local D1 plugin and client-key helper; needs D1 Edit access to the selected account. Worker deployment tools may use a separate authenticated session. | Reuse a scoped local token or create one in Cloudflare API Tokens. Save it privately; never request its value in chat. |
| `HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME` | Required by storage and the Worker binding. | Query/create the selected R2 bucket and record its actual name. |
| `HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID` | Required by the local R2 S3-compatible client. | Reuse or create R2 API credentials scoped to the bucket with the read/write access needed for OTA deploys. Store the returned ID locally with its secret. |
| `HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY` | Required secret paired with the R2 access key ID. | Save the secret privately when R2 credentials are created; a normal Cloudflare API token is not a replacement. |
| `HOT_UPDATER_CLOUDFLARE_WORKER_NAME` | Deployment identity; also usable when resuming interactive init. | Derive a name from the project for a new Worker, check for conflicts, then record the verified name. Preserve an existing deployment's name. |
| `HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID` | Required by the local D1 plugin and Worker DB binding. | Query/create D1 and record the provider-returned ID. |
| `HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME` | Used by Wrangler migrations and deployment configuration. | Read the selected D1 database's name; it is different from its ID. |
| `HOT_UPDATER_CLOUDFLARE_R2_PRIVATE` | Bucket privacy choice recorded for init reuse; `true` or `false`. The environment value alone does not change bucket access. | Inspect actual bucket settings, preserve existing privacy, and use the setup guide's private default for a new bucket. |
| `HOT_UPDATER_API_KEY` | Client authentication via `x-api-key`; required after schema setup. | Reuse the existing client key or run app/provision-api-key.mjs. It saves api-key.local before registration. Keep the same key on retries; only this client key belongs in app request configuration. |

## Worker settings

`STORAGE_DOWNLOAD_URL_SIGNING_KEY` is a Worker secret, not a local plugin input.
It signs private storage downloads. Follow SETUP.md to generate and persist it
privately before uploading; reuse it for retries and upgrades.

`DB` and `BUCKET` are resource bindings, and `BUCKET_NAME` is a Worker variable.
Fill them in worker/wrangler.json with the verified resource identities. Use
the provider-reported Worker URL for the client base URL and deployment record.

An MCP login does not supply D1/R2 credentials to the local Hot Updater CLI.
Prepare that local access before claiming future CLI deploys are configured.
