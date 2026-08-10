---
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/managed": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Add a shared managed server-plugin preset that composes API-key authentication,
client route policy, and Analytics without exposing those feature contracts to
database providers. Cloudflare, Firebase, and Supabase use the same preset for
deployment targets and runtimes. Their deployment workflows migrate universal
components and the provider-owned access-key store, issue and persist the first
client key during init, save it locally, and show its plaintext once. Managed
runtimes require the key for OTA reads and event ingestion and do not grant
client keys Analytics read or management access.
