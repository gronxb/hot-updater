---
"@hot-updater/aws": minor
"@hot-updater/plugin-core": minor
---

Add the `dynamodbDatabase` Database V2 provider with optimized update checks
through DynamoDB secondary indexes. Deprecate `s3Database`; S3 remains the
artifact storage provider.

Use DynamoDB by default for new managed AWS `hot-updater init` installations,
including table provisioning, Lambda@Edge reads, IAM access, generated config,
CloudFront invalidation, public Analytics ingestion, and API-key-protected
Analytics queries. Keep S3 metadata selectable with a deprecation warning so
existing installations can replay their saved setup safely.

Harden managed AWS provisioning by isolating Lambda execution roles per
installation, scoping S3/SSM/DynamoDB permissions, preserving unrelated
CloudFront and bucket-policy configuration, forwarding and caching by SDK
version, reconciling Lambda configuration before publishing, narrowing cache
invalidations to update APIs, and caching successful Analytics schema checks.

Expose the provider-native atomic bundle mutation hook so database providers
without callback transactions can commit bundle and patch aggregates safely.
