# Vercel environment

Read COMMON.md for secure credential handling. Discover the team, project,
Blob stores and PostgreSQL databases, create what the requested setup needs,
and record the returned identifiers. Ask about the target only when it cannot
be resolved from the app, existing deployment or authenticated account.

Use env.example as a reference and set only applicable values in the app's
ignored .env.hotupdater. The Function reads the same
`HOT_UPDATER_VERCEL_DATABASE_URL` and `HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN`
from the project's production environment variables.

| Variable                                   | Purpose and when needed                                                                                                                                                                          | Where to obtain it                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOT_UPDATER_VERCEL_TEAM_ID`               | Team that owns the project and Blob store; every API call and CLI deployment targets it. A personal account Vercel has not moved to a team uses the user ID, and its API calls take no `teamId`. | Query the authenticated account's teams and record the team ID (`team_...`), not its slug; for a personal account, record the user ID.       |
| `HOT_UPDATER_VERCEL_PROJECT_NAME`          | Project that runs the Function; its production domain is the client base URL.                                                                                                                    | Reuse the established project or derive a new name from the app; record the actual name.                                                     |
| `HOT_UPDATER_VERCEL_PROJECT_ID`            | Project ID for deployments (`VERCEL_PROJECT_ID`) and resource records.                                                                                                                           | Query or create the project and record its ID (`prj_...`).                                                                                   |
| `HOT_UPDATER_VERCEL_BLOB_STORE_NAME`       | Private Blob store name, used to find or create the store on reruns.                                                                                                                             | Reuse the established private store or create a private one; record its actual name. A public store is not used.                             |
| `HOT_UPDATER_VERCEL_BLOB_STORE_ID`         | Blob store ID for resource records.                                                                                                                                                              | Query or create the store and record its ID (`store_...`).                                                                                   |
| `HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN` | Required by the local storage plugin to upload bundles, and by the Function.                                                                                                                     | Read the `*_READ_WRITE_TOKEN` the store's project connection added to the production environment. Save it locally, never in chat or the app. |
| `HOT_UPDATER_VERCEL_DATABASE_URL`          | PostgreSQL connection URL for the local database plugin, the client credential helper and the Function.                                                                                          | Read the connected Marketplace database's `DATABASE_URL`, or use the URL the user configured. Save it locally, never in chat or the app.     |
| `VERCEL_TOKEN`                             | Conditional Vercel API and CLI authentication. Not needed when the selected tool or `npx vercel login` already has access.                                                                       | Create an access token in the account's settings and save it privately through the tool's credential flow.                                   |

<!-- if credential -->

| `{{CREDENTIAL_ENV}}` | The client {{CREDENTIAL_LABEL}}, sent in `{{CREDENTIAL_HEADER}}`; required after schema setup. | Reuse the saved one or run app/provision-client-credential.mjs. Keep client-credential.local private; never replace this with a Vercel or database credential. |

<!-- end -->

## Function settings

The Function connects with `HOT_UPDATER_VERCEL_DATABASE_URL`; a pooled URL,
such as Neon's `DATABASE_URL`, suits serverless connections. Vercel's
production domain must stay publicly reachable: Deployment Protection on
production blocks devices. Record the verified production URL in
deployment.json. Do not guess it from the project name.
