# AWS setup

Read COMMON.md. This scaffold uses S3, DynamoDB, Lambda@Edge and CloudFront.
Use available AWS MCP/API tools or authenticated AWS CLI operations. The files
under reference/ are the current init specifications, not standalone scripts.
Resolve their DYNAMODB_* constants using reference/dynamodb-constants.json.

1. **Identify resources.** Confirm the account, S3/DynamoDB region, names and
   existing/new resource choices. Verify the caller identity and query resources
   before creation. Use a separate v1 table, Lambda name and distribution when
   moving from v0. S3 can be shared if existing objects/policies remain intact.
2. **S3 and DynamoDB.** Create/reuse the bucket. Apply the exact createTable input
   from reference/dynamodb.ts: string keys pk/sk and gsi1pk/gsi1sk,
   hot-updater-update-index with ALL projection, PAY_PER_REQUEST, throughput
   limits, and deletion protection. Enable point-in-time recovery as specified.
   For existing tables, compare key/index schema and lifecycle settings first.
   Wait for ACTIVE. Do not rebuild an incompatible table in place.
3. **IAM.** Create/reuse an installation-specific Lambda role trusted by both
   lambda.amazonaws.com and edgelambda.amazonaws.com. Apply the basic execution
   policy and the table/index, S3 and SSM permissions in reference/iam.ts using
   the selected account, region and exact resource ARNs. Preserve unrelated
   policies. Wait for role propagation rather than repeatedly creating roles.
4. **Signing.** Use /hot-updater/v1/<lambda-name>/keypair in regional SSM.
   reference/ssm.ts specifies the SecureString JSON shape: keyPairId, publicKey,
   privateKey. Reuse an existing pair. For a new pair, generate RSA-2048 with
   SPKI public PEM and PKCS8 private PEM and persist it privately before upload.
   Create/reuse the corresponding CloudFront public key and trusted key group.
   Do not rotate signing keys during a retry or copy the private key into Lambda.
5. **Lambda.** Fill every __HOT_UPDATER_*__ placeholder in lambda/index.cjs with
   resource identifiers, including the CloudFront public key ID (not the group
   ID), regional DynamoDB/SSM settings and bucket name. Lambda@Edge cannot use
   ordinary function environment variables for these inputs. Install the exact
   dependencies in lambda/package.json and zip the directory with index.cjs and
   node_modules at the zip root. Create/update the function in us-east-1 with
   runtime nodejs22.x, handler index.handler, memory 256 MB and timeout 10 seconds.
   Wait for Active and successful configuration updates, then publish a numbered
   version. Record the qualified version ARN; do not associate $LATEST.
6. **CloudFront.** Create/reuse the policy definitions under cloudfront/ and an
   S3 Origin Access Control. Fill distribution.json placeholders, including the
   qualified Lambda ARN, key group and policy IDs. For an existing distribution,
   retrieve its current config/ETag and merge the managed behaviors. Preserve
   unrelated behaviors, aliases, origins and bucket-policy statements. Grant
   CloudFront OAC read access to the selected S3 objects, scoped to the distribution
   ARN. The default behavior serves signed artifacts; API/catalog paths use the
   provided origin-request Lambda associations and API-key-aware cache policies.
   Preserve IncludeBody for event requests. Wait for distribution deployment.
7. **Local access and key.** Complete COMMON.md using the selected table and
   region. The app config template uses the standard AWS credential chain;
   configure the chosen profile/SSO/session for future CLI use. Register/reuse
   the client key after table readiness, and record its private local location.
8. **Verify.** Check the distribution's /version, an authenticated client request,
   and signed artifact retrieval when an artifact exists. Record the actual
   distribution ID/domain and Lambda version. Retry only the failing step after
   checking the remote result; never replace the table or signing pair to retry.
