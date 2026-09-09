# Supabase setup checklist

For an already initialized 1.0.0 RC namespace, inspect actual Insights fields;
the unchanged version marker does not identify the current event layout.
Fresh storage uses event `metadata` and no shared installation table. Follow the
packaged 1.0.0 infrastructure upgrade's offline export/replay procedure for old
flat-event data before deploying matching code. Preserve non-Insights data,
artifacts, endpoint and credentials; do not rerun initialization as a conversion.


Read COMMON.md first. Follow these steps in order and record verified observations
in deployment.json. Paths are relative to this scaffold. Use actual connected
MCP capabilities; a project-scoped connection cannot create projects. An account
connection, CLI/API or browser can handle missing account-level prerequisites.

- [ ] **sb.project — Select or create the project**
  - Inputs: existing app configuration, organization and established region preference.
  - Run: query projects and record the selected organization/name before creating
    a missing project. Wait for database readiness. Inspect existing functions,
    schema and /version before adoption; read applicable upgrade files first.
  - Verify/record: projectId/reference and actual project URL are known, the
    database is ready, and an existing namespace/endpoint is compatible.
  - Retry: query the original organization/name or returned operation ID; a timeout
    or denied request is not evidence that the project is absent.

- [ ] **sb.storage — Prepare Storage**
  - Requires: sb.project.
  - Run: query/reuse the bucket, preserving its public/private setting; create a
    missing bucket as private. Use a storage API or console if MCP lacks Storage.
  - Verify/record: the selected bucket is available; save bucketName.
  - Retry: `Missing tenant config for tenant` can be provisioning delay. Wait and
    query the same project/bucket; do not recreate the project.

- [ ] **sb.schema — Apply pending database migrations**
  - Requires: sb.storage; inspect actual schema and migration history first.
  - Run: fill %%BUCKET_NAME%% in supabase/migrations with SQL-safe escaping and
    the project ID in config.toml. Preserve original migration filenames.
    With local CLI access, use private session/environment credentials and run
    these commands from the scaffold root, one at a time:
    `npx supabase link --project-ref <project-id>`;
    `npx supabase migration fetch --linked --yes`;
    inspect the synchronized history and pending supplied SQL, then
    `npx supabase db push --include-all --yes`.
    MCP migration operations must preserve the same names/history and SQL.
  - Verify/record: supplied migrations are applied, expected tables/schema version
    exist, and the API schema cache can access them. Record applied filenames.
  - Retry: inspect actual schema/history before replaying anything. Only the exact
    missing `supabase_migrations.schema_migrations` relation on a fresh project
    permits proceeding from failed history fetch to the first push. This error
    may appear JSON-escaped in stdout. Connection/permission errors and any other
    missing relation must be resolved; never treat them as an empty database.

- [ ] **sb.client-key — Configure local access and register the key**
  - Requires: sb.schema. Do this before Function deployment, as interactive init does.
  - Run: complete COMMON.md's Local CLI and client API key steps using the chosen
    project URL/service-role access from ENVIRONMENT.md. Run the key helper from
    the app directory with the same saved key on retries.
  - Verify/record: key registration succeeds and the local config targets this
    project/bucket. Save only the private key-file reference.
  - Retry: allow for schema-cache propagation; inspect permission/schema errors
    and retry the helper without rotating keys or recreating resources.

- [ ] **sb.function — Deploy the complete Edge Function**
  - Requires: sb.client-key.
  - Run: fill __HOT_UPDATER_BUCKET_NAME__. Default function: hot-updater-v1.
    If preserving another function name, update its directory, functionName in
    index.ts and config.toml entry together. Deploy deno.json and all _hot-updater/
    vendored files along with index.ts. Keep verify_jwt=false for x-api-key auth.
    From the scaffold root:
    `npx supabase functions deploy <function-name> --project-ref <project-id> --no-verify-jwt`.
  - Verify/record: the active function uses the complete bundle and has runtime
    SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY. Save functionName and baseUrl as
    https://<project-id>.supabase.co/functions/v1/<function-name>.
  - Retry: inspect function status/logs and redeploy only the incomplete function;
    do not repeat completed schema changes or key registration unnecessarily.

- [ ] **sb.complete — Verify and report**
  - Requires: sb.function.
  - Run: check /ping and complete common.verify, common.local and common.report
    in COMMON.md at the function URL.
  - Verify/record: server version/generation, catalog authentication and local
    configuration pass. Origin-only catalog checks invoke the Edge Function;
    do not report CDN hits. Report requested app integration separately.
  - Retry: investigate the specific failed check using existing resources.
