---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/cloudflare": major
"@hot-updater/postgres": minor
"@hot-updater/supabase": major
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/standalone": minor
"@hot-updater/aws": minor
"@hot-updater/react-native": minor
---

Implement the database plugin v2 resource runtime and promote Kysely, Drizzle,
and Prisma as the official public database middle layers. The low-level
database factory now lives behind internal boundaries for first-party runtime
code and legacy/native exceptions. SQL providers share the Kysely-backed
substrate through explicit provider metadata, while S3, Firebase, Standalone,
Mock, and MongoDB are classified as legacy/native database options outside the
official middle-layer set.

Deploy, bundle management, rollback, promote, console, standalone, server
handler, and React Native app-ready telemetry paths now persist through the v2
runtime commit boundary.
