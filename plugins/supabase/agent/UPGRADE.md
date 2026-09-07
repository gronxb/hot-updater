# Supabase upgrade

Read COMMON.md and UPGRADE-NOTES.md. Inspect the live function, project reference,
schema/migration history, bucket privacy and /version before changing anything.

Compare pending migrations and the prepared function/import map against the
existing deployment. Keep the project, function name/URL, bucket, API key records,
unrelated schema and existing customizations. Apply compatible pending migrations
first, preserving history through the chosen migration tool. Deploy the complete
function directory and retain verify_jwt=false with runtime x-api-key validation.
If function deployment fails, verify the migration results and retry deployment
without recreating the project or replaying successful migrations.

Wait for schema/function readiness, then verify /version, /ping and an
authenticated client request. Generation 0 requires separate generation 1
resources; do not infer an in-place schema conversion from the baseline SQL.
