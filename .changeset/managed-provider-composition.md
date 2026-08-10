---
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Compose managed API-key authentication with Analytics in the Cloudflare,
Firebase, and Supabase runtimes. Their deployment workflows migrate the
provider-owned access-key store, issue and persist the first client key during
init, save it locally, and show its plaintext once. Managed runtimes verify the
key from their provider store, require it for OTA reads and event ingestion,
and do not grant client keys Analytics read or management access.
