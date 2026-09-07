# Supabase environment

Read COMMON.md for secure credential handling. Discover the organization and
projects, create a project and bucket if the requested setup needs them, and
record the returned identifiers. Ask about the target only when it cannot be
resolved from the app, existing deployment or authenticated account.

Use env.example as a reference and set only applicable values in the app's ignored
.env.hotupdater. Project creation and CLI login inputs are conditional; an MCP/API
workflow does not require every interactive-init input.

| Variable | Purpose and when needed | Where to obtain it |
| --- | --- | --- |
| `HOT_UPDATER_SUPABASE_PROJECT_ID` | Project reference for migrations, Function deployment and resource records. | Query/create the project and record its reference; do not use its display name. |
| `HOT_UPDATER_SUPABASE_URL` | Required by the local database/storage plugins and client-key helper. | Read the selected project's API URL from its API settings or provider response. |
| `HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY` | Required by the supplied local admin plugins and client-key helper. Use a server-side service-role or supported secret key, not a publishable/anon key. | Reuse private local configuration or obtain a suitable server credential from the selected project's API settings. Save it locally, never in chat or the app. |
| `HOT_UPDATER_SUPABASE_BUCKET_NAME` | Required storage bucket and migration/function input. | Query/create the bucket and record its actual name, preserving an existing bucket's access policy. |
| `HOT_UPDATER_SUPABASE_FUNCTION_NAME` | Edge Function name used to build the client endpoint; also recorded for init reuse. | Use the supplied name in SETUP.md or preserve the verified existing function name across all template references. |
| `HOT_UPDATER_SUPABASE_PROJECT_NAME` | Needed only when creating a project through a tool that requires a display name. | Derive it from the app where possible and record the created project's name. Leave unset for reuse. |
| `HOT_UPDATER_SUPABASE_ORGANIZATION_SLUG` | Organization selection for project creation; not read by the local database/storage config. | Query accessible organizations and reuse the established target. Ask only if the selection is ambiguous. |
| `HOT_UPDATER_SUPABASE_REGION` | Region for a new project; not needed to reuse a ready project. | Reuse the project's deployment preference and supported provider regions; ask only when a location decision is missing. |
| `SUPABASE_ACCESS_TOKEN` | Conditional Supabase CLI/Management API authentication. Not needed when the selected tool already has suitable access. | Authenticate the tool or save a personal access token privately through its supported local credential flow. |
| `HOT_UPDATER_SUPABASE_DB_PASSWORD` | Conditional database password for creation or a migration tool that requires direct database access. Not used by the supplied local plugins. | For a new project, generate and persist it privately before creation. For an existing project, reuse local credentials or ask the user to configure the chosen tool securely. |
| `HOT_UPDATER_API_KEY` | Client authentication via `x-api-key`; required after schema setup. | Reuse the saved key or run app/provision-api-key.mjs. Keep api-key.local private; never replace this with the service-role key. |

## Function settings

The prepared Edge Function uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
in its runtime environment. Verify the project's built-in Function environment
provides them. They are separate from the `HOT_UPDATER_*` local plugin settings.
Keep `verify_jwt=false` as specified in SETUP.md; client requests use the
Hot Updater client key.

Record the verified Function base URL in deployment.json. Do not guess it from
a display name. An authenticated MCP connection does not configure local CLI
service credentials automatically.
