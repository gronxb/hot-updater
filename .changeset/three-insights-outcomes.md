---
"@hot-updater/react-native": patch
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/test-utils": patch
---

Finalize the unreleased v1 Insights contract with three event types: UPDATE_APPLIED, UNCHANGED, and RECOVERED. Same-file release selection reports UNCHANGED with null source bundle and update strategy while retaining release IDs. Remove RELEASE_ADOPTED from SDK payloads, server ingestion, database validators, and initial v1 schemas. No compatibility alias is accepted.

Replace adopted outcomes and counters with unchanged in the Insights query API. Refresh all v1 SDK and infrastructure packages together; existing prerelease development databases require their obsolete event rows and constraints to be updated before using this contract.
