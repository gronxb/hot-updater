---
"@hot-updater/cloudflare": minor
"@hot-updater/cli-tools": minor
"@hot-updater/firebase": minor
"@hot-updater/managed": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Add a shared managed server-plugin preset that composes API-key authentication,
client route policy, and Analytics without exposing those feature contracts to
database providers. Cloudflare, Firebase, and Supabase use the same preset for
deployment targets and runtimes. Their deployment workflows migrate universal
components, run Better Auth-owned deployment preparation, issue and persist the
first client key during init, save it locally, and show its plaintext once. The
database providers implement only the universal component adapter and do not
know the access-key schema or lifecycle. Managed
runtimes require the key for OTA reads and event ingestion and do not grant
client keys Analytics read or management access.
Self-hosted composition roots can optionally authenticate their existing
management bearer through the same preset while preserving those client-role
limits.
