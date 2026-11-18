# Vercel setup checklist

Read COMMON.md first. Work through this checklist in order; each Verify is a
prerequisite for the next dependent step. Use available authenticated Vercel
MCP/API operations or the Vercel CLI fallback shown below. Paths are relative
to this scaffold. Record observations in deployment.json as described in
COMMON.md. Before using the CLI fallback, install `vercel` as an app
development dependency with its package manager and verify `npx vercel whoami`.

## Upgrade or reconcile an existing deployment

Read upgrades/README.md and the Vercel section of each applicable version file
first; a listed change applies before anything below. Then reconcile the
recorded project, Blob store and database with this scaffold: every step is
idempotent. Repeat vc.database-credential, whose migration creates only what is
missing, then vc.function, which sets the Function's variables and deploys this
scaffold's Function to production, and finish with vc.complete. Reuse the
recorded resources and saved client credential; never create replacements to
upgrade. `hot-updater init` with the saved inputs performs the same migration
and deployment.

## Setup

- [ ] **vc.project — Select the team and project**
  - Inputs: the app's existing configuration and authenticated Vercel access.
  - Run: query teams, then the intended project by name. Reuse a project only
    when it is this app's Hot Updater project (its production domain answers
    `/version` with `infrastructureGeneration`) or has never deployed to
    production; the deployment replaces production. Otherwise choose another
    name, or create the project with no framework and no build step.
  - Verify/record: teamId, projectId and projectName; the production domain is
    `<project>.vercel.app` or a domain the project already serves.
  - Retry: query the same team and name before creating anything.

- [ ] **vc.storage — Prepare the Blob store**
  - Requires: vc.project.
  - Run: query the team's Blob stores and reuse the established private one, or
    create a private one. Never use a public store: devices download bundles
    only through signed URLs that expire. Connect the store to the project's
    production environment with a read-write token (`HOT_UPDATER_VERCEL_BLOB`
    prefix), or reuse an existing connection that has one. Preserve existing
    objects.
  - Verify/record: blobStoreId; the store is private; the project's production
    environment has a `*_READ_WRITE_TOKEN` for this store. Save the token value
    privately as `HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN`, never in chat.
  - Retry: query the same team and store name before creating another store.

- [ ] **vc.database — Prepare PostgreSQL**
  - Requires: vc.project.
  - Run: reuse the PostgreSQL database the user established: a Marketplace
    database connected to the project (its `DATABASE_URL` or `POSTGRES_URL`),
    or a connection URL they provide. Creating a Marketplace database needs the
    user to accept the provider's terms; ask before creating one. Read
    `information_schema.tables`: a database with `bundles` but no
    `release_catalogs` is a Hot Updater v0 database; stop and follow the
    upgrade guide. A populated namespace needs `schema.engine` = `1` in
    `private_hot_updater_settings` before writes.
  - Verify/record: the database is reachable with its URL; save it privately as
    `HOT_UPDATER_VERCEL_DATABASE_URL`. Record only its host, never the URL.
  - Retry: inspect connectivity and schema; never replace a database to retry.

- [ ] **vc.database-credential — Migrate and register the client credential**
  - Requires: vc.storage and vc.database. Complete this before deploying the
    Function: it answers 503 until the schema settings exist.
  - Run: follow COMMON.md's Local CLI and client credential steps. Run
    app/provision-client-credential.mjs from the app directory with the
    `HOT_UPDATER_VERCEL_*` values set. The helper loads app/hotUpdater.ts, the
    credential helper's server definition, which stays in the scaffold, and
    first runs app/migrate.ts: it creates the tables of core and the plugins
    app/hotUpdater.ts runs and writes their schema settings,
<!-- if credential -->
    then registers the client {{CREDENTIAL_LABEL}}.
  - Verify/record: the helper succeeds and the {{CREDENTIAL_LABEL}} is
    persisted privately; the tables and `private_hot_updater_settings` exist.
  - Retry: rerun the helper with the saved {{CREDENTIAL_LABEL}}; it creates
    only what is missing. Never edit settings or rotate the {{CREDENTIAL_LABEL}}.
<!-- else -->
    and registers no client credential, since client routes are public.
  - Verify/record: the helper succeeds; the tables and
    `private_hot_updater_settings` exist.
  - Retry: rerun the helper; it creates only what is missing.
<!-- end -->

- [ ] **vc.function — Deploy the Function**
  - Requires: vc.database-credential.
  - Run: set the project's production environment variables
    `HOT_UPDATER_VERCEL_DATABASE_URL` and, unless the store connection already
    added it, `HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN`, as encrypted values.
    Then
    deploy the prebuilt runtime in vercel/ (api/index.mjs and vercel.json)
    to production:
    `VERCEL_ORG_ID=<team-id> VERCEL_PROJECT_ID=<project-id> npx vercel deploy vercel --prod --yes`.
    Preserve the project's domains and unrelated environment variables.
  - Verify/record: the production domain answers `/version` without
    Deployment Protection (a 401 or a redirect to vercel.com means production
    is protected; allow public access to production). Save baseUrl.
  - Retry: inspect the deployment logs; reuse the project, store and database.

- [ ] **vc.complete — Verify and report**
  - Requires: all preceding steps.
  - Run: complete common.verify, common.local and common.report in COMMON.md
    against the actual production URL.
  - Verify/record: server version/generation, authenticated catalog access and
    local configuration are verified; requested app integration is reported
    separately.
  - Retry: return to the specific failing step; a deploy alone is not completion.
