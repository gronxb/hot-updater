# AWS setup checklist

For an already initialized 1.0.0 RC namespace, inspect actual Insights fields;
the unchanged version marker does not identify the current event layout.
Fresh storage uses event `metadata` and no shared installation table. Follow the
packaged 1.0.0 infrastructure upgrade's offline export/replay procedure for old
flat-event data before deploying matching code. Preserve non-Insights data,
artifacts, endpoint and credentials; do not rerun initialization as a conversion.


Read COMMON.md first. Use authenticated AWS MCP/API operations or the CLI recipes
below, from the scaffold root. Fill the JSON/code placeholders with verified
identifiers before use. dynamodb/ contains whole API request objects; iam/
contains policy documents. They are generated from the same input builders as
init. reference/ is additional context, not executable provisioning code.

- [ ] **aws.target — Identify the installation**
  - Inputs: app configuration and working AWS role/profile/SSO access.
  - Run: verify caller identity, regional S3/DynamoDB resources and any existing
    Lambda/CloudFront deployment. Resolve ambiguous account/region choices. Check
    generation/schema and applicable upgrade files before adopting resources.
    For legacy infrastructure, use separate table/Lambda/distribution identities.
  - Verify/record: accountId, region, resource names and compatible reuse decisions.
    Save intended names before creating anything. S3 may be shared with data/policies preserved.
  - Retry: query the same account/region/names; denied listings do not mean absence.

- [ ] **aws.storage — Prepare S3**
  - Requires: aws.target.
  - Run: reuse the selected bucket or create it in the established regional
    deployment location; preserve its objects, privacy and unrelated policies.
  - Verify/record: bucketName, actual region and regional domain name.
  - Retry: query the bucket/location before any repeated creation request.

- [ ] **aws.database — Prepare DynamoDB**
  - Requires: aws.storage. Fill DYNAMODB_TABLE_NAME in both dynamodb/ JSON files.
  - Run: inspect an existing table against create-table.json. If absent, use
    `aws dynamodb create-table --region <region> --cli-input-json file://dynamodb/create-table.json`.
    Wait for ACTIVE, then inspect PITR; when disabled, use
    `aws dynamodb update-continuous-backups --region <region> --cli-input-json file://dynamodb/enable-pitr.json`.
  - Verify/record: tableName; string pk/sk and gsi1pk/gsi1sk, required GSI with ALL
    projection, PAY_PER_REQUEST and table/index throughput limits match the JSON;
    table/GSI are ACTIVE and PITR is enabled. New tables have deletion protection
    enabled; preserve that setting on reused tables. There is no separate SQL
    migration for this provider. Reject incompatible tables in place.
  - Retry: describe the same table/backups and enable PITR only when missing.

- [ ] **aws.client-key — Initialize local access and the client key**
  - Requires: aws.database. Run this before Lambda deployment, as init does.
  - Run: follow COMMON.md's Local CLI and client API key steps with the selected
    table/region and standard AWS credential chain. At this stage leave
    HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID unset if no distribution exists yet;
    it is not needed for key registration. ENVIRONMENT.md explains the inputs.
  - Verify/record: the supplied helper registers/reuses the saved key in the
    selected table. Record its private file path, never its contents.
  - Retry: inspect local access and reuse the same key; do not recreate the table.

- [ ] **aws.iam — Prepare the Lambda execution role**
  - Requires: aws.client-key. Fill account/region/table/bucket/SSM placeholders in iam/.
  - Run: select an installation-specific role and inspect its trust/policies.
    For a new role use `aws iam create-role --role-name <role-name> --assume-role-policy-document file://iam/trust-policy.json`.
    Attach `arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole` if missing. Apply the documents with
    `aws iam put-role-policy --role-name <role-name> --policy-name <policy-name> --policy-document file://<file>`:
    iam/dynamodb-policy.json → HotUpdaterDynamoDBReadAccess;
    iam/s3-policy.json → HotUpdaterS3ReadAccess;
    iam/ssm-policy.json → HotUpdaterSSMAccess. In that IAM document,
    __HOT_UPDATER_SSM_PARAMETER_PATH__ is the SSM name without its leading slash
    (`hot-updater/v1/<lambda-name>/keypair`); lambda/index.cjs uses the full
    __HOT_UPDATER_SSM_PARAMETER_NAME__ (`/hot-updater/v1/<lambda-name>/keypair`).
    Preserve unrelated policies.
  - Verify/record: roleName/roleArn; both lambda.amazonaws.com and
    edgelambda.amazonaws.com can assume it; resource ARNs match this installation.
  - Retry: retrieve role/policies and allow propagation; reuse the selected role.

- [ ] **aws.signing — Prepare download signing**
  - Requires: aws.iam.
  - Run: query regional SSM at /hot-updater/v1/<lambda-name>/keypair. Reuse its
    SecureString JSON {keyPairId, publicKey, privateKey}. If absent, generate
    RSA-2048 with SPKI public PEM/PKCS8 private PEM and save privately before
    upload. Create/reuse the corresponding CloudFront public key and trusted
    key group; store each returned ID immediately. Private keys stay out of Lambda.
  - Verify/record: ssmParameterName, publicKeyId and keyGroupId are consistent.
    Store stable creation names/CallerReference before creation; key ID and group
    ID are different inputs. Never record decrypted key material or signed URLs.
  - Retry: inspect SSM/public-key/group state and reuse the saved pair and IDs.

- [ ] **aws.lambda — Publish the server**
  - Requires: aws.database, aws.client-key, aws.iam and aws.signing.
  - Run: fill lambda/index.cjs resource inputs, including the public key ID
    (not key group), regional DynamoDB/SSM inputs and bucket. Lambda@Edge uses
    these code inputs, not ordinary environment variables. Install the pinned
    lambda/package.json dependencies; zip index.cjs and node_modules at zip root.
    Create/update in us-east-1: nodejs22.x, index.handler, 256 MB, 10 seconds.
    Wait for Active and successful configuration updates, then publish a numbered version.
  - Verify/record: qualifiedLambdaArn includes a numeric version; save it before
    CloudFront association. Do not associate $LATEST.
  - Retry: inspect existing code/config and published versions; reuse a verified
    matching version instead of publishing again after a lost response.

- [ ] **aws.distribution — Expose the deployment**
  - Requires: aws.lambda and aws.signing.
  - Run: query/create the policies using `aws cloudfront create-cache-policy
    --cli-input-json file://cloudfront/cache-policy.json` and catalog-cache-policy.json;
    for origin-request-policy.json use create-origin-request-policy with the same
    --cli-input-json form. Record each policy ID before the next creation.
    Create/reuse an S3 OAC (sigv4, always signing); record oacId. Fill distribution.json
    with these IDs, the qualified Lambda ARN, key group and regional S3 domain.
    Persist one distributionCallerReference before the first create request and
    reuse it on retry. For a new distribution use
    `aws cloudfront create-distribution --distribution-config file://cloudfront/distribution.json`.
    For an existing one, get its full config/ETag and merge only managed settings;
    update with that ETag. Preserve aliases, unrelated origins/behaviors and IncludeBody
    for events. Grant S3 OAC read access scoped to this distribution ARN while
    preserving unrelated bucket-policy statements.
  - Verify/record: oacId, cachePolicyId, catalogCachePolicyId, originRequestPolicyId,
    distributionId, distributionCallerReference and baseUrl. Wait for Deployed;
    verify the selected S3 origin, Lambda version, signed default artifact behavior
    and API-key-aware API/catalog policies before marking this step complete.
  - Retry: query saved IDs/names/CallerReference and current ETag. Do not generate
    a new CallerReference, distribution, policy or key group merely to retry.

- [ ] **aws.complete — Finish local configuration and verify**
  - Requires: aws.distribution.
  - Run: fill HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID now that it exists. Complete
    common.verify, common.local and common.report in COMMON.md using the actual
    distribution URL.
  - Verify/record: local config and standard credential chain work; server version,
    generation and catalog authentication pass; check signed artifact access when
    available and report requested app integration separately.
  - Retry: return to the failed resource/check and preserve all verified resources.
