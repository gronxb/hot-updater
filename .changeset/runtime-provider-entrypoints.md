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

This is a breaking import-boundary change. Migrate existing imports as follows:

| Previous import | Replacement |
| --- | --- |
| `require("@hot-updater/aws/lambda").handler` | `require("@hot-updater/aws/lambda/handler").handler` |
| `@hot-updater/aws` `awsLambdaEdgeStorage` or `s3LambdaEdgeStorage` | `@hot-updater/aws/lambda` `s3Storage` |
| `require("@hot-updater/firebase/functions").hot` | `require("@hot-updater/firebase/functions/handler").hot` |
| `@hot-updater/supabase` `supabaseEdgeFunctionDatabase` | `@hot-updater/supabase/edge` `supabaseDatabase` |
| `@hot-updater/supabase` `supabaseEdgeFunctionStorage` | `@hot-updater/supabase/edge` `supabaseStorage` |
| `@hot-updater/supabase/edge` `supabaseEdgeFunctionDatabase` | `@hot-updater/supabase/edge` `supabaseDatabase` |
| `@hot-updater/supabase/edge` `supabaseEdgeFunctionStorage` | `@hot-updater/supabase/edge` `supabaseStorage` |

The provider packages remain pre-1.0, where this repository releases breaking
provider changes as a minor version. No compatibility aliases are shipped for
these runtime-only names or handler paths.
