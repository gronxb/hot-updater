---
"@hot-updater/aws": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Add normalized server-runtime plugin entrypoints:

- `@hot-updater/aws/lambda` exports `s3Database` and the Lambda@Edge
  CloudFront-aware `s3Storage`.
- `@hot-updater/firebase/functions` exports `firebaseDatabase` and
  `firebaseStorage`, deriving Admin SDK settings from the initialized Functions
  app.
- `@hot-updater/supabase/edge` exports `supabaseDatabase` and
  `supabaseStorage` from an isolated Edge runtime bundle.

Move the managed deployment artifacts to
`@hot-updater/aws/lambda/handler` and
`@hot-updater/firebase/functions/handler`. Move the AWS Lambda-specific and
Supabase Edge-specific plugin names out of the root provider entrypoints.
