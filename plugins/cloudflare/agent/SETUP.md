# Cloudflare setup

Read COMMON.md. This scaffold uses D1, R2 and a Worker with client API-key
authentication. Prefer available Cloudflare MCP/API operations; Wrangler can
deploy the worker/ project. Inspect the actual tools before choosing a route.

1. **Account and resources.** Confirm the Cloudflare account and region/location
   preferences. Query existing D1 databases, R2 buckets and Worker names. Create
   missing resources needed for the requested setup and record their IDs. Before
   adopting an existing Hot Updater Worker, check /version and generation 1.
   Inspect the D1 schema before applying SQL; legacy tables require new resources.
2. **Schema.** Replace %%BUCKET_NAME%% in worker/migrations with the selected
   bucket name. Inspect D1 migration history, then apply pending files in order.
   With Wrangler, work in worker/ and run
   `npx wrangler d1 migrations apply <database-name> --remote`.
   When using MCP SQL operations, preserve migration history and verify every
   schema change; do not blindly execute all SQL again after a timeout.
3. **Worker inputs.** Fill worker/wrangler.json with the account ID, Worker name,
   D1 ID/name, and R2 bucket. Keep bindings DB and BUCKET, variable BUCKET_NAME,
   and the supplied cache configuration and compatibility date. The bundled
   worker/dist/index.js is the same runtime used by interactive init.
4. **Signing secret.** Inspect whether STORAGE_DOWNLOAD_URL_SIGNING_KEY already
   exists. Reuse it. For a new deployment, create 32 random bytes locally and
   persist them in an ignored secret file before uploading through the provider's
   secret API or `wrangler secret put STORAGE_DOWNLOAD_URL_SIGNING_KEY`.
   Never print the value. Some tools require a Worker deployment before setting
   secrets; in that case perform the initial deployment, set the secret, then
   verify the final active deployment before declaring it ready.
5. **Deploy.** Apply the bundled Worker through an available deployment tool, or
   install worker/package.json dependencies and run `npm run deploy` in worker/.
   Verify actual bindings, active version, and the resulting public URL. On
   failure, inspect logs and retry this step using the existing D1 and R2.
6. **Local access and key.** Prepare D1 API access and R2 S3-compatible credentials
   for future CLI deploys. Keep existing bucket privacy settings. Complete the
   local config and client-key steps in COMMON.md after schema readiness.
7. **Verify.** Check /version and an authenticated client request. Record the
   Worker URL and actual deployment version in deployment.json. A successful
   deploy command alone does not establish a working signing secret or binding.
