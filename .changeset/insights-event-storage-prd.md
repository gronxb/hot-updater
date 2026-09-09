---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"@hot-updater/mock": minor
"@hot-updater/console": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

Replace shared Insights installation storage with canonical event queries and provider-private latest copies where needed. Custom providers implement `record({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

This changes the unreleased 1.0.0 initialization and custom database contract. Existing RC stores need the documented offline export/normalization and fresh-target replay; rerunning the initial migration does not convert them. SQL latest-state counts now grow with retained event history; measured costs are documented.
