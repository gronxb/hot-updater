---
"@hot-updater/aws": minor
"@hot-updater/plugin-core": minor
---

Add the `dynamoDB` Database V2 provider with optimized update checks
through DynamoDB secondary indexes. Deprecate `s3Database`; S3 remains the
artifact storage provider. Deprecate the public blob-backed database APIs in
preparation for their removal in a future major release.

Use DynamoDB by default for new managed AWS `hot-updater init` installations,
including table provisioning, Lambda@Edge reads, IAM access, generated config,
CloudFront invalidation, public Analytics ingestion, and API-key-protected
Analytics queries. Keep S3 metadata selectable with a deprecation warning so
existing installations can replay their saved setup safely.

Shard managed Analytics events by month and event identity, retain them for 90
days with DynamoDB TTL, push recent-window lower bounds into storage reads, and
provision on-demand throughput caps, deletion protection, and point-in-time
recovery for new tables.

Bound bundle metadata to 1,000 bundles, 1,000 patches, 24 relationships per
bundle, and 8 KiB per serialized item with transactional counters. Use targeted
cursor/key/index reads, serialize patch creation and bundle updates against
cascade deletion, and process broad deletions as retryable per-bundle atomic
groups that remain below DynamoDB transaction limits.

Hydrate owner-index candidates and exact bundle references with strongly
consistent base-table batch reads, use transactional counters for unfiltered
totals, and bound unprocessed-key retries with exponential backoff. Validate TTL
compatibility before enabling billed point-in-time recovery.

Harden managed AWS provisioning by isolating Lambda execution roles per
installation, scoping S3/SSM/DynamoDB permissions, preserving unrelated
CloudFront and bucket-policy configuration, forwarding and caching by SDK
version, reconciling Lambda configuration before publishing, narrowing cache
invalidations to update APIs, and caching successful Analytics schema checks.

Expose the provider-native atomic bundle mutation hook so database providers
without callback transactions can commit bundle and patch aggregates safely.
