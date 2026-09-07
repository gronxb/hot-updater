# Firebase environment

Read COMMON.md for secure credential handling. Discover the project and existing
deployment; create missing project, Firestore, Storage and Function resources
with authorized provider tools. Ask only for unresolved project selection,
authentication or prerequisites that require the user's involvement.

Use env.example as a reference and set only applicable values in the app's ignored
.env.hotupdater. The supplied plugins use Firebase Admin's application-default
credentials. An authenticated Firebase CLI or MCP session does not necessarily
provide credentials to the local Admin SDK.

| Variable | Purpose and when needed | Where to obtain it |
| --- | --- | --- |
| `HOT_UPDATER_FIREBASE_PROJECT_ID` | Required by the local database/storage configuration and client-key helper. | Query/create the project and record its actual ID, not its display name. |
| `HOT_UPDATER_FIREBASE_REGION` | Function deployment region; recorded for init reuse. | Read the existing function's region or use the established project deployment preference for a new function. |
| `HOT_UPDATER_FIREBASE_STORAGE_BUCKET` | Required by the supplied local storage config. | Query the project's canonical default Storage bucket. Enable Storage if needed and record the returned name; do not guess its suffix. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional local path to a private credential file used by application-default credentials. Leave unset when a working application-default identity is already available. | Prefer the environment's existing identity or application-default login. If a credential file is required, configure it privately and set its path, never paste its JSON into chat. |
| `HOT_UPDATER_API_KEY` | Client authentication via `x-api-key`; required after the namespace is ready. | Reuse the saved key or run app/provision-api-key.mjs. Keep api-key.local private and stable on retries; do not use an Admin SDK credential as this key. |

## Function settings

The deployed Function uses its runtime application-default identity. It needs
Firestore/Storage permissions and the actual default bucket in Firebase app
options. Do not upload the local service-account credential file as an app asset
or substitute it for the runtime identity.

The region is a deployment-template input. Preserve an existing optional
`HOT_UPDATER_CDN_URL` runtime setting when present; it is not required for a new
direct-Function deployment. Record the verified Function URL in deployment.json.
