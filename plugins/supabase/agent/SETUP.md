# Supabase setup

Read COMMON.md. The scaffold contains a prepared supabase/ project with SQL
migrations and an Edge Function with local vendored imports in deno.json.

1. **Project.** Confirm organization, region, project name and existing/new
   project choice. Discover available MCP operations. Project-scoped MCP disables
   account management; use an account-capable connection, CLI/API, or browser
   when creation is needed. Wait for project/database readiness and record the
   project reference. Inspect existing functions and schema before adopting them.
2. **Storage.** Query storage buckets and reuse the selected bucket when present.
   Preserve its public/private setting. Create a missing bucket through an
   available storage API or console. A missing storage capability in MCP does
   not mean the bucket is absent. Record its name after verifying availability.
3. **Schema.** Fill %%BUCKET_NAME%% in supabase/migrations and the project ID in
   config.toml. Inspect migration history, then apply pending SQL in order via
   the Supabase migration tool or CLI. Preserve migration names/history across
   tools. Verify schema readiness after applying SQL; partial errors require
   inspecting actual schema and history before retrying.
4. **Function.** Replace __HOT_UPDATER_BUCKET_NAME__ in the prepared function.
   The default function is hot-updater-v1. If retaining another existing name,
   update the directory name, functionName value in index.ts, and config.toml
   entry together. Deploy every referenced file under the function directory,
   including deno.json and _hot-updater/. A single index.ts upload is insufficient.
   Configure verify_jwt=false: the supplied runtime authenticates x-api-key.
   CLI fallback from the scaffold root:
   `npx supabase functions deploy <function-name> --project-ref <project-id> --no-verify-jwt`.
5. **Runtime access.** Verify the runtime has SUPABASE_URL and
   SUPABASE_SERVICE_ROLE_KEY. Provider credentials stay server-side. Complete
   the local config and client-key steps in COMMON.md using the selected project.
6. **Verify.** The client base URL is
   https://<project-id>.supabase.co/functions/v1/<function-name>.
   Verify /ping, /version and an authenticated client request. Record the actual
   deployment in deployment.json. Origin-only Release Catalog checks still
   invoke the Edge Function; do not report them as CDN cache hits.
