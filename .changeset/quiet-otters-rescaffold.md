---
"@hot-updater/aws": minor
"@hot-updater/cli-tools": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/react-native": minor
"@hot-updater/server": minor
"@hot-updater/supabase": minor
"@hot-updater/test-utils": minor
"hot-updater": minor
---

Make Hot Updater v1 infrastructure a clean generation boundary. Managed init
now rejects selected v0 compute resources before mutation. Supabase tables and
RPCs plus Firebase collections and Functions use fixed v1 namespaces, allowing
v0 and v1 to coexist in one project while doctor identifies missing generation
markers and gives the parallel-cutover remediation.

AWS fresh installs use v1 Lambda and DynamoDB names plus a Lambda-scoped v1
signing-key path. S3 buckets can be shared across generations: init no longer
treats a matching bucket origin as CloudFront ownership, creates a new
distribution by default, and only updates the exact saved distribution after
its generation check passes.

Remove the v0 app-version and fingerprint HTTP routes, the legacy SDK-version
header contract, CDN forwarding and cache paths for those routes, and managed
provider Release Catalog backfills. Existing v0 native binaries must remain on
their unchanged v0 endpoint; new v1 native builds use the unversioned catalog
and artifact routes on fresh v1 infrastructure.

Normalize managed provider base URLs to their public deployment roots. AWS,
Cloudflare, and Firebase now serve `/version`, `/release-catalogs/*`,
`/artifacts/*`, and `/events` directly; Supabase retains only its
provider-owned Edge Function prefix. Client routes do not carry a library or
protocol version prefix because incompatible generations use a fresh base URL.
