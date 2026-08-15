---
"@hot-updater/plugin-core": minor
"@hot-updater/aws": minor
---

Remove `createBlobDatabasePlugin` and the AWS `s3Database` metadata provider.
AWS init and Lambda@Edge now use DynamoDB as the only metadata database while
continuing to store bundle artifacts in S3.
