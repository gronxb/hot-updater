---
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/console": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/plugin-core": minor
"@hot-updater/postgres": minor
"@hot-updater/server": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Replace the bounded Insights scan contract with native cursor pages and durable
report preparation. Insights event history, installation search, and reports now
remain exact beyond 50,000 events while bounding each storage request, response,
and maintenance step. Preparing reads advance one required provider-owned step,
so standalone servers converge without an external worker.

Official database providers now preserve raw events while maintaining committed
source positions, latest installations, historical aliases, and immutable report
publications. Console Insights uses cursor pagination, explicit readiness states,
and readable local timestamps across desktop and mobile layouts.

Prisma deployments now provision the provider-specific Insights layout with
`hot-updater db migrate` after Prisma applies the generated core schema. The
server checks this layout before Insights operations and returns a migration
required response instead of failing the first event write with a raw database
error.
