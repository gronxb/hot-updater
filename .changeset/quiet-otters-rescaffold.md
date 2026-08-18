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
now rejects selected v0 resources before mutation and requires newly
scaffolded resources, while doctor identifies missing v1 generation markers
and gives the parallel-cutover remediation.

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
