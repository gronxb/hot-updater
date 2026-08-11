---
"@hot-updater/aws": minor
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": minor
---

Add the `dynamoDB` Database V2 provider with optimized update checks
through DynamoDB secondary indexes. Deprecate `s3Database`; S3 remains the
artifact storage provider. Deprecate the public blob-backed database APIs in
preparation for their removal in a future major release.

Use DynamoDB by default for new managed AWS `hot-updater init` installations,
including table provisioning, Lambda@Edge reads, IAM access, generated config,
CloudFront invalidation, and managed client access keys. Init registers the
first key through Better Auth's universal component, saves it locally, and
shows its plaintext once. Managed clients use that key for OTA reads and
Analytics writes without receiving Analytics read or management access. Keep
S3 metadata selectable with a deprecation warning so existing installations can
replay their saved setup safely.

Map universal component data onto generic DynamoDB partitions and ordered sort
keys without importing feature schemas into the AWS provider. Keep logical
component versions in their shared schema markers and leave retention policy to
the component contract. Provision on-demand throughput caps, deletion
protection, and point-in-time recovery for new tables.

Store any number of bundle and patch metadata rows while retaining the 8 KiB
per-item guard and transactional counters. Use targeted cursor/key/index reads,
serialize patch creation and bundle updates against cascade deletion, and
process broad deletions as retryable per-bundle atomic groups.

Hydrate owner-index candidates and exact bundle references with strongly
consistent base-table batch reads, use transactional counters for unfiltered
totals, and bound unprocessed-key retries with exponential backoff. Validate
table compatibility before enabling billed point-in-time recovery.

Harden managed AWS provisioning by isolating Lambda execution roles per
installation, scoping S3/SSM/DynamoDB permissions, preserving unrelated
CloudFront and bucket-policy configuration, forwarding and caching by SDK
version and client key, reconciling Lambda configuration before publishing,
narrowing cache invalidations to update APIs, invalidating revoked-key cache
entries through neutral component mutation hooks, and caching successful full
component-readiness inspections.

Expose the provider-native atomic bundle mutation hook so database providers
without callback transactions can commit bundle and patch aggregates safely.
