---
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/supabase": patch
---

A database whose settings carry `schema.core` without `schema.engine` is no longer refused separately: the schema fence and `hot-updater db migrate` treat it like any unmigrated database. A v0 database is still refused, with the advice to create a new empty database and run `hot-updater db migrate`. `standaloneRepository` no longer sends a `v` query parameter with admin requests, and `hot-updater init` no longer looks for a `hotUpdater.plugins.ts` file or, on Firebase and Supabase, for collections and tables outside the storage engine's layout. A plugin with a `kind` key fails with the unknown-key error.
