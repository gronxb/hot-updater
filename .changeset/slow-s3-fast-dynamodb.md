---
"@hot-updater/aws": minor
---

Add the `dynamoDB` database provider with the flat official contract:
`bundles`, `bundlePatches`, `analytics`, `clientAccessKeys`, and atomic
`commit({ mutations })`. The provider stores all official domains directly in
one DynamoDB table; it has no universal component adapter, feature schema
migration, server kernel, or managed preset dependency.

Use DynamoDB by default for new AWS `hot-updater init` installations,
including table provisioning, Lambda@Edge reads, resource-scoped IAM access,
generated config, and CloudFront invalidation. The packaged DynamoDB runtime
enables the server's built-in Analytics and client access-key features. Client
keys are created through the Console and stored by the official access-key
port; init does not generate or retain plaintext keys. DynamoDB is the only
AWS metadata database; S3 remains available for bundle artifact storage.

Store any number of bundle, patch, Analytics event, and access-key rows while
retaining the 8 KiB per-item guard for metadata. Plan every bundle mutation
envelope as one DynamoDB transaction, including counters, patch relations, and
cascade deletions, so a later invalid mutation cannot leave earlier mutations
applied. Reject envelopes that exceed DynamoDB's 100-action transaction limit.

Use targeted cursor, key, and index reads for update checks and official-domain
queries. Hydrate owner-index candidates and exact bundle references with
strongly consistent base-table reads, maintain unfiltered totals
transactionally, and retry unprocessed batch keys with bounded exponential
backoff. Validate table compatibility before enabling billed point-in-time
recovery.

Harden AWS provisioning by isolating Lambda execution roles per installation,
scoping S3, SSM, and DynamoDB permissions, preserving unrelated CloudFront and
bucket-policy configuration, reconciling Lambda configuration before
publishing, and narrowing cache invalidations to update APIs. Successful
bundle commits perform CloudFront invalidation inside the provider; `dispose`
owns SDK client cleanup.
