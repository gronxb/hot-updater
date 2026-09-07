# AWS upgrade

Read COMMON.md and UPGRADE-NOTES.md. Confirm account/region, table schema,
distribution configuration/ETag, qualified Lambda ARN, SSM parameter and public
key/group identities against the previous deployment record and live /version.

Compare the new Lambda code, exact dependencies, IAM requirements, and CloudFront
policy/behavior specifications. Keep S3, DynamoDB data and API keys, SSM key pair,
trusted key group, endpoint and unrelated policies. For generation 1, the current
baseline does not require a SQL migration; validate the table/index schema and
apply any lifecycle or IAM changes specified in the version notes.

Publish the new Lambda version in us-east-1, wait for Active, then update only
the managed associations/behaviors on the existing distribution using its current
ETag. Preserve custom domains and unrelated origins/behaviors. Wait for global
propagation, verify /version and authenticated requests, and record the exact
active version. If distribution update fails, reuse the published Lambda version
after inspection; do not recreate keys, tables, or distributions.

For v0, keep the old Lambda/distribution serving old binaries and use separate
v1 identities as described in UPGRADE-NOTES.md. Do not repoint a v0 distribution
to v1 or use a v0 endpoint as rollback for v1 native binaries.
