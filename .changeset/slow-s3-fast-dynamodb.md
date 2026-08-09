---
"@hot-updater/aws": minor
"@hot-updater/plugin-core": minor
---

Add the `dynamodbDatabase` Database V2 provider with optimized update checks
through DynamoDB secondary indexes. Deprecate `s3Database`; S3 remains the
artifact storage provider.

Expose the provider-native atomic bundle mutation hook so database providers
without callback transactions can commit bundle and patch aggregates safely.
