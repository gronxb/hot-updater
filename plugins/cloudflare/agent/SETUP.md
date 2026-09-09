# Cloudflare setup checklist

Read COMMON.md first. Work through this checklist in order; each Verify is a
prerequisite for the next dependent step. Use available authenticated MCP/API
operations or the CLI fallback shown below. Paths are relative to this scaffold.
Record observations in deployment.json as described in COMMON.md.

- [ ] **cf.account — Select the target**
  - Inputs: the app's existing configuration and authenticated Cloudflare access.
  - Run: query accounts, Worker names, D1 databases and R2 buckets. Resolve only
    ambiguous choices with the user. Before adopting an existing Hot Updater
    Worker, inspect /version and D1 schema; read the applicable upgrade files.
  - Verify/record: accountId and intended resource names are established; any
    existing endpoint/schema is compatible. Legacy D1/Workers need separate resources.
  - Retry: resolve denied/incomplete discovery before treating a resource as absent.

- [ ] **cf.storage — Prepare R2**
  - Requires: cf.account. Record the account and selected bucket name before creation.
  - Run: query/reuse the bucket or create the missing bucket. Preserve existing
    privacy settings and objects. Use the project's established location preferences.
  - Verify/record: the bucket exists in the selected account; save bucketName.
  - Retry: query that same account/name after a timeout before creating anything.

- [ ] **cf.database — Prepare D1**
  - Requires: cf.account; inspect existing table names before adoption.
  - Run: query/reuse a compatible database or create the selected new database.
  - Verify/record: save d1DatabaseId and d1DatabaseName from the provider response.
  - Retry: query the selected account/name; never replace a database to retry.

- [ ] **cf.schema — Configure and migrate**
  - Requires: cf.storage and cf.database.
  - Run: install worker/package.json dependencies in worker/. Fill wrangler.json's
    account, Worker name, D1 ID/name and R2 bucket. Keep DB/BUCKET bindings,
    BUCKET_NAME, cache settings and compatibility date. Replace %%BUCKET_NAME%%
    in worker/migrations using the verified bucket name with SQL-safe escaping.
    Inspect history, then from worker/ run
    `npx wrangler d1 migrations apply <database-name> --remote`.
    MCP SQL operations must preserve migration names/history as well.
  - Verify/record: no pending supplied migrations, expected tables/schema version
    exist, and deployment inputs contain no unresolved placeholders. Record the
    actual applied filenames and database ID, not SQL or credential dumps.
  - Retry: inspect schema and migration history before applying only missing SQL.

- [ ] **cf.worker — Deploy the runtime**
  - Requires: cf.schema. The bundled worker/dist/index.js is the init runtime.
  - Run: from worker/, `npm run deploy`, or deploy the same bundle/config through
    a provider tool. Preserve an existing Worker's routes and custom settings.
  - Verify/record: actual DB/BUCKET bindings, active deployment version and public
    URL match the selected resources. Save workerName and baseUrl.
  - Retry: query the existing Worker deployment and logs; reuse D1/R2 and its name.

- [ ] **cf.signing — Configure download signing**
  - Requires: cf.worker. Inspect secret names without revealing values.
  - Run: retain an existing STORAGE_DOWNLOAD_URL_SIGNING_KEY. If absent, generate
    32 random bytes locally and persist them privately before uploading via a
    secret store/API or `wrangler secret put STORAGE_DOWNLOAD_URL_SIGNING_KEY`
    from worker/, piping the saved file through stdin without printing its contents.
  - Verify/record: the secret exists on the active Worker. Record its name/private
    local reference only; artifact download is checked by common.report when available.
  - Retry: reuse the same saved secret and inspect remote state; do not rotate it.

- [ ] **cf.client-key — Prepare local access and register the client key**
  - Requires: cf.schema and cf.signing.
  - Run: complete COMMON.md's Local CLI and client API key steps. ENVIRONMENT.md
    explains the local D1 API and R2 S3 credentials. Run the supplied key helper
    from the app directory; do not use a provider token as the client key.
  - Verify/record: helper registration succeeds with the saved/reused key and
    local config points to the selected D1/R2. Record only the private key path.
  - Retry: reuse the persisted key and resources; inspect access errors.

- [ ] **cf.complete — Verify and report**
  - Requires: all preceding steps.
  - Run: complete common.verify, common.local and common.report in
    COMMON.md against the actual Worker URL.
  - Verify/record: server version/generation, authenticated catalog access and
    local configuration are verified; requested app integration is reported separately.
  - Retry: return to the specific failing step; a deploy command alone is not completion.
